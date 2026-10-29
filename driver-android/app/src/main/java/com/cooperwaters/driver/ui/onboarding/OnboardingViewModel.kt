package com.cooperwaters.driver.ui.onboarding

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.DocumentState
import com.cooperwaters.core.net.DriverProfile
import com.cooperwaters.core.net.SubmitDocumentRequest
import com.cooperwaters.core.net.TruckRequest
import com.cooperwaters.core.net.Uploader
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.driver.R
import com.cooperwaters.driver.data.DriverRepository
import com.cooperwaters.driver.data.DriverState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Where a driver belongs given their account status. */
enum class DriverStage { ONBOARDING, WAITING, WORKING }

fun stageFor(status: String): DriverStage = when (status) {
    "approved" -> DriverStage.WORKING
    "pending_approval", "suspended" -> DriverStage.WAITING
    else -> DriverStage.ONBOARDING // pending_docs, rejected
}

data class OnboardingState(
    val loading: Boolean = true,
    val profile: DriverProfile? = null,
    val documents: List<DocumentState> = emptyList(),
    /** Document type currently uploading. */
    val uploading: String? = null,
    /** Document type whose last upload failed, or [TRUCK]: its card shows [error] so the driver sees it next to the buttons. */
    val failedType: String? = null,
    val plate: String = "",
    val capacity: String = "",
    val truckPhotoBytes: ByteArray? = null,
    val savingTruck: Boolean = false,
    val truckSaved: Boolean = false,
    val error: UiText? = null,
) {
    val allDocumentsIn: Boolean get() = documents.isNotEmpty() && documents.all { it.status == "pending" || it.status == "approved" }
    val stage: DriverStage? get() = profile?.let { stageFor(it.status) }

    companion object {
        /** [failedType] value for errors from the truck form. */
        const val TRUCK = "truck"
    }

    override fun equals(other: Any?): Boolean = other is OnboardingState &&
        loading == other.loading && profile == other.profile && documents == other.documents && uploading == other.uploading && failedType == other.failedType &&
        plate == other.plate && capacity == other.capacity && truckPhotoBytes.contentEqualsOrBothNull(other.truckPhotoBytes) &&
        savingTruck == other.savingTruck && truckSaved == other.truckSaved && error == other.error

    override fun hashCode(): Int = listOf(loading, profile, documents, uploading, failedType, plate, capacity, savingTruck, truckSaved, error).hashCode()
}

private fun ByteArray?.contentEqualsOrBothNull(o: ByteArray?) = if (this == null) o == null else o != null && contentEquals(o)

/** Upload required documents (from GET /driver/config) and register the truck. */
class OnboardingViewModel(
    private val repo: DriverRepository,
    private val uploader: Uploader,
    private val driverState: DriverState,
) : ViewModel() {
    private val _state = MutableStateFlow(OnboardingState())
    val state: StateFlow<OnboardingState> = _state.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            driverState.refreshConfig()
            val p = driverState.refreshProfile()
            val required = driverState.config.value?.requiredDocuments.orEmpty()
            val docs = p?.documents?.takeIf { it.isNotEmpty() } ?: required.map { DocumentState(it) }
            _state.update { s ->
                s.copy(
                    loading = false,
                    profile = p,
                    documents = docs,
                    plate = s.plate.ifBlank { p?.truck?.plate.orEmpty() },
                    capacity = s.capacity.ifBlank { p?.truck?.capacityLitres?.toString().orEmpty() },
                    truckSaved = s.truckSaved || p?.truck != null,
                    error = if (p == null) UiText.res(com.cooperwaters.core.R.string.cw_error_network) else null,
                )
            }
        }
    }

    /** [jpeg] is the already-compressed photo. */
    fun uploadDocument(type: String, jpeg: ByteArray) {
        if (_state.value.uploading != null) return
        _state.update { it.copy(uploading = type, error = null, failedType = null) }
        viewModelScope.launch {
            val key = when (val u = uploader.upload(Uploader.Purpose.DOCUMENT, "image/jpeg", jpeg)) {
                is ApiResult.Success -> u.value
                is ApiResult.Failure -> {
                    _state.update { it.copy(uploading = null, error = u.error.toUiText(), failedType = type) }
                    return@launch
                }
            }
            when (val r = apiCall { repo.api.submitDocument(SubmitDocumentRequest(type, key)) }) {
                is ApiResult.Success -> {
                    _state.update { s -> s.copy(uploading = null, documents = s.documents.map { if (it.type == type) it.copy(status = "pending", notes = null) else it }) }
                    refresh()
                }
                is ApiResult.Failure -> _state.update { it.copy(uploading = null, error = r.error.toUiText(), failedType = type) }
            }
        }
    }

    /** The picked image could not be decoded (corrupt, unsupported format or out of memory). */
    fun photoUnreadable(type: String) = _state.update { it.copy(error = UiText.res(R.string.onboarding_photo_unreadable), failedType = type) }

    fun onPlate(v: String) = _state.update { it.copy(plate = v.uppercase().take(20), error = null, failedType = null, truckSaved = false) }
    fun onCapacity(v: String) = _state.update { it.copy(capacity = v.filter(Char::isDigit).take(6), error = null, failedType = null, truckSaved = false) }
    fun onTruckPhoto(jpeg: ByteArray) = _state.update { it.copy(truckPhotoBytes = jpeg, truckSaved = false) }

    fun saveTruck() {
        val s = _state.value
        val capacity = s.capacity.toIntOrNull()
        when {
            s.plate.replace(" ", "").length < 2 -> { _state.update { it.copy(failedType = OnboardingState.TRUCK, error = UiText.res(R.string.truck_plate_required)) }; return }
            capacity == null || capacity !in 100..100_000 -> { _state.update { it.copy(failedType = OnboardingState.TRUCK, error = UiText.res(R.string.truck_capacity_invalid)) }; return }
            s.savingTruck -> return
        }
        _state.update { it.copy(savingTruck = true, error = null, failedType = null) }
        viewModelScope.launch {
            val photoKey = s.truckPhotoBytes?.let { bytes ->
                when (val u = uploader.upload(Uploader.Purpose.TRUCK_PHOTO, "image/jpeg", bytes)) {
                    is ApiResult.Success -> u.value
                    is ApiResult.Failure -> {
                        _state.update { it.copy(savingTruck = false, failedType = OnboardingState.TRUCK, error = u.error.toUiText()) }
                        return@launch
                    }
                }
            }
            when (val r = apiCall { repo.api.putTruck(TruckRequest(s.plate.trim(), capacity!!, photoKey)) }) {
                is ApiResult.Success -> {
                    _state.update { it.copy(savingTruck = false, truckSaved = true, truckPhotoBytes = null) }
                    refresh()
                }
                is ApiResult.Failure -> _state.update { it.copy(savingTruck = false, failedType = OnboardingState.TRUCK, error = r.error.toUiText()) }
            }
        }
    }
}
