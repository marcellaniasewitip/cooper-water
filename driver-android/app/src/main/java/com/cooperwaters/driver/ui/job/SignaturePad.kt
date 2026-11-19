package com.cooperwaters.driver.ui.job

import android.graphics.Bitmap
import android.graphics.Paint
import android.util.Base64
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import java.io.ByteArrayOutputStream

/** Strokes of a signature drawn with a finger. */
class SignatureState {
    val strokes = mutableStateListOf<List<Offset>>()
    var current by mutableStateOf<List<Offset>>(emptyList())
    var size by mutableStateOf(IntSize.Zero)

    val isEmpty: Boolean get() = strokes.isEmpty() && current.size < 2

    fun clear() {
        strokes.clear()
        current = emptyList()
    }

    /** Black ink on white, as a PNG (base64, no line breaks); null when nothing was drawn. */
    fun toPngBase64(): String? {
        if (isEmpty || size.width <= 0 || size.height <= 0) return null
        // Keep the image small (max 900 px wide) so it uploads fast on 3G.
        val scale = minOf(1f, 900f / size.width)
        val w = (size.width * scale).toInt().coerceAtLeast(1)
        val h = (size.height * scale).toInt().coerceAtLeast(1)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(bmp)
        canvas.drawColor(android.graphics.Color.WHITE)
        val paint = Paint().apply {
            color = android.graphics.Color.BLACK
            style = Paint.Style.STROKE
            strokeWidth = 5f
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
            isAntiAlias = true
        }
        for (stroke in strokes + listOf(current)) {
            if (stroke.size < 2) continue
            val path = android.graphics.Path()
            path.moveTo(stroke[0].x * scale, stroke[0].y * scale)
            for (p in stroke.drop(1)) path.lineTo(p.x * scale, p.y * scale)
            canvas.drawPath(path, paint)
        }
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        bmp.recycle()
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }
}

@Composable
fun rememberSignatureState(): SignatureState = remember { SignatureState() }

/** White box the customer signs in with a finger. */
@Composable
fun SignaturePad(state: SignatureState, hint: String, modifier: Modifier = Modifier) {
    Box(
        modifier
            .background(Color.White, RoundedCornerShape(12.dp))
            .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(12.dp))
            .testTag("signature-pad"),
    ) {
        if (state.isEmpty) {
            Text(hint, color = Color.Gray, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.align(Alignment.Center))
        }
        Canvas(
            Modifier
                .fillMaxSize()
                .onSizeChanged { state.size = it }
                .pointerInput(state) {
                    detectDragGestures(
                        onDragStart = { state.current = listOf(it) },
                        onDrag = { change, _ ->
                            change.consume()
                            state.current = state.current + change.position
                        },
                        onDragEnd = {
                            if (state.current.size > 1) state.strokes.add(state.current)
                            state.current = emptyList()
                        },
                        onDragCancel = {
                            if (state.current.size > 1) state.strokes.add(state.current)
                            state.current = emptyList()
                        },
                    )
                },
        ) {
            val ink = Stroke(width = 3.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
            for (stroke in state.strokes + listOf(state.current)) {
                if (stroke.size < 2) continue
                val path = Path().apply {
                    moveTo(stroke[0].x, stroke[0].y)
                    stroke.drop(1).forEach { lineTo(it.x, it.y) }
                }
                drawPath(path, Color.Black, style = ink)
            }
        }
    }
}
