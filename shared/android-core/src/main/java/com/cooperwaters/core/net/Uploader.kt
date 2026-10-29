package com.cooperwaters.core.net

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/**
 * Driver uploads: POST /driver/uploads → pre-signed PUT straight to S3 → caller submits the returned key.
 * If the PUT fails (some networks and proxies interfere with S3), the bytes go through the API instead
 * (POST /driver/uploads/direct), which stores them and returns a key the caller submits the same way.
 * Bytes should already be compressed (see core.android.ImageCompressor) — drivers are on 3G.
 */
class Uploader(
    private val driverApi: DriverApi,
    /** Must NOT add the bearer token (S3 pre-signed URLs reject extra auth). */
    private val plainHttp: OkHttpClient,
) {
    suspend fun upload(purpose: String, contentType: String, bytes: ByteArray): ApiResult<String> {
        val ticket = when (val t = apiCall { driverApi.requestUpload(UploadRequest(purpose, contentType, bytes.size.toLong())) }) {
            is ApiResult.Failure -> return t
            is ApiResult.Success -> t.value
        }
        val failure = putPresigned(ticket, contentType, bytes) ?: return ApiResult.Success(ticket.key)
        // Header values must be printable ASCII.
        val reason = failure.filter { it in ' '..'~' }.take(MAX_REASON)
        return apiCall { driverApi.uploadDirect(purpose, reason, bytes.toRequestBody(contentType.toMediaType())) }
            .map { it.key }
    }

    /** @return null on success, otherwise a short description of why S3 refused (sent to the API for the logs). */
    private suspend fun putPresigned(ticket: UploadTicket, contentType: String, bytes: ByteArray): String? = withContext(Dispatchers.IO) {
        try {
            val builder = Request.Builder().url(ticket.url)
            ticket.headers.forEach { (k, v) -> builder.header(k, v) }
            val body = bytes.toRequestBody((ticket.headers["Content-Type"] ?: contentType).toMediaType())
            builder.method(ticket.method.ifBlank { "PUT" }, body)
            plainHttp.newCall(builder.build()).execute().use { resp ->
                if (resp.isSuccessful) null else "S3 ${resp.code} ${resp.body?.string().orEmpty().replace(Regex("\\s+"), " ").take(MAX_REASON)}"
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            "network ${e.javaClass.simpleName}: ${e.message.orEmpty()}"
        }
    }

    object Purpose {
        const val DOCUMENT = "document"
        const val TOPUP_PROOF = "topup_proof"
        const val PROOF_OF_DELIVERY = "proof_of_delivery"
        const val TRUCK_PHOTO = "truck_photo"
    }

    private companion object {
        const val MAX_REASON = 300
    }
}
