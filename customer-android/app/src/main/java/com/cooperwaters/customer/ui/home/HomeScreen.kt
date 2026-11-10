package com.cooperwaters.customer.ui.home

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.AccountBox
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.CwBrandBlue
import com.cooperwaters.core.android.ui.CwIcons
import com.cooperwaters.core.android.ui.CwMap
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.Labels
import com.cooperwaters.core.android.ui.MapCenter
import com.cooperwaters.core.android.ui.MapMarker
import com.cooperwaters.core.android.ui.OfflineBanner
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.net.Order
import com.cooperwaters.core.net.SavedLocation
import com.cooperwaters.core.order.OrderStatus
import com.cooperwaters.core.realtime.RealtimeEvent
import com.cooperwaters.core.util.Geo
import com.cooperwaters.customer.BuildConfig
import com.cooperwaters.customer.R
import com.cooperwaters.customer.data.CustomerRepository
import com.cooperwaters.customer.ui.common.appContainer
import com.cooperwaters.customer.ui.common.containerViewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class HomeState(
    val loading: Boolean = true,
    val active: List<Order> = emptyList(),
    val recent: List<Order> = emptyList(),
    val fromCache: Boolean = false,
    val hasUnsentOrder: Boolean = false,
    /** Saved delivery places, shown on the map and as shortcuts under "Where to?". */
    val places: List<SavedLocation> = emptyList(),
    val error: UiText? = null,
)

class HomeViewModel(
    private val repo: CustomerRepository,
    realtime: Flow<RealtimeEvent>,
    pushes: Flow<Map<String, String>>,
) : ViewModel() {
    private val _state = MutableStateFlow(HomeState())
    val state: StateFlow<HomeState> = _state.asStateFlow()

    init {
        refresh()
        viewModelScope.launch { realtime.collect { if (it is RealtimeEvent.OrderUpdated) refresh() } }
        viewModelScope.launch { pushes.collect { refresh() } }
        viewModelScope.launch { repo.queue.pending.collect { p -> _state.update { it.copy(hasUnsentOrder = p.any { a -> a.type == CustomerRepository.TYPE_CREATE_ORDER }) } } }
    }

    fun refresh() {
        _state.update { it.copy(loading = true) }
        viewModelScope.launch {
            val loaded = repo.recentOrders()
            val orders = loaded.value?.items.orEmpty()
            val places = repo.locations().value
            _state.update {
                it.copy(
                    loading = false,
                    active = orders.filter { o -> !OrderStatus.isTerminal(o.status) },
                    recent = orders.filter { o -> OrderStatus.isTerminal(o.status) }.take(3),
                    fromCache = loaded.fromCache,
                    places = places ?: it.places,
                    error = if (loaded.value == null) loaded.error?.toUiText() else null,
                )
            }
        }
    }
}

/** Where the side menu and the Home shortcuts lead. */
class HomeActions(
    val onNewOrder: (locationId: String?) -> Unit,
    val onOpenOrder: (Order) -> Unit,
    val onOrders: () -> Unit,
    val onPlaces: () -> Unit,
    val onProfile: () -> Unit,
    val onSupport: () -> Unit,
    val onWallet: () -> Unit,
    val onOffers: () -> Unit,
    val onReferral: () -> Unit,
    val onInbox: () -> Unit,
    val onChats: () -> Unit,
)

/**
 * Home (StarTrip style): full-screen map with the menu button, and a white panel at the bottom with
 * "Where to deliver?", saved places and the service tiles. The side menu holds everything else.
 */
@Composable
fun HomeScreen(actions: HomeActions) {
    val vm = containerViewModel { c -> HomeViewModel(c.repository, c.realtime.events, c.pushEvents) }
    val state by vm.state.collectAsStateWithLifecycle()
    val container = appContainer()
    val online by container.connectivity.isOnline.collectAsStateWithLifecycle()
    val pending by container.queue.pending.collectAsStateWithLifecycle()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    val notifPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }

    fun closeThen(go: () -> Unit) {
        scope.launch { drawer.close() }
        go()
    }

    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet(drawerContainerColor = CwBrandBlue, drawerContentColor = Color.White, drawerShape = RoundedCornerShape(0.dp)) {
                DrawerContent(
                    onProfile = { closeThen(actions.onProfile) },
                    onOrderWater = { closeThen { actions.onNewOrder(null) } },
                    onOrders = { closeThen(actions.onOrders) },
                    onPlaces = { closeThen(actions.onPlaces) },
                    onSupport = { closeThen(actions.onSupport) },
                    onWallet = { closeThen(actions.onWallet) },
                    onOffers = { closeThen(actions.onOffers) },
                    onReferral = { closeThen(actions.onReferral) },
                    onInbox = { closeThen(actions.onInbox) },
                    onChats = { closeThen(actions.onChats) },
                    onSignOut = { closeThen { container.signOut() } },
                )
            }
        },
    ) {
        Box(Modifier.fillMaxSize()) {
            val first = state.places.firstOrNull()
            CwMap(
                modifier = Modifier.fillMaxSize(),
                center = MapCenter(first?.lat ?: Geo.POM_LAT, first?.lng ?: Geo.POM_LNG, if (first != null) 15.0 else 13.0),
                markers = state.places.map { MapMarker(it.id, it.lat, it.lng, it.label, MapMarker.Kind.DESTINATION) },
            )
            // Round floating buttons over the map, like StarTrip.
            Row(Modifier.fillMaxWidth().statusBarsPadding().padding(16.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                MapButton(Icons.Filled.Menu, stringResource(R.string.menu_open)) { scope.launch { drawer.open() } }
                MapButton(Icons.Filled.Refresh, stringResource(R.string.action_refresh), onClick = vm::refresh)
            }
            BottomPanel(
                state = state,
                offline = !online,
                pendingCount = pending.size,
                actions = actions,
                onRetry = vm::refresh,
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }
    }
}

@Composable
private fun MapButton(icon: ImageVector, label: String, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = CircleShape, color = MaterialTheme.colorScheme.surface, shadowElevation = 4.dp, modifier = Modifier.size(48.dp)) {
        Box(contentAlignment = Alignment.Center) { Icon(icon, contentDescription = label) }
    }
}

@Composable
private fun BottomPanel(
    state: HomeState,
    offline: Boolean,
    pendingCount: Int,
    actions: HomeActions,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp),
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 12.dp,
    ) {
        Column(
            Modifier.navigationBarsPadding().verticalScroll(rememberScrollState()).padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            OfflineBanner(offline = offline, pendingCount = pendingCount)
            Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                state.active.forEach { order -> ActiveOrderCard(order) { actions.onOpenOrder(order) } }
                if (state.hasUnsentOrder) {
                    Text(stringResource(R.string.home_unsent_order), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
                }
                ErrorCard(state.error, onRetry = onRetry)
                WhereToBar { actions.onNewOrder(null) }
            }
            state.places.take(2).forEach { place ->
                PlaceRow(place) { actions.onNewOrder(place.id) }
                HorizontalDivider(Modifier.padding(start = 56.dp, end = 16.dp))
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                ServiceTile(stringResource(R.string.home_tile_delivery), CwIcons.WaterDrop, selected = true, modifier = Modifier.weight(1f)) { actions.onNewOrder(null) }
                ServiceTile(stringResource(R.string.home_tile_orders), Icons.Filled.List, selected = false, modifier = Modifier.weight(1f), onClick = actions.onOrders)
            }
        }
    }
}

/** Search-style bar: tapping starts an order (StarTrip "Where to?"). */
@Composable
private fun WhereToBar(onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.home_where_to), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primary, modifier = Modifier.size(40.dp)) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(CwIcons.WaterDrop, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(20.dp))
                }
            }
        }
    }
}

@Composable
private fun PlaceRow(place: SavedLocation, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(CwIcons.Clock, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(18.dp))
        Column(Modifier.weight(1f)) {
            Text(place.label, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(place.addressText, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
    }
}

/** Service tile: black when selected (StarTrip "On Demand"), white with a border otherwise. */
@Composable
private fun ServiceTile(label: String, icon: ImageVector, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val c = MaterialTheme.colorScheme
    Card(
        onClick = onClick,
        modifier = modifier.height(84.dp),
        shape = RoundedCornerShape(10.dp),
        colors = CardDefaults.cardColors(containerColor = if (selected) c.primary else c.surface, contentColor = if (selected) c.onPrimary else c.onSurface),
        border = if (selected) null else BorderStroke(1.dp, c.outlineVariant),
    ) {
        Column(Modifier.fillMaxSize().padding(10.dp), verticalArrangement = Arrangement.SpaceBetween) {
            Icon(icon, contentDescription = null, tint = if (selected) Color(0xFF4FC3F7) else Color(0xFF29B6F6), modifier = Modifier.size(28.dp).align(Alignment.End))
            Text(label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun ActiveOrderCard(order: Order, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer, contentColor = MaterialTheme.colorScheme.onSecondaryContainer),
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.home_active_order, order.shortCode), fontWeight = FontWeight.SemiBold)
                Text(stringResource(Labels.status(order.status)), style = MaterialTheme.typography.bodyMedium)
            }
            Text(stringResource(if (order.status == OrderStatus.PENDING_PAYMENT) R.string.home_active_pay else R.string.home_active_track), fontWeight = FontWeight.SemiBold)
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
        }
    }
}

/** Side menu in the brand blue (same as the driver app): avatar, name and phone (opens Profile), then the menu list. */
@Composable
private fun DrawerContent(
    onProfile: () -> Unit,
    onOrderWater: () -> Unit,
    onOrders: () -> Unit,
    onPlaces: () -> Unit,
    onSupport: () -> Unit,
    onWallet: () -> Unit,
    onOffers: () -> Unit,
    onReferral: () -> Unit,
    onInbox: () -> Unit,
    onChats: () -> Unit,
    onSignOut: () -> Unit,
) {
    val user = appContainer().tokenStore.user()
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onProfile).statusBarsPadding().padding(horizontal = 16.dp, vertical = 24.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(64.dp).clip(CircleShape).background(Color.White), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.Person, contentDescription = null, tint = CwBrandBlue, modifier = Modifier.size(40.dp))
            }
            Spacer(Modifier.width(16.dp))
            Column(Modifier.weight(1f)) {
                Text(user?.name?.takeIf { it.isNotBlank() } ?: stringResource(R.string.profile_title), color = Color.White, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text(user?.phone.orEmpty(), color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.bodyMedium)
            }
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = Color.White)
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
            DrawerItem(CwIcons.WaterDrop, stringResource(R.string.menu_order_water), onOrderWater)
            DrawerItem(Icons.Filled.List, stringResource(R.string.menu_orders), onOrders)
            DrawerItem(Icons.Filled.AccountBox, stringResource(R.string.menu_wallet), onWallet)
            DrawerItem(Icons.Filled.Star, stringResource(R.string.menu_offers), onOffers)
            DrawerItem(Icons.Filled.Favorite, stringResource(R.string.menu_referral), onReferral)
            DrawerItem(Icons.Filled.Notifications, stringResource(R.string.menu_inbox), onInbox)
            DrawerItem(Icons.AutoMirrored.Filled.Send, stringResource(R.string.menu_chat), onChats)
            DrawerItem(Icons.Filled.LocationOn, stringResource(R.string.menu_places), onPlaces)
            DrawerItem(Icons.Filled.Person, stringResource(R.string.profile_title), onProfile)
            DrawerItem(Icons.Filled.Email, stringResource(R.string.menu_support), onSupport)
            HorizontalDivider(Modifier.padding(vertical = 8.dp), color = Color.White.copy(alpha = 0.25f))
            DrawerItem(Icons.AutoMirrored.Filled.ExitToApp, stringResource(R.string.profile_sign_out), onSignOut)
        }
        Text(
            stringResource(R.string.app_version, BuildConfig.VERSION_NAME, BuildConfig.GIT_SHA),
            style = MaterialTheme.typography.bodySmall,
            color = Color.White.copy(alpha = 0.7f),
            modifier = Modifier.navigationBarsPadding().padding(16.dp),
        )
    }
}

@Composable
private fun DrawerItem(icon: ImageVector, label: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(18.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge, color = Color.White)
    }
}
