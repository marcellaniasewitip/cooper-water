package com.cooperwaters.core.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/*
 * Cooper Waters brand palette: ocean blue + aqua, on clean white (light) or deep navy (dark).
 * Every on-colour pair below meets WCAG AA contrast (≥ 4.5:1 for text), so screens stay readable
 * outdoors in bright sun and on low-end displays. Dynamic (wallpaper) colour is intentionally off
 * so the brand looks the same on every phone.
 */

// Brand
private val Ocean = Color(0xFF0A6CBF)       // primary (light)
private val OceanDeep = Color(0xFF003A66)
private val OceanTint = Color(0xFFD6E9FA)
private val Sky = Color(0xFF7FC4FF)         // primary (dark)
private val Aqua = Color(0xFF00838F)        // secondary (light)
private val AquaBright = Color(0xFF4FD8E3)  // secondary (dark)
private val AquaTint = Color(0xFFCDF3F6)
private val Sun = Color(0xFF8A5100)         // tertiary: money / highlights (light)
private val SunBright = Color(0xFFFFB95C)   // tertiary (dark)

// Neutrals
private val Navy950 = Color(0xFF0A1622)
private val Navy900 = Color(0xFF0F1D2B)
private val Navy850 = Color(0xFF142536)
private val Navy800 = Color(0xFF1A2E42)
private val Navy700 = Color(0xFF233B53)
private val Slate = Color(0xFF8CA3B8)

private val Light = lightColorScheme(
    primary = Ocean,
    onPrimary = Color.White,
    primaryContainer = OceanTint,
    onPrimaryContainer = OceanDeep,
    secondary = Aqua,
    onSecondary = Color.White,
    secondaryContainer = AquaTint,
    onSecondaryContainer = Color(0xFF00363B),
    tertiary = Sun,
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFFFDDB8),
    onTertiaryContainer = Color(0xFF2C1600),
    error = Color(0xFFBA1A1A),
    onError = Color.White,
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
    background = Color(0xFFF5F8FC),
    onBackground = Color(0xFF111C27),
    surface = Color(0xFFF5F8FC),
    onSurface = Color(0xFF111C27),
    surfaceVariant = Color(0xFFDDE5EE),
    onSurfaceVariant = Color(0xFF40505F),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFFFFFFF),
    surfaceContainer = Color(0xFFEDF2F8),
    surfaceContainerHigh = Color(0xFFE6EDF5),
    surfaceContainerHighest = Color(0xFFDDE6F0),
    outline = Color(0xFF70808F),
    outlineVariant = Color(0xFFC3CDD8),
    inverseSurface = Color(0xFF26323E),
    inverseOnSurface = Color(0xFFEDF2F8),
    inversePrimary = Sky,
)

private val Dark = darkColorScheme(
    primary = Sky,
    onPrimary = Color(0xFF00213B),
    primaryContainer = Color(0xFF0B4E86),
    onPrimaryContainer = OceanTint,
    secondary = AquaBright,
    onSecondary = Color(0xFF00363B),
    secondaryContainer = Color(0xFF00505A),
    onSecondaryContainer = AquaTint,
    tertiary = SunBright,
    onTertiary = Color(0xFF482900),
    tertiaryContainer = Color(0xFF673D00),
    onTertiaryContainer = Color(0xFFFFDDB8),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
    background = Navy950,
    onBackground = Color(0xFFE3EBF3),
    surface = Navy950,
    onSurface = Color(0xFFE3EBF3),
    surfaceVariant = Navy800,
    onSurfaceVariant = Color(0xFFB8C7D6),
    surfaceContainerLowest = Color(0xFF060F18),
    surfaceContainerLow = Navy900,
    surfaceContainer = Navy850,
    surfaceContainerHigh = Navy800,
    surfaceContainerHighest = Navy700,
    outline = Slate,
    outlineVariant = Color(0xFF34495E),
    inverseSurface = Color(0xFFE3EBF3),
    inverseOnSurface = Color(0xFF1A2733),
    inversePrimary = Ocean,
)

private val CwShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

private val CwTypography = Typography().let { t ->
    t.copy(
        headlineMedium = t.headlineMedium.copy(fontWeight = FontWeight.Bold),
        headlineSmall = t.headlineSmall.copy(fontWeight = FontWeight.SemiBold),
        titleLarge = t.titleLarge.copy(fontWeight = FontWeight.SemiBold),
        titleMedium = t.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        // Slightly larger body and button text: easier to read and tap outdoors.
        bodyLarge = t.bodyLarge.copy(fontSize = 17.sp, lineHeight = 24.sp),
        bodyMedium = t.bodyMedium.copy(fontSize = 15.sp, lineHeight = 21.sp),
        labelLarge = t.labelLarge.copy(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
    )
}

@Composable
fun CooperWatersTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (dark) Dark else Light,
        shapes = CwShapes,
        typography = CwTypography,
        content = content,
    )
}
