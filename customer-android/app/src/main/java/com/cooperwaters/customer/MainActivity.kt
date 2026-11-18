package com.cooperwaters.customer

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import com.cooperwaters.core.android.ui.CooperWatersTheme
import com.cooperwaters.customer.ui.common.SplashScreen
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {
    /** Order to open, from a notification tap. */
    private val openOrder = MutableStateFlow<String?>(null)

    /** Chat to open, from a message notification tap. */
    private val openChat = MutableStateFlow<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        openOrder.value = intent?.getStringExtra(EXTRA_ORDER_ID)
        openChat.value = intent?.getStringExtra(EXTRA_CHAT_ORDER_ID)
        setContent {
            CooperWatersTheme {
                var splash by rememberSaveable { mutableStateOf(savedInstanceState == null) }
                LaunchedEffect(Unit) {
                    delay(SPLASH_MS)
                    splash = false
                }
                if (splash) SplashScreen() else CustomerNavHost(openOrder = openOrder, openChat = openChat)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(EXTRA_ORDER_ID)?.let { openOrder.value = it }
        intent.getStringExtra(EXTRA_CHAT_ORDER_ID)?.let { openChat.value = it }
    }

    companion object {
        const val EXTRA_ORDER_ID = "orderId"
        const val EXTRA_CHAT_ORDER_ID = "chatOrderId"
        private const val SPLASH_MS = 1_200L
    }
}
