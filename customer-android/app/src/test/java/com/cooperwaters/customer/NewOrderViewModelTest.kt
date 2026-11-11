package com.cooperwaters.customer

import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.customer.ui.order.NewOrderViewModel
import com.cooperwaters.customer.ui.order.OrderStep
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.Collections

@OptIn(ExperimentalCoroutinesApi::class)
class NewOrderViewModelTest {
    @get:Rule val tmp = TemporaryFolder()
    private val server = MockWebServer()
    private val orderKeys: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private val orderBodies: MutableList<String> = Collections.synchronizedList(mutableListOf())

    /** How the next POST /customer/orders calls behave, in order; afterwards: success. */
    private val createPlan: MutableList<String> = Collections.synchronizedList(mutableListOf())

    @Before fun setUp() {
        Dispatchers.setMain(Dispatchers.Unconfined)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                return when {
                    path.endsWith("/customer/config") -> json(Fixtures.CONFIG)
                    path.endsWith("/customer/packages") -> json(Fixtures.PACKAGES)
                    path.endsWith("/customer/locations") -> json(Fixtures.LOCATIONS)
                    path.endsWith("/customer/quote") -> {
                        val qty = Regex("\"quantity\":(\\d+)").find(request.body.readUtf8())!!.groupValues[1].toInt()
                        json(Fixtures.quote(qty, 8000))
                    }
                    path.endsWith("/customer/orders") && request.method == "POST" -> {
                        orderKeys += request.getHeader("Idempotency-Key").orEmpty()
                        orderBodies += request.body.readUtf8()
                        when (if (createPlan.isEmpty()) "ok" else createPlan.removeAt(0)) {
                            "503" -> MockResponse().setResponseCode(503).setBody("""{"error":{"code":"server_error","message":"Down"}}""")
                            "in_progress" -> MockResponse().setResponseCode(409).setBody("""{"error":{"code":"request_in_progress","message":"Retry shortly."}}""")
                            // Request reached the server but the response was lost (the classic double-submit trap).
                            "drop" -> MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                            "invalid" -> MockResponse().setResponseCode(422).setBody("""{"error":{"code":"quantity_too_large","message":"You can order at most 3 at a time"}}""")
                            else -> json("""{"order":${Fixtures.order("44444444-4444-4444-4444-444444444444", "SEARCHING")},"payment":null,"paymentError":null}""")
                        }
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After fun tearDown() {
        server.shutdown()
        Dispatchers.resetMain()
    }

    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)

    private fun readyViewModel(maxAttempts: Int = 3): NewOrderViewModel {
        val vm = NewOrderViewModel(testRepository(server, tmp.root, maxAttempts), accountPhone = "+67571000001")
        waitUntil { !vm.state.value.loading && vm.state.value.quotedPriceToea != null }
        return vm
    }

    private fun goToReview(vm: NewOrderViewModel) {
        repeat(3) { vm.next() }
        assertEquals(OrderStep.REVIEW, vm.state.value.step)
    }

    @Test fun loadsCatalogueAndQuotesFixedPrice() {
        val vm = readyViewModel()
        val s = vm.state.value
        assertEquals(2, s.packages.size)
        assertEquals("11111111-1111-1111-1111-111111111111", s.packageId)
        assertEquals("33333333-3333-3333-3333-333333333333", s.locationId)
        assertEquals(3, s.maxQuantity)
        assertEquals(8000L, s.priceToea)

        vm.setQuantity(2)
        waitUntil { vm.state.value.quotedPriceToea == 16_000L }
        vm.setQuantity(10) // clamped to config.maxQuantity
        assertEquals(3, vm.state.value.quantity)
        waitUntil { vm.state.value.quotedPriceToea == 24_000L }
    }

    @Test fun whereToStartsOnTheAddressThenGoesToThePackage() {
        val vm = NewOrderViewModel(testRepository(server, tmp.root, 3), accountPhone = "+67571000001", locationFirst = true)
        waitUntil { !vm.state.value.loading }
        assertEquals(OrderStep.LOCATION, vm.state.value.step)
        assertFalse(vm.back()) // first step: Back closes the screen
        vm.next()
        assertEquals(OrderStep.PACKAGE, vm.state.value.step)
        vm.next()
        assertEquals(OrderStep.PAYMENT, vm.state.value.step)
        assertTrue(vm.back())
        assertEquals(OrderStep.PACKAGE, vm.state.value.step)
    }

    @Test fun savedPlaceShortcutOpensOnThePackageWithTheAddressBehindIt() {
        val vm = NewOrderViewModel(
            testRepository(server, tmp.root, 3),
            accountPhone = "+67571000001",
            initialLocationId = "33333333-3333-3333-3333-333333333333",
            locationFirst = true,
        )
        waitUntil { !vm.state.value.loading }
        assertEquals(OrderStep.PACKAGE, vm.state.value.step)
        assertTrue(vm.back()) // Back changes the address
        assertEquals(OrderStep.LOCATION, vm.state.value.step)
    }

    @Test fun cellMoneyNeedsANumber() {
        val vm = readyViewModel()
        vm.next() // package -> location
        vm.next() // location -> payment
        vm.selectPayment("cellmoney")
        vm.onMsisdn("")
        vm.next()
        assertEquals(OrderStep.PAYMENT, vm.state.value.step)
        assertTrue(vm.state.value.error is UiText.Res)
    }

    @Test fun placeOrderRetriesTransientFailuresWithTheSameIdempotencyKey() {
        val vm = readyViewModel(maxAttempts = 4)
        goToReview(vm)
        createPlan += listOf("503", "drop", "in_progress")
        vm.placeOrder()
        waitUntil { vm.state.value.placed != null }
        assertTrue(orderKeys.size >= 4)
        assertEquals(1, orderKeys.toSet().size)
        assertTrue(orderKeys.first().length >= 8)
        assertEquals(1, orderBodies.toSet().size) // identical body on every retry
        val placed = vm.state.value.placed!!
        assertEquals("44444444-4444-4444-4444-444444444444", placed.orderId)
        assertFalse(placed.needsPayment)
    }

    @Test fun unconfirmedOrderSurvivesAndIsResentWithTheSameKey() {
        val vm = readyViewModel(maxAttempts = 2)
        goToReview(vm)
        // Every attempt loses its response. (OkHttp may also transparently retry a POST on a stale pooled
        // connection — harmless here precisely because the retry carries the same Idempotency-Key.)
        repeat(10) { createPlan += "drop" }
        vm.placeOrder()
        waitUntil { !vm.state.value.placing && orderKeys.size >= 2 }
        createPlan.clear()
        assertTrue(vm.state.value.unsent)
        assertTrue(vm.state.value.locked)
        assertEquals(null, vm.state.value.placed)

        // "Restart": a fresh ViewModel over the same files resumes the saved order on the review step.
        val vm2 = readyViewModel()
        assertTrue(vm2.state.value.unsent)
        assertEquals(OrderStep.REVIEW, vm2.state.value.step)
        vm2.setQuantity(3) // locked: the draft cannot change under a pending key
        assertEquals(1, vm2.state.value.quantity)
        val attemptsBefore = orderKeys.size
        vm2.placeOrder()
        waitUntil { vm2.state.value.placed != null }
        assertTrue(orderKeys.size > attemptsBefore)
        assertEquals(1, orderKeys.toSet().size)
        assertEquals(1, orderBodies.toSet().size)
    }

    @Test fun permanentErrorIsShownAndNextTapUsesANewKey() {
        val vm = readyViewModel()
        goToReview(vm)
        createPlan += "invalid"
        vm.placeOrder()
        waitUntil { !vm.state.value.placing && vm.state.value.error != null }
        assertEquals(UiText.Raw("You can order at most 3 at a time"), vm.state.value.error)
        assertFalse(vm.state.value.unsent)
        vm.placeOrder()
        waitUntil { vm.state.value.placed != null }
        assertEquals(2, orderKeys.size)
        assertNotNull(orderKeys[1])
        assertTrue(orderKeys[0] != orderKeys[1])
    }
}
