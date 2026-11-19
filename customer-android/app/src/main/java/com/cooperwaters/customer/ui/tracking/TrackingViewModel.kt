package com.cooperwaters.customer.ui.tracking

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.CancelRequest
import com.cooperwaters.core.net.DriverLocation
import com.cooperwaters.core.net.Eta
import com.cooperwaters.core.net.SendReceiptRequest
import com.cooperwaters.core.net.ErrorCodes
import com.cooperwaters.core.net.Order
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.core.order.OrderStatus
import com.cooperwaters.core.realtime.RealtimeEvent
import com.cooperwaters.customer.R
import com.cooperwaters.customer.data.CustomerRepository
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class TrackingState(
    val loading: Boolean = true,
    val order: Order? = null,
    val fromCache: Boolean = false,
    val driverLocation: DriverLocation? = null,
    /** "Driver is 7 min away" (null until known / when there is no driver on the way). */
    val eta: Eta? = null,
    /** Email on the customer's profile (prefills the receipt box). */
    val profileEmail: String? = null,
    val receiptBusy: Boolean = false,
    val receiptInfo: UiText? = null,
    val receiptError: UiText? = null,
    val cancelFreeUntil: String = OrderStatus.ACCEPTED,
    val busy: Boolean = false,
    val error: UiText? = null,
    val info: UiText? = null,
) {
    val canCancel: Boolean get() = order != null && OrderStatus.customerMayCancel(order.status, cancelFreeUntil)
    val canConfirm: Boolean get() = order?.status == OrderStatus.DELIVERED
    val canRate: Boolean get() = order?.status == OrderStatus.COMPLETED && order.driver != null
    val canDispute: Boolean get() = order != null && OrderStatus.isDisputable(order.status)
    val needsPayment: Boolean get() = order?.status == OrderStatus.PENDING_PAYMENT
    val canEmailReceipt: Boolean get() = order?.status?.let { it == OrderStatus.DELIVERED || it == OrderStatus.COMPLETED || it == OrderStatus.DISPUTED } == true
}

/** Live tracking: REST snapshot + socket `order.updated` / `order.driver_location`, with polling as a fallback. */
class TrackingViewModel(
    private val repo: CustomerRepository,
    private val orderId: String,
    realtime: Flow<RealtimeEvent>,
    pushes: Flow<Map<String, String>>,
) : ViewModel() {
    private val _state = MutableStateFlow(TrackingState())
    val state: StateFlow<TrackingState> = _state.asStateFlow()
    private var etaFetchedAt = 0L

    init {
        viewModelScope.launch {
            repo.config().value?.let { cfg -> _state.update { it.copy(cancelFreeUntil = cfg.cancelFreeUntil) } }
        }
        viewModelScope.launch {
            (apiCall { repo.api.me() } as? ApiResult.Success)?.value?.email?.let { e -> _state.update { it.copy(profileEmail = e) } }
        }
        viewModelScope.launch {
            while (true) {
                refreshNow()
                val st = _state.value.order?.status
                if (st != null && OrderStatus.isTerminal(st)) break
                delay(if (st != null && OrderStatus.isTrackable(st)) 20_000L else 30_000L)
            }
        }
        viewModelScope.launch {
            realtime.collect { e ->
                when (e) {
                    is RealtimeEvent.OrderUpdated -> if (e.order.id == orderId) applyOrder(e.order, fromSocket = true)
                    is RealtimeEvent.DriverLocationChanged -> if (e.orderId == orderId) {
                        _state.update { it.copy(driverLocation = DriverLocation(e.lat, e.lng, e.at)) }
                        // The driver moved: refresh the arrival time (at most every 30 s).
                        if (System.currentTimeMillis() - etaFetchedAt > 30_000) refreshEta()
                    }
                    else -> Unit
                }
            }
        }
        viewModelScope.launch { pushes.collect { refreshNow() } }
    }

    fun refresh() {
        viewModelScope.launch { refreshNow() }
    }

    private suspend fun refreshNow() {
        val loaded = repo.order(orderId)
        _state.update { it.copy(loading = false, fromCache = loaded.fromCache, error = if (loaded.value == null) loaded.error?.toUiText() else it.error) }
        loaded.value?.let { applyOrder(it, fromSocket = false) }
        refreshEtaNow()
    }

    private fun refreshEta() {
        viewModelScope.launch { refreshEtaNow() }
    }

    /** Arrival estimate while a driver is on the way (accepted → arrived); cleared otherwise. */
    private suspend fun refreshEtaNow() {
        val status = _state.value.order?.status
        if (status == null || status !in ETA_STATUSES) {
            _state.update { it.copy(eta = null) }
            return
        }
        etaFetchedAt = System.currentTimeMillis()
        val r = apiCall { repo.api.eta(orderId) }
        if (r is ApiResult.Success) _state.update { it.copy(eta = r.value) }
    }

    private fun applyOrder(o: Order, fromSocket: Boolean) {
        _state.update { s ->
            // Socket payloads can be partial (e.g. reassignment); keep the richer snapshot fields.
            val merged = if (fromSocket && o.delivery == null && s.order != null) s.order.copy(status = o.status) else o
            s.copy(
                order = merged,
                driverLocation = merged.driver?.location ?: s.driverLocation.takeIf { OrderStatus.isTrackable(merged.status) },
            )
        }
        // A new stage (e.g. water loaded) changes the route: update the arrival time straight away.
        if (fromSocket) refreshEta()
        if (fromSocket) viewModelScope.launch { repo.cacheOrder(_state.value.order ?: o) }
    }

    fun cancel(reason: String) = act { apiCall { repo.api.cancel(orderId, CancelRequest(reason)) } }

    fun confirmReceipt() = act(successInfo = UiText.res(R.string.tracking_confirmed)) { apiCall { repo.api.confirm(orderId) } }

    private fun act(successInfo: UiText? = null, call: suspend () -> ApiResult<Order>) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, error = null, info = null) }
        viewModelScope.launch {
            when (val r = call()) {
                is ApiResult.Success -> {
                    repo.cacheOrder(r.value)
                    _state.update { it.copy(busy = false, order = r.value, info = successInfo) }
                }
                is ApiResult.Failure -> {
                    _state.update { it.copy(busy = false, error = r.error.toUiText()) }
                    // The status moved on (e.g. driver accepted meanwhile): show the latest.
                    if (r.error.hasCode(ErrorCodes.CANCEL_NOT_ALLOWED)) refreshNow()
                }
            }
        }
    }

    fun clearMessages() = _state.update { it.copy(error = null, info = null) }

    /** Email the delivery receipt (with the signature); optionally keep the address on the profile. */
    fun sendReceipt(email: String, save: Boolean) {
        val to = email.trim()
        if (_state.value.receiptBusy) return
        if (!Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$").matches(to)) {
            _state.update { it.copy(receiptError = UiText.res(R.string.receipt_email_invalid), receiptInfo = null) }
            return
        }
        _state.update { it.copy(receiptBusy = true, receiptError = null, receiptInfo = null) }
        viewModelScope.launch {
            when (val r = apiCall { repo.api.sendReceipt(orderId, SendReceiptRequest(to, saveEmail = save)) }) {
                is ApiResult.Success -> {
                    _state.update { it.copy(receiptBusy = false, receiptInfo = UiText.res(R.string.receipt_sent, r.value.email), profileEmail = if (save) r.value.email else it.profileEmail) }
                    refreshNow()
                }
                is ApiResult.Failure -> _state.update { it.copy(receiptBusy = false, receiptError = r.error.toUiText()) }
            }
        }
    }

    private companion object {
        val ETA_STATUSES = setOf(OrderStatus.ACCEPTED, OrderStatus.LOADING, OrderStatus.EN_ROUTE, OrderStatus.ARRIVED)
    }
}
