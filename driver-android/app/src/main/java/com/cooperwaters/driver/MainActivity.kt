package com.cooperwaters.driver

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.cooperwaters.core.android.ui.CooperWatersTheme
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {
    /** Chat to open, from a message notification tap. */
    private val openChat = MutableStateFlow<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        openChat.value = intent?.getStringExtra(EXTRA_CHAT_ORDER_ID)
        setContent {
            CooperWatersTheme {
                DriverNavHost(openChat = openChat)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(EXTRA_CHAT_ORDER_ID)?.let { openChat.value = it }
    }

    companion object {
        const val EXTRA_CHAT_ORDER_ID = "chatOrderId"
    }
}
