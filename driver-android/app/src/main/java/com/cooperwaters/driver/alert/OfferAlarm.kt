package com.cooperwaters.driver.alert

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.cooperwaters.driver.R

/**
 * Rings like a ride-hailing app when a new job offer arrives: the "ding-ding-dong" tone loops and the
 * phone vibrates until the driver accepts or declines, the offer is taken/expired, or [MAX_RING_MS]
 * passes. Plays on the ringtone stream so it is heard even with the app in the background (the
 * location service keeps the process alive while the driver is online).
 */
class OfferAlarm(context: Context) {
    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null
    private val autoStop = Runnable { stop() }

    /** Set as soon as start()/stop() is called (playback itself starts on the main thread). */
    @Volatile
    var isRinging: Boolean = false
        private set

    fun start() {
        isRinging = true
        main.post(::startOnMain)
    }

    fun stop() {
        isRinging = false
        main.post(::stopOnMain)
    }

    private fun startOnMain() {
        main.removeCallbacks(autoStop)
        main.postDelayed(autoStop, MAX_RING_MS)
        if (player != null) return // already ringing: just extend
        player = try {
            MediaPlayer.create(
                appContext,
                R.raw.offer_alert,
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
                AudioManager.AUDIO_SESSION_ID_GENERATE,
            )?.apply {
                isLooping = true
                start()
            }
        } catch (e: Exception) {
            null // never crash the app over a sound
        }
        vibrate()
    }

    private fun stopOnMain() {
        main.removeCallbacks(autoStop)
        player?.let {
            try {
                it.stop()
            } catch (_: IllegalStateException) {
            }
            it.release()
        }
        player = null
        vibrator()?.cancel()
    }

    private fun vibrate() {
        val v = vibrator() ?: return
        if (!v.hasVibrator()) return
        // Buzz in time with the chime, repeating until stop().
        val pattern = longArrayOf(0, 180, 70, 180, 70, 450, 650)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createWaveform(pattern, 0))
            } else {
                @Suppress("DEPRECATION")
                v.vibrate(pattern, 0)
            }
        } catch (_: Exception) {
        }
    }

    private fun vibrator(): Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        appContext.getSystemService(VibratorManager::class.java)?.defaultVibrator
    } else {
        @Suppress("DEPRECATION")
        appContext.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }

    companion object {
        /** Offers last a dispatch round (~30–60 s); stop ringing after this even if nobody answers. */
        const val MAX_RING_MS = 45_000L
    }
}
