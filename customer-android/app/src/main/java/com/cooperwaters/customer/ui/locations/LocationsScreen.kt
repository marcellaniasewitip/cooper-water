package com.cooperwaters.customer.ui.locations

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.EmptyState
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.SavedLocation
import com.cooperwaters.core.net.apiResponse
import com.cooperwaters.customer.R
import com.cooperwaters.customer.data.CustomerRepository
import com.cooperwaters.customer.ui.common.ScreenScaffold
import com.cooperwaters.customer.ui.common.containerViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class LocationsState(
    val loading: Boolean = true,
    val items: List<SavedLocation> = emptyList(),
    val error: UiText? = null,
)

class LocationsViewModel(private val repo: CustomerRepository) : ViewModel() {
    private val _state = MutableStateFlow(LocationsState())
    val state: StateFlow<LocationsState> = _state.asStateFlow()

    fun refresh() {
        _state.update { it.copy(loading = true) }
        viewModelScope.launch {
            val l = repo.locations()
            _state.update { it.copy(loading = false, items = l.value.orEmpty(), error = if (l.value == null) l.error?.toUiText() else null) }
        }
    }

    fun delete(id: String) {
        viewModelScope.launch {
            when (val r = apiResponse { repo.api.deleteLocation(id) }) {
                is ApiResult.Success -> refresh()
                is ApiResult.Failure -> _state.update { it.copy(error = r.error.toUiText()) }
            }
        }
    }
}

@Composable
fun LocationsScreen(onEdit: (String?) -> Unit, bottomBar: @Composable () -> Unit) {
    val vm = containerViewModel { c -> LocationsViewModel(c.repository) }
    val state by vm.state.collectAsStateWithLifecycle()
    var confirmDelete by remember { mutableStateOf<SavedLocation?>(null) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }

    ScreenScaffold(
        title = stringResource(R.string.locations_title),
        bottomBar = bottomBar,
        actions = {
            IconButton(onClick = { onEdit(null) }) { Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.locations_add)) }
        },
    ) {
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        ErrorCard(state.error, Modifier.padding(16.dp), onRetry = vm::refresh)
        if (!state.loading && state.items.isEmpty()) {
            EmptyState(
                stringResource(R.string.locations_empty),
                icon = Icons.Filled.LocationOn,
                actionLabel = stringResource(R.string.locations_add),
                onAction = { onEdit(null) },
            )
        }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.items, key = { it.id }) { loc ->
                Card(Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.LocationOn, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(loc.label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                            Text(loc.addressText, style = MaterialTheme.typography.bodyMedium)
                            if (loc.landmarkNotes.isNotBlank()) {
                                Text(stringResource(R.string.locations_landmark, loc.landmarkNotes), style = MaterialTheme.typography.bodySmall)
                            }
                        }
                        IconButton(onClick = { onEdit(loc.id) }) { Icon(Icons.Filled.Edit, contentDescription = stringResource(R.string.action_edit)) }
                        IconButton(onClick = { confirmDelete = loc }) { Icon(Icons.Filled.Delete, contentDescription = stringResource(R.string.action_delete)) }
                    }
                }
            }
        }
    }

    confirmDelete?.let { loc ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text(stringResource(R.string.locations_delete_title)) },
            text = { Text(stringResource(R.string.locations_delete_body, loc.label)) },
            confirmButton = {
                TextButton(onClick = {
                    vm.delete(loc.id)
                    confirmDelete = null
                }) { Text(stringResource(R.string.action_delete)) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}
