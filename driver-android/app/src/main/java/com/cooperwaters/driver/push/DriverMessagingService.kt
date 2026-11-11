package com.cooperwaters.driver.push

import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.cooperwaters.driver.DriverApp
import com.cooperwaters.driver.MainActivity
import com.cooperwaters.driver.R
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** FCM backup channel for offers / job updates / wallet (only active with google-services.json). */
class DriverMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        (application as DriverApp).container.registerPushToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val container = (application as DriverApp).container
        container.onPush(message.data)
        val title = message.notification?.title ?: message.data["title"] ?: getString(R.string.app_name)
        val body = message.notification?.body ?: message.data["body"] ?: return
        val isOffer = message.data["template"]?.contains("offer") == true || message.data.containsKey("earnings")
        val channel = getString(if (isOffer) R.string.notification_channel_offers_id else R.string.notification_channel_jobs_id)
        // Ring like a call for offers; the notification itself then stays silent so the tone doesn't play twice.
        val app = application as DriverApp
        if (isOffer && container.state.activeOrder.value == null) app.offerAlarm.start()
        val pi = PendingIntent.getActivity(
            this, 2, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(if (isOffer) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setSilent(isOffer && app.offerAlarm.isRinging)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        try {
            // A push message also arrives over the socket; the same id (broadcast id) keeps it to one notification.
            NotificationManagerCompat.from(this).notify((message.data["broadcastId"] ?: message.messageId ?: body).hashCode(), n)
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS not granted
        }
    }
}
