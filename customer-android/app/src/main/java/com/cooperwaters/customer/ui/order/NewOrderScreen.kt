package com.cooperwaters.customer.ui.order

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cooperwaters.core.android.ui.EmptyState
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.LabelValue
import com.cooperwaters.core.android.ui.Labels
import com.cooperwaters.core.android.ui.LoadingButton
import com.cooperwaters.core.android.ui.QuantityStepper
import com.cooperwaters.core.android.ui.SectionTitle
import com.cooperwaters.core.money.Money
import com.cooperwaters.customer.R
import com.cooperwaters.customer.ui.common.ScreenScaffold
import com.cooperwaters.customer.ui.common.containerViewModel

@Composable
fun NewOrderScreen(
    onBack: () -> Unit,
    onAddLocation: () -> Unit,
    onPlaced: (orderId: String, needsPayment: Boolean) -> Unit,
    onResumedElsewhere: () -> Unit,
) {
    val vm = containerViewModel { c -> NewOrderViewModel(c.repository, c.tokenStore.user()?.phone.orEmpty()) }
    val state by vm.state.collectAsStateWithLifecycle()

    LaunchedEffect(state.placed) { state.placed?.let { onPlaced(it.orderId, it.needsPayment) } }
    LaunchedEffect(state.resumedElsewhere) { if (state.resumedElsewhere) onResumedElsewhere() }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.reloadLocations() }
    BackHandler { if (!vm.back()) onBack() }

    val title = when (state.step) {
        OrderStep.PACKAGE -> R.string.order_step_package
        OrderStep.LOCATION -> R.string.order_step_location
        OrderStep.PAYMENT -> R.string.order_step_payment
        OrderStep.REVIEW -> R.string.order_step_review
    }
    ScreenScaffold(title = stringResource(title), onBack = { if (!vm.back()) onBack() }) {
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            when (state.step) {
                OrderStep.PACKAGE -> PackageStep(state, vm)
                OrderStep.LOCATION -> LocationStep(state, vm, onAddLocation)
                OrderStep.PAYMENT -> PaymentStep(state, vm)
                OrderStep.REVIEW -> ReviewStep(state)
            }
            ErrorCard(state.error)
        }
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PriceBar(state)
            if (state.step == OrderStep.REVIEW) {
                LoadingButton(
                    text = stringResource(if (state.unsent) R.string.order_retry_send else R.string.order_place),
                    loading = state.placing,
                    onClick = vm::placeOrder,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (state.unsent && !state.placing) {
                    TextButton(onClick = vm::discardUnsent, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.order_discard_unsent)) }
                }
            } else {
                Button(onClick = vm::next, modifier = Modifier.fillMaxWidth(), enabled = !state.loading) { Text(stringResource(R.string.action_continue)) }
            }
        }
    }
}

@Composable
private fun PriceBar(state: NewOrderState) {
    val price = state.priceToea ?: return
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(
            stringResource(if (state.quotedPriceToea != null) R.string.order_fixed_price else R.string.order_price_estimate),
            style = MaterialTheme.typography.bodyMedium,
        )
        Text(Money.format(price), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun PackageStep(state: NewOrderState, vm: NewOrderViewModel) {
    SectionTitle(stringResource(R.string.order_choose_package))
    if (state.packages.isEmpty() && !state.loading) {
        EmptyState(
            stringResource(R.string.order_no_packages),
            icon = Icons.Filled.ShoppingCart,
            actionLabel = stringResource(com.cooperwaters.core.R.string.cw_retry),
            onAction = vm::reload,
        )
        return
    }
    for (p in state.packages) {
        val selected = p.id == state.packageId
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .selectable(selected = selected, onClick = { vm.selectPackage(p.id) }, role = Role.RadioButton),
            colors = CardDefaults.cardColors(
                containerColor = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
            ),
            border = if (selected) BorderStroke(2.dp, MaterialTheme.colorScheme.primary) else null,
        ) {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                RadioButton(selected = selected, onClick = null)
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text(p.name, style = MaterialTheme.typography.titleMedium)
                    Text(
                        stringResource(com.cooperwaters.core.R.string.cw_litres, p.volumeLitres),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(Money.format(p.priceToea), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
            }
        }
    }
    SectionTitle(stringResource(R.string.order_quantity))
    QuantityStepper(
        value = state.quantity,
        onChange = vm::setQuantity,
        min = 1,
        max = state.maxQuantity,
        decreaseLabel = stringResource(R.string.order_qty_minus),
        increaseLabel = stringResource(R.string.order_qty_plus),
    )
    Text(stringResource(R.string.order_max_quantity, state.maxQuantity), style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun LocationStep(state: NewOrderState, vm: NewOrderViewModel, onAddLocation: () -> Unit) {
    SectionTitle(stringResource(R.string.order_choose_location))
    if (state.locations.isEmpty()) Text(stringResource(R.string.order_no_locations))
    for (l in state.locations) {
        val selected = l.id == state.locationId
        Card(
            modifier = Modifier.fillMaxWidth().selectable(selected = selected, onClick = { vm.selectLocation(l.id) }),
            colors = CardDefaults.cardColors(
                containerColor = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
            ),
        ) {
            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                RadioButton(selected = selected, onClick = { vm.selectLocation(l.id) })
                Column {
                    Text(l.label, style = MaterialTheme.typography.titleMedium)
                    Text(l.addressText, style = MaterialTheme.typography.bodyMedium)
                    if (l.landmarkNotes.isNotBlank()) {
                        Text(stringResource(R.string.locations_landmark, l.landmarkNotes), style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
    OutlinedButton(onClick = onAddLocation, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.locations_add)) }
}

@Composable
private fun PaymentStep(state: NewOrderState, vm: NewOrderViewModel) {
    SectionTitle(stringResource(R.string.order_payment_method))
    for (m in listOf("cod", "cellmoney")) {
        val selected = state.paymentMethod == m
        Row(
            Modifier.fillMaxWidth().selectable(selected = selected, onClick = { vm.selectPayment(m) }).padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RadioButton(selected = selected, onClick = { vm.selectPayment(m) })
            Spacer(Modifier.width(8.dp))
            Column {
                Text(stringResource(Labels.paymentMethod(m)), style = MaterialTheme.typography.titleMedium)
                Text(
                    stringResource(if (m == "cod") R.string.order_cod_help else R.string.order_cellmoney_help),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
    if (state.paymentMethod == "cellmoney") {
        OutlinedTextField(
            value = state.msisdn,
            onValueChange = vm::onMsisdn,
            label = { Text(stringResource(R.string.order_msisdn_label)) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun ReviewStep(state: NewOrderState) {
    SectionTitle(stringResource(R.string.order_review_title))
    val pkg = state.selectedPackage
    val loc = state.selectedLocation
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            LabelValue(stringResource(R.string.order_review_package), pkg?.name.orEmpty())
            LabelValue(stringResource(R.string.order_quantity), state.quantity.toString())
            pkg?.let { LabelValue(stringResource(R.string.order_review_unit_price), Money.format(it.priceToea)) }
            HorizontalDivider()
            LabelValue(stringResource(R.string.order_review_deliver_to), loc?.label.orEmpty())
            loc?.let {
                Text(it.addressText, style = MaterialTheme.typography.bodyMedium)
                if (it.landmarkNotes.isNotBlank()) Text(stringResource(R.string.locations_landmark, it.landmarkNotes), style = MaterialTheme.typography.bodySmall)
            }
            HorizontalDivider()
            LabelValue(stringResource(R.string.order_payment_method), stringResource(Labels.paymentMethod(state.paymentMethod)))
            if (state.paymentMethod == "cellmoney") LabelValue(stringResource(R.string.order_msisdn_label), state.msisdn)
        }
    }
    Text(stringResource(R.string.order_review_note), style = MaterialTheme.typography.bodySmall)
}
