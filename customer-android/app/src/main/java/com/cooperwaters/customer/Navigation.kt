package com.cooperwaters.customer

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.cooperwaters.customer.ui.auth.LoginScreen
import com.cooperwaters.customer.ui.chat.ChatListScreen
import com.cooperwaters.customer.ui.chat.ChatThreadScreen
import com.cooperwaters.customer.ui.common.appContainer
import com.cooperwaters.customer.ui.history.HistoryScreen
import com.cooperwaters.customer.ui.home.HomeActions
import com.cooperwaters.customer.ui.home.HomeScreen
import com.cooperwaters.customer.ui.inbox.InboxScreen
import com.cooperwaters.customer.ui.locations.LocationEditScreen
import com.cooperwaters.customer.ui.locations.LocationsScreen
import com.cooperwaters.customer.ui.offers.OffersScreen
import com.cooperwaters.customer.ui.order.NewOrderScreen
import com.cooperwaters.customer.ui.payment.PaymentPendingScreen
import com.cooperwaters.customer.ui.profile.ProfileScreen
import com.cooperwaters.customer.ui.referral.ReferralScreen
import com.cooperwaters.customer.ui.support.SupportScreen
import com.cooperwaters.customer.ui.tracking.DisputeScreen
import com.cooperwaters.customer.ui.tracking.RateScreen
import com.cooperwaters.customer.ui.tracking.TrackingScreen
import com.cooperwaters.customer.ui.wallet.CustomerTopupScreen
import com.cooperwaters.customer.ui.wallet.WalletScreen
import kotlinx.coroutines.flow.MutableStateFlow

object Routes {
    const val LOGIN = "login"
    const val PROFILE = "profile?onboarding={onboarding}"
    const val HOME = "home"
    const val LOCATIONS = "locations"
    const val LOCATION_EDIT = "location_edit?id={id}"
    const val NEW_ORDER = "new_order?locationId={locationId}&addressFirst={addressFirst}"
    const val SUPPORT = "support"
    const val PAYMENT = "payment/{orderId}"
    const val TRACKING = "tracking/{orderId}"
    const val RATE = "rate/{orderId}"
    const val DISPUTE = "dispute/{orderId}"
    const val HISTORY = "history"
    const val WALLET = "wallet"
    const val TOPUP = "topup"
    const val OFFERS = "offers"
    const val REFERRAL = "referral"
    const val INBOX = "inbox"
    const val CHATS = "chats"
    const val CHAT = "chat/{orderId}"

    fun profile(onboarding: Boolean) = "profile?onboarding=$onboarding"
    fun locationEdit(id: String?) = if (id == null) "location_edit" else "location_edit?id=$id"
    fun newOrder(locationId: String? = null, addressFirst: Boolean = false): String {
        val args = listOfNotNull(locationId?.let { "locationId=$it" }, "addressFirst=true".takeIf { addressFirst })
        return if (args.isEmpty()) "new_order" else "new_order?" + args.joinToString("&")
    }
    fun payment(orderId: String) = "payment/$orderId"
    fun tracking(orderId: String) = "tracking/$orderId"
    fun rate(orderId: String) = "rate/$orderId"
    fun dispute(orderId: String) = "dispute/$orderId"
    fun chat(orderId: String) = "chat/$orderId"
}

private fun NavHostController.goHomeClearingStack() = navigate(Routes.HOME) { popUpTo(0) { inclusive = true } }

@Composable
fun CustomerNavHost(openOrder: MutableStateFlow<String?>) {
    val nav = rememberNavController()
    val container = appContainer()
    val loggedIn by container.loggedIn.collectAsStateWithLifecycle()
    val orderToOpen by openOrder.collectAsStateWithLifecycle()

    LaunchedEffect(loggedIn) {
        if (!loggedIn && nav.currentDestination?.route != Routes.LOGIN) {
            nav.navigate(Routes.LOGIN) { popUpTo(0) { inclusive = true } }
        }
    }
    LaunchedEffect(orderToOpen, loggedIn) {
        val id = orderToOpen
        if (id != null && loggedIn) {
            nav.navigate(Routes.tracking(id))
            openOrder.value = null
        }
    }

    NavHost(navController = nav, startDestination = if (loggedIn) Routes.HOME else Routes.LOGIN) {
        composable(Routes.LOGIN) {
            LoginScreen(onSignedIn = { needsName ->
                if (needsName) {
                    nav.navigate(Routes.profile(onboarding = true)) { popUpTo(0) { inclusive = true } }
                } else {
                    nav.goHomeClearingStack()
                }
            })
        }
        composable(
            Routes.PROFILE,
            arguments = listOf(navArgument("onboarding") { type = NavType.BoolType; defaultValue = false }),
        ) { entry ->
            val onboarding = entry.arguments?.getBoolean("onboarding") ?: false
            ProfileScreen(
                onboarding = onboarding,
                onDone = { if (onboarding) nav.goHomeClearingStack() else nav.popBackStack() },
                showBack = !onboarding,
                onBack = { nav.popBackStack() },
            )
        }
        composable(Routes.HOME) {
            HomeScreen(
                HomeActions(
                    onNewOrder = { locationId -> nav.navigate(Routes.newOrder(locationId)) },
                    onWhereTo = { locationId -> nav.navigate(Routes.newOrder(locationId, addressFirst = true)) },
                    onOpenOrder = { order ->
                        if (order.status == com.cooperwaters.core.order.OrderStatus.PENDING_PAYMENT) {
                            nav.navigate(Routes.payment(order.id))
                        } else {
                            nav.navigate(Routes.tracking(order.id))
                        }
                    },
                    onOrders = { nav.navigate(Routes.HISTORY) { launchSingleTop = true } },
                    onPlaces = { nav.navigate(Routes.LOCATIONS) { launchSingleTop = true } },
                    onProfile = { nav.navigate(Routes.profile(onboarding = false)) { launchSingleTop = true } },
                    onSupport = { nav.navigate(Routes.SUPPORT) { launchSingleTop = true } },
                    onWallet = { nav.navigate(Routes.WALLET) { launchSingleTop = true } },
                    onOffers = { nav.navigate(Routes.OFFERS) { launchSingleTop = true } },
                    onReferral = { nav.navigate(Routes.REFERRAL) { launchSingleTop = true } },
                    onInbox = { nav.navigate(Routes.INBOX) { launchSingleTop = true } },
                    onChats = { nav.navigate(Routes.CHATS) { launchSingleTop = true } },
                ),
            )
        }
        composable(Routes.LOCATIONS) {
            LocationsScreen(
                onEdit = { id -> nav.navigate(Routes.locationEdit(id)) },
                onBack = { nav.popBackStack() },
            )
        }
        composable(
            Routes.LOCATION_EDIT,
            arguments = listOf(navArgument("id") { type = NavType.StringType; nullable = true; defaultValue = null }),
        ) { entry ->
            LocationEditScreen(locationId = entry.arguments?.getString("id"), onDone = { nav.popBackStack() })
        }
        composable(
            Routes.NEW_ORDER,
            arguments = listOf(
                navArgument("locationId") { type = NavType.StringType; nullable = true; defaultValue = null },
                navArgument("addressFirst") { type = NavType.BoolType; defaultValue = false },
            ),
        ) { entry ->
            NewOrderScreen(
                initialLocationId = entry.arguments?.getString("locationId"),
                locationFirst = entry.arguments?.getBoolean("addressFirst") ?: false,
                onBack = { nav.popBackStack() },
                onAddLocation = { nav.navigate(Routes.locationEdit(null)) },
                onPlaced = { orderId, needsPayment ->
                    val target = if (needsPayment) Routes.payment(orderId) else Routes.tracking(orderId)
                    nav.navigate(target) { popUpTo(Routes.HOME) }
                },
                onResumedElsewhere = { nav.goHomeClearingStack() },
            )
        }
        composable(Routes.PAYMENT, arguments = listOf(navArgument("orderId") { type = NavType.StringType })) { entry ->
            val orderId = entry.arguments?.getString("orderId").orEmpty()
            PaymentPendingScreen(
                orderId = orderId,
                onBack = { nav.popBackStack() },
                onPaid = { nav.navigate(Routes.tracking(orderId)) { popUpTo(Routes.HOME) } },
                onClosed = { nav.navigate(Routes.tracking(orderId)) { popUpTo(Routes.HOME) } },
            )
        }
        composable(Routes.TRACKING, arguments = listOf(navArgument("orderId") { type = NavType.StringType })) { entry ->
            val orderId = entry.arguments?.getString("orderId").orEmpty()
            TrackingScreen(
                orderId = orderId,
                onBack = { if (!nav.popBackStack()) nav.goHomeClearingStack() },
                onPay = { nav.navigate(Routes.payment(orderId)) },
                onRate = { nav.navigate(Routes.rate(orderId)) },
                onDispute = { nav.navigate(Routes.dispute(orderId)) },
                onChat = { nav.navigate(Routes.chat(orderId)) { launchSingleTop = true } },
            )
        }
        composable(Routes.RATE, arguments = listOf(navArgument("orderId") { type = NavType.StringType })) { entry ->
            RateScreen(orderId = entry.arguments?.getString("orderId").orEmpty(), onDone = { nav.popBackStack() })
        }
        composable(Routes.DISPUTE, arguments = listOf(navArgument("orderId") { type = NavType.StringType })) { entry ->
            DisputeScreen(orderId = entry.arguments?.getString("orderId").orEmpty(), onDone = { nav.popBackStack() })
        }
        composable(Routes.HISTORY) {
            HistoryScreen(
                onOpen = { id -> nav.navigate(Routes.tracking(id)) },
                onNewOrder = { nav.navigate(Routes.newOrder()) },
                onBack = { nav.popBackStack() },
            )
        }
        composable(Routes.SUPPORT) { SupportScreen(onBack = { nav.popBackStack() }) }
        composable(Routes.WALLET) { WalletScreen(onBack = { nav.popBackStack() }, onTopup = { nav.navigate(Routes.TOPUP) }) }
        composable(Routes.TOPUP) { CustomerTopupScreen(onDone = { nav.popBackStack() }) }
        composable(Routes.OFFERS) { OffersScreen(onBack = { nav.popBackStack() }) }
        composable(Routes.REFERRAL) { ReferralScreen(onBack = { nav.popBackStack() }) }
        composable(Routes.INBOX) { InboxScreen(onBack = { nav.popBackStack() }) }
        composable(Routes.CHATS) { ChatListScreen(onOpen = { id -> nav.navigate(Routes.chat(id)) }, onBack = { nav.popBackStack() }) }
        composable(Routes.CHAT, arguments = listOf(navArgument("orderId") { type = NavType.StringType })) { entry ->
            ChatThreadScreen(orderId = entry.arguments?.getString("orderId").orEmpty(), onBack = { nav.popBackStack() })
        }
    }
}
