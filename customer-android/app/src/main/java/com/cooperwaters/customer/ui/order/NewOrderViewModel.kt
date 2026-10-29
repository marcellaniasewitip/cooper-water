package com.cooperwaters.customer.ui.order

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.CreateOrderRequest
import com.cooperwaters.core.net.QuoteRequest
import com.cooperwaters.core.net.SavedLocation
import com.cooperwaters.core.net.WaterPackage
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.core.order.OrderStatus
import com.cooperwaters.core.queue.PendingAction
import com.cooperwaters.core.queue.QueueOutcome
import com.cooperwaters.customer.R
import com.cooperwaters.customer.data.CustomerRepository
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class OrderStep { PACKAGE, LOCATION, PAYMENT, REVIEW }

data class NewOrderState(
    val loading: Boolean = true,
    val step: OrderStep = OrderStep.PACKAGE,
    val packages: List<WaterPackage> = emptyList(),
    val packageId: String? = null,
    val quantity: Int = 1,
    val maxQuantity: Int = 10,
    /** Server quote (fixed citywide price). Null while loading/offline — then [localPriceToea] is shown. */
    val quotedPriceToea: Long? = null,
    val quoting: Boolean = false,
    val locations: List<SavedLocation> = emptyList(),
    val locationId: String? = null,
    val paymentMethod: String = "cod",
    val msisdn: String = "",
    val placing: Boolean = false,
    /** A previous "Place order" is saved but unconfirmed: retry it with the same Idempotency-Key. */
    val unsent: Boolean = false,
    val error: UiText? = null,
    val placed: Placed? = null,
    val resumedElsewhere: Boolean = false,
) {
    data class Placed(val orderId: String, val needsPayment: Boolean, val paymentError: String?)

    val selectedPackage: WaterPackage? get() = packages.firstOrNull { it.id == packageId }
    val selectedLocation: SavedLocation? get() = locations.firstOrNull { it.id == locationId }
    val localPriceToea: Long? get() = selectedPackage?.let { it.priceToea * quantity }
    val priceToea: Long? get() = quotedPriceToea ?: localPriceToea

    /** Draft fields are locked while an unconfirmed order exists, so a retry always sends the identical body. */
    val locked: Boolean get() = unsent || placing
}

/**
 * Package & quantity → fixed price quote → delivery location → payment method → place order.
 *
 * "Place order" never double-submits: the tap creates ONE persisted action (UUID Idempotency-Key + exact body);
 * retries — automatic backoff, the Retry button, or the background drain after reconnecting — reuse it.
 */
class NewOrderViewModel(
    private val repo: CustomerRepository,
    accountPhone: String,
) : ViewModel() {
    private val _state = MutableStateFlow(NewOrderState(msisdn = accountPhone))
    val state: StateFlow<NewOrderState> = _state.asStateFlow()

    private var quoteJob: Job? = null
    private var pending: PendingAction? = null

    init {
        viewModelScope.launch { load() }
    }

    /** Retry loading packages, locations and settings (e.g. after "no packages" or offline). */
    fun reload() {
        if (_state.value.loading) return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch { load() }
    }

    private suspend fun load() {
        val config = repo.config()
        val pkgs = repo.packages()
        val locs = repo.locations()
        val unsent = repo.pendingOrder()
        pending = unsent
        _state.update { s ->
            var next = s.copy(
                loading = false,
                packages = pkgs.value.orEmpty(),
                locations = locs.value.orEmpty(),
                maxQuantity = config.value?.maxQuantity ?: s.maxQuantity,
                packageId = s.packageId ?: pkgs.value?.firstOrNull()?.id,
                locationId = s.locationId ?: locs.value?.firstOrNull()?.id,
                error = if (pkgs.value == null) pkgs.error?.toUiText() else null,
            )
            if (unsent != null) {
                val req = repo.decodeOrderRequest(unsent)
                next = next.copy(
                    unsent = true,
                    step = OrderStep.REVIEW,
                    packageId = req.packageId,
                    quantity = req.quantity,
                    locationId = req.locationId,
                    paymentMethod = req.paymentMethod,
                    msisdn = req.msisdn ?: next.msisdn,
                    error = UiText.res(R.string.order_unsent_resume),
                )
            }
            next
        }
        requestQuote()
    }

    /** Re-read saved locations (after the user added one). */
    fun reloadLocations() {
        viewModelScope.launch {
            val locs = repo.locations().value ?: return@launch
            _state.update { s -> s.copy(locations = locs, locationId = s.locationId?.takeIf { id -> locs.any { it.id == id } } ?: locs.firstOrNull()?.id) }
        }
    }

    fun selectPackage(id: String) {
        if (_state.value.locked) return
        _state.update { it.copy(packageId = id, quotedPriceToea = null) }
        requestQuote()
    }

    fun setQuantity(q: Int) {
        val s = _state.value
        if (s.locked) return
        val clamped = q.coerceIn(1, s.maxQuantity)
        if (clamped == s.quantity) return
        _state.update { it.copy(quantity = clamped, quotedPriceToea = null) }
        requestQuote()
    }

    fun selectLocation(id: String) {
        if (!_state.value.locked) _state.update { it.copy(locationId = id) }
    }

    fun selectPayment(method: String) {
        if (!_state.value.locked) _state.update { it.copy(paymentMethod = method) }
    }

    fun onMsisdn(v: String) {
        if (!_state.value.locked) _state.update { it.copy(msisdn = v.filter { c -> c.isDigit() || c == '+' }.take(20)) }
    }

    fun next() {
        val s = _state.value
        val err: UiText? = when (s.step) {
            OrderStep.PACKAGE -> if (s.selectedPackage == null) UiText.res(R.string.order_choose_package) else null
            OrderStep.LOCATION -> if (s.selectedLocation == null) UiText.res(R.string.order_choose_location) else null
            OrderStep.PAYMENT -> if (s.paymentMethod == "cellmoney" && s.msisdn.length < 7) UiText.res(R.string.order_msisdn_invalid) else null
            OrderStep.REVIEW -> null
        }
        if (err != null) {
            _state.update { it.copy(error = err) }
            return
        }
        val nextStep = OrderStep.entries.getOrNull(s.step.ordinal + 1) ?: return
        _state.update { it.copy(step = nextStep, error = null) }
    }

    /** @return false when already at the first step (screen should close). */
    fun back(): Boolean {
        val s = _state.value
        if (s.step == OrderStep.PACKAGE || s.placing) return s.placing
        if (s.unsent && s.step == OrderStep.REVIEW) return false
        _state.update { it.copy(step = OrderStep.entries[s.step.ordinal - 1], error = null) }
        return true
    }

    private fun requestQuote() {
        val s = _state.value
        val pkg = s.packageId ?: return
        quoteJob?.cancel()
        _state.update { it.copy(quoting = true) }
        quoteJob = viewModelScope.launch {
            val r = apiCall { repo.api.quote(QuoteRequest(pkg, s.quantity)) }
            _state.update {
                if (it.packageId != pkg || it.quantity != s.quantity) it
                else it.copy(quoting = false, quotedPriceToea = (r as? ApiResult.Success)?.value?.priceToea)
            }
        }
    }

    fun buildRequest(s: NewOrderState = _state.value): CreateOrderRequest? {
        val pkg = s.selectedPackage ?: return null
        val loc = s.selectedLocation ?: return null
        return CreateOrderRequest(
            packageId = pkg.id,
            quantity = s.quantity,
            locationId = loc.id,
            paymentMethod = s.paymentMethod,
            msisdn = if (s.paymentMethod == "cellmoney") s.msisdn.ifBlank { null } else null,
        )
    }

    fun placeOrder() {
        val s = _state.value
        if (s.placing) return
        _state.update { it.copy(placing = true, error = null) }
        viewModelScope.launch {
            val action = pending ?: run {
                val req = buildRequest(s)
                if (req == null) {
                    _state.update { it.copy(placing = false, error = UiText.res(R.string.order_incomplete)) }
                    return@launch
                }
                repo.newOrderAction(req).also { pending = it }
            }
            _state.update { it.copy(unsent = true) }
            when (val outcome = repo.submitOrder(action)) {
                is QueueOutcome.Success -> {
                    pending = null
                    val o = outcome.value.order
                    _state.update {
                        it.copy(
                            placing = false,
                            unsent = false,
                            placed = NewOrderState.Placed(o.id, o.status == OrderStatus.PENDING_PAYMENT, outcome.value.paymentError?.message),
                        )
                    }
                }
                is QueueOutcome.Failed -> {
                    pending = null
                    _state.update { it.copy(placing = false, unsent = false, error = outcome.error.toUiText()) }
                }
                is QueueOutcome.StillPending -> _state.update {
                    it.copy(placing = false, error = if (outcome.error.isNetwork) UiText.res(R.string.order_still_sending_offline) else UiText.res(R.string.order_still_sending))
                }
                QueueOutcome.AlreadyHandled -> {
                    pending = null
                    _state.update { it.copy(placing = false, unsent = false, resumedElsewhere = true) }
                }
                QueueOutcome.Expired -> {
                    pending = null
                    _state.update { it.copy(placing = false, unsent = false) }
                }
            }
        }
    }

    /** Give up on an unconfirmed order (only offered while it is NOT in flight). */
    fun discardUnsent() {
        val a = pending ?: return
        if (_state.value.placing) return
        viewModelScope.launch {
            repo.queue.discard(a.key)
            pending = null
            _state.update { it.copy(unsent = false, error = null, step = OrderStep.PACKAGE) }
        }
    }

    fun clearError() = _state.update { it.copy(error = null) }
}
