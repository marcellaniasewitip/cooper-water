package com.cooperwaters.customer.ui.locations

import kotlinx.coroutines.delay
import kotlinx.coroutines.Job
import com.cooperwaters.core.net.GeoPlace
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material.icons.filled.Search
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.clickable
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.LocationHelper
import com.cooperwaters.core.android.ui.CwMap
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.LoadingButton
import com.cooperwaters.core.android.ui.MapCenter
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.LocationRequest
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.core.util.Geo
import com.cooperwaters.customer.R
import com.cooperwaters.customer.data.CustomerRepository
import com.cooperwaters.customer.ui.common.ScreenScaffold
import com.cooperwaters.customer.ui.common.containerViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class LocationEditState(
    val id: String? = null,
    val label: String = "",
    val address: String = "",
    val notes: String = "",
    val lat: Double = Geo.POM_LAT,
    val lng: Double = Geo.POM_LNG,
    /** Bumped when the camera should jump (loaded / "use my location"), not on user pans. */
    val cameraVersion: Int = 0,
    val locating: Boolean = false,
    val saving: Boolean = false,
    val saved: Boolean = false,
    val error: UiText? = null,
    /** Google address search is set up on the server. */
    val searchAvailable: Boolean = false,
    val query: String = "",
    val results: List<GeoPlace> = emptyList(),
    val searching: Boolean = false,
    /** The address was filled from the map (so moving the pin may update it); false once the user types. */
    val addressFromMap: Boolean = false,
)

class LocationEditViewModel(private val repo: CustomerRepository, private val locationId: String?) : ViewModel() {
    private val _state = MutableStateFlow(LocationEditState(id = locationId))
    val state: StateFlow<LocationEditState> = _state.asStateFlow()

    private var searchJob: Job? = null
    private var reverseJob: Job? = null

    init {
        viewModelScope.launch {
            val ok = (apiCall { repo.api.geoStatus() } as? ApiResult.Success)?.value?.search == true
            _state.update { it.copy(searchAvailable = ok) }
        }
        if (locationId != null) {
            viewModelScope.launch {
                repo.locations().value?.firstOrNull { it.id == locationId }?.let { l ->
                    _state.update {
                        it.copy(label = l.label, address = l.addressText, notes = l.landmarkNotes, lat = l.lat, lng = l.lng, cameraVersion = it.cameraVersion + 1)
                    }
                }
            }
        }
    }

    fun onLabel(v: String) = _state.update { it.copy(label = v.take(50), error = null) }
    fun onAddress(v: String) = _state.update { it.copy(address = v.take(300), error = null, addressFromMap = false) }

    /** Address search (Google Places), debounced. */
    fun onQuery(v: String) {
        _state.update { it.copy(query = v.take(120)) }
        searchJob?.cancel()
        val q = v.trim()
        if (q.length < 2) {
            _state.update { it.copy(results = emptyList(), searching = false) }
            return
        }
        searchJob = viewModelScope.launch {
            delay(400)
            _state.update { it.copy(searching = true) }
            val s = _state.value
            val r = apiCall { repo.api.geoSearch(q, s.lat, s.lng) }
            _state.update { it.copy(searching = false, results = (r as? ApiResult.Success)?.value?.items ?: emptyList()) }
        }
    }

    /** Picked a search result: move the pin there and use its address. */
    fun pick(p: GeoPlace) {
        searchJob?.cancel()
        _state.update {
            it.copy(
                lat = p.lat,
                lng = p.lng,
                cameraVersion = it.cameraVersion + 1,
                address = p.address.ifBlank { p.name }.take(300),
                addressFromMap = true,
                label = it.label.ifBlank { p.name.take(50) },
                query = "",
                results = emptyList(),
            )
        }
    }

    /** Fill the address from the pin (Google reverse geocoding) unless the customer typed their own. */
    private fun lookupAddress(lat: Double, lng: Double) {
        val s = _state.value
        if (!s.searchAvailable || (s.address.isNotBlank() && !s.addressFromMap)) return
        reverseJob?.cancel()
        reverseJob = viewModelScope.launch {
            delay(700)
            val place = (apiCall { repo.api.geoReverse(lat, lng) } as? ApiResult.Success)?.value?.place ?: return@launch
            _state.update { st ->
                if (st.address.isNotBlank() && !st.addressFromMap) st else st.copy(address = place.address.ifBlank { place.name }.take(300), addressFromMap = true)
            }
        }
    }
    fun onNotes(v: String) = _state.update { it.copy(notes = v.take(500), error = null) }

    /** User panned the map: the pin (map centre) moved. */
    fun onPinMoved(lat: Double, lng: Double) {
        val before = _state.value
        _state.update { it.copy(lat = lat, lng = lng) }
        // Ignore tiny jitter (the map reports its centre when it settles).
        if (Math.abs(before.lat - lat) > 0.00005 || Math.abs(before.lng - lng) > 0.00005 || before.address.isBlank()) lookupAddress(lat, lng)
    }

    fun setLocating(b: Boolean) = _state.update { it.copy(locating = b) }

    fun jumpTo(lat: Double, lng: Double) = _state.update { it.copy(lat = lat, lng = lng, cameraVersion = it.cameraVersion + 1, locating = false) }

    fun locationUnavailable() = _state.update { it.copy(locating = false, error = UiText.res(R.string.location_unavailable)) }

    fun save() {
        val s = _state.value
        when {
            s.label.isBlank() -> { _state.update { it.copy(error = UiText.res(R.string.location_label_required)) }; return }
            s.address.isBlank() -> { _state.update { it.copy(error = UiText.res(R.string.location_address_required)) }; return }
            s.saving -> return
        }
        _state.update { it.copy(saving = true, error = null) }
        val body = LocationRequest(s.label.trim(), s.address.trim(), s.lat, s.lng, s.notes.trim())
        viewModelScope.launch {
            val r = if (s.id == null) apiCall { repo.api.addLocation(body) } else apiCall { repo.api.updateLocation(s.id, body) }
            when (r) {
                is ApiResult.Success -> {
                    repo.locations() // refresh cache
                    _state.update { it.copy(saving = false, saved = true) }
                }
                is ApiResult.Failure -> _state.update { it.copy(saving = false, error = r.error.toUiText()) }
            }
        }
    }
}

/** Saved delivery location: drag the map under the centre pin, then add address + landmark notes. */
@Composable
fun LocationEditScreen(locationId: String?, onDone: () -> Unit) {
    val vm = containerViewModel(key = "loc-$locationId") { c -> LocationEditViewModel(c.repository, locationId) }
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(state.saved) { if (state.saved) onDone() }

    fun locate() {
        vm.setLocating(true)
        scope.launch {
            val loc = LocationHelper.currentLocation(context)
            if (loc != null) vm.jumpTo(loc.latitude, loc.longitude) else vm.locationUnavailable()
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted.values.any { it }) locate() else vm.locationUnavailable()
    }

    ScreenScaffold(
        title = stringResource(if (locationId == null) R.string.location_new_title else R.string.location_edit_title),
        onBack = onDone,
    ) {
        run {
            Box(Modifier.fillMaxWidth().height(260.dp)) {
                // Re-key on cameraVersion so programmatic jumps move the camera but user pans don't fight it.
                androidx.compose.runtime.key(state.cameraVersion) {
                    CwMap(
                        modifier = Modifier.fillMaxWidth().height(260.dp),
                        center = MapCenter(state.lat, state.lng, 17.0),
                        onCenterChanged = vm::onPinMoved,
                    )
                }
                Icon(
                    Icons.Filled.LocationOn,
                    contentDescription = stringResource(R.string.location_pin),
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.align(Alignment.Center).padding(bottom = 36.dp).size(36.dp),
                )
            }
            Column(
                Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (state.searchAvailable) {
                    OutlinedTextField(
                        value = state.query,
                        onValueChange = vm::onQuery,
                        label = { Text(stringResource(R.string.location_search)) },
                        placeholder = { Text(stringResource(R.string.location_search_hint)) },
                        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                        trailingIcon = { if (state.searching) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    state.results.forEach { p ->
                        Row(
                            Modifier.fillMaxWidth().clickable { vm.pick(p) }.padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Filled.LocationOn, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                            Column(Modifier.padding(start = 10.dp)) {
                                Text(p.name, style = MaterialTheme.typography.bodyLarge)
                                if (p.address.isNotBlank() && p.address != p.name) Text(p.address, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
                Text(stringResource(R.string.location_drag_hint), style = MaterialTheme.typography.bodySmall)
                OutlinedButton(
                    onClick = { if (LocationHelper.hasPermission(context)) locate() else permission.launch(LocationHelper.PERMISSIONS) },
                    enabled = !state.locating,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(stringResource(if (state.locating) R.string.location_locating else R.string.location_use_mine)) }
                OutlinedTextField(state.label, vm::onLabel, label = { Text(stringResource(R.string.location_label)) }, placeholder = { Text(stringResource(R.string.location_label_hint)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(state.address, vm::onAddress, label = { Text(stringResource(R.string.location_address)) }, placeholder = { Text(stringResource(R.string.location_address_hint)) }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(
                    state.notes,
                    vm::onNotes,
                    label = { Text(stringResource(R.string.location_notes)) },
                    placeholder = { Text(stringResource(R.string.location_notes_hint)) },
                    supportingText = { Text(stringResource(R.string.location_notes_help)) },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
                ErrorCard(state.error)
                LoadingButton(stringResource(R.string.action_save), state.saving, vm::save, Modifier.fillMaxWidth())
            }
        }
    }
}
