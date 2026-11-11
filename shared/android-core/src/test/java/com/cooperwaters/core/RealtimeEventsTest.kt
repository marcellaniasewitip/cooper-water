package com.cooperwaters.core

import com.cooperwaters.core.realtime.RealtimeEvent
import com.cooperwaters.core.realtime.RealtimeEvents
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RealtimeEventsTest {
    @Test fun parsesPartialOrderUpdate() {
        val e = RealtimeEvents.parse("order.updated", """{"order":{"id":"o1","shortCode":"CW-1","status":"CANCELLED"}}""")
        assertTrue(e is RealtimeEvent.OrderUpdated)
        assertEquals("CANCELLED", (e as RealtimeEvent.OrderUpdated).order.status)
    }

    @Test fun parsesAdminPushMessage() {
        val e = RealtimeEvents.parse("notification.message", """{"broadcastId":"b1","title":"Depot closed","body":"Gordons is closed today."}""")
        assertEquals(RealtimeEvent.MessageReceived("b1", "Depot closed", "Gordons is closed today."), e)
    }

    @Test fun parsesOfferAndWallet() {
        val offer = RealtimeEvents.parse("order.offer", """{"offer":{"offerId":"f","orderId":"o","shortCode":"CW-2","package":"Small tank","volumeLitres":2000,"quantity":2,"distanceM":1234.5,"earningsToea":14400,"priceToea":16000,"expiresAt":"2026-10-16T06:00:00.000Z","delivery":{"lat":-9.4,"lng":147.1,"address":"Boroko","notes":"Blue gate"}}}""")
        assertEquals(14400L, (offer as RealtimeEvent.OfferReceived).offer.earningsToea)
        val w = RealtimeEvents.parse("wallet.updated", """{"balanceToea":1200,"minBalanceToea":5000,"blocked":true}""")
        assertEquals(true, (w as RealtimeEvent.WalletUpdated).update.blocked)
        val loc = RealtimeEvents.parse("order.driver_location", """{"orderId":"o","lat":-9.44,"lng":147.18,"at":"2026-10-16T06:00:00.000Z"}""")
        assertEquals(-9.44, (loc as RealtimeEvent.DriverLocationChanged).lat, 0.0)
        val rev = RealtimeEvents.parse("order.offer_revoked", """{"orderId":"o","reason":"taken"}""")
        assertEquals("taken", (rev as RealtimeEvent.OfferRevoked).reason)
    }

    @Test fun ignoresUnknownAndMalformed() {
        assertNull(RealtimeEvents.parse("fleet.driver_location", "{}"))
        assertNull(RealtimeEvents.parse("order.updated", "not json"))
    }
}
