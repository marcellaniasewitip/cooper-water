package com.cooperwaters.driver.ui.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBox
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cooperwaters.core.android.ui.CwIcons
import com.cooperwaters.core.android.ui.ErrorCard
import com.cooperwaters.core.android.ui.LoadingButton
import com.cooperwaters.core.android.ui.SectionTitle
import com.cooperwaters.driver.R
import com.cooperwaters.driver.ui.common.PhotoPickerButtons
import com.cooperwaters.driver.ui.common.ScreenScaffold
import com.cooperwaters.driver.ui.common.appContainer
import com.cooperwaters.driver.ui.common.compressPhoto
import com.cooperwaters.driver.ui.common.containerViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

fun documentLabel(type: String): Int = when (type) {
    "drivers_licence" -> R.string.doc_drivers_licence
    "vehicle_registration" -> R.string.doc_vehicle_registration
    "national_id" -> R.string.doc_national_id
    "truck_photo" -> R.string.doc_truck_photo
    else -> R.string.doc_other
}

fun documentStatusLabel(status: String): Int = when (status) {
    "approved" -> R.string.doc_status_approved
    "pending" -> R.string.doc_status_pending
    "rejected" -> R.string.doc_status_rejected
    else -> R.string.doc_status_missing
}

/** Coloured status pill: grey = needed, amber = in review, green-blue = approved, red = rejected. */
@Composable
fun DocumentStatusPill(status: String) {
    val c = MaterialTheme.colorScheme
    val (bg, fg) = when (status) {
        "approved" -> c.secondaryContainer to c.onSecondaryContainer
        "pending" -> c.tertiaryContainer to c.onTertiaryContainer
        "rejected" -> c.errorContainer to c.onErrorContainer
        else -> c.surfaceVariant to c.onSurfaceVariant
    }
    Surface(shape = CircleShape, color = bg, contentColor = fg) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (status == "approved") {
                Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
            }
            Text(stringResource(documentStatusLabel(status)), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun DocumentIcon(type: String, status: String) {
    val c = MaterialTheme.colorScheme
    val done = status == "approved" || status == "pending"
    Surface(shape = CircleShape, color = if (done) c.primary else c.primaryContainer, modifier = Modifier.size(44.dp)) {
        Box(contentAlignment = Alignment.Center) {
            Icon(
                when {
                    done -> Icons.Filled.Check
                    type == "truck_photo" -> CwIcons.Truck
                    type == "national_id" -> Icons.Filled.Person
                    else -> Icons.Filled.AccountBox
                },
                contentDescription = null,
                tint = if (done) c.onPrimary else c.onPrimaryContainer,
            )
        }
    }
}

/** Upload documents (camera or gallery per required type) + truck registration. */
@Composable
fun OnboardingScreen(onStageChanged: (DriverStage) -> Unit, onProfile: () -> Unit) {
    val vm = containerViewModel { c -> OnboardingViewModel(c.repository, c.uploader, c.state) }
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(state.stage) { state.stage?.takeIf { it != DriverStage.ONBOARDING }?.let(onStageChanged) }

    ScreenScaffold(
        title = stringResource(R.string.onboarding_title),
        actions = {
            IconButton(onClick = vm::refresh) { Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.action_refresh)) }
            IconButton(onClick = onProfile) { Icon(Icons.Filled.AccountCircle, contentDescription = stringResource(R.string.profile_title)) }
        },
    ) {
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            // Progress header: how far along the driver is, at a glance.
            val total = state.documents.size
            val uploaded = state.documents.count { it.status == "pending" || it.status == "approved" }
            Card(
                Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
            ) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.onboarding_intro), style = MaterialTheme.typography.bodyMedium)
                    if (total > 0) {
                        Text(
                            stringResource(R.string.onboarding_progress, uploaded, total),
                            style = MaterialTheme.typography.titleMedium,
                        )
                        LinearProgressIndicator(
                            progress = { uploaded.toFloat() / total },
                            modifier = Modifier.fillMaxWidth().height(8.dp).clip(CircleShape),
                            trackColor = MaterialTheme.colorScheme.surface,
                        )
                    }
                }
            }
            state.profile?.rejectReason?.takeIf { state.profile?.status == "rejected" }?.let {
                ErrorCard(com.cooperwaters.core.android.ui.UiText.Res(R.string.onboarding_rejected, listOf(it)))
            }
            if (state.failedType == null) ErrorCard(state.error, onDismiss = null)
            SectionTitle(stringResource(R.string.onboarding_documents))
            for (doc in state.documents) {
                Card(
                    Modifier.fillMaxWidth(),
                ) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            DocumentIcon(doc.type, doc.status)
                            Spacer(Modifier.width(12.dp))
                            Text(stringResource(documentLabel(doc.type)), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                            Spacer(Modifier.width(8.dp))
                            DocumentStatusPill(doc.status)
                        }
                        doc.notes?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error) }
                        if (state.failedType == doc.type) ErrorCard(state.error, onDismiss = null)
                        if (state.uploading == doc.type) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 3.dp)
                                Spacer(Modifier.width(12.dp))
                                Text(stringResource(R.string.onboarding_uploading))
                            }
                        } else if (doc.status != "approved") {
                            PhotoPickerButtons(
                                enabled = state.uploading == null,
                                onPicked = { uri ->
                                    scope.launch {
                                        val bytes = compressPhoto(context, uri)
                                        if (bytes != null) vm.uploadDocument(doc.type, bytes) else vm.photoUnreadable(doc.type)
                                    }
                                },
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(4.dp))
            SectionTitle(stringResource(R.string.truck_title))
            Card(
                Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        DocumentIcon("truck_photo", if (state.truckSaved) "approved" else "missing")
                        Spacer(Modifier.width(12.dp))
                        Text(stringResource(R.string.truck_hint), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    OutlinedTextField(
                        state.plate,
                        vm::onPlate,
                        label = { Text(stringResource(R.string.truck_plate)) },
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        state.capacity,
                        vm::onCapacity,
                        label = { Text(stringResource(R.string.truck_capacity)) },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(
                        stringResource(if (state.truckPhotoBytes != null) R.string.truck_photo_ready else R.string.truck_photo_optional),
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (state.truckPhotoBytes != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    PhotoPickerButtons(onPicked = { uri -> scope.launch { compressPhoto(context, uri)?.let(vm::onTruckPhoto) } })
                }
            }
            if (state.failedType == OnboardingState.TRUCK) ErrorCard(state.error, onDismiss = null)
            LoadingButton(
                stringResource(if (state.truckSaved) R.string.truck_saved else R.string.truck_save),
                state.savingTruck,
                vm::saveTruck,
                Modifier.fillMaxWidth(),
                enabled = !state.truckSaved,
            )
            Spacer(Modifier.height(8.dp))
        }
    }
}

/** Shown while an admin reviews the documents (or the account is suspended). Polls GET /driver/me. */
@Composable
fun WaitingScreen(onStageChanged: (DriverStage) -> Unit, onProfile: () -> Unit) {
    val container = appContainer()
    val profile by container.state.profile.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        while (true) {
            container.state.refreshProfile()
            delay(30_000)
        }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { scope.launch { container.state.refreshProfile() } }
    LaunchedEffect(profile?.status) { profile?.let { p -> stageFor(p.status).takeIf { it != DriverStage.WAITING }?.let(onStageChanged) } }

    ScreenScaffold(title = stringResource(R.string.waiting_title), actions = {
        IconButton(onClick = onProfile) { Icon(Icons.Filled.AccountCircle, contentDescription = stringResource(R.string.profile_title)) }
    }) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            val suspended = profile?.status == "suspended"
            val c = MaterialTheme.colorScheme
            Card(
                Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = if (suspended) c.errorContainer else c.primaryContainer),
            ) {
                Column(
                    Modifier.fillMaxWidth().padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Surface(shape = CircleShape, color = if (suspended) c.error else c.primary, modifier = Modifier.size(64.dp)) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(
                                if (suspended) Icons.Filled.Warning else Icons.Filled.DateRange,
                                contentDescription = null,
                                tint = if (suspended) c.onError else c.onPrimary,
                                modifier = Modifier.size(32.dp),
                            )
                        }
                    }
                    Text(
                        stringResource(if (suspended) R.string.waiting_suspended_title else R.string.waiting_review_title),
                        style = MaterialTheme.typography.titleLarge,
                        textAlign = TextAlign.Center,
                    )
                    Text(
                        stringResource(if (suspended) R.string.waiting_suspended_body else R.string.waiting_review_body),
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = TextAlign.Center,
                    )
                }
            }
            profile?.documents?.takeIf { it.isNotEmpty() }?.let { docs ->
                SectionTitle(stringResource(R.string.onboarding_documents))
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(vertical = 4.dp)) {
                        docs.forEach { d ->
                            Row(
                                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(stringResource(documentLabel(d.type)), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                                DocumentStatusPill(d.status)
                            }
                        }
                    }
                }
            }
            profile?.truck?.let { t ->
                Card(Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(CwIcons.Truck, contentDescription = null, tint = c.primary)
                        Spacer(Modifier.width(12.dp))
                        Text(stringResource(R.string.waiting_truck, t.plate, t.capacityLitres), style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
            OutlinedButton(
                onClick = { scope.launch { container.state.refreshProfile() } },
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
            ) {
                Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.waiting_check_now))
            }
        }
    }
}
