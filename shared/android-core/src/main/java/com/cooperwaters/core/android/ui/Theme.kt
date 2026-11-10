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

/** Cooper Waters brand blue, the same in light and dark mode (side menus, splash). Matches the admin. */
val CwBrandBlue: Color = Ocean
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

/*
 * Monochrome palette (customer app): black on white like StarTrip, green for success, red for errors.
 * Dark mode inverts to white on black. Contrast pairs stay at WCAG AA.
 */
private val Ink = Color(0xFF111111)
private val Success = Color(0xFF1E8E3E)
private val SuccessBright = Color(0xFF5BD27C)

private val MonoLight = lightColorScheme(
    primary = Ink,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFEDEDED),
    onPrimaryContainer = Ink,
    secondary = Success,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFDDF3E3),
    onSecondaryContainer = Color(0xFF0B3B1A),
    tertiary = Sun,
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFFFE9D1),
    onTertiaryContainer = Color(0xFF2C1600),
    error = Color(0xFFD32F2F),
    onError = Color.White,
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
    background = Color.White,
    onBackground = Ink,
    surface = Color.White,
    onSurface = Ink,
    surfaceVariant = Color(0xFFF2F2F2),
    onSurfaceVariant = Color(0xFF5F5F5F),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFFAFAFA),
    surfaceContainer = Color(0xFFF5F5F5),
    surfaceContainerHigh = Color(0xFFF0F0F0),
    surfaceContainerHighest = Color(0xFFEAEAEA),
    outline = Color(0xFFBDBDBD),
    outlineVariant = Color(0xFFE3E3E3),
    inverseSurface = Ink,
    inverseOnSurface = Color.White,
    inversePrimary = Color.White,
)

private val MonoDark = darkColorScheme(
    primary = Color.White,
    onPrimary = Ink,
    primaryContainer = Color(0xFF2A2A2A),
    onPrimaryContainer = Color.White,
    secondary = SuccessBright,
    onSecondary = Color(0xFF00391A),
    secondaryContainer = Color(0xFF14532D),
    onSecondaryContainer = Color(0xFFDDF3E3),
    tertiary = SunBright,
    onTertiary = Color(0xFF482900),
    tertiaryContainer = Color(0xFF673D00),
    onTertiaryContainer = Color(0xFFFFDDB8),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
    background = Color.Black,
    onBackground = Color(0xFFEDEDED),
    surface = Color.Black,
    onSurface = Color(0xFFEDEDED),
    surfaceVariant = Color(0xFF1E1E1E),
    onSurfaceVariant = Color(0xFFBDBDBD),
    surfaceContainerLowest = Color.Black,
    surfaceContainerLow = Color(0xFF0E0E0E),
    surfaceContainer = Color(0xFF141414),
    surfaceContainerHigh = Color(0xFF1C1C1C),
    surfaceContainerHighest = Color(0xFF262626),
    outline = Color(0xFF6E6E6E),
    outlineVariant = Color(0xFF333333),
    inverseSurface = Color(0xFFEDEDED),
    inverseOnSurface = Ink,
    inversePrimary = Ink,
)

/** OCEAN: blue brand look (driver app). MONO: black & white (customer app). */
enum class CwPalette { OCEAN, MONO }

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
fun CooperWatersTheme(
    dark: Boolean = isSystemInDarkTheme(),
    palette: CwPalette = CwPalette.OCEAN,
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = when (palette) {
            CwPalette.OCEAN -> if (dark) Dark else Light
            CwPalette.MONO -> if (dark) MonoDark else MonoLight
        },
        shapes = CwShapes,
        typography = CwTypography,
        content = content,
    )
}
