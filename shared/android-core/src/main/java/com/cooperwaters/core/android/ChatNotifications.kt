package com.cooperwaters.core.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * Heads-up notifications for in-app chat messages (customer ↔ driver), shared by both apps.
 *
 * The same message can arrive twice (live socket and FCM push); it is shown once. Each order has one
 * notification that is updated with the newest message. Nothing is shown while that chat is on screen.
 */
object ChatNotifications {
    const val CHANNEL_ID = "chat_messages"

    /** Order whose chat screen is showing right now (null when none). */
    val openChatOrderId = MutableStateFlow<String?>(null)

    private val shown = LinkedHashSet<String>()

    fun createChannel(context: Context, name: String, description: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_HIGH).apply {
                this.description = description
                enableVibration(true)
            },
        )
    }

    /**
     * @param appInForeground whether the app is visible; with the chat open in the foreground nothing is shown.
     * @param messageId dedupes the socket and push copies of one message (null = always show).
     */
    @Synchronized
    fun show(
        context: Context,
        orderId: String,
        messageId: String?,
        title: String,
        body: String,
        smallIcon: Int,
        tapIntent: PendingIntent,
        appInForeground: Boolean,
    ): Boolean {
        if (appInForeground && openChatOrderId.value == orderId) return false
        if (messageId != null) {
            if (!shown.add(messageId)) return false
            while (shown.size > 200) shown.remove(shown.first())
        }
        val n = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(smallIcon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setContentIntent(tapIntent)
            .build()
        return try {
            NotificationManagerCompat.from(context).notify(notificationId(orderId), n)
            true
        } catch (e: SecurityException) {
            false // POST_NOTIFICATIONS not granted
        }
    }

    /** Clear an order's chat notification (its chat was opened). */
    fun clear(context: Context, orderId: String) {
        NotificationManagerCompat.from(context).cancel(notificationId(orderId))
    }

    fun notificationId(orderId: String): Int = "chat:$orderId".hashCode()
}

/** Call from a chat screen: marks it open (no banners for it) and clears its notification. */
@Composable
fun TrackOpenChat(context: Context, orderId: String) {
    DisposableEffect(orderId) {
        ChatNotifications.openChatOrderId.value = orderId
        ChatNotifications.clear(context, orderId)
        onDispose {
            if (ChatNotifications.openChatOrderId.value == orderId) ChatNotifications.openChatOrderId.value = null
        }
    }
}
