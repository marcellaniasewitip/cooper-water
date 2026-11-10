package com.cooperwaters.customer.ui.wallet

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.CwIcons
import com.cooperwaters.core.android.ui.EmptyState
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.LoadingButton
import com.cooperwaters.core.android.ui.SectionTitle
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.money.Money
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.CustomerApi
import com.cooperwaters.core.net.CustomerWallet
import com.cooperwaters.core.net.LedgerEntry
import com.cooperwaters.core.net.Topup
import com.cooperwaters.core.net.TopupRequest
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.core.realtime.RealtimeEvent
import com.cooperwaters.core.time.PomTime
import com.cooperwaters.customer.R
import com.cooperwaters.customer.ui.common.ScreenScaffold
import com.cooperwaters.customer.ui.common.appContainer
import com.cooperwaters.customer.ui.common.containerViewModel
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class WalletUi(
    val loading: Boolean = true,
    val wallet: CustomerWallet? = null,
    val entries: List<LedgerEntry> = emptyList(),
    val pending: List<Topup> = emptyList(),
    val error: UiText? = null,
)

class WalletViewModel(private val api: CustomerApi, realtime: Flow<RealtimeEvent>) : ViewModel() {
    private val _ui = MutableStateFlow(WalletUi())
    val ui: StateFlow<WalletUi> = _ui.asStateFlow()

    init {
        viewModelScope.launch { realtime.collect { if (it is RealtimeEvent.WalletUpdated) refresh() } }
    }

    fun refresh() {
        _ui.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            val w = apiCall { api.wallet() }
            val e = apiCall { api.walletEntries() }
            val t = apiCall { api.walletTopups() }
            _ui.update {
                it.copy(
                    loading = false,
                    wallet = (w as? ApiResult.Success)?.value ?: it.wallet,
                    entries = (e as? ApiResult.Success)?.value?.items ?: it.entries,
                    pending = (t as? ApiResult.Success)?.value?.items?.filter { x -> x.status == "pending" } ?: it.pending,
                    error = (w as? ApiResult.Failure)?.error?.toUiText(),
                )
            }
        }
    }
}

/** StarTrip-style wallet: "Cooper Cash" balance, top up, pending top-ups and transactions. */
@Composable
fun WalletScreen(onBack: () -> Unit, onTopup: () -> Unit) {
    val vm = containerViewModel { c -> WalletViewModel(c.api.customerApi, c.realtime.events) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }
    ScreenScaffold(title = stringResource(R.string.wallet_title), onBack = onBack) {
        if (ui.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Card(
                    Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                ) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(CwIcons.Wallet, contentDescription = null, modifier = Modifier.size(32.dp))
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(stringResource(R.string.wallet_cash_name), style = MaterialTheme.typography.titleMedium)
                            Text(stringResource(R.string.wallet_cash_help), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Text(
                            Money.format(ui.wallet?.balanceToea ?: 0),
                            style = MaterialTheme.typography.headlineSmall,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.secondary,
                        )
                    }
                }
            }
            item { WalletRow(Icons.Filled.Add, stringResource(R.string.wallet_topup), onTopup) }
            item { ErrorCard(ui.error, onRetry = vm::refresh) }
            if (ui.pending.isNotEmpty()) {
                item { SectionTitle(stringResource(R.string.wallet_pending_title)) }
                items(ui.pending, key = { "p" + it.id }) { t ->
                    Text(
                        stringResource(R.string.wallet_pending_line, Money.format(t.amountToea), stringResource(methodLabel(t.method)), PomTime.formatDateTime(t.createdAt)),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            item { SectionTitle(stringResource(R.string.wallet_transactions)) }
            if (!ui.loading && ui.entries.isEmpty()) item { EmptyState(stringResource(R.string.wallet_no_entries)) }
            items(ui.entries, key = { it.id }) { e -> EntryRow(e) }
        }
    }
}

@Composable
private fun WalletRow(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null)
            Spacer(Modifier.width(14.dp))
            Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
        }
    }
}

@Composable
private fun EntryRow(e: LedgerEntry) {
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(e.description ?: stringResource(entryLabel(e.type)), style = MaterialTheme.typography.bodyLarge)
                Text(PomTime.formatDateTime(e.createdAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(
                Money.formatSigned(e.amountToea),
                fontWeight = FontWeight.Bold,
                color = if (e.amountToea >= 0) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.error,
            )
        }
        HorizontalDivider(Modifier.padding(top = 10.dp))
    }
}

private fun entryLabel(type: String): Int = when (type) {
    "topup" -> R.string.wallet_entry_topup
    "order_payment" -> R.string.wallet_entry_payment
    "refund" -> R.string.wallet_entry_refund
    "referral" -> R.string.wallet_entry_referral
    else -> R.string.wallet_entry_other
}

fun methodLabel(method: String): Int = when (method) {
    "cash" -> R.string.topup_method_cash
    "bank_transfer" -> R.string.topup_method_bank
    else -> R.string.topup_method_cellmoney
}

// ───────────── Top up ─────────────

data class TopupUi(
    val method: String = "cash",
    val amount: String = "",
    val reference: String = "",
    val msisdn: String = "",
    val submitting: Boolean = false,
    val done: Topup? = null,
    val error: UiText? = null,
)

/** Matches the backend's @Min on CustomerTopupDto. */
private const val MIN_TOPUP_TOEA = 100L

class CustomerTopupViewModel(private val api: CustomerApi, phone: String) : ViewModel() {
    private val _ui = MutableStateFlow(TopupUi(msisdn = phone))
    val ui: StateFlow<TopupUi> = _ui.asStateFlow()

    /** One key per filled-in form: retries of the same submit never create two top-ups. */
    private var key = UUID.randomUUID().toString()

    fun onMethod(m: String) = edit { it.copy(method = m) }
    fun onAmount(v: String) = edit { it.copy(amount = v.filter { c -> c.isDigit() || c == '.' || c == ',' }.take(12)) }
    fun onReference(v: String) = edit { it.copy(reference = v.take(100)) }
    fun onMsisdn(v: String) = edit { it.copy(msisdn = v.filter { c -> c.isDigit() || c == '+' }.take(20)) }

    private fun edit(f: (TopupUi) -> TopupUi) {
        if (_ui.value.submitting) return
        _ui.update { f(it).copy(error = null) }
        key = UUID.randomUUID().toString()
    }

    fun submit() {
        val s = _ui.value
        if (s.submitting) return
        val amount = Money.parseKina(s.amount)
        val error = when {
            amount == null -> UiText.res(R.string.topup_amount_invalid)
            amount < MIN_TOPUP_TOEA -> UiText.res(R.string.topup_amount_min, Money.format(MIN_TOPUP_TOEA))
            s.reference.isBlank() -> UiText.res(R.string.topup_reference_required)
            s.method == "cellmoney" && s.msisdn.length < 7 -> UiText.res(R.string.order_msisdn_invalid)
            else -> null
        }
        if (error != null || amount == null) {
            _ui.update { it.copy(error = error) }
            return
        }
        _ui.update { it.copy(submitting = true, error = null) }
        val body = TopupRequest(method = s.method, amountToea = amount, referenceText = s.reference.trim(), msisdn = if (s.method == "cellmoney") s.msisdn else null)
        viewModelScope.launch {
            when (val r = apiCall { api.topup(key, body) }) {
                is ApiResult.Success -> _ui.update { it.copy(submitting = false, done = r.value) }
                is ApiResult.Failure -> _ui.update { it.copy(submitting = false, error = r.error.toUiText()) }
            }
        }
    }
}

@Composable
fun CustomerTopupScreen(onDone: () -> Unit) {
    val phone = appContainer().tokenStore.user()?.phone.orEmpty()
    val vm = containerViewModel { c -> CustomerTopupViewModel(c.api.customerApi, phone) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    ScreenScaffold(title = stringResource(R.string.topup_title), onBack = onDone) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            val done = ui.done
            if (done != null) {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(stringResource(R.string.topup_submitted_title), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Text(stringResource(R.string.topup_submitted_body, Money.format(done.amountToea)))
                    }
                }
                LoadingButton(stringResource(R.string.topup_back_to_wallet), false, onDone, Modifier.fillMaxWidth())
                return@Column
            }
            Text(stringResource(R.string.topup_how), style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (m in listOf("cash", "bank_transfer", "cellmoney")) {
                    FilterChip(
                        selected = ui.method == m,
                        onClick = { vm.onMethod(m) },
                        label = { Text(stringResource(methodLabel(m))) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = MaterialTheme.colorScheme.primary,
                            selectedLabelColor = MaterialTheme.colorScheme.onPrimary,
                        ),
                    )
                }
            }
            Text(
                stringResource(
                    when (ui.method) {
                        "cash" -> R.string.topup_cash_help
                        "bank_transfer" -> R.string.topup_bank_help
                        else -> R.string.topup_cellmoney_help
                    },
                ),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = ui.amount,
                onValueChange = vm::onAmount,
                label = { Text(stringResource(R.string.topup_amount_label)) },
                prefix = { Text("K") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = ui.reference,
                onValueChange = vm::onReference,
                label = {
                    Text(
                        stringResource(
                            when (ui.method) {
                                "cash" -> R.string.topup_reference_cash
                                "bank_transfer" -> R.string.topup_reference_bank
                                else -> R.string.topup_reference_cellmoney
                            },
                        ),
                    )
                },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            if (ui.method == "cellmoney") {
                OutlinedTextField(
                    value = ui.msisdn,
                    onValueChange = vm::onMsisdn,
                    label = { Text(stringResource(R.string.topup_msisdn_label)) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            ErrorCard(ui.error)
            LoadingButton(stringResource(R.string.topup_submit), ui.submitting, vm::submit, Modifier.fillMaxWidth())
            Text(stringResource(R.string.topup_review_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
