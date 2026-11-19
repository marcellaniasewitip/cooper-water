package com.cooperwaters.driver.ui.job

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.DeliveredRequest
import com.cooperwaters.core.net.Depot
import com.cooperwaters.core.net.Eta
import com.cooperwaters.core.net.DisputeRequest
import com.cooperwaters.core.net.ErrorCodes
import com.cooperwaters.core.net.OptionalPositionRequest
import com.cooperwaters.core.net.Order
import com.cooperwaters.core.net.PositionRequest
import com.cooperwaters.core.net.Uploader
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.core.order.OrderStatus
import com.cooperwaters.core.util.Geo
import com.cooperwaters.driver.R
import com.cooperwaters.driver.data.DriverRepository
import com.cooperwaters.driver.data.DriverState
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Which step the driver performs next for an order status. */
enum class JobStep { ARRIVE_DEPOT, CONFIRM_LOADED, MARK_ARRIVED, MARK_DELIVERED, AWAIT_CUSTOMER, DONE }

fun nextStep(status: String): JobStep = when (status) {
    OrderStatus.ACCEPTED -> JobStep.ARRIVE_DEPOT
    OrderStatus.LOADING -> JobStep.CONFIRM_LOADED
    OrderStatus.EN_ROUTE -> JobStep.MARK_ARRIVED
    OrderStatus.ARRIVED -> JobStep.MARK_DELIVERED
    OrderStatus.DELIVERED, OrderStatus.DISPUTED -> JobStep.AWAIT_CUSTOMER
    else -> JobStep.DONE
}

/** Steps that need the driver's position (depot geofence checks happen on the server). */
fun JobStep.needsPosition(): Boolean = this == JobStep.ARRIVE_DEPOT || this == JobStep.CONFIRM_LOADED

data class JobUi(
    val order: Order? = null,
    val fromCache: Boolean = false,
    val depots: List<Depot> = emptyList(),
    val busy: Boolean = false,
    val proofPhoto: ByteArray? = null,
    val categories: List<String> = emptyList(),
    val issueCategory: String? = null,
    val issueText: String = "",
    val issueSent: Boolean = false,
    val error: UiText? = null,
    val info: UiText? = null,
) {
    val step: JobStep get() = order?.let { nextStep(it.status) } ?: JobStep.DONE

    fun nearestDepot(lat: Double?, lng: Double?): Depot? =
        if (lat == null || lng == null) depots.firstOrNull() else depots.minByOrNull { Geo.distanceM(lat, lng, it.lat, it.lng) }

    override fun equals(other: Any?): Boolean = other is JobUi && order == other.order && fromCache == other.fromCache &&
        depots == other.depots && busy == other.busy && (proofPhoto?.contentHashCode() == other.proofPhoto?.contentHashCode()) &&
        categories == other.categories && issueCategory == other.issueCategory && issueText == other.issueText &&
        issueSent == other.issueSent && error == other.error && info == other.info

    override fun hashCode(): Int = listOf(order, fromCache, depots, busy, proofPhoto?.contentHashCode(), issueCategory, issueText, issueSent, error, info).hashCode()
}

/** Active job: confirm loading at the depot (geofence), en route, arrived, delivered (+ optional photo), report issue. */
class JobViewModel(
    private val repo: DriverRepository,
    private val uploader: Uploader,
    private val driverState: DriverState,
    private val orderId: String,
) : ViewModel() {
    private val _ui = MutableStateFlow(JobUi())
    val ui: StateFlow<JobUi> = _ui.asStateFlow()

    private val _openNavigation = Channel<Unit>(Channel.CONFLATED)

    /** Fires once when the water is loaded: the screen opens Google Maps directions to the customer. */
    val openNavigation: Flow<Unit> = _openNavigation.receiveAsFlow()

    private val _eta = MutableStateFlow<Eta?>(null)

    /** Time and road distance to the customer (via the depot until loaded), refreshed every 30 s. */
    val eta: StateFlow<Eta?> = _eta.asStateFlow()

    init {
        viewModelScope.launch {
            repo.cachedOrder(orderId)?.let { o -> _ui.update { it.copy(order = o, fromCache = true) } }
            refreshNow()
            repo.depots().value?.let { d -> _ui.update { it.copy(depots = d) } }
            val cats = repo.config().value?.disputeCategories.orEmpty()
            _ui.update { it.copy(categories = cats) }
        }
        viewModelScope.launch {
            driverState.activeOrder.collect { o -> if (o != null && o.id == orderId) _ui.update { it.copy(order = o, fromCache = false) } }
        }
        viewModelScope.launch {
            while (true) {
                refreshEta()
                delay(30_000L)
            }
        }
    }

    private suspend fun refreshEta() {
        val status = _ui.value.order?.status
        if (status == null || status !in ETA_STATUSES) {
            _eta.value = null
            return
        }
        val r = apiCall { repo.api.eta(orderId) }
        if (r is ApiResult.Success) _eta.value = r.value
    }

    fun refresh() {
        viewModelScope.launch { refreshNow() }
    }

    private suspend fun refreshNow() {
        when (val r = apiCall { repo.api.order(orderId) }) {
            is ApiResult.Success -> apply(r.value)
            is ApiResult.Failure -> if (_ui.value.order == null) _ui.update { it.copy(error = r.error.toUiText()) }
        }
    }

    private suspend fun apply(o: Order) {
        repo.cacheOrder(o)
        driverState.setActiveOrder(o)
        _ui.update { it.copy(order = o, fromCache = false) }
    }

    fun onProofPhoto(jpeg: ByteArray) = _ui.update { it.copy(proofPhoto = jpeg) }
    fun clearProofPhoto() = _ui.update { it.copy(proofPhoto = null) }

    /** Called by the screen once it has (or failed to get) a position. */
    fun performStep(lat: Double?, lng: Double?) {
        val step = _ui.value.step
        if (_ui.value.busy) return
        if (step.needsPosition() && (lat == null || lng == null)) {
            _ui.update { it.copy(error = UiText.res(R.string.job_location_needed)) }
            return
        }
        _ui.update { it.copy(busy = true, error = null, info = null) }
        viewModelScope.launch {
            val r: ApiResult<Order> = when (step) {
                JobStep.ARRIVE_DEPOT -> apiCall { repo.api.arriveDepot(orderId, PositionRequest(lat!!, lng!!)) }
                JobStep.CONFIRM_LOADED -> apiCall { repo.api.loaded(orderId, PositionRequest(lat!!, lng!!)) }
                JobStep.MARK_ARRIVED -> apiCall { repo.api.arrived(orderId, OptionalPositionRequest(lat, lng)) }
                JobStep.MARK_DELIVERED -> {
                    val photo = _ui.value.proofPhoto
                    val key = if (photo != null) {
                        when (val u = uploader.upload(Uploader.Purpose.PROOF_OF_DELIVERY, "image/jpeg", photo)) {
                            is ApiResult.Success -> u.value
                            is ApiResult.Failure -> {
                                _ui.update { it.copy(busy = false, error = u.error.toUiText()) }
                                return@launch
                            }
                        }
                    } else {
                        null
                    }
                    apiCall { repo.api.delivered(orderId, DeliveredRequest(key)) }
                }
                JobStep.AWAIT_CUSTOMER, JobStep.DONE -> {
                    _ui.update { it.copy(busy = false) }
                    return@launch
                }
            }
            when (r) {
                is ApiResult.Success -> {
                    apply(r.value)
                    _ui.update { it.copy(busy = false, proofPhoto = if (step == JobStep.MARK_DELIVERED) null else it.proofPhoto) }
                    if (step == JobStep.CONFIRM_LOADED) _openNavigation.trySend(Unit)
                    refreshEta()
                }
                is ApiResult.Failure -> {
                    val msg = if (r.error.hasCode(ErrorCodes.NOT_AT_DEPOT)) {
                        val d = _ui.value.nearestDepot(lat, lng)
                        if (d != null && lat != null && lng != null) {
                            UiText.res(R.string.job_not_at_depot, d.name, Geo.formatDistance(Geo.distanceM(lat, lng, d.lat, d.lng)))
                        } else {
                            r.error.toUiText()
                        }
                    } else {
                        r.error.toUiText()
                    }
                    _ui.update { it.copy(busy = false, error = msg) }
                    // Status may have moved on (admin reassigned / customer cancelled).
                    if (r.error.httpStatus == 409 || r.error.httpStatus == 404) refreshNow()
                }
            }
        }
    }

    fun setIssueCategory(c: String) = _ui.update { it.copy(issueCategory = c, error = null) }
    fun setIssueText(t: String) = _ui.update { it.copy(issueText = t.take(2000), error = null) }

    fun reportIssue() {
        val s = _ui.value
        val cat = s.issueCategory
        if (cat == null) {
            _ui.update { it.copy(error = UiText.res(R.string.issue_choose_category)) }
            return
        }
        if (s.issueText.isBlank()) {
            _ui.update { it.copy(error = UiText.res(R.string.issue_describe)) }
            return
        }
        if (s.busy) return
        _ui.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            when (val r = apiCall { repo.api.reportIssue(orderId, DisputeRequest(cat, s.issueText.trim())) }) {
                is ApiResult.Success -> {
                    _ui.update { it.copy(busy = false, issueSent = true, issueText = "", issueCategory = null) }
                    refreshNow()
                }
                is ApiResult.Failure -> _ui.update { it.copy(busy = false, error = r.error.toUiText()) }
            }
        }
    }

    fun consumeIssueSent() = _ui.update { it.copy(issueSent = false, info = UiText.res(R.string.issue_sent)) }

    private companion object {
        val ETA_STATUSES = setOf(OrderStatus.ACCEPTED, OrderStatus.LOADING, OrderStatus.EN_ROUTE, OrderStatus.ARRIVED)
    }
}
