package com.cooperwaters.core.android.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.AuthApi
import com.cooperwaters.core.net.AuthResponse
import com.cooperwaters.core.net.ErrorCodes
import com.cooperwaters.core.net.OtpChannels
import com.cooperwaters.core.net.OtpRequest
import com.cooperwaters.core.net.OtpResendSmsRequest
import com.cooperwaters.core.net.OtpVerifyRequest
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.core.R
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class LoginState(
    val step: Step = Step.PHONE,
    val phone: String = "",
    /** E.164 phone as normalised by the server. */
    val normalisedPhone: String = "",
    val code: String = "",
    val loading: Boolean = false,
    val error: UiText? = null,
    val resendInSec: Int = 0,
    /** Where the current code was sent: [OtpChannels.WHATSAPP] or [OtpChannels.SMS]. */
    val channel: String = OtpChannels.SMS,
    /** The current WhatsApp code was also re-sent by SMS. */
    val smsFallbackSent: Boolean = false,
) {
    val canSendBySms: Boolean get() = step == Step.CODE && channel == OtpChannels.WHATSAPP && !smsFallbackSent

    enum class Step { PHONE, CODE }
}

/**
 * Phone entry → one-time code (WhatsApp first when the server has it enabled, else SMS) → tokens.
 * Same flow (with app="driver") in the driver app.
 */
class LoginViewModel(
    private val authApi: AuthApi,
    private val app: String,
    private val onSignedIn: (AuthResponse) -> Unit,
) : ViewModel() {
    private val _state = MutableStateFlow(LoginState())
    val state: StateFlow<LoginState> = _state.asStateFlow()

    fun onPhoneChanged(v: String) = _state.update { it.copy(phone = v.filter { c -> c.isDigit() || c == '+' || c == ' ' }.take(20), error = null) }

    fun onCodeChanged(v: String) = _state.update { it.copy(code = v.filter(Char::isDigit).take(6), error = null) }

    fun backToPhone() = _state.update { it.copy(step = LoginState.Step.PHONE, code = "", error = null) }

    fun requestCode() {
        val phone = _state.value.phone.replace(" ", "")
        if (phone.length < 7) {
            _state.update { it.copy(error = UiText.res(R.string.cw_login_phone_invalid)) }
            return
        }
        if (_state.value.loading) return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            when (val r = apiCall { authApi.requestOtp(OtpRequest(phone)) }) {
                is ApiResult.Success -> _state.update {
                    it.copy(
                        loading = false,
                        step = LoginState.Step.CODE,
                        normalisedPhone = r.value.phone,
                        code = "",
                        resendInSec = 30,
                        channel = r.value.channel,
                        smsFallbackSent = false,
                    )
                }
                is ApiResult.Failure -> _state.update { it.copy(loading = false, error = r.error.toUiText()) }
            }
        }
    }

    /** "Send by SMS instead": the same code, re-sent by SMS once. */
    fun sendBySms() {
        val s = _state.value
        if (!s.canSendBySms || s.loading) return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            val phone = s.normalisedPhone.ifBlank { s.phone.replace(" ", "") }
            when (val r = apiCall { authApi.resendOtpBySms(OtpResendSmsRequest(phone)) }) {
                is ApiResult.Success -> _state.update { it.copy(loading = false, smsFallbackSent = true) }
                is ApiResult.Failure -> _state.update { it.copy(loading = false, error = r.error.toUiText()) }
            }
        }
    }

    fun verify() {
        val s = _state.value
        if (s.code.length != 6) {
            _state.update { it.copy(error = UiText.res(R.string.cw_login_code_invalid)) }
            return
        }
        if (s.loading) return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            val phone = s.normalisedPhone.ifBlank { s.phone.replace(" ", "") }
            when (val r = apiCall { authApi.verifyOtp(OtpVerifyRequest(phone = phone, code = s.code, app = app)) }) {
                is ApiResult.Success -> {
                    _state.update { it.copy(loading = false) }
                    onSignedIn(r.value)
                }
                is ApiResult.Failure -> _state.update {
                    val msg = if (r.error.hasCode(ErrorCodes.OTP_INVALID) && r.error.message == null) UiText.res(R.string.cw_login_code_wrong) else r.error.toUiText()
                    it.copy(loading = false, error = msg, code = "")
                }
            }
        }
    }

    fun tickResend() = _state.update { if (it.resendInSec > 0) it.copy(resendInSec = it.resendInSec - 1) else it }
}
