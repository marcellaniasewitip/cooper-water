package com.cooperwaters.driver.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.ChatMessage
import com.cooperwaters.core.net.ChatSendRequest
import com.cooperwaters.core.net.DriverApi
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.core.realtime.RealtimeEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ChatUi(
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

/** Driver ↔ customer chat for one order: load, send, and refresh on realtime chat events. */
class ChatViewModel(
    private val api: DriverApi,
    realtime: Flow<RealtimeEvent>,
    private val orderId: String,
) : ViewModel() {
    private val _ui = MutableStateFlow(ChatUi())
    val ui: StateFlow<ChatUi> = _ui.asStateFlow()

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
