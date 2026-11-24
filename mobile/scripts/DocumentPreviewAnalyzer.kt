package expo.modules.camera

import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.SystemClock
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.roundToInt

internal class DocumentPreviewAnalyzer : ImageAnalysis.Analyzer {
  private data class Sample(val capturedAt: Long, val jpeg: ByteArray)
  private val latest = AtomicReference<Sample?>()
  private var lastCapture = -250L

  override fun analyze(image: ImageProxy) {
    val now = SystemClock.elapsedRealtime()
    try {
      if (now - lastCapture < 250) return
      lastCapture = now
      val crop = image.cropRect
      val original = image.toBitmap()
      val scale = minOf(1f, 560f / maxOf(crop.width(), crop.height()))
      val transform = Matrix().apply {
        postRotate(image.imageInfo.rotationDegrees.toFloat())
        postScale(scale, scale)
      }
      val portrait = try {
        Bitmap.createBitmap(original, crop.left, crop.top, crop.width(), crop.height(), transform, true)
      } catch (error: RuntimeException) {
        original.recycle()
        throw error
      }
      try {
        if (portrait.height <= portrait.width || (3f * portrait.height / 4).roundToInt() - portrait.width !in -2..2) return
        val data = ByteArrayOutputStream()
        if (portrait.compress(Bitmap.CompressFormat.JPEG, 66, data)) {
          latest.set(Sample(now, data.toByteArray()))
        }
      } finally {
        if (portrait !== original) portrait.recycle()
        original.recycle()
      }
    } catch (_: RuntimeException) {
      // A malformed or interrupted frame is replaced by the next preview frame.
    } finally {
      image.close()
    }
  }

  fun takeLatest(cache: File): Map<String, Any>? {
    val sample = latest.getAndSet(null) ?: return null
    if (SystemClock.elapsedRealtime() - sample.capturedAt > 450) return null
    val file = File.createTempFile("alignment-", ".jpg", cache)
    try {
      file.writeBytes(sample.jpeg)
    } catch (error: java.io.IOException) {
      file.delete()
      throw error
    }
    return mapOf("uri" to android.net.Uri.fromFile(file).toString(), "ageMs" to SystemClock.elapsedRealtime() - sample.capturedAt)
  }
}
