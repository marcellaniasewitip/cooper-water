package com.cooperwaters.driver

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
import com.cooperwaters.driver.ui.auth.LoginScreen
import com.cooperwaters.driver.ui.chat.ChatListScreen
import com.cooperwaters.driver.ui.chat.ChatScreen
import com.cooperwaters.driver.ui.common.appContainer
import com.cooperwaters.driver.ui.earnings.EarningsScreen
import com.cooperwaters.driver.ui.earnings.JobHistoryScreen
import com.cooperwaters.driver.ui.gate.GateScreen
import com.cooperwaters.driver.ui.home.HomeActions
import com.cooperwaters.driver.ui.home.HomeScreen
import com.cooperwaters.driver.ui.job.IssueScreen
import com.cooperwaters.driver.ui.job.JobScreen
import com.cooperwaters.driver.ui.onboarding.DriverStage
import com.cooperwaters.driver.ui.onboarding.OnboardingScreen
import com.cooperwaters.driver.ui.onboarding.WaitingScreen
import com.cooperwaters.driver.ui.profile.ProfileScreen
import com.cooperwaters.driver.ui.requests.LiveRequestsScreen
import com.cooperwaters.driver.ui.support.SupportScreen
import com.cooperwaters.driver.ui.wallet.TopupScreen
import com.cooperwaters.driver.ui.wallet.WalletScreen
import com.cooperwaters.driver.ui.wallet.WithdrawScreen

object Routes {
    const val LOGIN = "login"
    const val GATE = "gate"
    const val PROFILE = "profile?onboarding={onboarding}"
    const val ONBOARDING = "onboarding"
    const val WAITING = "waiting"
    const val HOME = "home"
    const val JOB = "job/{orderId}"
    const val ISSUE = "issue/{orderId}"
    const val WALLET = "wallet"
    const val TOPUP = "topup"
    const val WITHDRAW = "withdraw"
    const val EARNINGS = "earnings"
    const val HISTORY = "history"
    const val CHAT = "chat/{orderId}"
    const val LIVE = "live_requests"
    const val CHATS = "chats"
    const val SUPPORT = "support"

    fun profile(onboarding: Boolean) = "profile?onboarding=$onboarding"
    fun job(id: String) = "job/$id"
    fun issue(id: String) = "issue/$id"
    fun chat(id: String) = "chat/$id"
}

private fun NavHostController.resetTo(route: String) = navigate(route) { popUpTo(0) { inclusive = true } }

private fun NavHostController.toStage(stage: DriverStage) = resetTo(
    when (stage) {
        DriverStage.ONBOARDING -> Routes.ONBOARDING
        DriverStage.WAITING -> Routes.WAITING
        DriverStage.WORKING -> Routes.HOME
    },
)

/** Side-menu destinations open on top of Home, once (Back returns to Home). */
private fun NavHostController.openFromMenu(route: String) = navigate(route) {
    popUpTo(Routes.HOME)
    launchSingleTop = true
}

@Composable
fun DriverNavHost() {
    val nav = rememberNavController()
    val container = appContainer()
    val loggedIn by container.loggedIn.collectAsStateWithLifecycle()

    LaunchedEffect(loggedIn) {
        if (!loggedIn && nav.currentDestination?.route != Routes.LOGIN) nav.resetTo(Routes.LOGIN)
    }

    NavHost(navController = nav, startDestination = if (loggedIn) Routes.GATE else Routes.LOGIN) {
        composable(Routes.LOGIN) {
            LoginScreen(onSignedIn = { needsName -> nav.resetTo(if (needsName) Routes.profile(onboarding = true) else Routes.GATE) })
        }
        composable(Routes.GATE) { GateScreen(onStage = { nav.toStage(it) }) }
        composable(Routes.PROFILE, arguments = listOf(navArgument("onboarding") { type = NavType.BoolType; defaultValue = false })) { entry ->
            val onboarding = entry.arguments?.getBoolean("onboarding") ?: false
            ProfileScreen(onboarding = onboarding, onDone = { if (onboarding) nav.resetTo(Routes.GATE) else nav.popBackStack() })
        }
        composable(Routes.ONBOARDING) {
            OnboardingScreen(onStageChanged = { nav.toStage(it) }, onProfile = { nav.navigate(Routes.profile(onboarding = false)) })
        }
        composable(Routes.WAITING) {
            WaitingScreen(onStageChanged = { nav.toStage(it) }, onProfile = { nav.navigate(Routes.profile(onboarding = false)) })
        }
        composable(Routes.HOME) {
            HomeScreen(
                HomeActions(
                    onOpenJob = { nav.navigate(Routes.job(it)) },
                    onTopup = { nav.navigate(Routes.TOPUP) },
                    onLiveRequests = { nav.openFromMenu(Routes.LIVE) },
                    onEarnings = { nav.openFromMenu(Routes.EARNINGS) },
                    onWallet = { nav.openFromMenu(Routes.WALLET) },
                    onHistory = { nav.openFromMenu(Routes.HISTORY) },
                    onMessages = { nav.openFromMenu(Routes.CHATS) },
                    onProfile = { nav.openFromMenu(Routes.profile(onboarding = false)) },
                    onSupport = { nav.openFromMenu(Routes.SUPPORT) },
                ),
            )
        }
        composable(Routes.LIVE) {
            LiveRequestsScreen(onBack = { nav.popBackStack() }, onOpenJob = { nav.navigate(Routes.job(it)) { popUpTo(Routes.HOME) } })
        }
        composable(Routes.CHATS) { ChatListScreen(onOpen = { nav.navigate(Routes.chat(it)) }, onBack = { nav.popBackStack() }) }
        composable(Routes.SUPPORT) { SupportScreen(onBack = { nav.popBackStack() }) }
        composable(Routes.JOB, arguments = listOf(navArgument("orderId") { type = NavType.StringType })) { entry ->
            val id = entry.arguments?.getString("orderId").orEmpty()
            JobScreen(
                orderId = id,
                onBack = { if (!nav.popBackStack()) nav.resetTo(Routes.HOME) },
                onReportIssue = { nav.navigate(Routes.issue(id)) },
                onChat = { nav.navigate(Routes.chat(id)) },
            )
        }
        composable(Routes.CHAT, arguments = listOf(navArgument("orderId") { type = NavType.StringType })) { entry ->
            ChatScreen(orderId = entry.arguments?.getString("orderId").orEmpty(), onBack = { nav.popBackStack() })
        }
        composable(Routes.ISSUE, arguments = listOf(navArgument("orderId") { type = NavType.StringType })) { entry ->
            IssueScreen(orderId = entry.arguments?.getString("orderId").orEmpty(), onDone = { nav.popBackStack() })
        }
        composable(Routes.WALLET) {
            WalletScreen(
                onBack = { nav.popBackStack() },
                onTopup = { nav.navigate(Routes.TOPUP) },
                onWithdraw = { nav.navigate(Routes.WITHDRAW) },
            )
        }
        composable(Routes.TOPUP) { TopupScreen(onDone = { nav.popBackStack() }) }
        composable(Routes.WITHDRAW) { WithdrawScreen(onDone = { nav.popBackStack() }) }
        composable(Routes.EARNINGS) {
            EarningsScreen(onBack = { nav.popBackStack() })
        }
        composable(Routes.HISTORY) {
            JobHistoryScreen(
                onBack = { nav.popBackStack() },
                onOpen = { nav.navigate(Routes.job(it)) },
            )
        }
    }
}
