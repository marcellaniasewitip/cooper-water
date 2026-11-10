package com.cooperwaters.customer.ui.referral

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.CwIcons
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.LoadingButton
import com.cooperwaters.core.android.ui.SectionTitle
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.money.Money
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.CustomerApi
import com.cooperwaters.core.net.ReferralApplyRequest
import com.cooperwaters.core.net.ReferralInfo
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.customer.R
import com.cooperwaters.customer.ui.common.ScreenScaffold
import com.cooperwaters.customer.ui.common.containerViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ReferralUi(
    val loading: Boolean = true,
    val info: ReferralInfo? = null,
    val friendCode: String = "",
    val applying: Boolean = false,
    val error: UiText? = null,
    val applied: Boolean = false,
)

class ReferralViewModel(private val api: CustomerApi) : ViewModel() {
    private val _ui = MutableStateFlow(ReferralUi())
    val ui: StateFlow<ReferralUi> = _ui.asStateFlow()

    init {
        viewModelScope.launch {
            val r = apiCall { api.referral() }
            _ui.update { it.copy(loading = false, info = (r as? ApiResult.Success)?.value, error = (r as? ApiResult.Failure)?.error?.toUiText()) }
        }
    }

    fun onFriendCode(v: String) = _ui.update { it.copy(friendCode = v.uppercase().filter(Char::isLetterOrDigit).take(20), error = null) }

    fun apply() {
        val code = _ui.value.friendCode
        if (code.length < 4 || _ui.value.applying) return
        _ui.update { it.copy(applying = true, error = null) }
        viewModelScope.launch {
            when (val r = apiCall { api.applyReferral(ReferralApplyRequest(code)) }) {
                is ApiResult.Success -> _ui.update { it.copy(applying = false, info = r.value, applied = true, friendCode = "") }
                is ApiResult.Failure -> _ui.update { it.copy(applying = false, error = r.error.toUiText()) }
            }
        }
    }
}

/** Refer & Earn: share your code; both you and your friend get wallet credit after their first delivery. */
@Composable
fun ReferralScreen(onBack: () -> Unit) {
    val vm = containerViewModel { c -> ReferralViewModel(c.api.customerApi) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current
    ScreenScaffold(title = stringResource(R.string.referral_title), onBack = onBack) {
        if (ui.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            val info = ui.info
            if (info != null) {
                val reward = Money.format(info.rewardToea)
                Card(colors = CardDefaults.cardColors(containerColor = Color.Black, contentColor = Color.White), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Icon(CwIcons.WaterDrop, contentDescription = null, tint = Color(0xFF4FC3F7), modifier = Modifier.size(48.dp))
                        Text(stringResource(R.string.referral_headline, reward), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                        Text(stringResource(R.string.referral_body, reward), textAlign = TextAlign.Center, color = Color.White.copy(alpha = 0.85f))
                        Text(stringResource(R.string.referral_your_code), color = Color.White.copy(alpha = 0.7f), style = MaterialTheme.typography.labelLarge)
                        Text(info.code, fontSize = 30.sp, fontWeight = FontWeight.Bold, letterSpacing = 3.sp)
                        Button(onClick = {
                            val text = context.getString(R.string.referral_share_text, reward, info.code)
                            val send = Intent(Intent.ACTION_SEND).apply {
                                type = "text/plain"
                                putExtra(Intent.EXTRA_TEXT, text)
                            }
                            context.startActivity(Intent.createChooser(send, context.getString(R.string.referral_share)))
                        }, colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Color.Black)) {
                            Icon(Icons.Filled.Share, contentDescription = null)
                            Text(stringResource(R.string.referral_share), modifier = Modifier.padding(start = 8.dp))
                        }
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                    Stat(info.invitedCount.toString(), stringResource(R.string.referral_invited))
                    Stat(Money.format(info.earnedToea), stringResource(R.string.referral_earned))
                }
                if (!info.enabled) Text(stringResource(R.string.referral_paused), color = MaterialTheme.colorScheme.error)
                if (info.canApplyCode) {
                    SectionTitle(stringResource(R.string.referral_have_code))
                    OutlinedTextField(
                        value = ui.friendCode,
                        onValueChange = vm::onFriendCode,
                        placeholder = { Text(stringResource(R.string.referral_friend_code_hint)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    LoadingButton(stringResource(R.string.referral_apply), ui.applying, vm::apply, Modifier.fillMaxWidth())
                } else {
                    info.referredByCode?.let { byCode ->
                        Text(stringResource(if (ui.applied) R.string.referral_applied else R.string.referral_used, byCode, reward), color = MaterialTheme.colorScheme.secondary)
                    }
                }
            }
            ErrorCard(ui.error)
        }
    }
}

@Composable
private fun Stat(value: String, label: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
