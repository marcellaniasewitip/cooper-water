package com.cooperwaters.core.android

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri

object Intents {
    /**
     * Turn-by-turn driving directions in Google Maps, starting straight away. Falls back to any app that handles
     * navigation, then Google Maps directions in the browser, then a plain map pin.
     */
    fun navigateTo(context: Context, lat: Double, lng: Double, label: String?): Boolean {
        val nav = "google.navigation:q=$lat,$lng&mode=d"
        val candidates = listOf(
            Intent(Intent.ACTION_VIEW, Uri.parse(nav)).setPackage(GOOGLE_MAPS),
            Intent(Intent.ACTION_VIEW, Uri.parse(nav)),
            Intent(Intent.ACTION_VIEW, Uri.parse("https://www.google.com/maps/dir/?api=1&destination=$lat,$lng&travelmode=driving&dir_action=navigate")),
            Intent(Intent.ACTION_VIEW, Uri.parse("geo:$lat,$lng?q=$lat,$lng(${Uri.encode(label ?: "")})")),
        )
        for (i in candidates) {
            try {
                context.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return true
            } catch (e: ActivityNotFoundException) {
                // try next
            }
        }
        return false
    }

    private const val GOOGLE_MAPS = "com.google.android.apps.maps"

    fun dial(context: Context, phone: String): Boolean = try {
        context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (e: ActivityNotFoundException) {
        false
    }
}
