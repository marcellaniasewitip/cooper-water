package com.cooperwaters.driver.ui.support

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.cooperwaters.driver.R
import com.cooperwaters.driver.ui.common.ScreenScaffold
import com.cooperwaters.driver.ui.common.appContainer

/** "Send us a mail": the message opens in the phone's email app, addressed to Cooper Waters support. */
@Composable
fun SupportScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val user = appContainer().tokenStore.user()
    var message by rememberSaveable { mutableStateOf("") }
    var noEmailApp by rememberSaveable { mutableStateOf(false) }
    val to = stringResource(R.string.support_email)
    val subject = stringResource(R.string.support_subject, user?.phone.orEmpty())

    ScreenScaffold(title = stringResource(R.string.support_title), onBack = onBack) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(stringResource(R.string.support_heading), style = MaterialTheme.typography.titleMedium, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(
                value = message,
                onValueChange = { message = it.take(2000); noEmailApp = false },
                placeholder = { Text(stringResource(R.string.support_placeholder)) },
                minLines = 6,
                modifier = Modifier.fillMaxWidth(),
            )
            if (noEmailApp) {
                Text(stringResource(R.string.support_no_email_app, to), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
            Button(
                onClick = {
                    val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:")).apply {
                        putExtra(Intent.EXTRA_EMAIL, arrayOf(to))
                        putExtra(Intent.EXTRA_SUBJECT, subject)
                        putExtra(Intent.EXTRA_TEXT, message.trim())
                    }
                    noEmailApp = try {
                        context.startActivity(intent)
                        false
                    } catch (e: ActivityNotFoundException) {
                        true
                    }
                },
                enabled = message.isNotBlank(),
                modifier = Modifier.widthIn(min = 200.dp).heightIn(min = 48.dp),
            ) {
                Text(stringResource(R.string.support_continue).uppercase())
            }
        }
    }
}
