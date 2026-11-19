package com.cooperwaters.core.order

import kotlin.math.ceil
import kotlin.math.roundToLong

/** Turning an ETA into what people read: whole minutes (rounded up) and a short distance. */
object EtaFormat {
    /** Minutes to show; 0 means "less than a minute". */
    fun minutes(etaSec: Long): Long = if (etaSec < 45) 0 else ceil(etaSec / 60.0).toLong()

    /** "650 m" under a kilometre, else "2.3 km". */
    fun distance(distanceM: Long): String =
        if (distanceM < 1000) "${(distanceM / 10.0).roundToLong() * 10} m" else String.format(java.util.Locale.ENGLISH, "%.1f km", distanceM / 1000.0)
}
