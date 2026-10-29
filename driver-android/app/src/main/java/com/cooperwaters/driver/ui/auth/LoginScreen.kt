package com.cooperwaters.driver.ui.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cooperwaters.core.android.auth.LoginState
import com.cooperwaters.core.android.auth.LoginViewModel
import com.cooperwaters.core.android.ui.CwIcons
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.LoadingButton
import com.cooperwaters.driver.R
import com.cooperwaters.driver.ui.common.appContainer
import com.cooperwaters.driver.ui.common.containerViewModel
import kotlinx.coroutines.delay

/** Phone number entry + OTP code entry. [onSignedIn] gets true when the user still needs to set a name. */
@Composable
fun LoginScreen(onSignedIn: (needsName: Boolean) -> Unit) {
    val container = appContainer()
    val vm = containerViewModel { c ->
        LoginViewModel(c.api.authApi, app = "driver", onSignedIn = { auth ->
            c.onSignedIn(auth)
        })
    }
    val state by vm.state.collectAsStateWithLifecycle()
    var signedInNeedsName by remember { mutableStateOf<Boolean?>(null) }
    val loggedIn by container.loggedIn.collectAsStateWithLifecycle()

    LaunchedEffect(loggedIn) {
        if (loggedIn) {
            signedInNeedsName = container.tokenStore.user()?.name.isNullOrBlank()
        }
    }
    LaunchedEffect(signedInNeedsName) { signedInNeedsName?.let(onSignedIn) }
    LaunchedEffect(state.step, state.resendInSec) {
        if (state.resendInSec > 0) {
            delay(1_000)
            vm.tickResend()
        }
    }

    Scaffold { padding ->
        // Centred on the screen; scrolls (and stays clear of the keyboard) on small phones.
        BoxWithConstraints(Modifier.fillMaxSize().padding(padding).imePadding()) {
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).heightIn(min = maxHeight).padding(horizontal = 24.dp, vertical = 32.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primary, modifier = Modifier.size(72.dp)) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(CwIcons.WaterDrop, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(40.dp))
                    }
                }
                Text(
                    stringResource(R.string.app_name),
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.primary,
                    textAlign = TextAlign.Center,
                )
                Text(
                    stringResource(R.string.login_tagline),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(8.dp))
                when (state.step) {
                    LoginState.Step.PHONE -> {
                        OutlinedTextField(
                            value = state.phone,
                            onValueChange = vm::onPhoneChanged,
                            label = { Text(stringResource(R.string.login_phone_label)) },
                            placeholder = { Text(stringResource(R.string.login_phone_hint)) },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        ErrorCard(state.error)
                        LoadingButton(stringResource(R.string.login_send_code), state.loading, vm::requestCode, Modifier.fillMaxWidth())
                    }
                    LoginState.Step.CODE -> {
                        Text(stringResource(R.string.login_code_sent, state.normalisedPhone), textAlign = TextAlign.Center)
                        OutlinedTextField(
                            value = state.code,
                            onValueChange = vm::onCodeChanged,
                            label = { Text(stringResource(R.string.login_code_label)) },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        ErrorCard(state.error)
                        LoadingButton(stringResource(R.string.login_verify), state.loading, vm::verify, Modifier.fillMaxWidth())
                        TextButton(onClick = vm::requestCode, enabled = state.resendInSec == 0 && !state.loading) {
                            Text(
                                if (state.resendInSec > 0) stringResource(R.string.login_resend_in, state.resendInSec)
                                else stringResource(R.string.login_resend),
                            )
                        }
                        TextButton(onClick = vm::backToPhone) { Text(stringResource(R.string.login_change_number)) }
                    }
                }
            }
        }
    }
}
