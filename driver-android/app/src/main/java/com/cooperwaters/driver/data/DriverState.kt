package com.cooperwaters.driver.data

import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.DriverConfig
import com.cooperwaters.core.net.DriverProfile
import com.cooperwaters.core.net.Offer
import com.cooperwaters.core.net.Order
import com.cooperwaters.core.net.WalletBrief
import com.cooperwaters.core.order.OrderStatus
import com.cooperwaters.core.realtime.RealtimeEvent
import com.cooperwaters.core.time.PomTime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant

/**
 * Process-wide driver state shared by the UI and the location service: profile/online flag, wallet
 * (blocked banner), open offers and the active job. Fed by REST snapshots and socket events.
 */
class DriverState(
    private val repo: DriverRepository,
    realtime: Flow<RealtimeEvent>,
    scope: CoroutineScope,
    private val now: () -> Instant = { Instant.now() },
) {
    private val _profile = MutableStateFlow<DriverProfile?>(null)
    val profile: StateFlow<DriverProfile?> = _profile.asStateFlow()

    private val _config = MutableStateFlow<DriverConfig?>(null)
    val config: StateFlow<DriverConfig?> = _config.asStateFlow()

    private val _wallet = MutableStateFlow<WalletBrief?>(null)
    val wallet: StateFlow<WalletBrief?> = _wallet.asStateFlow()

    private val _offers = MutableStateFlow<List<Offer>>(emptyList())
    val offers: StateFlow<List<Offer>> = _offers.asStateFlow()

    private val _activeOrder = MutableStateFlow<Order?>(null)
    val activeOrder: StateFlow<Order?> = _activeOrder.asStateFlow()

    /** New offer ids pushed by the socket (for an alert sound / heads-up notification). */
    private val _newOffers = MutableStateFlow<Offer?>(null)
    val latestNewOffer: StateFlow<Offer?> = _newOffers.asStateFlow()

    init {
        scope.launch { realtime.collect { handle(it) } }
    }

    fun handle(e: RealtimeEvent) {
        when (e) {
            is RealtimeEvent.OfferReceived -> {
                _offers.update { list -> (list.filterNot { it.orderId == e.offer.orderId } + e.offer).let(::pruneExpired) }
                _newOffers.value = e.offer
            }
            is RealtimeEvent.OfferRevoked -> removeOffer(e.orderId)
            is RealtimeEvent.WalletUpdated -> _wallet.update { w ->
                val min = e.update.minBalanceToea ?: w?.minBalanceToea ?: 0
                WalletBrief(e.update.balanceToea, min, e.update.blocked ?: (e.update.balanceToea < min))
            }
            is RealtimeEvent.OrderUpdated -> {
                val o = e.order
                val current = _activeOrder.value
                if (current != null && current.id == o.id) {
                    val merged = if (o.delivery == null) current.copy(status = o.status) else o
                    _activeOrder.value = merged.takeUnless { OrderStatus.isTerminal(it.status) }
                } else if (o.status in OrderStatus.ACTIVE_DRIVER && o.delivery != null) {
                    _activeOrder.value = o
                }
                if (o.status != OrderStatus.SEARCHING) removeOffer(o.id)
            }
            is RealtimeEvent.DriverLocationChanged -> Unit
            is RealtimeEvent.ChatMessageReceived -> Unit // handled by the chat screen
        }
    }

    fun setProfile(p: DriverProfile) {
        _profile.value = p
        _wallet.value = p.wallet
    }

    fun setOnline(online: Boolean) = _profile.update { it?.copy(online = online) }

    fun setActiveOrder(o: Order?) {
        _activeOrder.value = o?.takeUnless { OrderStatus.isTerminal(it.status) }
        if (o != null) removeOffer(o.id)
    }

    fun setWallet(w: WalletBrief) {
        _wallet.value = w
    }

    fun removeOffer(orderId: String) = _offers.update { list -> list.filterNot { it.orderId == orderId } }

    fun pruneExpiredOffers() = _offers.update(::pruneExpired)

    private fun pruneExpired(list: List<Offer>): List<Offer> =
        list.filter { o -> (PomTime.secondsUntil(o.expiresAt, now()) ?: 1) > 0 }

    suspend fun refreshProfile(): DriverProfile? {
        val p = repo.profile()
        p.value?.let(::setProfile)
        return p.value
    }

    suspend fun refreshConfig() {
        repo.config().value?.let { _config.value = it }
    }

    suspend fun refreshOffers() {
        val r = repo.offers()
        if (r is ApiResult.Success) {
            val known = _offers.value.map { it.orderId }.toSet()
            val fresh = pruneExpired(r.value)
            _offers.value = fresh
            // An offer picked up by polling (socket was down) alerts the driver just like a pushed one.
            fresh.lastOrNull { it.orderId !in known }?.let { _newOffers.value = it }
        }
    }

    suspend fun refreshActive() {
        val a = repo.activeOrder()
        if (!a.fromCache || _activeOrder.value == null) setActiveOrder(a.value)
    }

    suspend fun refreshAll() {
        refreshConfig()
        refreshProfile()
        refreshActive()
        if (_profile.value?.online == true) refreshOffers()
    }
}
