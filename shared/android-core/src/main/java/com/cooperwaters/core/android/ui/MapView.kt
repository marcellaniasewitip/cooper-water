package com.cooperwaters.core.android.ui

import android.content.Context
import android.content.pm.PackageManager
import android.graphics.drawable.Drawable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.cooperwaters.core.util.Geo
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.model.BitmapDescriptorFactory
import com.google.android.gms.maps.model.CameraPosition
import com.google.android.gms.maps.model.LatLng
import com.google.maps.android.compose.Circle
import com.google.maps.android.compose.GoogleMap
import com.google.maps.android.compose.MapUiSettings
import com.google.maps.android.compose.Marker
import com.google.maps.android.compose.MarkerState
import com.google.maps.android.compose.rememberCameraPositionState
import org.osmdroid.config.Configuration
import org.osmdroid.events.MapEventsReceiver
import org.osmdroid.events.MapListener
import org.osmdroid.events.ScrollEvent
import org.osmdroid.events.ZoomEvent
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.CustomZoomButtonsController
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.MapEventsOverlay
import org.osmdroid.views.overlay.Marker as OsmMarker
import org.osmdroid.views.overlay.Polygon

/**
 * Map abstraction used by both apps. Google Maps (Maps Compose) when the app is built with a Google Maps
 * key (-Pcw.googleMapsKey → manifest com.google.android.geo.API_KEY); otherwise osmdroid (OpenStreetMap, no
 * key). Screens only use [CwMap] / [MapMarker], so they work the same with either.
 */
data class MapMarker(
    val id: String,
    val lat: Double,
    val lng: Double,
    val title: String? = null,
    val kind: Kind = Kind.DESTINATION,
    /** Draw a circle of this radius (depot geofence). */
    val radiusM: Double? = null,
) {
    enum class Kind { DESTINATION, DRIVER, DEPOT, ME }
}

data class MapCenter(val lat: Double = Geo.POM_LAT, val lng: Double = Geo.POM_LNG, val zoom: Double = 14.0)

private fun ensureOsmConfig(context: Context) {
    val cfg = Configuration.getInstance()
    if (cfg.userAgentValue.isNullOrBlank() || cfg.userAgentValue == "osmdroid") {
        cfg.load(context, context.getSharedPreferences("cw_osmdroid", Context.MODE_PRIVATE))
        // OSM tile policy requires an identifying user agent.
        cfg.userAgentValue = context.packageName
    }
}

/**
 * @param center initial camera; when [followCenter] is true the camera re-centres whenever [center] changes.
 * @param onCenterChanged reports the map centre after the user pans (for "drag the map under the pin" pickers).
 * @param onTap reports a tapped coordinate.
 */
@Composable
fun CwMap(
    modifier: Modifier = Modifier,
    center: MapCenter = MapCenter(),
    markers: List<MapMarker> = emptyList(),
    followCenter: Boolean = false,
    onCenterChanged: ((lat: Double, lng: Double) -> Unit)? = null,
    onTap: ((lat: Double, lng: Double) -> Unit)? = null,
) {
    val context = LocalContext.current
    val useGoogle = remember { hasGoogleMapsKey(context) }
    if (useGoogle) {
        GoogleCwMap(modifier, center, markers, followCenter, onCenterChanged, onTap)
    } else {
        OsmCwMap(modifier, center, markers, followCenter, onCenterChanged, onTap)
    }
}

/** True when the app was built with a Google Maps key (and Google Play services can show the map). */
fun hasGoogleMapsKey(context: Context): Boolean = try {
    val info = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
    !info.metaData?.getString("com.google.android.geo.API_KEY").isNullOrBlank()
} catch (e: Exception) {
    false
}

@Composable
private fun GoogleCwMap(
    modifier: Modifier,
    center: MapCenter,
    markers: List<MapMarker>,
    followCenter: Boolean,
    onCenterChanged: ((lat: Double, lng: Double) -> Unit)?,
    onTap: ((lat: Double, lng: Double) -> Unit)?,
) {
    val camera = rememberCameraPositionState {
        position = CameraPosition.fromLatLngZoom(LatLng(center.lat, center.lng), center.zoom.toFloat())
    }
    val latestOnCenterChanged by rememberUpdatedState(onCenterChanged)
    LaunchedEffect(center, followCenter) {
        if (followCenter) camera.animate(CameraUpdateFactory.newLatLngZoom(LatLng(center.lat, center.lng), center.zoom.toFloat()))
    }
    // Report the centre whenever the camera stops (user pan, or our own animation) — for pin pickers.
    LaunchedEffect(camera) {
        snapshotFlow { camera.isMoving }.collect { moving ->
            if (!moving) camera.position.target.let { latestOnCenterChanged?.invoke(it.latitude, it.longitude) }
        }
    }
    GoogleMap(
        modifier = modifier.clipToBounds(),
        cameraPositionState = camera,
        uiSettings = MapUiSettings(zoomControlsEnabled = true, mapToolbarEnabled = false, myLocationButtonEnabled = false),
        onMapClick = { p -> onTap?.invoke(p.latitude, p.longitude) },
    ) {
        for (m in markers) {
            key(m.id) {
                m.radiusM?.let { r ->
                    Circle(
                        center = LatLng(m.lat, m.lng),
                        radius = r,
                        fillColor = Color(0x220B6FB8),
                        strokeColor = Color(0xFF0B6FB8),
                        strokeWidth = 3f,
                    )
                }
                Marker(
                    state = remember(m.lat, m.lng) { MarkerState(LatLng(m.lat, m.lng)) },
                    title = m.title,
                    icon = BitmapDescriptorFactory.defaultMarker(
                        when (m.kind) {
                            MapMarker.Kind.DRIVER -> BitmapDescriptorFactory.HUE_AZURE
                            MapMarker.Kind.DEPOT -> BitmapDescriptorFactory.HUE_GREEN
                            MapMarker.Kind.ME -> BitmapDescriptorFactory.HUE_VIOLET
                            MapMarker.Kind.DESTINATION -> BitmapDescriptorFactory.HUE_RED
                        },
                    ),
                )
            }
        }
    }
}

@Composable
private fun OsmCwMap(
    modifier: Modifier,
    center: MapCenter,
    markers: List<MapMarker>,
    followCenter: Boolean,
    onCenterChanged: ((lat: Double, lng: Double) -> Unit)?,
    onTap: ((lat: Double, lng: Double) -> Unit)?,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val latestOnCenterChanged by rememberUpdatedState(onCenterChanged)
    val latestOnTap by rememberUpdatedState(onTap)
    val mapView = remember {
        ensureOsmConfig(context)
        MapView(context).apply {
            setTileSource(TileSourceFactory.MAPNIK)
            setMultiTouchControls(true)
            zoomController.setVisibility(CustomZoomButtonsController.Visibility.SHOW_AND_FADEOUT)
            controller.setZoom(center.zoom)
            controller.setCenter(GeoPoint(center.lat, center.lng))
            isTilesScaledToDpi = true
            // Keep pans on the map when it sits inside a scrolling parent.
            setOnTouchListener { v, _ ->
                v.parent?.requestDisallowInterceptTouchEvent(true)
                false
            }
            val self = this
            addMapListener(object : MapListener {
                override fun onScroll(event: ScrollEvent?): Boolean {
                    val c = self.mapCenter
                    latestOnCenterChanged?.invoke(c.latitude, c.longitude)
                    return false
                }

                override fun onZoom(event: ZoomEvent?): Boolean = false
            })
        }
    }
    val tapOverlay = remember {
        MapEventsOverlay(object : MapEventsReceiver {
            override fun singleTapConfirmedHelper(p: GeoPoint): Boolean {
                val cb = latestOnTap ?: return false
                cb(p.latitude, p.longitude)
                return true
            }

            override fun longPressHelper(p: GeoPoint): Boolean = false
        })
    }
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> mapView.onResume()
                Lifecycle.Event.ON_PAUSE -> mapView.onPause()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            mapView.onDetach()
        }
    }
    AndroidView(
        factory = { mapView },
        // Clip: in a scrolling list the map view otherwise paints over the cards above and below it.
        modifier = modifier.clipToBounds(),
        update = { map ->
            map.overlays.clear()
            map.overlays.add(tapOverlay)
            for (m in markers) {
                m.radiusM?.let { r ->
                    val circle = Polygon(map)
                    circle.setPoints(Polygon.pointsAsCircle(GeoPoint(m.lat, m.lng), r))
                    circle.fillPaint.color = 0x220B6FB8
                    circle.outlinePaint.color = 0xFF0B6FB8.toInt()
                    circle.outlinePaint.strokeWidth = 2f
                    map.overlays.add(circle)
                }
                val marker = OsmMarker(map)
                marker.position = GeoPoint(m.lat, m.lng)
                marker.title = m.title
                marker.setAnchor(OsmMarker.ANCHOR_CENTER, OsmMarker.ANCHOR_BOTTOM)
                iconFor(context, m.kind)?.let { marker.icon = it }
                map.overlays.add(marker)
            }
            if (followCenter) {
                map.controller.animateTo(GeoPoint(center.lat, center.lng))
            }
            map.invalidate()
        },
    )
}

private fun iconFor(context: Context, kind: MapMarker.Kind): Drawable? {
    val res = when (kind) {
        MapMarker.Kind.DRIVER -> com.cooperwaters.core.R.drawable.cw_marker_truck
        MapMarker.Kind.DEPOT -> com.cooperwaters.core.R.drawable.cw_marker_depot
        MapMarker.Kind.ME -> com.cooperwaters.core.R.drawable.cw_marker_me
        MapMarker.Kind.DESTINATION -> return null // osmdroid default pin
    }
    return ContextCompat.getDrawable(context, res)
}
