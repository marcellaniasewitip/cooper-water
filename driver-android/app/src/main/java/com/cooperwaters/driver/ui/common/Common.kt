package com.cooperwaters.driver.ui.common

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.foundation.layout.RowScope
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.cooperwaters.core.android.ui.CwIcons
import com.cooperwaters.core.android.ui.OfflineBanner
import com.cooperwaters.driver.AppContainer
import com.cooperwaters.driver.DriverApp
import com.cooperwaters.driver.R

@Composable
fun appContainer(): AppContainer = (LocalContext.current.applicationContext as DriverApp).container

/** ViewModel scoped to the current navigation entry, built from the AppContainer. */
@Composable
inline fun <reified VM : ViewModel> containerViewModel(key: String? = null, crossinline create: (AppContainer) -> VM): VM {
    val container = appContainer()
    return viewModel(key = key, factory = viewModelFactory { initializer { create(container) } })
}

/**
 * Standard screen frame: top bar (back arrow unless it's a main tab), offline banner, snackbar host,
 * and the bottom tab bar on the main screens.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScreenScaffold(
    title: String,
    onBack: (() -> Unit)? = null,
    snackbar: SnackbarHostState = remember { SnackbarHostState() },
    actions: @Composable () -> Unit = {},
    bottomBar: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val container = appContainer()
    val online by container.connectivity.isOnline.collectAsStateWithLifecycle()
    val pending by container.queue.pending.collectAsStateWithLifecycle()
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title, fontWeight = FontWeight.SemiBold) },
                navigationIcon = {
                    if (onBack != null && bottomBar == null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
                        }
                    }
                },
                actions = { actions() },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                    titleContentColor = MaterialTheme.colorScheme.onSurface,
                ),
            )
        },
        bottomBar = { bottomBar?.invoke() },
        snackbarHost = { SnackbarHost(snackbar) },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            OfflineBanner(offline = !online, pendingCount = pending.size)
            content()
        }
    }
}

/** Main driver screens reachable from the bottom bar. */
enum class MainTab { JOBS, WALLET, EARNINGS, HISTORY, PROFILE }

@Composable
fun MainBottomBar(current: MainTab, onSelect: (MainTab) -> Unit) {
    NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        TabItem(MainTab.JOBS, current, Icons.Filled.Home, R.string.tab_jobs, onSelect)
        TabItem(MainTab.WALLET, current, CwIcons.Wallet, R.string.tab_wallet, onSelect)
        TabItem(MainTab.EARNINGS, current, CwIcons.BarChart, R.string.tab_earnings, onSelect)
        TabItem(MainTab.HISTORY, current, Icons.Filled.List, R.string.tab_history, onSelect)
        TabItem(MainTab.PROFILE, current, Icons.Filled.Person, R.string.tab_profile, onSelect)
    }
}

@Composable
private fun RowScope.TabItem(tab: MainTab, current: MainTab, icon: ImageVector, label: Int, onSelect: (MainTab) -> Unit) {
    NavigationBarItem(
        selected = tab == current,
        onClick = { if (tab != current) onSelect(tab) },
        icon = { Icon(icon, contentDescription = null) },
        label = { Text(stringResource(label), maxLines = 1) },
        colors = NavigationBarItemDefaults.colors(
            selectedIconColor = MaterialTheme.colorScheme.onPrimaryContainer,
            selectedTextColor = MaterialTheme.colorScheme.primary,
            indicatorColor = MaterialTheme.colorScheme.primaryContainer,
        ),
    )
}
