package com.cooperwaters.core.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

/** Why a picked/captured photo couldn't be prepared for upload; [message] is short enough to show on screen. */
class PhotoReadException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Downscale + JPEG-compress photos before upload. A 12 MP camera shot (~4 MB) becomes ~150–300 KB,
 * which matters on 3G. Applies EXIF rotation so documents aren't sideways for reviewers.
 */
object ImageCompressor {
    const val CONTENT_TYPE = "image/jpeg"

    private const val TAG = "CW-Photo"

    /** @throws PhotoReadException with a short, displayable reason when the photo can't be read. */
    fun compress(context: Context, uri: Uri, maxDimension: Int = 1600, quality: Int = 70): ByteArray {
        val resolver = context.contentResolver
        val type = resolver.getType(uri) ?: "unknown type"
        // Read the file once: some providers (cloud galleries, camera apps) don't like being opened repeatedly.
        val raw = try {
            resolver.openInputStream(uri)?.use { it.readBytes() }
        } catch (e: Exception) {
            throw PhotoReadException("couldn't open the photo (${e.javaClass.simpleName})", e)
        } ?: throw PhotoReadException("couldn't open the photo")
        if (raw.isEmpty()) throw PhotoReadException("the photo file is empty; the camera app may not have saved it")

        // BitmapFactory first (all Android versions); ImageDecoder as a fallback on Android 9+ for formats it can't
        // read (e.g. some HEIC photos). ImageDecoder already applies EXIF rotation.
        val fromFactory = decodeWithBitmapFactory(raw, maxDimension)
        val decoded = fromFactory
            ?: (if (Build.VERSION.SDK_INT >= 28) decodeWithImageDecoder(raw, maxDimension) else null)
            ?: run {
                Log.w(TAG, "could not decode $uri ($type, ${raw.size} bytes)")
                throw PhotoReadException("unsupported picture format ($type)")
            }

        val rotation = if (fromFactory == null) 0f else exifRotation(raw)
        val scale = minOf(1f, maxDimension.toFloat() / maxOf(decoded.width, decoded.height))
        val matrix = Matrix().apply {
            if (scale < 1f) postScale(scale, scale)
            if (rotation != 0f) postRotate(rotation)
        }
        val finalBitmap = if (scale < 1f || rotation != 0f) {
            Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
        } else {
            decoded
        }
        val out = ByteArrayOutputStream()
        finalBitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
        if (finalBitmap !== decoded) finalBitmap.recycle()
        decoded.recycle()
        return out.toByteArray()
    }

    private fun decodeWithBitmapFactory(raw: ByteArray, maxDimension: Int): Bitmap? {
        // A bounds-only decode always returns null and just fills in outWidth/outHeight, so judge success by those.
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, maxDimension) }
        return BitmapFactory.decodeByteArray(raw, 0, raw.size, opts)
    }

    @RequiresApi(28)
    private fun decodeWithImageDecoder(raw: ByteArray, maxDimension: Int): Bitmap? = try {
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(raw))) { decoder, info, _ ->
            decoder.setTargetSampleSize(sampleSize(info.size.width, info.size.height, maxDimension))
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE // Bitmap.compress needs a software bitmap
        }
    } catch (e: Exception) {
        Log.w(TAG, "ImageDecoder failed", e)
        null
    }

    private fun exifRotation(raw: ByteArray): Float = try {
        when (ExifInterface(ByteArrayInputStream(raw)).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> 0f
        }
    } catch (e: Exception) {
        0f
    }

    /** Largest power-of-two downsample that keeps both sides at or above [maxDimension]. */
    private fun sampleSize(width: Int, height: Int, maxDimension: Int): Int {
        var sample = 1
        while (width / (sample * 2) >= maxDimension || height / (sample * 2) >= maxDimension) sample *= 2
        return sample
    }
}
