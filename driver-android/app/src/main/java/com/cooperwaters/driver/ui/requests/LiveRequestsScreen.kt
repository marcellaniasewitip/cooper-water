package com.cooperwaters.driver.ui.requests

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cooperwaters.core.android.ui.EmptyState
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.driver.R
import com.cooperwaters.driver.ui.common.ScreenScaffold
import com.cooperwaters.driver.ui.common.containerViewModel
import com.cooperwaters.driver.ui.home.HomeViewModel
import com.cooperwaters.driver.ui.home.OfferCard

/** Live Requests (StarTrip style): the job offers open to this driver right now, with accept/decline. */
@Composable
fun LiveRequestsScreen(onBack: () -> Unit, onOpenJob: (String) -> Unit) {
    val vm = containerViewModel(key = "live-requests") { c -> HomeViewModel(c.repository, c.state) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    val profile by vm.driverState.profile.collectAsStateWithLifecycle()
    val offers by vm.driverState.offers.collectAsStateWithLifecycle()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }
    LaunchedEffect(ui.acceptedOrderId) {
        ui.acceptedOrderId?.let {
            vm.consumeAccepted()
            onOpenJob(it)
        }
    }
    val online = profile?.online == true

    ScreenScaffold(title = stringResource(R.string.live_title), onBack = onBack) {
        if (ui.refreshing) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { ErrorCard(ui.error, onDismiss = vm::clearMessages) }
            ui.message?.let { m -> item { Text(m.asString(), color = MaterialTheme.colorScheme.primary) } }
            if (offers.isEmpty()) {
                item {
                    EmptyState(
                        stringResource(if (online) R.string.live_empty else R.string.live_offline),
                        icon = Icons.Filled.Notifications,
                    )
                }
            }
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
    }
}
