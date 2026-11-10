package com.cooperwaters.driver.ui.wallet

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.money.Money
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.CursorPager
import com.cooperwaters.core.net.LedgerEntry
import com.cooperwaters.core.net.Payment
import com.cooperwaters.core.net.TopupRequest
import com.cooperwaters.core.net.Uploader
import com.cooperwaters.core.net.WalletBrief
import com.cooperwaters.core.net.WalletSummary
import com.cooperwaters.core.net.WithdrawalRequest
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.core.queue.PendingAction
import com.cooperwaters.core.queue.QueueOutcome
import com.cooperwaters.core.realtime.RealtimeEvent
import com.cooperwaters.driver.R
import com.cooperwaters.driver.data.DriverRepository
import com.cooperwaters.driver.data.DriverState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

// ───────────── Wallet summary + ledger ─────────────

data class WalletUi(
    val loading: Boolean = true,
    val summary: WalletSummary? = null,
    val fromCache: Boolean = false,
    val entries: List<LedgerEntry> = emptyList(),
    val endReached: Boolean = false,
    val error: UiText? = null,
)

class WalletViewModel(
    private val repo: DriverRepository,
    private val driverState: DriverState,
    realtime: Flow<RealtimeEvent>,
) : ViewModel() {
    private val pager = CursorPager { cursor, limit -> apiCall { repo.api.walletEntries(cursor, limit) } }
    private val _ui = MutableStateFlow(WalletUi())
    val ui: StateFlow<WalletUi> = _ui.asStateFlow()

    init {
        refresh()
        viewModelScope.launch { realtime.collect { if (it is RealtimeEvent.WalletUpdated) refresh() } }
    }

    fun refresh() {
        _ui.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            val s = repo.wallet()
            s.value?.let { w -> driverState.setWallet(WalletBrief(w.balanceToea, w.minBalanceToea, w.blocked)) }
            val e = pager.refresh()
            _ui.update {
                it.copy(
                    loading = false,
                    summary = s.value,
                    fromCache = s.fromCache,
                    entries = (e as? ApiResult.Success)?.value ?: it.entries,
                    endReached = pager.endReached,
                    error = (s.error ?: e.errorOrNull())?.toUiText(),
                )
            }
        }
    }

    fun loadMore() {
        if (_ui.value.loading) return
        _ui.update { it.copy(loading = true) }
        viewModelScope.launch {
            val e = pager.loadMore()
            _ui.update { it.copy(loading = false, entries = (e as? ApiResult.Success)?.value ?: it.entries, endReached = pager.endReached, error = e.errorOrNull()?.toUiText()) }
        }
    }
}

// ───────────── Top-up ─────────────

data class TopupUi(
    val method: String = METHOD_BANK,
    val amount: String = "",
    val reference: String = "",
    val msisdn: String = "",
    val proofPhoto: ByteArray? = null,
    val submitting: Boolean = false,
    /** A submitted-but-unconfirmed top-up is saved; retry reuses its Idempotency-Key. */
    val unsent: Boolean = false,
    val merchantNumber: String? = null,
    val minBalanceToea: Long? = null,
    val result: Result? = null,
    val error: UiText? = null,
) {
    data class Result(val amountToea: Long, val method: String, val status: String, val payment: Payment?)

    val locked: Boolean get() = unsent || submitting

    override fun equals(other: Any?): Boolean = other is TopupUi && method == other.method && amount == other.amount &&
        reference == other.reference && msisdn == other.msisdn && proofPhoto?.contentHashCode() == other.proofPhoto?.contentHashCode() &&
        submitting == other.submitting && unsent == other.unsent && merchantNumber == other.merchantNumber &&
        minBalanceToea == other.minBalanceToea && result == other.result && error == other.error

    override fun hashCode(): Int = listOf(method, amount, reference, msisdn, submitting, unsent, result, error).hashCode()

    companion object {
        const val METHOD_BANK = "bank_transfer"
        const val METHOD_CELLMONEY = "cellmoney"
        const val METHOD_CASH = "cash"
    }
}

/**
 * Top up by bank transfer (amount + reference + optional proof photo → admin approval) or cell money
 * (amount + number → collection). Amount typed in Kina is parsed exactly into toea (no floats).
 */
class TopupViewModel(
    private val repo: DriverRepository,
    private val uploader: Uploader,
    accountPhone: String,
) : ViewModel() {
    private val _ui = MutableStateFlow(TopupUi(msisdn = accountPhone))
    val ui: StateFlow<TopupUi> = _ui.asStateFlow()
    private var pending: PendingAction? = null

    init {
        viewModelScope.launch {
            val cfg = repo.config().value
            val w = repo.wallet().value
            _ui.update { it.copy(merchantNumber = cfg?.merchantNumber?.takeIf { m -> m.isNotBlank() }, minBalanceToea = w?.minBalanceToea) }
            if (w != null && w.shortfallToea > 0 && _ui.value.amount.isBlank()) _ui.update { it.copy(amount = Money.toInput(w.shortfallToea)) }
            repo.pendingTopup()?.let { a ->
                pending = a
                val req = repo.decodeTopup(a)
                _ui.update {
                    it.copy(
                        unsent = true,
                        method = req.method,
                        amount = Money.toInput(req.amountToea),
                        reference = req.referenceText.orEmpty(),
                        msisdn = req.msisdn ?: it.msisdn,
                        error = UiText.res(R.string.topup_unsent_resume),
                    )
                }
            }
        }
    }

    fun setMethod(m: String) { if (!_ui.value.locked) _ui.update { it.copy(method = m, error = null) } }
    fun onAmount(v: String) { if (!_ui.value.locked) _ui.update { it.copy(amount = v.filter { c -> c.isDigit() || c == '.' || c == ',' }.take(12), error = null) } }
    fun onReference(v: String) { if (!_ui.value.locked) _ui.update { it.copy(reference = v.take(100), error = null) } }
    fun onMsisdn(v: String) { if (!_ui.value.locked) _ui.update { it.copy(msisdn = v.filter { c -> c.isDigit() || c == '+' }.take(20), error = null) } }
    fun onProofPhoto(jpeg: ByteArray?) { if (!_ui.value.locked) _ui.update { it.copy(proofPhoto = jpeg) } }

    /** Validate the form; returns the error to show, or null. Pure — unit tested. */
    fun validate(s: TopupUi = _ui.value): UiText? {
        val toea = Money.parseKina(s.amount)
        return when {
            toea == null -> UiText.res(R.string.topup_amount_invalid)
            toea < MIN_TOPUP_TOEA -> UiText.res(R.string.topup_amount_min, Money.format(MIN_TOPUP_TOEA))
            s.method == TopupUi.METHOD_BANK && s.reference.isBlank() -> UiText.res(R.string.topup_reference_required)
            s.method == TopupUi.METHOD_CASH && s.reference.isBlank() -> UiText.res(R.string.topup_receipt_required)
            s.method == TopupUi.METHOD_CELLMONEY && s.msisdn.length < 7 -> UiText.res(R.string.topup_msisdn_invalid)
            else -> null
        }
    }

    fun submit() {
        val s = _ui.value
        if (s.submitting) return
        if (pending == null) {
            validate(s)?.let { e -> _ui.update { it.copy(error = e) }; return }
        }
        _ui.update { it.copy(submitting = true, error = null) }
        viewModelScope.launch {
            val action = pending ?: run {
                // Upload the optional proof first; the key becomes part of the persisted body.
                val proofKey = s.proofPhoto?.let { bytes ->
                    when (val u = uploader.upload(Uploader.Purpose.TOPUP_PROOF, "image/jpeg", bytes)) {
                        is ApiResult.Success -> u.value
                        is ApiResult.Failure -> {
                            _ui.update { it.copy(submitting = false, error = u.error.toUiText()) }
                            return@launch
                        }
                    }
                }
                val req = TopupRequest(
                    method = s.method,
                    amountToea = Money.parseKina(s.amount)!!,
                    referenceText = if (s.method == TopupUi.METHOD_BANK || s.method == TopupUi.METHOD_CASH) s.reference.trim() else null,
                    proofFileKey = proofKey,
                    msisdn = if (s.method == TopupUi.METHOD_CELLMONEY) s.msisdn else null,
                )
                repo.newTopupAction(req).also { pending = it }
            }
            _ui.update { it.copy(unsent = true) }
            when (val out = repo.topup(action)) {
                is QueueOutcome.Success -> {
                    pending = null
                    val t = out.value.topup
                    _ui.update { it.copy(submitting = false, unsent = false, result = TopupUi.Result(t.amountToea, t.method, t.status, out.value.payment)) }
                }
                is QueueOutcome.Failed -> {
                    pending = null
                    _ui.update { it.copy(submitting = false, unsent = false, error = out.error.toUiText()) }
                }
                is QueueOutcome.StillPending -> _ui.update { it.copy(submitting = false, error = UiText.res(com.cooperwaters.core.R.string.cw_still_sending)) }
                else -> {
                    pending = null
                    _ui.update { it.copy(submitting = false, unsent = false) }
                }
            }
        }
    }

    fun discardUnsent() {
        val a = pending ?: return
        if (_ui.value.submitting) return
        viewModelScope.launch {
            repo.queue.discard(a.key)
            pending = null
            _ui.update { it.copy(unsent = false, error = null) }
        }
    }

    companion object {
        /** Backend TopupDto minimum (K1.00). */
        const val MIN_TOPUP_TOEA = 100L
    }
}

// ───────────── Withdrawal ─────────────

data class WithdrawUi(
    val summary: WalletSummary? = null,
    val amount: String = "",
    val method: String = "cellmoney",
    val destination: String = "",
    val submitting: Boolean = false,
    val unsent: Boolean = false,
    val done: Boolean = false,
    val error: UiText? = null,
) {
    val locked: Boolean get() = unsent || submitting
}

/** Request a payout of the balance above the minimum (processed manually by Finance). */
class WithdrawViewModel(private val repo: DriverRepository, accountPhone: String) : ViewModel() {
    private val _ui = MutableStateFlow(WithdrawUi(destination = accountPhone))
    val ui: StateFlow<WithdrawUi> = _ui.asStateFlow()
    private var pending: PendingAction? = null

    init {
        viewModelScope.launch {
            repo.wallet().value?.let { w -> _ui.update { it.copy(summary = w) } }
            repo.pendingWithdrawal()?.let { a ->
                pending = a
                val r = repo.decodeWithdrawal(a)
                _ui.update { it.copy(unsent = true, amount = Money.toInput(r.amountToea), method = r.method, destination = r.destination, error = UiText.res(R.string.withdraw_unsent_resume)) }
            }
        }
    }

    fun onAmount(v: String) { if (!_ui.value.locked) _ui.update { it.copy(amount = v.filter { c -> c.isDigit() || c == '.' || c == ',' }.take(12), error = null) } }
    fun setMethod(m: String) { if (!_ui.value.locked) _ui.update { it.copy(method = m, error = null) } }
    fun onDestination(v: String) { if (!_ui.value.locked) _ui.update { it.copy(destination = v.take(200), error = null) } }
    fun withdrawAll() { _ui.value.summary?.let { s -> onAmount(Money.toInput(s.withdrawableToea)) } }

    fun validate(s: WithdrawUi = _ui.value): UiText? {
        val toea = Money.parseKina(s.amount)
        val sum = s.summary
        return when {
            toea == null || toea <= 0 -> UiText.res(R.string.topup_amount_invalid)
            sum != null && toea < sum.payoutMinToea -> UiText.res(R.string.withdraw_min, Money.format(sum.payoutMinToea))
            sum != null && toea > sum.withdrawableToea -> UiText.res(R.string.withdraw_max, Money.format(sum.withdrawableToea))
            s.destination.trim().length < 5 -> UiText.res(R.string.withdraw_destination_required)
            else -> null
        }
    }

    fun submit() {
        val s = _ui.value
        if (s.submitting) return
        if (pending == null) validate(s)?.let { e -> _ui.update { it.copy(error = e) }; return }
        _ui.update { it.copy(submitting = true, error = null, unsent = true) }
        viewModelScope.launch {
            val action = pending ?: repo.newWithdrawalAction(WithdrawalRequest(Money.parseKina(s.amount)!!, s.method, s.destination.trim())).also { pending = it }
            when (val out = repo.withdraw(action)) {
                is QueueOutcome.Success -> {
                    pending = null
                    _ui.update { it.copy(submitting = false, unsent = false, done = true) }
                }
                is QueueOutcome.Failed -> {
                    pending = null
                    _ui.update { it.copy(submitting = false, unsent = false, error = out.error.toUiText()) }
                }
                is QueueOutcome.StillPending -> _ui.update { it.copy(submitting = false, error = UiText.res(com.cooperwaters.core.R.string.cw_still_sending)) }
                else -> {
                    pending = null
                    _ui.update { it.copy(submitting = false, unsent = false) }
                }
            }
        }
    }
}
