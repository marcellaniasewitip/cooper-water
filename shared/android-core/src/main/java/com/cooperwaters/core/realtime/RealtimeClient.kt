package com.cooperwaters.core.realtime

import com.cooperwaters.core.net.ChatMessage
import com.cooperwaters.core.net.CwJson
import com.cooperwaters.core.net.Offer
import com.cooperwaters.core.net.Order
import com.cooperwaters.core.net.WalletUpdate
import com.cooperwaters.core.util.CrashReporter
import io.socket.client.IO
import io.socket.client.Socket
import io.socket.engineio.client.transports.WebSocket
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.URI
import java.util.concurrent.ConcurrentHashMap

/** Server → client events (backend/src/realtime/realtime.gateway.ts). */
sealed interface RealtimeEvent {
    data class OrderUpdated(val order: Order) : RealtimeEvent
    data class DriverLocationChanged(val orderId: String, val lat: Double, val lng: Double, val at: String?) : RealtimeEvent
    data class OfferReceived(val offer: Offer) : RealtimeEvent
    data class OfferRevoked(val orderId: String, val reason: String?) : RealtimeEvent
    data class WalletUpdated(val update: WalletUpdate) : RealtimeEvent
    data class ChatMessageReceived(val orderId: String, val shortCode: String, val message: ChatMessage) : RealtimeEvent

    /** A push message from Cooper Waters (admin → Push messages). */
    data class MessageReceived(val id: String, val title: String, val body: String) : RealtimeEvent
}

object RealtimeEvents {
    const val ORDER_UPDATED = "order.updated"
    const val ORDER_DRIVER_LOCATION = "order.driver_location"
    const val ORDER_OFFER = "order.offer"
    const val ORDER_OFFER_REVOKED = "order.offer_revoked"
    const val WALLET_UPDATED = "wallet.updated"
    const val DRIVER_LOCATION = "driver.location"
    const val CHAT_MESSAGE = "chat.message"
    const val NOTIFICATION_MESSAGE = "notification.message"

    val ALL = listOf(ORDER_UPDATED, ORDER_DRIVER_LOCATION, ORDER_OFFER, ORDER_OFFER_REVOKED, WALLET_UPDATED, CHAT_MESSAGE, NOTIFICATION_MESSAGE)

    @Serializable private data class OrderWrap(val order: Order)
    @Serializable private data class OfferWrap(val offer: Offer)
    @Serializable private data class LocationMsg(val orderId: String, val lat: Double, val lng: Double, val at: String? = null)
    @Serializable private data class RevokedMsg(val orderId: String, val reason: String? = null)
    @Serializable private data class ChatMsg(val orderId: String, val shortCode: String = "", val message: ChatMessage)
    @Serializable private data class BroadcastMsg(val broadcastId: String, val title: String = "", val body: String = "")

    /** Parse one event's JSON payload; null for unknown events or malformed payloads. */
    fun parse(event: String, payloadJson: String, json: Json = CwJson): RealtimeEvent? = try {
        when (event) {
            ORDER_UPDATED -> RealtimeEvent.OrderUpdated(json.decodeFromString(OrderWrap.serializer(), payloadJson).order)
            ORDER_DRIVER_LOCATION -> json.decodeFromString(LocationMsg.serializer(), payloadJson)
                .let { RealtimeEvent.DriverLocationChanged(it.orderId, it.lat, it.lng, it.at) }
            ORDER_OFFER -> RealtimeEvent.OfferReceived(json.decodeFromString(OfferWrap.serializer(), payloadJson).offer)
            ORDER_OFFER_REVOKED -> json.decodeFromString(RevokedMsg.serializer(), payloadJson)
                .let { RealtimeEvent.OfferRevoked(it.orderId, it.reason) }
            WALLET_UPDATED -> RealtimeEvent.WalletUpdated(json.decodeFromString(WalletUpdate.serializer(), payloadJson))
            CHAT_MESSAGE -> json.decodeFromString(ChatMsg.serializer(), payloadJson).let { RealtimeEvent.ChatMessageReceived(it.orderId, it.shortCode, it.message) }
            NOTIFICATION_MESSAGE -> json.decodeFromString(BroadcastMsg.serializer(), payloadJson).let { RealtimeEvent.MessageReceived(it.broadcastId, it.title, it.body) }
            else -> null
        }
    } catch (e: Exception) {
        null
    }
}

/**
 * Socket.IO client for `<base>/realtime` with `auth: { token }`.
 * Reconnects automatically; when the server rejects the token it refreshes it (single-flight via
 * [refreshToken]) and reconnects. Push notifications remain the backup channel while disconnected.
 */
class RealtimeClient(
    private val url: String,
    private val accessToken: () -> String?,
    private val refreshToken: suspend (failed: String?) -> String?,
    private val scope: CoroutineScope,
    private val crashReporter: CrashReporter = CrashReporter.NoOp,
) {
    private val _events = MutableSharedFlow<RealtimeEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<RealtimeEvent> = _events.asSharedFlow()

    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    /** Mutable so a refreshed token is used on the next (re)connect handshake. */
    private val auth: MutableMap<String, String> = ConcurrentHashMap()
    private var socket: Socket? = null
    private var authRetryJob: Job? = null

    @Synchronized
    fun connect() {
        val token = accessToken() ?: return
        auth["token"] = token
        val existing = socket
        if (existing != null) {
            if (!existing.connected()) existing.connect()
            return
        }
        val options = IO.Options.builder()
            .setAuth(auth)
            .setTransports(arrayOf(WebSocket.NAME))
            .setReconnection(true)
            .setReconnectionDelay(2_000)
            .setReconnectionDelayMax(30_000)
            .setTimeout(20_000)
            .build()
        val s = try {
            IO.socket(URI.create(url), options)
        } catch (e: Exception) {
            crashReporter.recordException(e, mapOf("where" to "socket_create"))
            return
        }
        s.on(Socket.EVENT_CONNECT) { _connected.value = true }
        s.on(Socket.EVENT_DISCONNECT) { _connected.value = false }
        s.on(Socket.EVENT_CONNECT_ERROR) {
            _connected.value = false
            onAuthProblem()
        }
        // Gateway emits `error {code:'unauthorized'}` then disconnects when the token is bad/expired.
        s.on("error") { args ->
            if (args.firstOrNull()?.toString()?.contains("unauthorized") == true) onAuthProblem()
        }
        for (name in RealtimeEvents.ALL) {
            s.on(name) { args ->
                val payload = args.firstOrNull()?.toString() ?: return@on
                RealtimeEvents.parse(name, payload)?.let { _events.tryEmit(it) }
            }
        }
        socket = s
        s.connect()
    }

    @Synchronized
    fun disconnect() {
        authRetryJob?.cancel()
        socket?.off()
        socket?.disconnect()
        socket = null
        _connected.value = false
    }

    /** Driver app: same as POST /driver/location for a single fix. */
    fun emitDriverLocation(lat: Double, lng: Double) {
        val s = socket ?: return
        if (!s.connected()) return
        try {
            s.emit(RealtimeEvents.DRIVER_LOCATION, org.json.JSONObject().put("lat", lat).put("lng", lng))
        } catch (e: Exception) {
            crashReporter.recordException(e, mapOf("where" to "socket_emit"))
        }
    }

    private fun onAuthProblem() {
        if (authRetryJob?.isActive == true) return
        authRetryJob = scope.launch {
            val current = auth["token"]
            val stored = accessToken()
            val fresh = if (stored != null && stored != current) stored else refreshToken(current)
            if (fresh != null && fresh != current) {
                auth["token"] = fresh
                delay(500)
                synchronized(this@RealtimeClient) {
                    socket?.let { if (!it.connected()) it.connect() }
                }
            } else if (fresh == null) {
                // Offline or session over: let socket.io's own reconnection keep trying; push covers us.
                delay(10_000)
            }
        }
    }
}
