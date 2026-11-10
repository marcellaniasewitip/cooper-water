package com.cooperwaters.customer.ui.chat

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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Email
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
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
import com.cooperwaters.core.net.ChatMessage
import com.cooperwaters.core.net.ChatSendRequest
import com.cooperwaters.core.net.CustomerApi
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.core.realtime.RealtimeEvent
import com.cooperwaters.core.time.PomTime
import com.cooperwaters.customer.R
import com.cooperwaters.customer.ui.common.ScreenScaffold
import com.cooperwaters.customer.ui.common.containerViewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

// ── Conversation list ──

data class ChatListUi(val loading: Boolean = true, val chats: List<ChatConversation> = emptyList(), val error: UiText? = null)

class ChatListViewModel(private val api: CustomerApi, realtime: Flow<RealtimeEvent>) : ViewModel() {
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

/** Chat list (StarTrip style): "Current" chats for active orders and "Past" ones, with unread badges. */
@Composable
fun ChatListScreen(onOpen: (orderId: String) -> Unit, onBack: () -> Unit) {
    val vm = containerViewModel { c -> ChatListViewModel(c.api.customerApi, c.realtime.events) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }
    val shown = ui.chats.filter { it.open == (tab == 0) }

    ScreenScaffold(title = stringResource(R.string.chat_list_title), onBack = onBack) {
        TabRow(selectedTabIndex = tab) {
            Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text(stringResource(R.string.chat_tab_current)) })
            Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text(stringResource(R.string.chat_tab_past)) })
        }
        if (ui.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { ErrorCard(ui.error, onRetry = vm::refresh) }
            if (!ui.loading && shown.isEmpty()) {
                item { EmptyState(stringResource(if (tab == 0) R.string.chat_none_current else R.string.chat_none_past), icon = Icons.Filled.Email) }
            }
            items(shown, key = { it.orderId }) { c -> ConversationRow(c) { onOpen(c.orderId) } }
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
                    stringResource(R.string.chat_row_title, c.otherName.ifBlank { stringResource(R.string.chat_driver) }, c.shortCode),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    c.lastMessage?.let { m -> if (m.mine) stringResource(R.string.chat_you_prefix, m.body) else m.body } ?: stringResource(R.string.chat_no_messages),
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
                    Text(
                        if (c.unread > 9) "9+" else c.unread.toString(),
                        color = MaterialTheme.colorScheme.onPrimary,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
        }
    }
}

// ── One conversation ──

data class ChatThreadUi(
    val loading: Boolean = true,
    val loaded: Boolean = false,
    val shortCode: String = "",
    val otherName: String = "",
    val open: Boolean = true,
    val messages: List<ChatMessage> = emptyList(),
    val draft: String = "",
    val sending: Boolean = false,
    val error: UiText? = null,
)

/** Customer ↔ driver chat for one order: load, send, and refresh on realtime chat events. */
class ChatThreadViewModel(
    private val api: CustomerApi,
    realtime: Flow<RealtimeEvent>,
    private val orderId: String,
) : ViewModel() {
    private val _ui = MutableStateFlow(ChatThreadUi())
    val ui: StateFlow<ChatThreadUi> = _ui.asStateFlow()

    init {
        refresh()
        viewModelScope.launch {
            realtime.collect { e -> if (e is RealtimeEvent.ChatMessageReceived && e.orderId == orderId) refresh() }
        }
    }

    fun refresh() {
        viewModelScope.launch {
            when (val r = apiCall { api.messages(orderId) }) {
                is ApiResult.Success -> _ui.update {
                    it.copy(
                        loading = false,
                        loaded = true,
                        shortCode = r.value.shortCode,
                        otherName = r.value.otherName,
                        open = r.value.open,
                        messages = r.value.messages,
                    )
                }
                is ApiResult.Failure -> _ui.update { it.copy(loading = false, error = r.error.toUiText()) }
            }
        }
    }

    fun onDraft(v: String) = _ui.update { it.copy(draft = v.take(1000), error = null) }

    fun clearError() = _ui.update { it.copy(error = null) }

    fun send() {
        val s = _ui.value
        val body = s.draft.trim()
        if (body.isEmpty() || s.sending) return
        _ui.update { it.copy(sending = true, error = null) }
        viewModelScope.launch {
            when (val r = apiCall { api.sendMessage(orderId, ChatSendRequest(body)) }) {
                is ApiResult.Success -> _ui.update { u ->
                    u.copy(sending = false, draft = "", messages = if (u.messages.any { it.id == r.value.id }) u.messages else u.messages + r.value)
                }
                is ApiResult.Failure -> _ui.update { it.copy(sending = false, error = r.error.toUiText()) }
            }
        }
    }
}

@Composable
fun ChatThreadScreen(orderId: String, onBack: () -> Unit) {
    val vm = containerViewModel(key = "chat-$orderId") { c -> ChatThreadViewModel(c.api.customerApi, c.realtime.events, orderId) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()
    LaunchedEffect(ui.messages.size) { if (ui.messages.isNotEmpty()) listState.animateScrollToItem(ui.messages.size - 1) }

    ScreenScaffold(
        title = if (ui.otherName.isBlank()) stringResource(R.string.chat_title) else ui.otherName,
        onBack = onBack,
    ) {
        if (ui.shortCode.isNotBlank()) {
            Text(
                stringResource(R.string.chat_order_label, ui.shortCode),
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (ui.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        ErrorCard(ui.error, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), onDismiss = vm::clearError)
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (!ui.loading && ui.messages.isEmpty()) {
                item { Text(stringResource(R.string.chat_empty, ui.otherName.ifBlank { stringResource(R.string.chat_driver) }), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            items(ui.messages, key = { it.id }) { m -> Bubble(m) }
        }
        if (ui.loaded && !ui.open) {
            Text(
                stringResource(R.string.chat_closed),
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Row(Modifier.fillMaxWidth().imePadding().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = ui.draft,
                    onValueChange = vm::onDraft,
                    placeholder = { Text(stringResource(R.string.chat_placeholder)) },
                    modifier = Modifier.weight(1f),
                    maxLines = 4,
                    shape = RoundedCornerShape(24.dp),
                )
                IconButton(onClick = vm::send, enabled = ui.draft.isNotBlank() && !ui.sending && ui.loaded) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.chat_send))
                }
            }
        }
    }
}

@Composable
private fun Bubble(m: ChatMessage) {
    val c = MaterialTheme.colorScheme
    Box(Modifier.fillMaxWidth(), contentAlignment = if (m.mine) Alignment.CenterEnd else Alignment.CenterStart) {
        Column(
            Modifier
                .widthIn(max = 300.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(if (m.mine) c.primary else c.surfaceVariant)
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(m.body, color = if (m.mine) c.onPrimary else c.onSurface)
            m.createdAt?.let {
                Text(
                    PomTime.formatDateTime(it),
                    style = MaterialTheme.typography.labelSmall,
                    color = (if (m.mine) c.onPrimary else c.onSurfaceVariant).copy(alpha = 0.8f),
                )
            }
        }
    }
}
