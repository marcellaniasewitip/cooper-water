package com.cooperwaters.driver.ui.home

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cooperwaters.core.android.LocationHelper
import com.cooperwaters.core.android.ui.CwMap
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.Labels
import com.cooperwaters.core.android.ui.LabelValue
import com.cooperwaters.core.android.ui.MapCenter
import com.cooperwaters.core.android.ui.MapMarker
import com.cooperwaters.core.android.ui.SectionTitle
import com.cooperwaters.core.android.ui.rememberCountdown
import com.cooperwaters.core.money.Money
import com.cooperwaters.core.net.Offer
import com.cooperwaters.core.net.WalletBrief
import com.cooperwaters.core.time.PomTime
import com.cooperwaters.core.util.Geo
import com.cooperwaters.driver.R
import com.cooperwaters.driver.ui.common.ScreenScaffold
import com.cooperwaters.driver.ui.common.containerViewModel
import kotlinx.coroutines.launch

@Composable
fun HomeScreen(
    onOpenJob: (String) -> Unit,
    onTopup: () -> Unit,
    bottomBar: @Composable () -> Unit,
) {
    val vm = containerViewModel { c -> HomeViewModel(c.repository, c.state) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    val profile by vm.driverState.profile.collectAsStateWithLifecycle()
    val wallet by vm.driverState.wallet.collectAsStateWithLifecycle()
    val offers by vm.driverState.offers.collectAsStateWithLifecycle()
    val active by vm.driverState.activeOrder.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    LaunchedEffect(ui.acceptedOrderId) {
        ui.acceptedOrderId?.let {
            vm.consumeAccepted()
            onOpenJob(it)
        }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }
    val notif = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) { if (Build.VERSION.SDK_INT >= 33) notif.launch(Manifest.permission.POST_NOTIFICATIONS) }

    fun locateAndGoOnline() {
        vm.startToggling()
        scope.launch {
            val loc = LocationHelper.currentLocation(context)
            if (loc == null) vm.locationUnavailable() else vm.goOnline(loc.latitude, loc.longitude)
        }
    }
    val locationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted.values.any { it }) locateAndGoOnline() else vm.locationUnavailable()
    }
    LaunchedEffect(Unit) {
        if (LocationHelper.hasPermission(context)) LocationHelper.lastKnown(context, Long.MAX_VALUE)?.let { vm.onMyLocation(it.latitude, it.longitude) }
    }

    val online = profile?.online == true
    ScreenScaffold(
        title = stringResource(R.string.app_name),
        actions = {
            IconButton(onClick = vm::refresh) { Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.action_refresh)) }
        },
        bottomBar = bottomBar,
    ) {
        if (ui.refreshing || ui.togglingOnline) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            wallet?.takeIf { it.blocked }?.let { w -> item { LowBalanceBanner(w, onTopup) } }
            item {
                OnlineCard(
                    online = online,
                    busy = ui.togglingOnline,
                    onToggle = { wantOnline ->
                        if (!wantOnline) vm.goOffline()
                        else if (LocationHelper.hasPermission(context)) locateAndGoOnline()
                        else locationPermission.launch(LocationHelper.PERMISSIONS)
                    },
                )
            }
            item { ErrorCard(ui.error, onDismiss = vm::clearMessages) }
            ui.message?.let { m -> item { Text(m.asString(), color = MaterialTheme.colorScheme.primary) } }
            active?.let { job ->
                item {
                    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(stringResource(R.string.home_current_job, job.shortCode), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                            Text(stringResource(Labels.status(job.status)))
                            job.delivery?.let { Text(it.address, style = MaterialTheme.typography.bodySmall) }
                            Button(onClick = { onOpenJob(job.id) }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.home_open_job)) }
                        }
                    }
                }
            }
            if (online && active == null) {
                item { SectionTitle(stringResource(R.string.home_offers)) }
                if (offers.isEmpty()) item { Text(stringResource(R.string.home_waiting_for_offers), style = MaterialTheme.typography.bodyMedium) }
                items(offers, key = { it.orderId }) { offer ->
                    OfferCard(
                        offer = offer,
                        accepting = ui.accepting == offer.orderId,
                        busy = ui.accepting != null || ui.declining == offer.orderId,
                        onAccept = { vm.accept(offer) },
                        onDecline = { vm.decline(offer) },
                    )
                }
            }
            if (!online) {
                item { SectionTitle(stringResource(R.string.home_depots)) }
                item { Text(stringResource(R.string.home_depots_help), style = MaterialTheme.typography.bodySmall) }
                if (ui.depots.isNotEmpty()) {
                    item {
                        val markers = ui.depots.map { MapMarker(it.id, it.lat, it.lng, it.name, MapMarker.Kind.DEPOT, it.geofenceRadiusM) } +
                            listOfNotNull(ui.myLat?.let { lat -> ui.myLng?.let { lng -> MapMarker("me", lat, lng, stringResource(com.cooperwaters.core.R.string.cw_map_me), MapMarker.Kind.ME) } })
                        CwMap(
                            modifier = Modifier.fillMaxWidth().height(200.dp),
                            center = MapCenter(ui.myLat ?: Geo.POM_LAT, ui.myLng ?: Geo.POM_LNG, 12.0),
                            markers = markers,
                        )
                    }
                }
                items(ui.depots, key = { it.id }) { d ->
                    val dist = ui.myLat?.let { lat -> ui.myLng?.let { lng -> Geo.distanceM(lat, lng, d.lat, d.lng) } }
                    LabelValue(d.name, dist?.let { Geo.formatDistance(it) } ?: "")
                }
            }
        }
    }
}

@Composable
private fun LowBalanceBanner(w: WalletBrief, onTopup: () -> Unit) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.wallet_blocked_title), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text(stringResource(R.string.wallet_blocked_body, Money.format(w.balanceToea), Money.format(w.minBalanceToea), HomeViewModel.shortfallText(w)))
            Button(onClick = onTopup) { Text(stringResource(R.string.wallet_topup)) }
        }
    }
}

@Composable
private fun OnlineCard(online: Boolean, busy: Boolean, onToggle: (Boolean) -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(if (online) R.string.home_online else R.string.home_offline), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text(stringResource(if (online) R.string.home_online_help else R.string.home_offline_help), style = MaterialTheme.typography.bodySmall)
            }
            Switch(checked = online, onCheckedChange = onToggle, enabled = !busy)
        }
    }
}

@Composable
fun OfferCard(offer: Offer, accepting: Boolean, busy: Boolean, onAccept: () -> Unit, onDecline: () -> Unit) {
    val secs = rememberCountdown(offer.expiresAt)
    val expired = secs != null && secs <= 0
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
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
