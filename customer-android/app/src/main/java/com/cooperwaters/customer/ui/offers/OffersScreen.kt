package com.cooperwaters.customer.ui.offers

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.cooperwaters.core.android.ui.EmptyState
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.SectionTitle
import com.cooperwaters.core.android.ui.UiText
import com.cooperwaters.core.android.ui.toUiText
import com.cooperwaters.core.money.Money
import com.cooperwaters.core.net.ApiResult
import com.cooperwaters.core.net.CustomerApi
import com.cooperwaters.core.net.PromoCheckRequest
import com.cooperwaters.core.net.ReferralApplyRequest
import com.cooperwaters.core.net.PromoOffer
import com.cooperwaters.core.net.apiCall
import com.cooperwaters.core.time.PomTime
import com.cooperwaters.customer.PromoStore
import com.cooperwaters.customer.R
import com.cooperwaters.customer.ui.common.ScreenScaffold
import com.cooperwaters.customer.ui.common.containerViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class OffersUi(
    val loading: Boolean = true,
    val offers: List<PromoOffer> = emptyList(),
    val input: String = "",
    val checking: Boolean = false,
    val selected: String? = null,
    val message: UiText? = null,
    val error: UiText? = null,
)

class OffersViewModel(private val api: CustomerApi, private val store: PromoStore) : ViewModel() {
    private val _ui = MutableStateFlow(OffersUi(selected = store.selected))
    val ui: StateFlow<OffersUi> = _ui.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            val r = apiCall { api.offers() }
            _ui.update { it.copy(loading = false, offers = (r as? ApiResult.Success)?.value ?: it.offers, error = (r as? ApiResult.Failure)?.error?.toUiText()) }
        }
    }

    fun onInput(v: String) = _ui.update { it.copy(input = v.uppercase().filter { c -> c.isLetterOrDigit() || c == '-' || c == '_' }.take(30), error = null, message = null) }

    /** "ADD": check the code; when valid it is kept for the next order. */
    fun add() {
        val code = _ui.value.input.trim()
        if (code.length < 3 || _ui.value.checking) return
        _ui.update { it.copy(checking = true, error = null, message = null) }
        viewModelScope.launch {
            when (val r = apiCall { api.checkOffer(PromoCheckRequest(code)) }) {
                is ApiResult.Success -> {
                    store.selected = r.value.code
                    _ui.update { it.copy(checking = false, input = "", selected = r.value.code, message = UiText.res(R.string.offers_saved, r.value.code)) }
                }
                is ApiResult.Failure ->
                    if (r.error.code == "promo_is_referral") {
                        // A friend's Refer & Earn code: apply it as a referral instead.
                        when (val ref = apiCall { api.applyReferral(ReferralApplyRequest(code)) }) {
                            is ApiResult.Success -> _ui.update {
                                it.copy(checking = false, input = "", message = UiText.res(R.string.order_referral_applied, code.uppercase(), Money.format(ref.value.rewardToea)))
                            }
                            is ApiResult.Failure -> _ui.update { it.copy(checking = false, error = ref.error.toUiText()) }
                        }
                    } else {
                        _ui.update { it.copy(checking = false, error = r.error.toUiText()) }
                    }
            }
        }
    }

    fun use(code: String) {
        store.selected = code
        _ui.update { it.copy(selected = code, message = UiText.res(R.string.offers_saved, code)) }
    }

    fun clear() {
        store.selected = null
        _ui.update { it.copy(selected = null, message = null) }
    }
}

/** StarTrip-style Offers: promo code box with ADD, then the live offers. */
@Composable
fun OffersScreen(onBack: () -> Unit) {
    val vm = containerViewModel { c -> OffersViewModel(c.api.customerApi, c.promoStore) }
    val ui by vm.ui.collectAsStateWithLifecycle()
    ScreenScaffold(title = stringResource(R.string.offers_title), onBack = onBack) {
        if (ui.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = ui.input,
                        onValueChange = vm::onInput,
                        placeholder = { Text(stringResource(R.string.offers_enter_code)) },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    Button(onClick = vm::add, enabled = ui.input.length >= 3 && !ui.checking, shape = MaterialTheme.shapes.extraSmall, modifier = Modifier.heightIn(min = 56.dp)) {
                        Text(stringResource(R.string.offers_add).uppercase())
                    }
                }
            }
            item { ErrorCard(ui.error) }
            ui.message?.let { m -> item { Text(m.asString(), color = MaterialTheme.colorScheme.secondary, style = MaterialTheme.typography.bodyMedium) } }
            ui.selected?.let { code ->
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer), modifier = Modifier.fillMaxWidth()) {
                        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(stringResource(R.string.offers_selected, code), modifier = Modifier.weight(1f))
                            OutlinedButton(onClick = vm::clear) { Text(stringResource(R.string.order_promo_remove)) }
                        }
                    }
                }
            }
            item { SectionTitle(stringResource(R.string.offers_available)) }
            if (!ui.loading && ui.offers.isEmpty()) item { EmptyState(stringResource(R.string.offers_none)) }
            items(ui.offers, key = { it.code }) { o -> OfferCard(o, selected = o.code == ui.selected, onUse = { vm.use(o.code) }) }
        }
    }
}

@Composable
private fun OfferCard(o: PromoOffer, selected: Boolean, onUse: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(o.code, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                Text(discountText(o), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.secondary, fontWeight = FontWeight.Bold)
            }
            if (o.description.isNotBlank()) Text(o.description, style = MaterialTheme.typography.bodyMedium)
            if (o.minOrderToea > 0) Text(stringResource(R.string.offers_min_order, Money.format(o.minOrderToea)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            o.expiresAt?.let { Text(stringResource(R.string.offers_expires, PomTime.formatDate(it)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (!o.usable) {
                Text(stringResource(R.string.offers_used), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            } else if (!selected) {
                OutlinedButton(onClick = onUse) { Text(stringResource(R.string.offers_use)) }
            }
        }
    }
}

@Composable
private fun discountText(o: PromoOffer): String =
    if (o.discountType == "percent") {
        stringResource(R.string.offers_percent_off, o.discountValue)
    } else {
        stringResource(R.string.offers_amount_off, Money.format(o.discountValue))
    }
