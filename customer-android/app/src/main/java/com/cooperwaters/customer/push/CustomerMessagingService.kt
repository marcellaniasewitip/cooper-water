package com.cooperwaters.customer.push

import android.Manifest
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.cooperwaters.customer.CustomerApp
import com.cooperwaters.customer.MainActivity
import com.cooperwaters.customer.R
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** FCM backup channel for order updates (only active when google-services.json is configured). */
class CustomerMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        (application as CustomerApp).container.registerPushToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val container = (application as CustomerApp).container
        container.onPush(message.data)
        val title = message.notification?.title ?: message.data["title"] ?: getString(R.string.app_name)
        val body = message.notification?.body ?: message.data["body"] ?: return
        val orderId = message.data["orderId"]
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (orderId != null) putExtra(MainActivity.EXTRA_ORDER_ID, orderId)
        }
        val pi = PendingIntent.getActivity(this, orderId.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(this, getString(R.string.notification_channel_orders_id))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED ||
            android.os.Build.VERSION.SDK_INT < 33
        ) {
            // A push message also arrives over the socket; the same id (broadcast id) keeps it to one notification.
            NotificationManagerCompat.from(this).notify((message.data["broadcastId"] ?: orderId ?: message.messageId ?: body).hashCode(), n)
        }
    }
}
