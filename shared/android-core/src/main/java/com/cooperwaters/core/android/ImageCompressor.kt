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
import java.io.ByteArrayOutputStream

/**
 * Downscale + JPEG-compress photos before upload. A 12 MP camera shot (~4 MB) becomes ~150–300 KB,
 * which matters on 3G. Applies EXIF rotation so documents aren't sideways for reviewers.
 */
object ImageCompressor {
    const val CONTENT_TYPE = "image/jpeg"

    private const val TAG = "CW-Photo"

    fun compress(context: Context, uri: Uri, maxDimension: Int = 1600, quality: Int = 70): ByteArray? {
        val resolver = context.contentResolver
        // BitmapFactory first (all Android versions); ImageDecoder as a fallback on Android 9+ for formats or
        // files BitmapFactory can't read (e.g. some HEIC photos). ImageDecoder already applies EXIF rotation.
        val fromFactory = decodeWithBitmapFactory(context, uri, maxDimension)
        val decoded = fromFactory
            ?: (if (Build.VERSION.SDK_INT >= 28) decodeWithImageDecoder(context, uri, maxDimension) else null)
            ?: run {
                Log.w(TAG, "could not decode $uri (type ${resolver.getType(uri)})")
                return null
            }

        val rotation = if (fromFactory == null) 0f else try {
            resolver.openInputStream(uri)?.use { input ->
                when (ExifInterface(input).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                    ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                    ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                    ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                    else -> 0f
                }
            } ?: 0f
        } catch (e: Exception) {
            0f
        }

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

    private fun decodeWithBitmapFactory(context: Context, uri: Uri, maxDimension: Int): Bitmap? {
        val resolver = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        // A bounds-only decode always returns null and just fills in outWidth/outHeight, so judge success by
        // those (they stay -1 if the stream couldn't be opened or the image couldn't be read).
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, maxDimension) }
        return resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
    }

    @RequiresApi(28)
    private fun decodeWithImageDecoder(context: Context, uri: Uri, maxDimension: Int): Bitmap? = try {
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { decoder, info, _ ->
            decoder.setTargetSampleSize(sampleSize(info.size.width, info.size.height, maxDimension))
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE // Bitmap.compress needs a software bitmap
        }
    } catch (e: Exception) {
        Log.w(TAG, "ImageDecoder failed for $uri", e)
        null
    }

    /** Largest power-of-two downsample that keeps both sides at or above [maxDimension]. */
    private fun sampleSize(width: Int, height: Int, maxDimension: Int): Int {
        var sample = 1
        while (width / (sample * 2) >= maxDimension || height / (sample * 2) >= maxDimension) sample *= 2
        return sample
    }
}
