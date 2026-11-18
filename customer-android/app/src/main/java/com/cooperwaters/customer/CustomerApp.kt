package com.cooperwaters.customer

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.cooperwaters.core.android.ChatNotifications
import com.cooperwaters.core.realtime.RealtimeEvent
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch

class CustomerApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        createNotificationChannels()

        // Realtime while signed in (also in the background, so driver messages pop up); FCM push covers a closed app.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                container.foreground.value = true
            }

            override fun onStop(owner: LifecycleOwner) {
                container.foreground.value = false
            }
        })
        container.appScope.launch {
            container.loggedIn
                .collect { if (it) container.realtime.connect() else container.realtime.disconnect() }
        }
        // Push messages from the admin and chat messages from the driver arrive live over the socket: show them as notifications.
        container.appScope.launch {
            container.realtime.events.collect { e ->
                when (e) {
                    is RealtimeEvent.MessageReceived -> notifyMessage(e.id, e.title, e.body)
                    is RealtimeEvent.ChatMessageReceived -> if (!e.message.mine) notifyChat(e.orderId, e.shortCode, e.message.id, e.message.body)
                    else -> Unit
                }
            }
        }
        // Resend saved idempotent requests (same keys) whenever we're signed in and back online.
        container.appScope.launch {
            combine(container.connectivity.isOnline, container.loggedIn) { online, inSession -> online && inSession }
                .distinctUntilChanged()
                .filter { it }
                .collect {
                    container.repository.drainPending()
                    container.registerPushToken()
                }
        }
    }

    /** Admin push message. The id is the broadcast id, so the socket copy and an FCM copy share one notification. */
    fun notifyMessage(id: String, title: String, body: String) {
        val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pi = PendingIntent.getActivity(this, 3, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(this, getString(R.string.notification_channel_orders_id))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title.ifBlank { getString(R.string.app_name) })
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        try {
            NotificationManagerCompat.from(this).notify(id.hashCode(), n)
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS not granted.
        }
    }

    /** Driver chat message: heads-up banner; tapping it opens the chat. Shown once even if push and socket both deliver it. */
    fun notifyChat(orderId: String, shortCode: String, messageId: String?, body: String) {
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_CHAT_ORDER_ID, orderId)
        val pi = PendingIntent.getActivity(this, ChatNotifications.notificationId(orderId), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        ChatNotifications.show(
            this, orderId, messageId,
            title = getString(R.string.notification_chat_title, shortCode),
            body = body,
            smallIcon = R.drawable.ic_notification,
            tapIntent = pi,
            appInForeground = container.foreground.value,
        )
    }

    private fun createNotificationChannels() {
        ChatNotifications.createChannel(this, getString(R.string.notification_channel_chat), getString(R.string.notification_channel_chat_desc))
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                getString(R.string.notification_channel_orders_id),
                getString(R.string.notification_channel_orders),
                NotificationManager.IMPORTANCE_HIGH,
            ),
        )
    }
}
