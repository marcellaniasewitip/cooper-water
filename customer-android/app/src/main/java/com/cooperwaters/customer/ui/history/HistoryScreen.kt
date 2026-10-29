package com.cooperwaters.customer.ui.history

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.List
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.EmptyState
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.CursorPager
import com.cooperwaters.core.net.Order
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.customer.R
import com.cooperwaters.customer.data.CustomerRepository
import com.cooperwaters.customer.ui.common.OrderCard
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

@Composable
fun HistoryScreen(onOpen: (String) -> Unit, onNewOrder: () -> Unit, bottomBar: @Composable () -> Unit) {
    val vm = containerViewModel { c -> HistoryViewModel(c.repository) }
    val state by vm.state.collectAsStateWithLifecycle()
    ScreenScaffold(title = stringResource(R.string.history_title), bottomBar = bottomBar) {
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item { ErrorCard(state.error, onRetry = vm::refresh) }
            if (!state.loading && state.items.isEmpty()) {
                item {
                    EmptyState(
                        stringResource(R.string.history_empty),
                        icon = Icons.Filled.List,
                        actionLabel = stringResource(R.string.home_order_water),
                        onAction = onNewOrder,
                    )
                }
            }
            items(state.items, key = { it.id }) { o -> OrderCard(o, onClick = { onOpen(o.id) }) }
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
