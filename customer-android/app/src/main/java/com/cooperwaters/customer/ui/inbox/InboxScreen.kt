package com.cooperwaters.customer.ui.inbox

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
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
import com.cooperwaters.core.net.CustomerApi
import com.cooperwaters.core.net.InboxItem
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.core.time.PomTime
import com.cooperwaters.customer.R
import com.cooperwaters.customer.ui.common.ScreenScaffold
import com.cooperwaters.customer.ui.common.containerViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class InboxUi(val loading: Boolean = true, val items: List<InboxItem> = emptyList(), val endReached: Boolean = false, val error: UiText? = null)

class InboxViewModel(api: CustomerApi) : ViewModel() {
    private val pager = CursorPager { cursor, limit -> apiCall { api.inbox(cursor, limit) } }
    private val _ui = MutableStateFlow(InboxUi())
    val ui: StateFlow<InboxUi> = _ui.asStateFlow()

    init {
        load { pager.refresh() }
    }

    fun refresh() = load { pager.refresh() }
    fun loadMore() = load { pager.loadMore() }

    private fun load(block: suspend () -> ApiResult<List<InboxItem>>) {
        _ui.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            when (val r = block()) {
                is ApiResult.Success -> _ui.update { it.copy(loading = false, items = r.value, endReached = pager.endReached) }
                is ApiResult.Failure -> _ui.update { it.copy(loading = false, error = r.error.toUiText()) }
            }
        }
    }
}

/** Inbox (StarTrip style): order updates, top-ups, rewards — newest first. */
@Composable
fun InboxScreen(onBack: () -> Unit) {
    val vm = containerViewModel { c -> InboxViewModel(c.api.customerApi) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    ScreenScaffold(title = stringResource(R.string.inbox_title), onBack = onBack) {
        if (ui.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { ErrorCard(ui.error, onRetry = vm::refresh) }
            if (!ui.loading && ui.items.isEmpty()) item { EmptyState(stringResource(R.string.inbox_empty), icon = Icons.Filled.Notifications) }
            items(ui.items, key = { it.id }) { n ->
                Card(
                    Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                ) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.Top) {
                        Icon(Icons.Filled.Notifications, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(22.dp))
                        Spacer(Modifier.width(12.dp))
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(n.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                            Text(n.body, style = MaterialTheme.typography.bodyMedium)
                            Text(PomTime.formatDateTime(n.createdAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            if (!ui.endReached && ui.items.isNotEmpty()) {
                item { OutlinedButton(onClick = vm::loadMore, enabled = !ui.loading, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.action_load_more)) } }
            }
        }
    }
}
