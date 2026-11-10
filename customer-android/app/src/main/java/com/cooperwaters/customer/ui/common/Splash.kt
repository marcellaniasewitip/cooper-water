package com.cooperwaters.customer.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cooperwaters.core.android.ui.CwBrandBlue
import com.cooperwaters.core.android.ui.CwIcons
import com.cooperwaters.customer.R

/** Brief blue launch screen with the logo, shown while the app starts (StarTrip style). */
@Composable
fun SplashScreen() {
    Box(Modifier.fillMaxSize().background(CwBrandBlue), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(CwIcons.WaterDrop, contentDescription = null, tint = Color.White, modifier = Modifier.size(96.dp))
            Text(stringResource(R.string.app_name), color = Color.White, fontSize = 28.sp, fontWeight = FontWeight.Bold)
        }
    }
}
