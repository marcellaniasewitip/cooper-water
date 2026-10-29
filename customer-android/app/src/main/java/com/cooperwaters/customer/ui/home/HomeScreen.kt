package com.cooperwaters.customer.ui.home

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.EmptyState
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.SectionTitle
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.net.Order
import com.cooperwaters.core.order.OrderStatus
import com.cooperwaters.core.realtime.RealtimeEvent
import com.cooperwaters.customer.R
import com.cooperwaters.customer.data.CustomerRepository
import com.cooperwaters.customer.ui.common.OrderCard
import com.cooperwaters.customer.ui.common.ScreenScaffold
import com.cooperwaters.customer.ui.common.appContainer
import com.cooperwaters.customer.ui.common.containerViewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class HomeState(
    val loading: Boolean = true,
    val active: List<Order> = emptyList(),
    val recent: List<Order> = emptyList(),
    val fromCache: Boolean = false,
    val hasUnsentOrder: Boolean = false,
    val error: UiText? = null,
)

class HomeViewModel(
    private val repo: CustomerRepository,
    realtime: Flow<RealtimeEvent>,
    pushes: Flow<Map<String, String>>,
) : ViewModel() {
    private val _state = MutableStateFlow(HomeState())
    val state: StateFlow<HomeState> = _state.asStateFlow()

    init {
        refresh()
        viewModelScope.launch { realtime.collect { if (it is RealtimeEvent.OrderUpdated) refresh() } }
        viewModelScope.launch { pushes.collect { refresh() } }
        viewModelScope.launch { repo.queue.pending.collect { p -> _state.update { it.copy(hasUnsentOrder = p.any { a -> a.type == CustomerRepository.TYPE_CREATE_ORDER }) } } }
    }

    fun refresh() {
        _state.update { it.copy(loading = true) }
        viewModelScope.launch {
            val loaded = repo.recentOrders()
            val orders = loaded.value?.items.orEmpty()
            _state.update {
                it.copy(
                    loading = false,
                    active = orders.filter { o -> !OrderStatus.isTerminal(o.status) },
                    recent = orders.filter { o -> OrderStatus.isTerminal(o.status) }.take(3),
                    fromCache = loaded.fromCache,
                    error = if (loaded.value == null) loaded.error?.toUiText() else null,
                )
            }
        }
    }
}

@Composable
fun HomeScreen(
    onNewOrder: () -> Unit,
    onOpenOrder: (Order) -> Unit,
    bottomBar: @Composable () -> Unit,
) {
    val vm = containerViewModel { c -> HomeViewModel(c.repository, c.realtime.events, c.pushEvents) }
    val state by vm.state.collectAsStateWithLifecycle()
    val name = appContainer().tokenStore.user()?.name?.trim()?.substringBefore(' ').orEmpty()

    val notifPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }

    ScreenScaffold(
        title = stringResource(R.string.app_name),
        actions = {
            IconButton(onClick = vm::refresh) { Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.action_refresh)) }
        },
        bottomBar = bottomBar,
    ) {
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { OrderHero(name = name, onNewOrder = onNewOrder) }
            if (state.hasUnsentOrder) {
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)) {
                        Text(
                            stringResource(R.string.home_unsent_order),
                            Modifier.padding(16.dp),
                            color = MaterialTheme.colorScheme.onTertiaryContainer,
                        )
                    }
                }
            }
            item { ErrorCard(state.error, onRetry = vm::refresh) }
            if (state.fromCache) {
                item { Text(stringResource(R.string.home_cached), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            item { SectionTitle(stringResource(R.string.home_active_orders)) }
            if (state.active.isEmpty() && !state.loading) {
                item { EmptyState(stringResource(R.string.home_no_active), icon = Icons.Filled.ShoppingCart) }
            }
            items(state.active, key = { it.id }) { order -> OrderCard(order, onClick = { onOpenOrder(order) }) }
            if (state.recent.isNotEmpty()) {
                item { SectionTitle(stringResource(R.string.home_recent_orders)) }
                items(state.recent, key = { "r" + it.id }) { order -> OrderCard(order, onClick = { onOpenOrder(order) }) }
            }
        }
    }
}

/** Brand card at the top of Home: greeting, one line of value, and the main call to action. */
@Composable
private fun OrderHero(name: String, onNewOrder: () -> Unit) {
    Card(
        shape = MaterialTheme.shapes.extraLarge,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                if (name.isBlank()) stringResource(R.string.home_hero_title) else stringResource(R.string.home_hero_title_named, name),
                style = MaterialTheme.typography.headlineSmall,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
            Text(
                stringResource(R.string.home_hero_body),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
            Button(
                onClick = onNewOrder,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp).heightIn(min = 56.dp),
            ) {
                Icon(Icons.Filled.Add, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.home_order_water), style = MaterialTheme.typography.titleMedium)
            }
        }
    }
}
