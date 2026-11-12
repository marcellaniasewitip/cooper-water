package com.cooperwaters.customer.ui.order

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.money.Money
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.AppliedPromo
import com.cooperwaters.core.net.CreateOrderRequest
import com.cooperwaters.core.net.QuoteRequest
import com.cooperwaters.core.net.ReferralApplyRequest
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

/** Package first (the "Water delivery" tile). */
val PACKAGE_FIRST: List<OrderStep> = listOf(OrderStep.PACKAGE, OrderStep.LOCATION, OrderStep.PAYMENT, OrderStep.REVIEW)

/** Address first ("Where should we deliver?" and saved-place shortcuts, like StarTrip's "Where to?"). */
val LOCATION_FIRST: List<OrderStep> = listOf(OrderStep.LOCATION, OrderStep.PACKAGE, OrderStep.PAYMENT, OrderStep.REVIEW)

data class NewOrderState(
    val loading: Boolean = true,
    /** Order the steps are walked in. */
    val steps: List<OrderStep> = PACKAGE_FIRST,
    val step: OrderStep = steps.first(),
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
    /** Wallet balance (null while unknown/offline); the Wallet option needs enough to cover [payableToea]. */
    val walletBalanceToea: Long? = null,
    /** Offers: code typed or picked on the Offers screen, and the one the server accepted. */
    val promoInput: String = "",
    val appliedPromo: AppliedPromo? = null,
    val discountToea: Long = 0,
    val promoChecking: Boolean = false,
    val promoError: UiText? = null,
    /** Success note under the promo box (e.g. a Refer & Earn code was applied instead). */
    val promoInfo: UiText? = null,
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
    /** What the customer pays after the promo discount. */
    val payableToea: Long? get() = priceToea?.let { (it - discountToea).coerceAtLeast(0) }

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
    /** Saved place picked on Home ("order to this place"); null → the first saved place. */
    initialLocationId: String? = null,
    /** Promo picked on the Offers screen; applied once a package is chosen. */
    initialPromoCode: String? = null,
    /** Ask for the delivery address before the package (started from "Where should we deliver?" or a saved place). */
    locationFirst: Boolean = false,
) : ViewModel() {
    private val _state = MutableStateFlow(
        NewOrderState(
            msisdn = accountPhone,
            locationId = initialLocationId,
            promoInput = initialPromoCode.orEmpty(),
            steps = if (locationFirst) LOCATION_FIRST else PACKAGE_FIRST,
            // A saved place was tapped: the address is already chosen, so open on the package step.
            step = if (locationFirst && initialLocationId == null) OrderStep.LOCATION else OrderStep.PACKAGE,
        ),
    )
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
        val wallet = (apiCall { repo.api.wallet() } as? ApiResult.Success)?.value
        _state.update { s ->
            var next = s.copy(
                loading = false,
                packages = pkgs.value.orEmpty(),
                locations = locs.value.orEmpty(),
                maxQuantity = config.value?.maxQuantity ?: s.maxQuantity,
                walletBalanceToea = wallet?.balanceToea ?: s.walletBalanceToea,
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
                    appliedPromo = req.promoCode?.let { AppliedPromo(it) },
                    promoInput = req.promoCode.orEmpty(),
                    error = UiText.res(R.string.order_unsent_resume),
                )
            }
            next
        }
        // A code picked on the Offers screen is checked as soon as there is a package to price.
        val st = _state.value
        if (!st.unsent && st.appliedPromo == null && st.promoInput.isNotBlank() && st.packageId != null) applyPromo() else requestQuote()
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
        val payable = s.payableToea
        val err: UiText? = when (s.step) {
            OrderStep.PACKAGE -> if (s.selectedPackage == null) UiText.res(R.string.order_choose_package) else null
            OrderStep.LOCATION -> if (s.selectedLocation == null) UiText.res(R.string.order_choose_location) else null
            OrderStep.PAYMENT -> when {
                s.paymentMethod == "cellmoney" && s.msisdn.length < 7 -> UiText.res(R.string.order_msisdn_invalid)
                s.paymentMethod == "wallet" && s.walletBalanceToea != null && payable != null && s.walletBalanceToea < payable ->
                    UiText.res(R.string.order_wallet_short, Money.format(s.walletBalanceToea))
                else -> null
            }
            OrderStep.REVIEW -> null
        }
        if (err != null) {
            _state.update { it.copy(error = err) }
            return
        }
        val nextStep = s.steps.getOrNull(s.steps.indexOf(s.step) + 1) ?: return
        _state.update { it.copy(step = nextStep, error = null) }
    }

    /** @return false when already at the first step (screen should close). */
    fun back(): Boolean {
        val s = _state.value
        if (s.step == s.steps.first() || s.placing) return s.placing
        if (s.unsent && s.step == OrderStep.REVIEW) return false
        _state.update { it.copy(step = s.steps[s.steps.indexOf(s.step) - 1], error = null) }
        return true
    }

    private fun requestQuote() {
        val s = _state.value
        val pkg = s.packageId ?: return
        quoteJob?.cancel()
        _state.update { it.copy(quoting = true) }
        val code = s.appliedPromo?.code
        quoteJob = viewModelScope.launch {
            val r = apiCall { repo.api.quote(QuoteRequest(pkg, s.quantity, code)) }
            _state.update {
                if (it.packageId != pkg || it.quantity != s.quantity) {
                    it
                } else if (r is ApiResult.Failure && code != null && r.error.code.startsWith("promo_")) {
                    // The promo no longer fits (e.g. below its minimum order): drop it and requote without it.
                    it.copy(quoting = false, appliedPromo = null, discountToea = 0, promoError = r.error.toUiText())
                } else {
                    val q = (r as? ApiResult.Success)?.value
                    it.copy(quoting = false, quotedPriceToea = q?.priceToea, discountToea = q?.discountToea ?: it.discountToea)
                }
            }
            if (r is ApiResult.Failure && code != null && r.error.code.startsWith("promo_")) requestQuote()
        }
    }

    fun onPromoInput(v: String) {
        if (!_state.value.locked) _state.update { it.copy(promoInput = v.uppercase().filter { c -> c.isLetterOrDigit() || c == '-' || c == '_' }.take(30), promoError = null, promoInfo = null) }
    }

    /** Check the typed code against the current package/quantity (the server also checks it again when ordering). */
    fun applyPromo() {
        val s = _state.value
        val pkg = s.packageId ?: return
        val code = s.promoInput.trim()
        if (code.length < 3 || s.locked || s.promoChecking) return
        _state.update { it.copy(promoChecking = true, promoError = null, promoInfo = null) }
        viewModelScope.launch {
            when (val r = apiCall { repo.api.quote(QuoteRequest(pkg, s.quantity, code)) }) {
                is ApiResult.Success -> _state.update {
                    it.copy(promoChecking = false, appliedPromo = r.value.promo, discountToea = r.value.discountToea, quotedPriceToea = r.value.priceToea)
                }
                is ApiResult.Failure ->
                    if (r.error.code == "promo_is_referral") {
                        applyAsReferral(code)
                    } else {
                        _state.update { it.copy(promoChecking = false, appliedPromo = null, discountToea = 0, promoError = r.error.toUiText()) }
                    }
            }
        }
    }

    /** A friend's Refer & Earn code was typed in the promo box: apply it as a referral (wallet credit after the first order). */
    private suspend fun applyAsReferral(code: String) {
        when (val r = apiCall { repo.api.applyReferral(ReferralApplyRequest(code)) }) {
            is ApiResult.Success -> _state.update {
                it.copy(
                    promoChecking = false,
                    promoInput = "",
                    promoInfo = UiText.res(R.string.order_referral_applied, code.uppercase(), Money.format(r.value.rewardToea)),
                )
            }
            is ApiResult.Failure -> _state.update { it.copy(promoChecking = false, promoError = r.error.toUiText()) }
        }
    }

    fun removePromo() {
        if (_state.value.locked) return
        _state.update { it.copy(appliedPromo = null, discountToea = 0, promoInput = "", promoError = null) }
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
            promoCode = s.appliedPromo?.code,
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
            _state.update { it.copy(unsent = false, error = null, step = it.steps.first()) }
        }
    }

    fun clearError() = _state.update { it.copy(error = null) }
}
