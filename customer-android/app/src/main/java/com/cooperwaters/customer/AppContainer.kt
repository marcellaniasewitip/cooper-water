package com.cooperwaters.customer

import android.content.Context
import com.cooperwaters.core.android.AndroidConnectivityMonitor
import com.cooperwaters.core.android.EncryptedTokenStore
import com.cooperwaters.core.android.LogcatCrashReporter
import com.cooperwaters.core.android.PushSupport
import com.cooperwaters.core.cache.JsonCache
import com.cooperwaters.core.net.ApiClient
import com.cooperwaters.core.net.ApiConfig
import com.cooperwaters.core.net.AuthResponse
import com.cooperwaters.core.net.ConnectivityMonitor
import com.cooperwaters.core.net.PushTokenRequest
import com.cooperwaters.core.net.RefreshRequest
import com.cooperwaters.core.net.TokenPair
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.core.net.apiResponse
import com.cooperwaters.core.queue.FilePendingActionStore
import com.cooperwaters.core.queue.IdempotentRequestQueue
import com.cooperwaters.core.realtime.RealtimeClient
import com.cooperwaters.core.util.CrashReporter
import com.cooperwaters.customer.data.CustomerRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File

/** Manual DI: one instance per process, created in [CustomerApp.onCreate]. */
class AppContainer(private val context: Context) {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // TODO(sentry): swap for a Sentry-backed CrashReporter once a DSN is provisioned.
    val crashReporter: CrashReporter = LogcatCrashReporter("CW-Customer")

    val baseUrl: String = BuildConfig.API_BASE_URL

    val tokenStore = EncryptedTokenStore(context, "cw_customer_session", crashReporter)

    private val _loggedIn = MutableStateFlow(tokenStore.refreshToken() != null)
    val loggedIn: StateFlow<Boolean> = _loggedIn.asStateFlow()

    val foreground = MutableStateFlow(false)

    val api = ApiClient(
        config = ApiConfig(baseUrl, "CooperWatersCustomer/${BuildConfig.VERSION_NAME} (Android)", debugLogging = BuildConfig.DEBUG),
        tokenStore = tokenStore,
        crashReporter = crashReporter,
        onSessionExpired = { onSessionEnded() },
    )

    val connectivity: ConnectivityMonitor = AndroidConnectivityMonitor(context)

    val queue = IdempotentRequestQueue(FilePendingActionStore(File(context.filesDir, "pending_actions.json")))

    val cache = JsonCache(File(context.filesDir, "cache"))

    val realtime = RealtimeClient(
        url = api.realtimeUrl,
        accessToken = { tokenStore.accessToken() },
        refreshToken = { failed -> api.tokenRefresher.refresh(failed) },
        scope = appScope,
        crashReporter = crashReporter,
    )

    val repository = CustomerRepository(api.customerApi, cache, queue, api.json)

    /** Push arrived (app may be in background): screens refresh what they show. */
    private val _pushEvents = MutableSharedFlow<Map<String, String>>(extraBufferCapacity = 8)
    val pushEvents: SharedFlow<Map<String, String>> = _pushEvents.asSharedFlow()
    fun onPush(data: Map<String, String>) {
        _pushEvents.tryEmit(data)
    }

    fun onSignedIn(auth: AuthResponse) {
        tokenStore.saveTokens(TokenPair(auth.accessToken, auth.refreshToken, auth.expiresIn))
        tokenStore.saveUser(auth.user)
        crashReporter.setUser(auth.user.id)
        _loggedIn.value = true
        appScope.launch { registerPushToken() }
    }

    fun registerPushToken(token: String? = null) {
        if (!_loggedIn.value) return
        if (token != null) {
            appScope.launch { apiResponse { api.customerApi.setPushToken(PushTokenRequest(token)) } }
        } else {
            PushSupport.fetchToken(context) { t -> registerPushToken(t) }
        }
    }

    /** User tapped "Sign out". */
    fun signOut() {
        val refresh = tokenStore.refreshToken()
        appScope.launch {
            apiResponse { api.customerApi.setPushToken(PushTokenRequest(null)) }
            if (refresh != null) apiCall { api.authApi.logout(RefreshRequest(refresh)) }
            PushSupport.deleteToken(context)
        }
        onSessionEnded()
    }

    private fun onSessionEnded() {
        tokenStore.clear()
        crashReporter.setUser(null)
        realtime.disconnect()
        _loggedIn.value = false
        appScope.launch { cache.clear() }
    }
}
