package com.cooperwaters.customer.ui.tracking

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cooperwaters.core.android.Intents
import com.cooperwaters.core.android.ui.CwMap
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.FullScreenLoading
import com.cooperwaters.core.android.ui.LabelValue
import com.cooperwaters.core.android.ui.Labels
import com.cooperwaters.core.android.ui.LoadingButton
import com.cooperwaters.core.android.ui.MapCenter
import com.cooperwaters.core.android.ui.MapMarker
import com.cooperwaters.core.android.ui.SectionTitle
import com.cooperwaters.core.money.Money
import com.cooperwaters.core.net.Order
import com.cooperwaters.core.order.OrderStatus
import com.cooperwaters.core.order.OrderTimelines
import com.cooperwaters.core.time.PomTime
import com.cooperwaters.customer.R
import com.cooperwaters.customer.ui.common.ScreenScaffold
import com.cooperwaters.customer.ui.common.containerViewModel
import com.cooperwaters.core.R as CoreR

@Composable
fun TrackingScreen(orderId: String, onBack: () -> Unit, onPay: () -> Unit, onRate: () -> Unit, onDispute: () -> Unit, onChat: () -> Unit) {
    val vm = containerViewModel(key = "track-$orderId") { c -> TrackingViewModel(c.repository, orderId, c.realtime.events, c.pushEvents) }
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var showCancel by remember { mutableStateOf(false) }

    ScreenScaffold(
        title = state.order?.shortCode ?: stringResource(R.string.tracking_title),
        onBack = onBack,
        actions = { IconButton(onClick = vm::refresh) { Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.action_refresh)) } },
    ) {
        val order = state.order
        if (order == null) {
            if (state.loading) FullScreenLoading() else ErrorCard(state.error, Modifier.padding(16.dp), onRetry = vm::refresh)
            return@ScreenScaffold
        }
        Column(Modifier.verticalScroll(rememberScrollState())) {
            TrackingMap(order, state)
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(Labels.status(order.status)), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                if (state.fromCache) Text(stringResource(R.string.tracking_cached), style = MaterialTheme.typography.bodySmall)
                ErrorCard(state.error, onDismiss = vm::clearMessages)
                state.info?.let { Text(it.asString(), color = MaterialTheme.colorScheme.primary) }

                order.driver?.let { d ->
                    Card(Modifier.fillMaxWidth()) {
                        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(d.name, style = MaterialTheme.typography.titleMedium)
                                d.truck?.let { t -> Text(stringResource(R.string.tracking_truck, t.plate), style = MaterialTheme.typography.bodySmall) }
                                if (d.ratingAvg > 0) Text(stringResource(R.string.tracking_rating, d.ratingAvg), style = MaterialTheme.typography.bodySmall)
                            }
                            IconButton(onClick = onChat) {
                                Icon(Icons.Filled.Email, contentDescription = stringResource(R.string.tracking_message_driver))
                            }
                            d.phone?.let { phone ->
                                IconButton(onClick = { Intents.dial(context, phone) }) {
                                    Icon(Icons.Filled.Call, contentDescription = stringResource(R.string.tracking_call_driver))
                                }
                            }
                        }
                    }
                }

                // Actions allowed in the current status.
                if (state.needsPayment) Button(onClick = onPay, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.tracking_pay)) }
                if (state.canConfirm) {
                    Text(stringResource(R.string.tracking_confirm_help), style = MaterialTheme.typography.bodyMedium)
                    LoadingButton(stringResource(R.string.tracking_confirm), state.busy, vm::confirmReceipt, Modifier.fillMaxWidth())
                }
                if (state.canRate) Button(onClick = onRate, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.tracking_rate)) }
                if (state.canCancel) {
                    OutlinedButton(onClick = { showCancel = true }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.tracking_cancel))
                    }
                } else if (!OrderStatus.isTerminal(order.status) && order.status != OrderStatus.DELIVERED) {
                    Text(stringResource(R.string.tracking_cancel_closed), style = MaterialTheme.typography.bodySmall)
                }
                if (state.canDispute) TextButton(onClick = onDispute) { Text(stringResource(R.string.tracking_report_problem)) }

                SectionTitle(stringResource(R.string.tracking_timeline))
                Timeline(order)

                SectionTitle(stringResource(R.string.tracking_details))
                OrderDetails(order)
            }
        }
    }

    if (showCancel) CancelDialog(onDismiss = { showCancel = false }, onConfirm = { reason ->
        showCancel = false
        vm.cancel(reason)
    })
}

@Composable
private fun TrackingMap(order: Order, state: TrackingState) {
    val delivery = order.delivery ?: return
    val markers = buildList {
        add(MapMarker("dest", delivery.lat, delivery.lng, stringResource(CoreR.string.cw_map_destination), MapMarker.Kind.DESTINATION))
        state.driverLocation?.takeIf { OrderStatus.isTrackable(order.status) }?.let {
            add(MapMarker("driver", it.lat, it.lng, stringResource(CoreR.string.cw_map_driver), MapMarker.Kind.DRIVER))
        }
    }
    val driver = markers.firstOrNull { it.kind == MapMarker.Kind.DRIVER }
    CwMap(
        modifier = Modifier.fillMaxWidth().height(260.dp),
        center = MapCenter(driver?.lat ?: delivery.lat, driver?.lng ?: delivery.lng, 15.0),
        markers = markers,
        followCenter = driver != null,
    )
    state.driverLocation?.at?.takeIf { driver != null }?.let {
        Text(stringResource(R.string.tracking_driver_seen, PomTime.formatTime(it)), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp))
    }
}

@Composable
private fun Timeline(order: Order) {
    for (step in OrderTimelines.steps(order)) {
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(14.dp).clip(CircleShape).background(
                    when {
                        step.current -> MaterialTheme.colorScheme.primary
                        step.done -> MaterialTheme.colorScheme.secondary
                        else -> MaterialTheme.colorScheme.outlineVariant
                    },
                ),
            )
            Spacer(Modifier.width(12.dp))
            Text(
                stringResource(Labels.status(step.status)),
                modifier = Modifier.weight(1f),
                fontWeight = if (step.current) FontWeight.Bold else FontWeight.Normal,
                color = if (step.done) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(PomTime.formatTime(step.at), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun OrderDetails(order: Order) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            LabelValue(stringResource(R.string.order_review_package), order.`package`?.name.orEmpty())
            LabelValue(stringResource(R.string.order_quantity), order.quantity.toString())
            LabelValue(stringResource(R.string.tracking_total), Money.format(order.priceToea))
            LabelValue(stringResource(R.string.order_payment_method), stringResource(Labels.paymentMethod(order.paymentMethod)))
            LabelValue(stringResource(R.string.tracking_placed_at), PomTime.formatDateTime(order.timeline.createdAt))
            order.delivery?.let {
                Text(it.address, style = MaterialTheme.typography.bodyMedium)
                it.notes?.takeIf { n -> n.isNotBlank() }?.let { n -> Text(stringResource(R.string.locations_landmark, n), style = MaterialTheme.typography.bodySmall) }
            }
            order.cancelReason?.let { LabelValue(stringResource(R.string.tracking_cancel_reason), it) }
        }
    }
}

@Composable
private fun CancelDialog(onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var reason by remember { mutableStateOf("") }
    val defaultReason = stringResource(R.string.tracking_cancel_default_reason)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.tracking_cancel_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.tracking_cancel_body))
                OutlinedTextField(reason, { reason = it.take(300) }, label = { Text(stringResource(R.string.tracking_cancel_reason)) })
            }
        },
        confirmButton = { TextButton(onClick = { onConfirm(reason.trim().ifBlank { defaultReason }) }) { Text(stringResource(R.string.tracking_cancel_confirm)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.tracking_cancel_keep)) } },
    )
}
