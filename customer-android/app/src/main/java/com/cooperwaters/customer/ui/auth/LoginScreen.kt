package com.cooperwaters.customer.ui.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cooperwaters.core.android.auth.LoginState
import com.cooperwaters.core.android.auth.LoginViewModel
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.LoadingButton
import com.cooperwaters.core.net.OtpChannels
import com.cooperwaters.customer.BuildConfig
import com.cooperwaters.customer.DebugSettings
import com.cooperwaters.customer.R
import com.cooperwaters.customer.ui.common.appContainer
import com.cooperwaters.customer.ui.common.containerViewModel
import kotlinx.coroutines.delay

/** Phone number entry + OTP code entry. [onSignedIn] gets true when the user still needs to set a name. */
@Composable
fun LoginScreen(onSignedIn: (needsName: Boolean) -> Unit) {
    val container = appContainer()
    val vm = containerViewModel { c ->
        LoginViewModel(c.api.authApi, app = "customer", onSignedIn = { auth ->
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
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Spacer(Modifier.height(32.dp))
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
            Text(stringResource(R.string.login_tagline), style = MaterialTheme.typography.bodyLarge)
            when (state.step) {
                LoginState.Step.PHONE -> {
                    OutlinedTextField(
                        value = state.phone,
                        onValueChange = vm::onPhoneChanged,
                        label = { Text(stringResource(R.string.login_phone_label)) },
                        placeholder = { Text(stringResource(R.string.login_phone_hint)) },
                        supportingText = { Text(stringResource(R.string.login_phone_support)) },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    ErrorCard(state.error)
                    LoadingButton(stringResource(R.string.login_send_code), state.loading, vm::requestCode, Modifier.fillMaxWidth())
                }
                LoginState.Step.CODE -> {
                    Text(
                        stringResource(
                            if (state.channel == OtpChannels.WHATSAPP) R.string.login_code_sent_whatsapp else R.string.login_code_sent,
                            state.normalisedPhone,
                        ),
                    )
                    if (state.smsFallbackSent) {
                        Text(stringResource(R.string.login_code_sent_sms_too), style = MaterialTheme.typography.bodySmall)
                    }
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
                    if (state.canSendBySms) {
                        TextButton(onClick = vm::sendBySms, enabled = !state.loading) { Text(stringResource(R.string.login_send_by_sms)) }
                    }
                    TextButton(onClick = vm::requestCode, enabled = state.resendInSec == 0 && !state.loading) {
                        Text(
                            if (state.resendInSec > 0) stringResource(R.string.login_resend_in, state.resendInSec)
                            else stringResource(R.string.login_resend),
                        )
                    }
                    TextButton(onClick = vm::backToPhone) { Text(stringResource(R.string.login_change_number)) }
                }
            }
            if (BuildConfig.DEBUG) DebugServerField()
        }
    }
}

@Composable
private fun DebugServerField() {
    val context = LocalContext.current
    val container = appContainer()
    var url by rememberSaveable { mutableStateOf(container.baseUrl) }
    var saved by remember { mutableStateOf(false) }
    HorizontalDivider()
    Text(stringResource(R.string.debug_server_title), style = MaterialTheme.typography.labelLarge)
    OutlinedTextField(
        value = url,
        onValueChange = { url = it; saved = false },
        label = { Text(stringResource(R.string.debug_server_label)) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    TextButton(onClick = {
        DebugSettings.setBaseUrlOverride(context, url)
        saved = true
    }) { Text(stringResource(R.string.debug_server_save)) }
    if (saved) Text(stringResource(R.string.debug_server_restart), style = MaterialTheme.typography.bodySmall)
}
