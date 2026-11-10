package com.cooperwaters.customer.ui.history

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.List
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.CwIcons
import com.cooperwaters.core.android.ui.EmptyState
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.Labels
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.money.Money
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.CursorPager
import com.cooperwaters.core.net.Order
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.core.order.OrderStatus
import com.cooperwaters.core.time.PomTime
import com.cooperwaters.customer.R
import com.cooperwaters.customer.data.CustomerRepository
import com.cooperwaters.customer.ui.common.ScreenScaffold
import com.cooperwaters.customer.ui.common.containerViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class HistoryState(
    val loading: Boolean = true,
    val items: List<Order> = emptyList(),
    val endReached: Boolean = false,
    val error: UiText? = null,
)

class HistoryViewModel(private val repo: CustomerRepository) : ViewModel() {
    private val pager = CursorPager { cursor, limit -> apiCall { repo.api.orders(cursor, limit) } }
    private val _state = MutableStateFlow(HistoryState())
    val state: StateFlow<HistoryState> = _state.asStateFlow()

    init {
        refresh()
    }

    fun refresh() = load { pager.refresh() }

    fun loadMore() = load { pager.loadMore() }

    private fun load(block: suspend () -> ApiResult<List<Order>>) {
        if (_state.value.loading && _state.value.items.isNotEmpty()) return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            when (val r = block()) {
                is ApiResult.Success -> _state.update { it.copy(loading = false, items = r.value, endReached = pager.endReached) }
                is ApiResult.Failure -> {
                    // Offline: fall back to the cached first page.
                    val cached = if (_state.value.items.isEmpty()) repo.recentOrders().value?.items.orEmpty() else _state.value.items
                    _state.update { it.copy(loading = false, items = cached, error = r.error.toUiText()) }
                }
            }
        }
    }
}

/** Filter chips above the list (client-side over the loaded pages). */
enum class HistoryFilter { ALL, ACTIVE, COMPLETED, CANCELLED }

fun HistoryFilter.matches(o: Order): Boolean = when (this) {
    HistoryFilter.ALL -> true
    HistoryFilter.ACTIVE -> !OrderStatus.isTerminal(o.status)
    HistoryFilter.COMPLETED -> o.status == OrderStatus.COMPLETED || o.status == OrderStatus.DELIVERED
    HistoryFilter.CANCELLED -> o.status == OrderStatus.CANCELLED || o.status == OrderStatus.EXPIRED || o.status == OrderStatus.FAILED
}

@Composable
fun HistoryScreen(onOpen: (String) -> Unit, onNewOrder: () -> Unit, onBack: () -> Unit) {
    val vm = containerViewModel { c -> HistoryViewModel(c.repository) }
    val state by vm.state.collectAsStateWithLifecycle()
    var filter by rememberSaveable { mutableStateOf(HistoryFilter.ALL) }
    val shown = state.items.filter(filter::matches)
    ScreenScaffold(title = stringResource(R.string.history_title), onBack = onBack) {
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HistoryFilter.entries.forEach { f ->
                        FilterChip(
                            selected = filter == f,
                            onClick = { filter = f },
                            label = { Text(stringResource(filterLabel(f))) },
                            shape = MaterialTheme.shapes.extraSmall,
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = MaterialTheme.colorScheme.primary,
                                selectedLabelColor = MaterialTheme.colorScheme.onPrimary,
                            ),
                        )
                    }
                }
            }
            item { ErrorCard(state.error, onRetry = vm::refresh) }
            if (!state.loading && shown.isEmpty()) {
                item {
                    EmptyState(
                        stringResource(R.string.history_empty),
                        icon = Icons.Filled.List,
                        actionLabel = stringResource(R.string.home_order_water),
                        onAction = onNewOrder,
                    )
                }
            }
            items(shown, key = { it.id }) { o -> HistoryCard(o, onClick = { onOpen(o.id) }) }
            if (!state.endReached && state.items.isNotEmpty()) {
                item {
                    OutlinedButton(onClick = vm::loadMore, enabled = !state.loading, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.action_load_more))
                    }
                }
            }
        }
    }
}

private fun filterLabel(f: HistoryFilter): Int = when (f) {
    HistoryFilter.ALL -> R.string.history_filter_all
    HistoryFilter.ACTIVE -> R.string.history_filter_active
    HistoryFilter.COMPLETED -> R.string.history_filter_completed
    HistoryFilter.CANCELLED -> R.string.history_filter_cancelled
}

/** StarTrip-style order card: id and coloured status, date, delivery address, then package and price. */
@Composable
private fun HistoryCard(o: Order, onClick: () -> Unit) {
    val c = MaterialTheme.colorScheme
    val statusColor = when {
        HistoryFilter.COMPLETED.matches(o) -> c.secondary
        HistoryFilter.CANCELLED.matches(o) -> c.error
        else -> c.primary
    }
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = c.surface),
        border = BorderStroke(1.dp, c.outlineVariant),
        shape = MaterialTheme.shapes.small,
    ) {
        Column(Modifier.padding(start = 14.dp, end = 14.dp, top = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("#${o.shortCode}", style = MaterialTheme.typography.labelLarge, color = c.onSurfaceVariant, modifier = Modifier.weight(1f))
                Text(stringResource(Labels.status(o.status)), style = MaterialTheme.typography.labelLarge, color = statusColor, fontWeight = FontWeight.SemiBold)
            }
            Text(PomTime.formatDateTime(o.timeline.createdAt).uppercase(), style = MaterialTheme.typography.bodyMedium)
            o.delivery?.let { d ->
                Row(verticalAlignment = Alignment.Top) {
                    Box(Modifier.padding(top = 6.dp).size(8.dp).clip(CircleShape).background(c.secondary))
                    Spacer(Modifier.width(10.dp))
                    Text(d.address, style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant)
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(top = 10.dp).background(c.surfaceVariant).padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(CwIcons.WaterDrop, contentDescription = null, tint = Color(0xFF29B6F6), modifier = Modifier.size(22.dp))
            Spacer(Modifier.width(10.dp))
            Text(
                stringResource(R.string.history_package_line, o.quantity, o.`package`?.name.orEmpty()),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
            Text(Money.format(o.priceToea), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        }
    }
}
