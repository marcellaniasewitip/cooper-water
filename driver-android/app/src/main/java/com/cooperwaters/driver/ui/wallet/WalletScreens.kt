package com.cooperwaters.driver.ui.wallet

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cooperwaters.core.android.ui.EmptyState
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.LabelValue
import com.cooperwaters.core.android.ui.LoadingButton
import com.cooperwaters.core.android.ui.SectionTitle
import com.cooperwaters.core.money.Money
import com.cooperwaters.core.net.LedgerEntry
import com.cooperwaters.core.time.PomTime
import com.cooperwaters.driver.R
import com.cooperwaters.driver.ui.common.PhotoPickerButtons
import com.cooperwaters.driver.ui.common.ScreenScaffold
import com.cooperwaters.driver.ui.common.compressPhoto
import com.cooperwaters.driver.ui.common.containerViewModel
import kotlinx.coroutines.launch

fun ledgerTypeLabel(type: String): Int = when (type) {
    "topup" -> R.string.ledger_topup
    "commission" -> R.string.ledger_commission
    "order_earning" -> R.string.ledger_order_earning
    "refund" -> R.string.ledger_refund
    "adjustment" -> R.string.ledger_adjustment
    "payout" -> R.string.ledger_payout
    else -> R.string.ledger_other
}

@Composable
fun WalletScreen(onBack: () -> Unit, onTopup: () -> Unit, onWithdraw: () -> Unit, bottomBar: (@Composable () -> Unit)? = null) {
    val vm = containerViewModel { c -> WalletViewModel(c.repository, c.state, c.realtime.events) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }
    ScreenScaffold(title = stringResource(R.string.wallet_title), onBack = onBack, bottomBar = bottomBar) {
        if (ui.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ui.summary?.let { s ->
                item {
                    Card(
                        Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = if (s.blocked) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer),
                    ) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(stringResource(R.string.wallet_balance), style = MaterialTheme.typography.labelLarge)
                            Text(Money.format(s.balanceToea), style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
                            LabelValue(stringResource(R.string.wallet_minimum), Money.format(s.minBalanceToea))
                            LabelValue(stringResource(R.string.wallet_withdrawable), Money.format(s.withdrawableToea))
                            if (s.pendingTopups.count > 0) {
                                LabelValue(stringResource(R.string.wallet_pending_topups, s.pendingTopups.count), Money.format(s.pendingTopups.amountToea))
                            }
                            if (s.blocked) {
                                Text(
                                    stringResource(R.string.wallet_blocked_body, Money.format(s.balanceToea), Money.format(s.minBalanceToea), Money.format(s.shortfallToea)),
                                    color = MaterialTheme.colorScheme.onErrorContainer,
                                )
                            }
                        }
                    }
                }
            }
            if (ui.fromCache) item { Text(stringResource(R.string.wallet_cached), style = MaterialTheme.typography.bodySmall) }
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onTopup, modifier = Modifier.weight(1f)) { Text(stringResource(R.string.wallet_topup)) }
                    OutlinedButton(onClick = onWithdraw, modifier = Modifier.weight(1f)) { Text(stringResource(R.string.wallet_withdraw)) }
                }
            }
            item { ErrorCard(ui.error, onRetry = vm::refresh) }
            item { SectionTitle(stringResource(R.string.wallet_history)) }
            if (!ui.loading && ui.entries.isEmpty()) item { EmptyState(stringResource(R.string.wallet_no_entries)) }
            items(ui.entries, key = { it.id }) { e -> LedgerRow(e) }
            if (!ui.endReached && ui.entries.isNotEmpty()) {
                item { OutlinedButton(onClick = vm::loadMore, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.action_load_more)) } }
            }
        }
    }
}

@Composable
private fun LedgerRow(e: LedgerEntry) {
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(stringResource(ledgerTypeLabel(e.type)), fontWeight = FontWeight.Medium)
            Text(
                Money.formatSigned(e.amountToea),
                color = if (e.amountToea >= 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                fontWeight = FontWeight.Bold,
            )
        }
        e.description?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(PomTime.formatDateTime(e.createdAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(stringResource(R.string.wallet_balance_after, Money.format(e.balanceAfter)), style = MaterialTheme.typography.bodySmall)
        }
        HorizontalDivider(Modifier.padding(top = 6.dp))
    }
}

@Composable
fun TopupScreen(onDone: () -> Unit) {
    val vm = containerViewModel { c -> TopupViewModel(c.repository, c.uploader, c.tokenStore.user()?.phone.orEmpty()) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    ScreenScaffold(title = stringResource(R.string.topup_title), onBack = onDone) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val result = ui.result
            if (result != null) {
                Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(stringResource(R.string.topup_submitted, Money.format(result.amountToea)), style = MaterialTheme.typography.titleMedium)
                        Text(stringResource(if (result.status == "approved") R.string.topup_status_approved else R.string.topup_status_pending))
                        result.payment?.instructions?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
                        result.payment?.let { LabelValue(stringResource(R.string.topup_reference_label), it.reference) }
                    }
                }
                Button(onClick = onDone, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.action_done)) }
                } else {
            ui.minBalanceToea?.let { Text(stringResource(R.string.topup_min_info, Money.format(it)), style = MaterialTheme.typography.bodySmall) }
            SectionTitle(stringResource(R.string.topup_method))
            for (m in listOf(TopupUi.METHOD_BANK, TopupUi.METHOD_CELLMONEY)) {
                Row(
                    Modifier.fillMaxWidth().selectable(selected = ui.method == m, onClick = { vm.setMethod(m) }).padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = ui.method == m, onClick = { vm.setMethod(m) })
                    Text(stringResource(if (m == TopupUi.METHOD_BANK) R.string.topup_bank else R.string.topup_cellmoney))
                }
            }
            OutlinedTextField(
                ui.amount,
                vm::onAmount,
                label = { Text(stringResource(R.string.topup_amount)) },
                prefix = { Text(stringResource(R.string.currency_prefix)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            if (ui.method == TopupUi.METHOD_BANK) {
                Text(stringResource(R.string.topup_bank_help), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(ui.reference, vm::onReference, label = { Text(stringResource(R.string.topup_reference)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Text(stringResource(if (ui.proofPhoto != null) R.string.topup_proof_ready else R.string.topup_proof_optional), style = MaterialTheme.typography.bodySmall)
                if (ui.proofPhoto != null) {
                    TextButton(onClick = { vm.onProofPhoto(null) }, enabled = !ui.locked) { Text(stringResource(R.string.job_proof_remove)) }
                } else {
                    PhotoPickerButtons(enabled = !ui.locked, onPicked = { uri -> scope.launch { compressPhoto(context, uri)?.let(vm::onProofPhoto) } })
                }
            } else {
                ui.merchantNumber?.let { Text(stringResource(R.string.topup_merchant, it), style = MaterialTheme.typography.bodySmall) }
                OutlinedTextField(
                    ui.msisdn,
                    vm::onMsisdn,
                    label = { Text(stringResource(R.string.topup_msisdn)) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            ErrorCard(ui.error)
            LoadingButton(stringResource(if (ui.unsent) R.string.topup_retry else R.string.topup_submit), ui.submitting, vm::submit, Modifier.fillMaxWidth())
            if (ui.unsent && !ui.submitting) TextButton(onClick = vm::discardUnsent) { Text(stringResource(R.string.topup_discard)) }
            }
        }
    }
}

@Composable
fun WithdrawScreen(onDone: () -> Unit) {
    val vm = containerViewModel { c -> WithdrawViewModel(c.repository, c.tokenStore.user()?.phone.orEmpty()) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    ScreenScaffold(title = stringResource(R.string.withdraw_title), onBack = onDone) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (ui.done) {
                Text(stringResource(R.string.withdraw_done), style = MaterialTheme.typography.titleMedium)
                Button(onClick = onDone, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.action_done)) }
                } else {
            ui.summary?.let { s ->
                LabelValue(stringResource(R.string.wallet_balance), Money.format(s.balanceToea))
                LabelValue(stringResource(R.string.wallet_withdrawable), Money.format(s.withdrawableToea))
                Text(stringResource(R.string.withdraw_help, Money.format(s.minBalanceToea), Money.format(s.payoutMinToea)), style = MaterialTheme.typography.bodySmall)
            }
            OutlinedTextField(
                ui.amount,
                vm::onAmount,
                label = { Text(stringResource(R.string.withdraw_amount)) },
                prefix = { Text(stringResource(R.string.currency_prefix)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            TextButton(onClick = vm::withdrawAll, enabled = !ui.locked) { Text(stringResource(R.string.withdraw_all)) }
            for (m in listOf("cellmoney", "bank_transfer")) {
                Row(
                    Modifier.fillMaxWidth().selectable(selected = ui.method == m, onClick = { vm.setMethod(m) }).padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = ui.method == m, onClick = { vm.setMethod(m) })
                    Text(stringResource(if (m == "cellmoney") R.string.topup_cellmoney else R.string.withdraw_bank))
                }
            }
            OutlinedTextField(
                ui.destination,
                vm::onDestination,
                label = { Text(stringResource(if (ui.method == "cellmoney") R.string.withdraw_destination_msisdn else R.string.withdraw_destination_bank)) },
                modifier = Modifier.fillMaxWidth(),
            )
            ErrorCard(ui.error)
            LoadingButton(stringResource(if (ui.unsent) R.string.topup_retry else R.string.withdraw_submit), ui.submitting, vm::submit, Modifier.fillMaxWidth())
            }
        }
    }
}
