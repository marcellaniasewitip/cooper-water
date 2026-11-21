package com.cooperwaters.driver.ui.booking

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.LocationHelper
import com.cooperwaters.core.android.ui.SectionTitle
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.money.Money
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.BookingOptions
import com.cooperwaters.core.net.CustomerLookup
import com.cooperwaters.core.net.DeliveryLocation
import com.cooperwaters.core.net.DriverApi
import com.cooperwaters.core.net.DriverBookingRequest
import com.cooperwaters.core.net.GeoPlace
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.driver.R
import com.cooperwaters.driver.ui.common.ScreenScaffold
import com.cooperwaters.driver.ui.common.containerViewModel
import java.util.UUID
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class BookingUi(
    val loading: Boolean = true,
    val options: BookingOptions? = null,
    val phone: String = "",
    val lookup: CustomerLookup? = null,
    val lookingUp: Boolean = false,
    val name: String = "",
    val packageId: String? = null,
    val quantity: Int = 1,
    val address: String = "",
    val notes: String = "",
    val lat: Double? = null,
    val lng: Double? = null,
    /** Where the pin came from: "gps" (driver's phone) or "search" (picked from address search). */
    val pinSource: String? = null,
    val searchEnabled: Boolean = false,
    val results: List<GeoPlace> = emptyList(),
    val searching: Boolean = false,
    val paymentMethod: String = "cod",
    val msisdn: String = "",
    val transferReference: String = "",
    val submitting: Boolean = false,
    val error: UiText? = null,
    val bookedOrderId: String? = null,
) {
    val selectedPackage get() = options?.packages?.firstOrNull { it.id == packageId }
    val totalToea: Long? get() = selectedPackage?.let { it.priceToea * quantity }
}

/**
 * Manual booking: the driver books water for a customer (who phoned, or flagged the truck down) by the
 * customer's phone number. A new number gets a customer account; the job is assigned to this driver at once.
 */
class BookingViewModel(private val api: DriverApi) : ViewModel() {
    private val _ui = MutableStateFlow(BookingUi())
    val ui: StateFlow<BookingUi> = _ui.asStateFlow()
    private val idempotencyKey = UUID.randomUUID().toString()
    private var lookupJob: Job? = null
    private var searchJob: Job? = null

    init {
        viewModelScope.launch {
            val opts = apiCall { api.bookingOptions() }
            val geo = (apiCall { api.geoStatus() } as? ApiResult.Success)?.value
            _ui.update {
                when (opts) {
                    is ApiResult.Success -> it.copy(loading = false, options = opts.value, packageId = opts.value.packages.firstOrNull()?.id, searchEnabled = geo?.search == true)
                    is ApiResult.Failure -> it.copy(loading = false, error = opts.error.toUiText())
                }
            }
        }
    }

    fun onPhone(v: String) {
        val clean = v.filter { it.isDigit() || it == '+' || it == ' ' }.take(20)
        _ui.update { it.copy(phone = clean, lookup = null, error = null) }
        lookupJob?.cancel()
        if (clean.count { it.isDigit() } < 7) return
        lookupJob = viewModelScope.launch {
            delay(600)
            _ui.update { it.copy(lookingUp = true) }
            when (val r = apiCall { api.lookupCustomer(clean) }) {
                is ApiResult.Success -> _ui.update { s ->
                    s.copy(
                        lookingUp = false,
                        lookup = r.value,
                        name = if (s.name.isBlank()) r.value.name.orEmpty() else s.name,
                        paymentMethod = if (r.value.company == null && s.paymentMethod == "account") "cod" else s.paymentMethod,
                    )
                }
                is ApiResult.Failure -> _ui.update { it.copy(lookingUp = false, error = r.error.toUiText()) }
            }
        }
    }

    fun onName(v: String) = _ui.update { it.copy(name = v.take(80)) }
    fun onPackage(id: String) = _ui.update { it.copy(packageId = id) }
    fun onQuantity(delta: Int) = _ui.update { it.copy(quantity = (it.quantity + delta).coerceIn(1, it.options?.maxQuantity ?: 10)) }
    fun onNotes(v: String) = _ui.update { it.copy(notes = v.take(500)) }
    fun onPayment(m: String) = _ui.update { it.copy(paymentMethod = m, error = null) }
    fun onMsisdn(v: String) = _ui.update { it.copy(msisdn = v.filter { c -> c.isDigit() || c == '+' || c == ' ' }.take(20)) }
    fun onTransferReference(v: String) = _ui.update { it.copy(transferReference = v.take(120)) }

    fun onAddress(v: String) {
        _ui.update { it.copy(address = v.take(300)) }
        val s = _ui.value
        searchJob?.cancel()
        if (!s.searchEnabled || v.trim().length < 3) {
            _ui.update { it.copy(results = emptyList()) }
            return
        }
        searchJob = viewModelScope.launch {
            delay(500)
            _ui.update { it.copy(searching = true) }
            val r = apiCall { api.geoSearch(v.trim(), s.lat, s.lng) }
            _ui.update { it.copy(searching = false, results = (r as? ApiResult.Success)?.value?.items.orEmpty()) }
        }
    }

    fun pickPlace(p: GeoPlace) {
        searchJob?.cancel()
        val label = listOf(p.name, p.address).filter { it.isNotBlank() }.distinct().joinToString(", ")
        _ui.update { it.copy(address = label.ifBlank { it.address }, lat = p.lat, lng = p.lng, pinSource = "search", results = emptyList()) }
    }

    fun useMyLocation(lat: Double, lng: Double) {
        _ui.update { it.copy(lat = lat, lng = lng, pinSource = "gps", error = null) }
        if (_ui.value.address.isBlank()) {
            viewModelScope.launch {
                val r = apiCall { api.geoReverse(lat, lng) }
                val place = (r as? ApiResult.Success)?.value?.place
                if (place != null && _ui.value.address.isBlank()) _ui.update { it.copy(address = place.address.ifBlank { place.name }) }
            }
        }
    }

    fun locationUnavailable() = _ui.update { it.copy(error = UiText.res(R.string.booking_location_unavailable)) }

    fun submit() {
        val s = _ui.value
        val err = when {
            s.phone.count { it.isDigit() } < 7 -> UiText.res(R.string.booking_phone_required)
            s.lookup?.exists != true && s.name.isBlank() -> UiText.res(R.string.booking_name_required)
            s.packageId == null -> UiText.res(R.string.booking_package_required)
            s.address.isBlank() -> UiText.res(R.string.booking_address_required)
            s.lat == null || s.lng == null -> UiText.res(R.string.booking_pin_required)
            else -> null
        }
        if (err != null) {
            _ui.update { it.copy(error = err) }
            return
        }
        val lat = s.lat ?: return
        val lng = s.lng ?: return
        val packageId = s.packageId ?: return
        _ui.update { it.copy(submitting = true, error = null) }
        viewModelScope.launch {
            val body = DriverBookingRequest(
                phone = s.phone.trim(),
                customerName = s.name.trim().ifBlank { null },
                packageId = packageId,
                quantity = s.quantity,
                location = DeliveryLocation(lat = lat, lng = lng, address = s.address.trim(), notes = s.notes.trim().ifBlank { null }),
                paymentMethod = s.paymentMethod,
                msisdn = if (s.paymentMethod == "cellmoney") s.msisdn.trim().ifBlank { null } else null,
                transferReference = if (s.paymentMethod == "bank_transfer") s.transferReference.trim().ifBlank { null } else null,
            )
            when (val r = apiCall { api.book(idempotencyKey, body) }) {
                is ApiResult.Success -> _ui.update { it.copy(submitting = false, bookedOrderId = r.value.id) }
                is ApiResult.Failure -> _ui.update { it.copy(submitting = false, error = r.error.toUiText()) }
            }
        }
    }
}

@Composable
fun BookingScreen(onBack: () -> Unit, onBooked: (String) -> Unit) {
    val vm = containerViewModel { c -> BookingViewModel(c.repository.api) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    LaunchedEffect(ui.bookedOrderId) { ui.bookedOrderId?.let(onBooked) }

    fun locate() {
        scope.launch {
            val loc = LocationHelper.currentLocation(context)
            if (loc == null) vm.locationUnavailable() else vm.useMyLocation(loc.latitude, loc.longitude)
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted.values.any { it }) locate() else vm.locationUnavailable()
    }

    ScreenScaffold(title = stringResource(R.string.booking_title), onBack = onBack) {
        if (ui.loading) {
            Row(Modifier.fillMaxWidth().padding(32.dp), horizontalArrangement = Arrangement.Center) { CircularProgressIndicator() }
            return@ScreenScaffold
        }
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.booking_intro), style = MaterialTheme.typography.bodyMedium)

            // ── Customer ──
            SectionTitle(stringResource(R.string.booking_customer))
            OutlinedTextField(
                ui.phone,
                vm::onPhone,
                label = { Text(stringResource(R.string.booking_phone)) },
                placeholder = { Text("7xxx xxxx") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                singleLine = true,
                modifier = Modifier.fillMaxWidth().testTag("booking-phone"),
                supportingText = {
                    val l = ui.lookup
                    Text(
                        when {
                            ui.lookingUp -> stringResource(R.string.booking_checking)
                            l == null -> stringResource(R.string.booking_phone_help)
                            l.exists -> stringResource(R.string.booking_existing, l.name ?: l.phone)
                            else -> stringResource(R.string.booking_new_customer)
                        },
                    )
                },
            )
            OutlinedTextField(
                ui.name,
                vm::onName,
                label = { Text(stringResource(R.string.booking_name)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            // ── Water ──
            SectionTitle(stringResource(R.string.booking_water))
            val options = ui.options
            if (options?.packages.isNullOrEmpty()) {
                Text(stringResource(R.string.booking_no_packages), color = MaterialTheme.colorScheme.error)
            }
            options?.truck?.let { Text(stringResource(R.string.booking_truck, it.plate, it.capacityLitres), style = MaterialTheme.typography.bodySmall) }
            for (p in options?.packages.orEmpty()) {
                Row(
                    Modifier.fillMaxWidth().selectable(selected = ui.packageId == p.id, onClick = { vm.onPackage(p.id) }).padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = ui.packageId == p.id, onClick = { vm.onPackage(p.id) })
                    Text("${p.name} · ${Money.format(p.priceToea)}", modifier = Modifier.weight(1f))
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.booking_quantity), modifier = Modifier.weight(1f))
                OutlinedButton(onClick = { vm.onQuantity(-1) }, enabled = ui.quantity > 1) { Text("−") }
                Text("${ui.quantity}", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp))
                OutlinedButton(onClick = { vm.onQuantity(1) }) { Text("+") }
            }

            // ── Where ──
            SectionTitle(stringResource(R.string.booking_where))
            OutlinedTextField(
                ui.address,
                vm::onAddress,
                label = { Text(stringResource(if (ui.searchEnabled) R.string.booking_address_search else R.string.booking_address)) },
                modifier = Modifier.fillMaxWidth(),
                trailingIcon = { if (ui.searching) CircularProgressIndicator(Modifier.width(20.dp), strokeWidth = 2.dp) },
            )
            if (ui.results.isNotEmpty()) {
                Card(Modifier.fillMaxWidth()) {
                    Column {
                        ui.results.take(5).forEachIndexed { i, p ->
                            if (i > 0) HorizontalDivider()
                            Column(Modifier.fillMaxWidth().clickable { vm.pickPlace(p) }.padding(12.dp)) {
                                Text(p.name.ifBlank { p.address }, style = MaterialTheme.typography.bodyLarge)
                                if (p.name.isNotBlank() && p.address.isNotBlank()) Text(p.address, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { if (LocationHelper.hasPermission(context)) locate() else permission.launch(LocationHelper.PERMISSIONS) }) {
                    Text(stringResource(R.string.booking_use_my_location))
                }
                Spacer(Modifier.width(8.dp))
                Text(
                    when (ui.pinSource) {
                        "gps" -> stringResource(R.string.booking_pin_gps)
                        "search" -> stringResource(R.string.booking_pin_search)
                        else -> stringResource(R.string.booking_pin_none)
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = if (ui.lat == null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            OutlinedTextField(ui.notes, vm::onNotes, label = { Text(stringResource(R.string.booking_notes)) }, modifier = Modifier.fillMaxWidth())

            // ── Payment ──
            SectionTitle(stringResource(R.string.booking_payment))
            val company = ui.lookup?.company
            val methods = listOf("cod", "cellmoney", "bank_transfer") + if (company != null) listOf("account") else emptyList()
            for (m in methods) {
                Row(
                    Modifier.fillMaxWidth().selectable(selected = ui.paymentMethod == m, onClick = { vm.onPayment(m) }).padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = ui.paymentMethod == m, onClick = { vm.onPayment(m) })
                    Text(
                        when (m) {
                            "account" -> stringResource(R.string.booking_pay_account, company?.name.orEmpty())
                            "cellmoney" -> stringResource(R.string.booking_pay_cellmoney)
                            "bank_transfer" -> stringResource(R.string.booking_pay_bank)
                            else -> stringResource(R.string.booking_pay_cash)
                        },
                    )
                }
            }
            if (ui.paymentMethod == "cellmoney") {
                Text(stringResource(R.string.booking_pay_cellmoney_help), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(
                    ui.msisdn,
                    vm::onMsisdn,
                    label = { Text(stringResource(R.string.booking_pay_cellmoney_number)) },
                    placeholder = { Text(ui.phone) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (ui.paymentMethod == "bank_transfer") {
                Text(stringResource(R.string.booking_pay_bank_help), style = MaterialTheme.typography.bodySmall)
                options?.bankInstructions?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                OutlinedTextField(
                    ui.transferReference,
                    vm::onTransferReference,
                    label = { Text(stringResource(R.string.booking_pay_bank_reference)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            ui.totalToea?.let {
                Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                    Text(stringResource(R.string.booking_total, Money.format(it)), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(16.dp))
                }
            }
            ui.error?.let { Text(it.asString(), color = MaterialTheme.colorScheme.error) }
            Button(onClick = vm::submit, enabled = !ui.submitting && !options?.packages.isNullOrEmpty(), modifier = Modifier.fillMaxWidth().testTag("booking-submit")) {
                Text(stringResource(if (ui.submitting) R.string.booking_booking else R.string.booking_submit))
            }
            Text(stringResource(R.string.booking_footer), style = MaterialTheme.typography.bodySmall)
        }
    }
}
