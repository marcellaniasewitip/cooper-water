package com.cooperwaters.driver.ui.job

import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cooperwaters.core.android.Intents
import com.cooperwaters.core.android.LocationHelper
import com.cooperwaters.core.android.ui.CwMap
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.FullScreenLoading
import com.cooperwaters.core.android.ui.LabelValue
import com.cooperwaters.core.android.ui.Labels
import com.cooperwaters.core.android.ui.LoadingButton
import com.cooperwaters.core.android.ui.MapCenter
import com.cooperwaters.core.android.ui.MapMarker
import com.cooperwaters.core.money.Money
import com.cooperwaters.driver.R
import com.cooperwaters.driver.ui.common.PhotoPickerButtons
import com.cooperwaters.driver.ui.common.ScreenScaffold
import com.cooperwaters.driver.ui.common.compressPhoto
import com.cooperwaters.driver.ui.common.containerViewModel
import kotlinx.coroutines.launch
import com.cooperwaters.core.R as CoreR

@Composable
fun JobScreen(orderId: String, onBack: () -> Unit, onReportIssue: () -> Unit) {
    val vm = containerViewModel(key = "job-$orderId") { c -> JobViewModel(c.repository, c.uploader, c.state, orderId) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    fun stepWithLocation() {
        scope.launch {
            val loc = LocationHelper.currentLocation(context, timeoutMs = 15_000)
            vm.performStep(loc?.latitude, loc?.longitude)
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { stepWithLocation() }
    val doStep = {
        if (LocationHelper.hasPermission(context)) stepWithLocation() else permission.launch(LocationHelper.PERMISSIONS)
    }

    ScreenScaffold(
        title = ui.order?.shortCode ?: stringResource(R.string.job_title),
        onBack = onBack,
        actions = { IconButton(onClick = vm::refresh) { Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.action_refresh)) } },
    ) {
        val order = ui.order
        if (order == null) {
            if (ui.error == null) FullScreenLoading() else ErrorCard(ui.error, Modifier.padding(16.dp), onRetry = vm::refresh)
            return@ScreenScaffold
        }
        val delivery = order.delivery
        Column(Modifier.verticalScroll(rememberScrollState())) {
            if (delivery != null) {
                val markers = listOf(MapMarker("dest", delivery.lat, delivery.lng, stringResource(CoreR.string.cw_map_destination))) +
                    ui.depots.map { MapMarker(it.id, it.lat, it.lng, it.name, MapMarker.Kind.DEPOT, it.geofenceRadiusM) }
                CwMap(Modifier.fillMaxWidth().height(220.dp), center = MapCenter(delivery.lat, delivery.lng, 13.0), markers = markers)
            }
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(Labels.status(order.status)), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                if (ui.fromCache) Text(stringResource(R.string.job_cached), style = MaterialTheme.typography.bodySmall)
                ErrorCard(ui.error)
                ui.info?.let { Text(it.asString(), color = MaterialTheme.colorScheme.primary) }

                Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(stringResource(R.string.job_deliver_to), style = MaterialTheme.typography.labelLarge)
                        Text(delivery?.address.orEmpty(), style = MaterialTheme.typography.titleMedium)
                        delivery?.notes?.takeIf { it.isNotBlank() }?.let {
                            Text(stringResource(R.string.job_landmark, it), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
                        }
                        order.customer?.let { cust ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(cust.name, modifier = Modifier.weight(1f))
                                cust.phone?.let { phone ->
                                    IconButton(onClick = { Intents.dial(context, phone) }) {
                                        Icon(Icons.Filled.Call, contentDescription = stringResource(R.string.job_call_customer))
                                    }
                                }
                            }
                        }
                    }
                }

                when (ui.step) {
                    JobStep.ARRIVE_DEPOT -> {
                        Text(stringResource(R.string.job_go_to_depot))
                        ui.nearestDepot(null, null)?.let { d ->
                            OutlinedButton(onClick = { Intents.navigateTo(context, d.lat, d.lng, d.name) }, modifier = Modifier.fillMaxWidth()) {
                                Text(stringResource(R.string.job_navigate_depot, d.name))
                            }
                        }
                        LoadingButton(stringResource(R.string.job_arrive_depot), ui.busy, doStep, Modifier.fillMaxWidth())
                    }
                    JobStep.CONFIRM_LOADED -> {
                        Text(stringResource(R.string.job_loading_help))
                        LoadingButton(stringResource(R.string.job_confirm_loaded), ui.busy, doStep, Modifier.fillMaxWidth())
                    }
                    JobStep.MARK_ARRIVED -> {
                        if (delivery != null) {
                            Button(onClick = { Intents.navigateTo(context, delivery.lat, delivery.lng, delivery.address) }, modifier = Modifier.fillMaxWidth()) {
                                Text(stringResource(R.string.job_navigate_customer))
                            }
                        }
                        LoadingButton(stringResource(R.string.job_mark_arrived), ui.busy, doStep, Modifier.fillMaxWidth(), outlined = true)
                    }
                    JobStep.MARK_DELIVERED -> {
                        Text(stringResource(R.string.job_proof_help))
                        val photo = ui.proofPhoto
                        if (photo != null) {
                            val bmp = remember(photo) { BitmapFactory.decodeByteArray(photo, 0, photo.size)?.asImageBitmap() }
                            bmp?.let { Image(it, contentDescription = stringResource(R.string.job_proof_photo), modifier = Modifier.fillMaxWidth().height(180.dp)) }
                            TextButton(onClick = vm::clearProofPhoto) { Text(stringResource(R.string.job_proof_remove)) }
                        } else {
                            PhotoPickerButtons(onPicked = { uri -> scope.launch { compressPhoto(context, uri).onSuccess(vm::onProofPhoto) } })
                        }
                        LoadingButton(stringResource(R.string.job_mark_delivered), ui.busy, { vm.performStep(null, null) }, Modifier.fillMaxWidth())
                    }
                    JobStep.AWAIT_CUSTOMER -> Text(stringResource(R.string.job_await_customer))
                    JobStep.DONE -> OutlinedButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.job_back_home)) }
                }

                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        LabelValue(stringResource(R.string.job_load), stringResource(R.string.job_load_value, order.quantity, order.`package`?.name.orEmpty()))
                        LabelValue(stringResource(R.string.job_price), Money.format(order.priceToea))
                        order.earningsToea?.let { LabelValue(stringResource(R.string.job_earnings), Money.format(it)) }
                        order.commissionToea?.let { LabelValue(stringResource(R.string.job_commission), Money.format(it)) }
                        LabelValue(stringResource(R.string.job_payment), stringResource(Labels.paymentMethod(order.paymentMethod)))
                        if (order.paymentMethod == "cod") Text(stringResource(R.string.job_collect_cash, Money.format(order.priceToea)), fontWeight = FontWeight.SemiBold)
                    }
                }
                TextButton(onClick = onReportIssue) { Text(stringResource(R.string.job_report_issue)) }
            }
        }
    }
}

@Composable
fun IssueScreen(orderId: String, onDone: () -> Unit) {
    val vm = containerViewModel(key = "issue-$orderId") { c -> JobViewModel(c.repository, c.uploader, c.state, orderId) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    LaunchedEffect(ui.issueSent) { if (ui.issueSent) onDone() }
    val categories = ui.categories.ifEmpty { listOf("not_delivered", "short_volume", "quality", "payment", "behaviour", "other") }
    ScreenScaffold(title = stringResource(R.string.issue_title), onBack = onDone) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.issue_intro))
            for (c in categories) {
                Row(
                    Modifier.fillMaxWidth().selectable(selected = ui.issueCategory == c, onClick = { vm.setIssueCategory(c) }).padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = ui.issueCategory == c, onClick = { vm.setIssueCategory(c) })
                    Text(Labels.disputeCategory(c)?.let { stringResource(it) } ?: c)
                }
            }
            OutlinedTextField(ui.issueText, vm::setIssueText, label = { Text(stringResource(R.string.issue_description)) }, minLines = 4, modifier = Modifier.fillMaxWidth())
            ErrorCard(ui.error)
            LoadingButton(stringResource(R.string.issue_submit), ui.busy, vm::reportIssue, Modifier.fillMaxWidth())
        }
    }
}
