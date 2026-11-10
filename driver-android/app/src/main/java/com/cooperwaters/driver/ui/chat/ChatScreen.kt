package com.cooperwaters.driver.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.net.ChatMessage
import com.cooperwaters.core.time.PomTime
import com.cooperwaters.driver.R
import com.cooperwaters.driver.ui.common.ScreenScaffold
import com.cooperwaters.driver.ui.common.containerViewModel

/** Chat with the customer for one job (StarTrip-style bubbles). */
@Composable
fun ChatScreen(orderId: String, onBack: () -> Unit) {
    val vm = containerViewModel(key = "chat-$orderId") { c -> ChatViewModel(c.repository.api, c.realtime.events, orderId) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()
    LaunchedEffect(ui.messages.size) { if (ui.messages.isNotEmpty()) listState.animateScrollToItem(ui.messages.size - 1) }

    ScreenScaffold(
        title = if (ui.shortCode.isBlank()) stringResource(R.string.chat_title) else stringResource(R.string.chat_title_order, ui.shortCode),
        onBack = onBack,
    ) {
        if (ui.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        ErrorCard(ui.error, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), onDismiss = vm::clearError)
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (!ui.loading && ui.messages.isEmpty()) {
                item { Text(stringResource(R.string.chat_empty, ui.otherName), color = MaterialTheme.colorScheme.onSurfaceVariant) }
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
