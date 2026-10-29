package com.cooperwaters.driver.ui.earnings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cooperwaters.core.android.ui.EmptyState
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.LabelValue
import com.cooperwaters.core.android.ui.Labels
import com.cooperwaters.core.money.Money
import com.cooperwaters.core.time.PomTime
import com.cooperwaters.driver.R
import com.cooperwaters.driver.ui.common.ScreenScaffold
import com.cooperwaters.driver.ui.common.containerViewModel

private val PERIODS = listOf("today" to R.string.earnings_today, "week" to R.string.earnings_week, "month" to R.string.earnings_month)

@Composable
fun EarningsScreen(onBack: () -> Unit, bottomBar: (@Composable () -> Unit)? = null) {
    val vm = containerViewModel { c -> EarningsViewModel(c.repository) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    ScreenScaffold(title = stringResource(R.string.earnings_title), onBack = onBack, bottomBar = bottomBar) {
        TabRow(selectedTabIndex = PERIODS.indexOfFirst { it.first == ui.period }.coerceAtLeast(0)) {
            PERIODS.forEach { (key, label) -> Tab(selected = ui.period == key, onClick = { vm.select(key) }, text = { Text(stringResource(label)) }) }
        }
        if (ui.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ErrorCard(ui.error, onRetry = { vm.select(ui.period) })
            if (ui.fromCache) Text(stringResource(R.string.wallet_cached), style = MaterialTheme.typography.bodySmall)
            ui.earnings?.let { e ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(stringResource(R.string.earnings_net), style = MaterialTheme.typography.labelLarge)
                        Text(Money.format(e.netToea), style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
                        LabelValue(stringResource(R.string.earnings_jobs), e.completedOrders.toString())
                        LabelValue(stringResource(R.string.earnings_gross), Money.format(e.grossToea))
                        LabelValue(stringResource(R.string.earnings_commission), Money.format(-e.commissionToea))
                        HorizontalDivider()
                        LabelValue(stringResource(R.string.earnings_cash), Money.format(e.cashCollectedToea))
                        LabelValue(stringResource(R.string.earnings_cellmoney), Money.format(e.cellmoneyEarningsCreditedToea))
                        LabelValue(stringResource(R.string.earnings_topups), Money.format(e.topupsToea))
                        LabelValue(stringResource(R.string.earnings_payouts), Money.format(e.payoutsToea))
                        e.since?.let { Text(stringResource(R.string.earnings_since, PomTime.formatDate(it)), style = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
        }
    }
}

@Composable
fun JobHistoryScreen(onBack: () -> Unit, onOpen: (String) -> Unit, bottomBar: (@Composable () -> Unit)? = null) {
    val vm = containerViewModel { c -> JobHistoryViewModel(c.repository) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    ScreenScaffold(title = stringResource(R.string.history_title), onBack = onBack, bottomBar = bottomBar) {
        if (ui.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item { ErrorCard(ui.error, onRetry = vm::refresh) }
            if (!ui.loading && ui.items.isEmpty()) item { EmptyState(stringResource(R.string.history_empty)) }
            items(ui.items, key = { it.id }) { o ->
                Card(Modifier.fillMaxWidth().clickable { onOpen(o.id) }) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text(o.shortCode, fontWeight = FontWeight.Bold)
                            AssistChip(onClick = { onOpen(o.id) }, label = { Text(stringResource(Labels.status(o.status))) })
                        }
                        o.delivery?.let { Text(it.address, style = MaterialTheme.typography.bodySmall) }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(PomTime.formatDateTime(o.timeline.acceptedAt ?: o.timeline.createdAt), style = MaterialTheme.typography.bodySmall)
                            o.earningsToea?.let { Text(Money.format(it), fontWeight = FontWeight.SemiBold) }
                        }
                    }
                }
            }
            if (!ui.endReached && ui.items.isNotEmpty()) {
                item { OutlinedButton(onClick = vm::loadMore, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.action_load_more)) } }
            }
        }
    }
}
