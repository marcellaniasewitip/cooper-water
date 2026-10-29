package com.cooperwaters.customer.ui.profile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.LoadingButton
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.auth.TokenStore
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.CustomerApi
import com.cooperwaters.core.net.UpdateProfileRequest
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.customer.R
import com.cooperwaters.customer.ui.common.ScreenScaffold
import com.cooperwaters.customer.ui.common.appContainer
import com.cooperwaters.customer.ui.common.containerViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ProfileState(
    val name: String = "",
    val phone: String = "",
    val saving: Boolean = false,
    val saved: Boolean = false,
    val error: UiText? = null,
)

class ProfileViewModel(private val api: CustomerApi, private val tokenStore: TokenStore) : ViewModel() {
    private val _state = MutableStateFlow(
        ProfileState(name = tokenStore.user()?.name.orEmpty(), phone = tokenStore.user()?.phone.orEmpty()),
    )
    val state: StateFlow<ProfileState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            (apiCall { api.me() } as? ApiResult.Success)?.value?.let { me ->
                _state.update { s -> s.copy(name = if (s.name.isBlank()) me.name.orEmpty() else s.name, phone = me.phone) }
            }
        }
    }

    fun onName(v: String) = _state.update { it.copy(name = v.take(80), error = null, saved = false) }

    fun save() {
        val name = _state.value.name.trim()
        if (name.isEmpty()) {
            _state.update { it.copy(error = UiText.res(R.string.profile_name_required)) }
            return
        }
        if (_state.value.saving) return
        _state.update { it.copy(saving = true, error = null) }
        viewModelScope.launch {
            when (val r = apiCall { api.updateMe(UpdateProfileRequest(name)) }) {
                is ApiResult.Success -> {
                    tokenStore.user()?.let { tokenStore.saveUser(it.copy(name = r.value.name)) }
                    _state.update { it.copy(saving = false, saved = true) }
                }
                is ApiResult.Failure -> _state.update { it.copy(saving = false, error = r.error.toUiText()) }
            }
        }
    }
}

@Composable
fun ProfileScreen(
    onboarding: Boolean,
    onDone: () -> Unit,
    showBack: Boolean,
    onBack: () -> Unit,
    bottomBar: (@Composable () -> Unit)? = null,
) {
    val container = appContainer()
    val vm = containerViewModel { c -> ProfileViewModel(c.api.customerApi, c.tokenStore) }
    val state by vm.state.collectAsStateWithLifecycle()
    // From the tab, saving shows a confirmation instead of leaving the screen.
    LaunchedEffect(state.saved) { if (state.saved && bottomBar == null) onDone() }

    ScreenScaffold(
        title = stringResource(if (onboarding) R.string.profile_welcome_title else R.string.profile_title),
        onBack = if (showBack) onBack else null,
        bottomBar = bottomBar,
    ) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (onboarding) Text(stringResource(R.string.profile_welcome_body), style = MaterialTheme.typography.bodyLarge)
            Card(Modifier.fillMaxWidth()) {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primary, modifier = Modifier.size(56.dp)) {
                        Box(contentAlignment = Alignment.Center) {
                            Text(
                                initials(state.name),
                                style = MaterialTheme.typography.titleLarge,
                                color = MaterialTheme.colorScheme.onPrimary,
                            )
                        }
                    }
                    Spacer(Modifier.width(16.dp))
                    Column {
                        Text(state.name.ifBlank { stringResource(R.string.profile_title) }, style = MaterialTheme.typography.titleMedium)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Filled.Phone, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(state.phone, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            OutlinedTextField(
                value = state.name,
                onValueChange = vm::onName,
                label = { Text(stringResource(R.string.profile_name_label)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            ErrorCard(state.error)
            if (state.saved && bottomBar != null) {
                Text(stringResource(R.string.profile_saved), color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
            }
            LoadingButton(stringResource(R.string.action_save), state.saving, vm::save, Modifier.fillMaxWidth())
            if (!onboarding) {
                OutlinedButton(
                    onClick = { container.signOut() },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.error),
                ) {
                    Icon(Icons.AutoMirrored.Filled.ExitToApp, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.profile_sign_out))
                }
            }
        }
    }
}

private fun initials(name: String): String =
    name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.take(2).joinToString("") { it.first().uppercase() }.ifEmpty { "?" }
