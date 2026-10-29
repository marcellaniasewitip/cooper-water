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
import com.cooperwaters.driver.ui.common.MainBottomBar
import com.cooperwaters.driver.ui.common.MainTab
import com.cooperwaters.driver.ui.common.appContainer
import com.cooperwaters.driver.ui.earnings.EarningsScreen
import com.cooperwaters.driver.ui.earnings.JobHistoryScreen
import com.cooperwaters.driver.ui.gate.GateScreen
import com.cooperwaters.driver.ui.home.HomeScreen
import com.cooperwaters.driver.ui.job.IssueScreen
import com.cooperwaters.driver.ui.job.JobScreen
import com.cooperwaters.driver.ui.onboarding.DriverStage
import com.cooperwaters.driver.ui.onboarding.OnboardingScreen
import com.cooperwaters.driver.ui.onboarding.WaitingScreen
import com.cooperwaters.driver.ui.profile.ProfileScreen
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
    const val PROFILE_TAB = "profile_tab"

    fun profile(onboarding: Boolean) = "profile?onboarding=$onboarding"
    fun job(id: String) = "job/$id"
    fun issue(id: String) = "issue/$id"
}

private fun NavHostController.resetTo(route: String) = navigate(route) { popUpTo(0) { inclusive = true } }

private fun NavHostController.toStage(stage: DriverStage) = resetTo(
    when (stage) {
        DriverStage.ONBOARDING -> Routes.ONBOARDING
        DriverStage.WAITING -> Routes.WAITING
        DriverStage.WORKING -> Routes.HOME
    },
)

/** Bottom-bar tabs: Jobs is the root; the other tabs sit one level above it so Back returns to Jobs. */
private fun NavHostController.selectTab(tab: MainTab) {
    if (tab == MainTab.JOBS) {
        popBackStack(Routes.HOME, inclusive = false)
        return
    }
    val route = when (tab) {
        MainTab.WALLET -> Routes.WALLET
        MainTab.EARNINGS -> Routes.EARNINGS
        MainTab.HISTORY -> Routes.HISTORY
        else -> Routes.PROFILE_TAB
    }
    navigate(route) {
        popUpTo(Routes.HOME)
        launchSingleTop = true
    }
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
                onOpenJob = { nav.navigate(Routes.job(it)) },
                onTopup = { nav.navigate(Routes.TOPUP) },
                bottomBar = { MainBottomBar(MainTab.JOBS) { nav.selectTab(it) } },
            )
        }
        composable(Routes.JOB, arguments = listOf(navArgument("orderId") { type = NavType.StringType })) { entry ->
            val id = entry.arguments?.getString("orderId").orEmpty()
            JobScreen(orderId = id, onBack = { if (!nav.popBackStack()) nav.resetTo(Routes.HOME) }, onReportIssue = { nav.navigate(Routes.issue(id)) })
        }
        composable(Routes.ISSUE, arguments = listOf(navArgument("orderId") { type = NavType.StringType })) { entry ->
            IssueScreen(orderId = entry.arguments?.getString("orderId").orEmpty(), onDone = { nav.popBackStack() })
        }
        composable(Routes.WALLET) {
            WalletScreen(
                onBack = { nav.popBackStack() },
                onTopup = { nav.navigate(Routes.TOPUP) },
                onWithdraw = { nav.navigate(Routes.WITHDRAW) },
                bottomBar = { MainBottomBar(MainTab.WALLET) { nav.selectTab(it) } },
            )
        }
        composable(Routes.TOPUP) { TopupScreen(onDone = { nav.popBackStack() }) }
        composable(Routes.WITHDRAW) { WithdrawScreen(onDone = { nav.popBackStack() }) }
        composable(Routes.EARNINGS) {
            EarningsScreen(onBack = { nav.popBackStack() }, bottomBar = { MainBottomBar(MainTab.EARNINGS) { nav.selectTab(it) } })
        }
        composable(Routes.HISTORY) {
            JobHistoryScreen(
                onBack = { nav.popBackStack() },
                onOpen = { nav.navigate(Routes.job(it)) },
                bottomBar = { MainBottomBar(MainTab.HISTORY) { nav.selectTab(it) } },
            )
        }
        composable(Routes.PROFILE_TAB) {
            ProfileScreen(
                onboarding = false,
                onDone = { nav.popBackStack() },
                bottomBar = { MainBottomBar(MainTab.PROFILE) { nav.selectTab(it) } },
            )
        }
    }
}
