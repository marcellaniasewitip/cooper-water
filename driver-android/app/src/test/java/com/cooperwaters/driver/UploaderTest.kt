package com.cooperwaters.driver

import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.Uploader
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.concurrent.CopyOnWriteArrayList

class UploaderTest {
    @get:Rule val tmp = TemporaryFolder()
    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val bodies = CopyOnWriteArrayList<ByteArray>()
    private var s3Status = 200

    @Before fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                bodies += request.body.readByteArray()
                val path = request.path.orEmpty()
                return when {
                    path.startsWith("/api/v1/driver/uploads/direct") -> json("""{"key":"driver-documents/me/direct.jpg"}""")
                    path == "/api/v1/driver/uploads" ->
                        json("""{"key":"driver-documents/me/presigned.jpg","url":"${server.url("/s3/put")}","method":"PUT","headers":{"Content-Type":"image/jpeg"}}""")
                    path.startsWith("/s3/put") -> MockResponse().setResponseCode(s3Status)
                        .setBody("<Error>\n  <Code>AccessDenied</Code>\n  <Message>Access Denied</Message>\n</Error>")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After fun tearDown() = server.shutdown()

    private val jpeg = byteArrayOf(-1, -40, -1, -32, 1, 2, 3)

    @Test fun presignedUploadReturnsTicketKey() = runBlocking {
        val result = TestEnv(server, tmp.root).uploader.upload(Uploader.Purpose.DOCUMENT, "image/jpeg", jpeg)
        assertEquals(ApiResult.Success("driver-documents/me/presigned.jpg"), result)
        assertTrue(requests.none { it.path.orEmpty().contains("/direct") })
        assertArrayEquals(jpeg, bodies[requests.indexOfFirst { it.path == "/s3/put" }])
    }

    @Test fun failedS3PutFallsBackToDirectUploadThroughApi() = runBlocking {
        s3Status = 403
        val result = TestEnv(server, tmp.root).uploader.upload(Uploader.Purpose.DOCUMENT, "image/jpeg", jpeg)
        assertEquals(ApiResult.Success("driver-documents/me/direct.jpg"), result)
        val i = requests.indexOfFirst { it.path.orEmpty().startsWith("/api/v1/driver/uploads/direct") }
        val direct = requests[i]
        assertEquals("/api/v1/driver/uploads/direct?purpose=document", direct.path)
        assertEquals("Bearer access", direct.getHeader("Authorization"))
        assertTrue(direct.getHeader("Content-Type")!!.startsWith("image/jpeg"))
        assertEquals("S3 403 <Error> <Code>AccessDenied</Code> <Message>Access Denied</Message> </Error>", direct.getHeader("X-Upload-Fallback-Reason"))
        assertArrayEquals(jpeg, bodies[i])
    }
}
