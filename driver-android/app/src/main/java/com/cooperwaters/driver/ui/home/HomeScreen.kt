package com.cooperwaters.driver.ui.home

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cooperwaters.core.android.LocationHelper
import com.cooperwaters.core.android.ui.CwBrandBlue
import com.cooperwaters.core.android.ui.CwIcons
import com.cooperwaters.core.android.ui.CwMap
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.Labels
import com.cooperwaters.core.android.ui.MapCenter
import com.cooperwaters.core.android.ui.MapMarker
import com.cooperwaters.core.android.ui.OfflineBanner
import com.cooperwaters.core.android.ui.rememberCountdown
import com.cooperwaters.core.money.Money
import com.cooperwaters.core.net.DriverProfile
import com.cooperwaters.core.net.Offer
import com.cooperwaters.core.net.Order
import com.cooperwaters.core.net.WalletBrief
import com.cooperwaters.core.time.PomTime
import com.cooperwaters.core.util.Geo
import com.cooperwaters.driver.BuildConfig
import com.cooperwaters.driver.R
import com.cooperwaters.driver.ui.common.appContainer
import com.cooperwaters.driver.ui.common.containerViewModel
import kotlinx.coroutines.launch

/** Where the side menu and the Home shortcuts lead. */
class HomeActions(
    val onOpenJob: (String) -> Unit,
    val onTopup: () -> Unit,
    val onLiveRequests: () -> Unit,
    val onEarnings: () -> Unit,
    val onWallet: () -> Unit,
    val onHistory: () -> Unit,
    val onMessages: () -> Unit,
    val onProfile: () -> Unit,
    val onSupport: () -> Unit,
)

/**
 * Home (StarTrip driver style): full-screen map under a white bar with the menu button, ONLINE/OFFLINE
 * title and the requests bell; a white panel at the bottom with offers or the current job and the big
 * GO ONLINE / GO OFFLINE button. Everything else lives in the coloured side menu.
 */
@Composable
fun HomeScreen(actions: HomeActions) {
    val vm = containerViewModel { c -> HomeViewModel(c.repository, c.state) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    val profile by vm.driverState.profile.collectAsStateWithLifecycle()
    val wallet by vm.driverState.wallet.collectAsStateWithLifecycle()
    val offers by vm.driverState.offers.collectAsStateWithLifecycle()
    val active by vm.driverState.activeOrder.collectAsStateWithLifecycle()
    val container = appContainer()
    val connected by container.connectivity.isOnline.collectAsStateWithLifecycle()
    val pending by container.queue.pending.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val drawer = rememberDrawerState(DrawerValue.Closed)

    LaunchedEffect(ui.acceptedOrderId) {
        ui.acceptedOrderId?.let {
            vm.consumeAccepted()
            actions.onOpenJob(it)
        }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }
    val notif = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) { if (Build.VERSION.SDK_INT >= 33) notif.launch(Manifest.permission.POST_NOTIFICATIONS) }

    fun locateAndGoOnline() {
        vm.startToggling()
        scope.launch {
            val loc = LocationHelper.currentLocation(context)
            if (loc == null) {
                vm.locationUnavailable()
            } else {
                vm.onMyLocation(loc.latitude, loc.longitude)
                vm.goOnline(loc.latitude, loc.longitude)
            }
        }
    }
    val onlinePermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted.values.any { it }) locateAndGoOnline() else vm.locationUnavailable()
    }
    fun locateMe() {
        scope.launch { LocationHelper.currentLocation(context)?.let { vm.onMyLocation(it.latitude, it.longitude) } }
    }
    val locatePermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted.values.any { it }) locateMe()
    }
    LaunchedEffect(Unit) {
        if (LocationHelper.hasPermission(context)) LocationHelper.lastKnown(context, Long.MAX_VALUE)?.let { vm.onMyLocation(it.latitude, it.longitude) }
    }

    val online = profile?.online == true
    fun toggle(wantOnline: Boolean) {
        when {
            !wantOnline -> vm.goOffline()
            LocationHelper.hasPermission(context) -> locateAndGoOnline()
            else -> onlinePermission.launch(LocationHelper.PERMISSIONS)
        }
    }
    fun closeThen(go: () -> Unit) {
        scope.launch { drawer.close() }
        go()
    }

    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet(
                drawerContainerColor = CwBrandBlue,
                drawerContentColor = Color.White,
                drawerShape = RoundedCornerShape(0.dp),
            ) {
                DrawerContent(
                    profile = profile,
                    wallet = wallet,
                    online = online,
                    toggling = ui.togglingOnline,
                    onToggle = ::toggle,
                    actions = actions,
                    close = ::closeThen,
                    onSignOut = { closeThen { container.signOut() } },
                )
            }
        },
    ) {
        Box(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize()) {
                TopBar(
                    online = online,
                    offerCount = offers.size,
                    onMenu = { scope.launch { drawer.open() } },
                    onBell = actions.onLiveRequests,
                )
                OfflineBanner(offline = !connected, pendingCount = pending.size)
                if (ui.refreshing || ui.togglingOnline) LinearProgressIndicator(Modifier.fillMaxWidth())
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    HomeMap(ui, online, offers, active)
                    MapButton(Icons.Filled.LocationOn, stringResource(R.string.home_locate), Modifier.align(Alignment.TopEnd).padding(12.dp)) {
                        if (LocationHelper.hasPermission(context)) locateMe() else locatePermission.launch(LocationHelper.PERMISSIONS)
                    }
                }
            }
            BottomPanel(
                modifier = Modifier.align(Alignment.BottomCenter),
                ui = ui,
                vm = vm,
                online = online,
                wallet = wallet,
                offers = offers,
                active = active,
                actions = actions,
                onToggle = ::toggle,
            )
        }
    }
}

@Composable
private fun TopBar(online: Boolean, offerCount: Int, onMenu: () -> Unit, onBell: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 3.dp) {
        Row(
            Modifier.fillMaxWidth().statusBarsPadding().height(56.dp).padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onMenu) { Icon(Icons.Filled.Menu, contentDescription = stringResource(R.string.menu_open)) }
            Text(
                stringResource(if (online) R.string.home_online else R.string.home_offline).uppercase(),
                modifier = Modifier.weight(1f),
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.5.sp,
                color = if (online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
            )
            IconButton(onClick = onBell) {
                BadgedBox(badge = { if (offerCount > 0) Badge { Text(offerCount.toString()) } }) {
                    Icon(Icons.Filled.Notifications, contentDescription = stringResource(R.string.menu_live_requests), tint = MaterialTheme.colorScheme.primary)
                }
            }
        }
    }
}

@Composable
private fun HomeMap(ui: HomeUi, online: Boolean, offers: List<Offer>, active: Order?) {
    val meLabel = stringResource(com.cooperwaters.core.R.string.cw_map_me)
    val markers = buildList {
        ui.depots.forEach { add(MapMarker(it.id, it.lat, it.lng, it.name, MapMarker.Kind.DEPOT, it.geofenceRadiusM)) }
        if (online && active == null) offers.forEach { o -> o.delivery?.let { add(MapMarker("offer-${o.orderId}", it.lat, it.lng, o.shortCode, MapMarker.Kind.DESTINATION)) } }
        active?.delivery?.let { add(MapMarker("job-${active.id}", it.lat, it.lng, active.shortCode, MapMarker.Kind.DESTINATION)) }
        val lat = ui.myLat
        val lng = ui.myLng
        if (lat != null && lng != null) add(MapMarker("me", lat, lng, meLabel, MapMarker.Kind.ME))
    }
    val firstDepot = ui.depots.firstOrNull()
    CwMap(
        modifier = Modifier.fillMaxSize(),
        center = MapCenter(ui.myLat ?: firstDepot?.lat ?: Geo.POM_LAT, ui.myLng ?: firstDepot?.lng ?: Geo.POM_LNG, if (ui.myLat != null) 15.0 else 13.0),
        markers = markers,
        followCenter = true,
    )
}

@Composable
private fun MapButton(icon: ImageVector, description: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Surface(onClick = onClick, modifier = modifier.size(44.dp), shape = CircleShape, color = MaterialTheme.colorScheme.surface, shadowElevation = 4.dp) {
        Box(contentAlignment = Alignment.Center) { Icon(icon, contentDescription = description, tint = MaterialTheme.colorScheme.primary) }
    }
}

@Composable
private fun BottomPanel(
    modifier: Modifier,
    ui: HomeUi,
    vm: HomeViewModel,
    online: Boolean,
    wallet: WalletBrief?,
    offers: List<Offer>,
    active: Order?,
    actions: HomeActions,
    onToggle: (Boolean) -> Unit,
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp),
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 12.dp,
    ) {
        Column(
            Modifier.navigationBarsPadding().padding(horizontal = 16.dp, vertical = 14.dp).heightIn(max = 460.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            ErrorCard(ui.error, onDismiss = vm::clearMessages)
            ui.message?.let { m -> Text(m.asString(), color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium) }
            wallet?.takeIf { it.blocked }?.let { w -> LowBalanceCard(w, actions.onTopup) }

            if (active != null) {
                CurrentJobCard(active) { actions.onOpenJob(active.id) }
            } else if (online) {
                if (offers.isEmpty()) {
                    Text(stringResource(R.string.home_waiting_requests), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    offers.forEach { offer ->
                        OfferCard(
                            offer = offer,
                            accepting = ui.accepting == offer.orderId,
                            busy = ui.accepting != null || ui.declining == offer.orderId,
                            onAccept = { vm.accept(offer) },
                            onDecline = { vm.decline(offer) },
                        )
                    }
                }
            } else {
                ui.nearestDepot()?.let { (d, dist) ->
                    Text(stringResource(R.string.home_nearest_depot, d.name, Geo.formatDistance(dist)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            Text(
                stringResource(if (online) R.string.home_you_are_online else R.string.home_you_are_offline),
                style = MaterialTheme.typography.bodyLarge,
            )
            if (online) {
                OutlinedButton(
                    onClick = { onToggle(false) },
                    enabled = !ui.togglingOnline,
                    modifier = Modifier.fillMaxWidth().height(50.dp),
                    shape = RoundedCornerShape(8.dp),
                ) { Text(stringResource(R.string.home_go_offline).uppercase()) }
            } else {
                Button(
                    onClick = { onToggle(true) },
                    enabled = !ui.togglingOnline,
                    modifier = Modifier.fillMaxWidth().height(50.dp),
                    shape = RoundedCornerShape(8.dp),
                ) { Text(stringResource(R.string.home_go_online).uppercase()) }
            }
        }
    }
}

@Composable
private fun LowBalanceCard(w: WalletBrief, onTopup: () -> Unit) {
    val c = MaterialTheme.colorScheme
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = c.errorContainer, contentColor = c.onErrorContainer)) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.wallet_blocked_body, Money.format(w.balanceToea), Money.format(w.minBalanceToea), HomeViewModel.shortfallText(w)),
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            Button(onClick = onTopup) { Text(stringResource(R.string.wallet_topup)) }
        }
    }
}

@Composable
private fun CurrentJobCard(job: Order, onOpen: () -> Unit) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(R.string.home_current_job, job.shortCode), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text(stringResource(Labels.status(job.status)))
            job.delivery?.let { Text(it.address, style = MaterialTheme.typography.bodySmall) }
            Button(onClick = onOpen, modifier = Modifier.fillMaxWidth().padding(top = 6.dp)) { Text(stringResource(R.string.home_open_job)) }
        }
    }
}

/** Side menu (StarTrip driver style): brand-coloured, profile header with rating and balance, online switch, then the menu. */
@Composable
private fun DrawerContent(
    profile: DriverProfile?,
    wallet: WalletBrief?,
    online: Boolean,
    toggling: Boolean,
    onToggle: (Boolean) -> Unit,
    actions: HomeActions,
    close: (() -> Unit) -> Unit,
    onSignOut: () -> Unit,
) {
    val onBrand = Color.White
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Column(Modifier.fillMaxWidth().clickable { close(actions.onProfile) }.padding(horizontal = 20.dp, vertical = 18.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(64.dp).clip(RoundedCornerShape(8.dp)).background(Color.White), contentAlignment = Alignment.Center) {
                    Icon(CwIcons.WaterDrop, contentDescription = null, tint = CwBrandBlue, modifier = Modifier.size(40.dp))
                }
                Spacer(Modifier.weight(1f))
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = stringResource(R.string.menu_profile), tint = onBrand)
            }
            Spacer(Modifier.height(12.dp))
            Text(profile?.name?.takeIf { it.isNotBlank() } ?: stringResource(R.string.menu_profile), style = MaterialTheme.typography.titleMedium, color = onBrand)
            Stars(profile?.ratingAvg ?: 0.0)
            wallet?.let { Text(stringResource(R.string.menu_balance, Money.format(it.balanceToea)), style = MaterialTheme.typography.bodySmall, color = onBrand.copy(alpha = 0.85f)) }
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 8.dp)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(CwIcons.Truck, contentDescription = null, tint = onBrand, modifier = Modifier.size(22.dp))
                Spacer(Modifier.width(16.dp))
                Text(
                    stringResource(if (online) R.string.menu_driver_on else R.string.menu_driver_off),
                    style = MaterialTheme.typography.bodyLarge,
                    color = onBrand,
                    modifier = Modifier.weight(1f),
                )
                Switch(
                    checked = online,
                    onCheckedChange = onToggle,
                    enabled = !toggling,
                    colors = SwitchDefaults.colors(
                        checkedThumbColor = CwBrandBlue,
                        checkedTrackColor = Color.White,
                        uncheckedThumbColor = MaterialTheme.colorScheme.error,
                        uncheckedTrackColor = Color.White,
                        uncheckedBorderColor = Color.White,
                    ),
                )
            }
            DrawerItem(Icons.Filled.Notifications, stringResource(R.string.menu_live_requests)) { close(actions.onLiveRequests) }
            DrawerItem(CwIcons.BarChart, stringResource(R.string.menu_earnings)) { close(actions.onEarnings) }
            DrawerItem(CwIcons.Wallet, stringResource(R.string.menu_wallet)) { close(actions.onWallet) }
            DrawerItem(Icons.AutoMirrored.Filled.List, stringResource(R.string.menu_history)) { close(actions.onHistory) }
            DrawerItem(Icons.Filled.Email, stringResource(R.string.menu_messages)) { close(actions.onMessages) }
            DrawerItem(Icons.Filled.Person, stringResource(R.string.menu_profile)) { close(actions.onProfile) }
            DrawerItem(Icons.Filled.Info, stringResource(R.string.menu_support)) { close(actions.onSupport) }
            HorizontalDivider(Modifier.padding(vertical = 6.dp), color = onBrand.copy(alpha = 0.25f))
            DrawerItem(Icons.AutoMirrored.Filled.ExitToApp, stringResource(R.string.menu_logout), onSignOut)
        }
        Text(
            stringResource(R.string.app_version, BuildConfig.VERSION_NAME, BuildConfig.GIT_SHA),
            style = MaterialTheme.typography.bodySmall,
            color = onBrand.copy(alpha = 0.7f),
            modifier = Modifier.navigationBarsPadding().padding(horizontal = 20.dp, vertical = 12.dp),
        )
    }
}

@Composable
private fun Stars(rating: Double) {
    val onBrand = Color.White
    Row(Modifier.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        for (i in 1..5) {
            Icon(
                Icons.Filled.Star,
                contentDescription = null,
                tint = if (rating >= i - 0.5) onBrand else onBrand.copy(alpha = 0.3f),
                modifier = Modifier.size(18.dp),
            )
        }
        if (rating > 0) Text(String.format(java.util.Locale.ENGLISH, " %.1f", rating), color = onBrand, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun DrawerItem(icon: ImageVector, label: String, onClick: () -> Unit) {
    val onBrand = Color.White
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = onBrand, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(16.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge, color = onBrand)
    }
}

@Composable
fun OfferCard(offer: Offer, accepting: Boolean, busy: Boolean, onAccept: () -> Unit, onDecline: () -> Unit) {
    val secs = rememberCountdown(offer.expiresAt)
    val expired = secs != null && secs <= 0
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(offer.shortCode, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                if (secs != null) {
                    Text(
                        if (expired) stringResource(R.string.offer_expired) else stringResource(R.string.offer_expires_in, PomTime.formatCountdown(secs)),
                        color = if (secs < 60) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
            Text(stringResource(R.string.offer_earn, Money.format(offer.earningsToea)), style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.primary)
            Text(stringResource(R.string.offer_load, offer.quantity, offer.`package`, offer.volumeLitres))
            offer.distanceM?.let { Text(stringResource(R.string.offer_distance, Geo.formatDistance(it))) }
            offer.paymentMethod?.let { Text(stringResource(Labels.paymentMethod(it)), style = MaterialTheme.typography.bodySmall) }
            offer.delivery?.let { d ->
                Text(d.address, style = MaterialTheme.typography.bodyMedium)
                d.notes?.takeIf { it.isNotBlank() }?.let { Text(stringResource(R.string.job_landmark, it), style = MaterialTheme.typography.bodySmall) }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onDecline, enabled = !busy && !expired, modifier = Modifier.weight(1f)) { Text(stringResource(R.string.offer_decline)) }
                Button(onClick = onAccept, enabled = !busy && !expired, modifier = Modifier.weight(1f)) {
                    Text(stringResource(if (accepting) R.string.offer_accepting else R.string.offer_accept))
                }
            }
        }
    }
}
