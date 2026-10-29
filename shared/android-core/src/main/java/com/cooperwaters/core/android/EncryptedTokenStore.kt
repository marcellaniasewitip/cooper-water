package com.cooperwaters.core.android

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.cooperwaters.core.auth.TokenStore
import com.cooperwaters.core.net.AuthUser
import com.cooperwaters.core.net.CwJson
import com.cooperwaters.core.net.TokenPair
import com.cooperwaters.core.util.CrashReporter

/**
 * Session tokens in EncryptedSharedPreferences (AES-256, key in the Android Keystore).
 * Some low-end devices have broken Keystore implementations; then we fall back to private
 * SharedPreferences (still app-private) rather than locking the user out, and report it.
 */
class EncryptedTokenStore(
    context: Context,
    fileName: String = "cw_session",
    crashReporter: CrashReporter = CrashReporter.NoOp,
) : TokenStore {
    private val prefs: SharedPreferences = openEncrypted(context, fileName, crashReporter)
        ?: context.getSharedPreferences(fileName + "_plain", Context.MODE_PRIVATE)

    @Volatile private var cachedAccess: String? = prefs.getString(KEY_ACCESS, null)

    override fun accessToken(): String? = cachedAccess

    override fun refreshToken(): String? = prefs.getString(KEY_REFRESH, null)

    override fun user(): AuthUser? = prefs.getString(KEY_USER, null)?.let {
        try {
            CwJson.decodeFromString(AuthUser.serializer(), it)
        } catch (e: Exception) {
            null
        }
    }

    @Synchronized
    override fun saveTokens(pair: TokenPair) {
        cachedAccess = pair.accessToken
        // commit(): the rotated refresh token must be on disk before we use it, or a crash loses the session.
        prefs.edit().putString(KEY_ACCESS, pair.accessToken).putString(KEY_REFRESH, pair.refreshToken).commit()
    }

    @Synchronized
    override fun saveUser(user: AuthUser) {
        prefs.edit().putString(KEY_USER, CwJson.encodeToString(AuthUser.serializer(), user)).apply()
    }

    @Synchronized
    override fun clear() {
        cachedAccess = null
        prefs.edit().clear().commit()
    }

    private companion object {
        /**
         * The Android Keystore occasionally fails transiently right after boot or an update on some phones.
         * One retry avoids falling back to an empty store, which would sign the user out for no reason.
         */
        fun openEncrypted(context: Context, fileName: String, crashReporter: CrashReporter): SharedPreferences? {
            repeat(2) { attempt ->
                try {
                    val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
                    return EncryptedSharedPreferences.create(
                        context,
                        fileName,
                        masterKey,
                        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
                    )
                } catch (e: Exception) {
                    crashReporter.recordException(e, mapOf("where" to "encrypted_prefs", "attempt" to attempt.toString()))
                    if (attempt == 0) Thread.sleep(150)
                }
            }
            return null
        }


        const val KEY_ACCESS = "access"
        const val KEY_REFRESH = "refresh"
        const val KEY_USER = "user"
    }
}
