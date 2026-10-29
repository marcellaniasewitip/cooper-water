package com.cooperwaters.driver.ui.profile

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.LoadingButton
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.UpdateProfileRequest
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.driver.R
import com.cooperwaters.driver.ui.common.ScreenScaffold
import com.cooperwaters.driver.ui.common.appContainer
import kotlinx.coroutines.launch

/** Name (needed on first sign-in), phone, rating, sign out. */
@Composable
fun ProfileScreen(onboarding: Boolean, onDone: () -> Unit, bottomBar: (@Composable () -> Unit)? = null) {
    val container = appContainer()
    val user = container.tokenStore.user()
    var name by rememberSaveable { mutableStateOf(user?.name.orEmpty()) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<UiText?>(null) }
    var saved by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val profile = container.state.profile.value
    LaunchedEffect(Unit) { container.state.refreshProfile() }

    ScreenScaffold(title = stringResource(R.string.profile_title), onBack = if (onboarding || bottomBar != null) null else onDone, bottomBar = bottomBar) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (onboarding) Text(stringResource(R.string.profile_welcome_body))
            OutlinedTextField(name, { name = it.take(80); error = null; saved = false }, label = { Text(stringResource(R.string.profile_name_label)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Text(stringResource(R.string.profile_phone, user?.phone.orEmpty()), style = MaterialTheme.typography.bodyMedium)
            profile?.takeIf { it.ratingCount > 0 }?.let { Text(stringResource(R.string.profile_rating, it.ratingAvg, it.ratingCount)) }
            ErrorCard(error)
            if (saved) Text(stringResource(R.string.profile_saved), color = MaterialTheme.colorScheme.primary)
            LoadingButton(stringResource(R.string.action_save), saving, {
                if (name.isBlank()) {
                    error = UiText.res(R.string.profile_name_required)
                } else {
                    saving = true
                    scope.launch {
                        when (val r = apiCall { container.api.driverApi.updateMe(UpdateProfileRequest(name.trim())) }) {
                            is ApiResult.Success -> {
                                user?.let { container.tokenStore.saveUser(it.copy(name = r.value.name)) }
                                container.state.setProfile(r.value)
                                saving = false
                                // As a tab there is nowhere to go back to: confirm in place instead.
                                if (bottomBar == null) onDone() else saved = true
                            }
                            is ApiResult.Failure -> {
                                saving = false
                                error = r.error.toUiText()
                            }
                        }
                    }
                }
            }, Modifier.fillMaxWidth())
            if (!onboarding) {
                OutlinedButton(onClick = { container.signOut() }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.profile_sign_out)) }
            }
        }
    }
}
