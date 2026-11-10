package com.cooperwaters.driver.ui.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.EmptyState
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.ChatConversation
import com.cooperwaters.core.net.DriverApi
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.core.realtime.RealtimeEvent
import com.cooperwaters.core.time.PomTime
import com.cooperwaters.driver.R
import com.cooperwaters.driver.ui.common.ScreenScaffold
import com.cooperwaters.driver.ui.common.containerViewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ChatListUi(val loading: Boolean = true, val chats: List<ChatConversation> = emptyList(), val error: UiText? = null)

class ChatListViewModel(private val api: DriverApi, realtime: Flow<RealtimeEvent>) : ViewModel() {
    private val _ui = MutableStateFlow(ChatListUi())
    val ui: StateFlow<ChatListUi> = _ui.asStateFlow()

    init {
        refresh()
        viewModelScope.launch { realtime.collect { if (it is RealtimeEvent.ChatMessageReceived) refresh() } }
    }

    fun refresh() {
        _ui.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            when (val r = apiCall { api.chats() }) {
                is ApiResult.Success -> _ui.update { it.copy(loading = false, chats = r.value) }
                is ApiResult.Failure -> _ui.update { it.copy(loading = false, error = r.error.toUiText()) }
            }
        }
    }
}

/** Messages: one conversation per job with its customer, newest first, with unread counts. */
@Composable
fun ChatListScreen(onOpen: (orderId: String) -> Unit, onBack: () -> Unit) {
    val vm = containerViewModel { c -> ChatListViewModel(c.repository.api, c.realtime.events) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }

    ScreenScaffold(title = stringResource(R.string.chats_title), onBack = onBack) {
        if (ui.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { ErrorCard(ui.error, onRetry = vm::refresh) }
            if (!ui.loading && ui.chats.isEmpty()) item { EmptyState(stringResource(R.string.chats_empty), icon = Icons.Filled.Email) }
            items(ui.chats, key = { it.orderId }) { c -> ConversationRow(c) { onOpen(c.orderId) } }
        }
    }
}

@Composable
private fun ConversationRow(c: ChatConversation, onClick: () -> Unit) {
    Card(
        Modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    stringResource(R.string.chats_row_title, c.otherName.ifBlank { stringResource(R.string.chats_customer) }, c.shortCode),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    c.lastMessage?.let { m -> if (m.mine) stringResource(R.string.chats_you_prefix, m.body) else m.body } ?: stringResource(R.string.chats_no_messages),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                (c.lastMessage?.createdAt ?: c.updatedAt)?.let {
                    Text(PomTime.formatDateTime(it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (c.unread > 0) {
                Spacer(Modifier.width(12.dp))
                Box(Modifier.size(24.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary), contentAlignment = Alignment.Center) {
                    Text(if (c.unread > 9) "9+" else c.unread.toString(), color = MaterialTheme.colorScheme.onPrimary, style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}
