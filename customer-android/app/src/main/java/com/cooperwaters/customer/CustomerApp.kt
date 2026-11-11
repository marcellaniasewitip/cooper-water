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

        // Realtime only while the app is visible; FCM push is the backup channel in the background.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                container.foreground.value = true
            }

            override fun onStop(owner: LifecycleOwner) {
                container.foreground.value = false
            }
        })
        container.appScope.launch {
            combine(container.foreground, container.loggedIn) { fg, inSession -> fg && inSession }
                .distinctUntilChanged()
                .collect { if (it) container.realtime.connect() else container.realtime.disconnect() }
        }
        // Push messages from the admin arrive live over the socket while the app is open: show them as notifications.
        container.appScope.launch {
            container.realtime.events.collect { e -> if (e is RealtimeEvent.MessageReceived) notifyMessage(e.id, e.title, e.body) }
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

    private fun createNotificationChannels() {
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
