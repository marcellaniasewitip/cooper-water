package com.cooperwaters.core

import com.cooperwaters.core.order.EtaFormat
import org.junit.Assert.assertEquals
import org.junit.Test

class EtaFormatTest {
    @Test fun minutesRoundUpAndUnderAMinuteIsZero() {
        assertEquals(0L, EtaFormat.minutes(30))
        assertEquals(1L, EtaFormat.minutes(50))
        assertEquals(2L, EtaFormat.minutes(111))
        assertEquals(13L, EtaFormat.minutes(754))
    }

    @Test fun distanceInMetresThenKilometres() {
        assertEquals("650 m", EtaFormat.distance(648))
        assertEquals("2.3 km", EtaFormat.distance(2310))
        assertEquals("1.0 km", EtaFormat.distance(1000))
    }
}
