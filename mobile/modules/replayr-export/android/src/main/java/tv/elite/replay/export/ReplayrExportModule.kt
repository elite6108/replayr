package tv.elite.replay.export

import android.graphics.BitmapFactory
import android.media.MediaCodecList
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.os.bundleOf
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.BitmapOverlay
import androidx.media3.effect.Crop
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.OverlaySettings
import androidx.media3.effect.Presentation
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

@OptIn(UnstableApi::class)
class ReplayrExportModule : Module() {
  private var transformer: Transformer? = null
  private val main = Handler(Looper.getMainLooper())
  private var progressRunnable: Runnable? = null

  override fun definition() = ModuleDefinition {
    Name("ReplayrExport")
    Events("onExportProgress")

    AsyncFunction("getExportCapabilities") {
      val hardware = hasHardwareH264()
      mapOf(
        "h264" to hardware,
        "maxWidth" to 1920,
        "maxHeight" to 1920,
        "maxFps" to 60,
        "recommendedWidth" to 1920,
        "recommendedHeight" to 1080,
        "recommendedFps" to 30,
      )
    }

    AsyncFunction("exportProject") { request: Map<String, Any?>, promise: Promise ->
      main.post {
        try {
          startExport(request, promise)
        } catch (error: Exception) {
          promise.reject("EXPORT_FAILED", error.message ?: "Export failed.", error)
        }
      }
    }

    Function("cancelExport") {
      main.post { transformer?.cancel() }
    }
  }

  private fun startExport(request: Map<String, Any?>, promise: Promise) {
    if (transformer != null) {
      promise.reject("EXPORT_BUSY", "An export is already running.", null)
      return
    }
    val context = appContext.reactContext ?: run {
      promise.reject("EXPORT_CONTEXT", "Export is not ready.", null)
      return
    }
    val sourcePath = filePath(request["sourcePath"])
    val outputPath = filePath(request["outputPath"])
    if (sourcePath == null || outputPath == null) {
      promise.reject("EXPORT_INPUT", "Export request is incomplete.", null)
      return
    }
    val startMs = num(request, "startMs").toLong()
    val endMs = num(request, "endMs").toLong()
    val srcW = num(request, "sourceWidth").toFloat().coerceAtLeast(2f)
    val srcH = num(request, "sourceHeight").toFloat().coerceAtLeast(2f)
    val cropX = num(request, "cropX").toFloat()
    val cropY = num(request, "cropY").toFloat()
    val cropW = num(request, "cropWidth").toFloat()
    val cropH = num(request, "cropHeight").toFloat()
    val outW = num(request, "outWidth").toInt()
    val outH = num(request, "outHeight").toInt()
    val volume = num(request, "volume").toFloat().coerceIn(0f, 1f)
    val muted = request["muted"] as? Boolean ?: false
    val watermark = request["watermark"] as? Boolean ?: false
    val watermarkPath = filePath(request["watermarkPath"])
    if (endMs - startMs < 1000 || outW < 2 || outH < 2) {
      promise.reject("EXPORT_INPUT", "Select at least one second.", null)
      return
    }
    if (watermark && (watermarkPath == null || !File(watermarkPath).isFile)) {
      promise.reject("EXPORT_WATERMARK", "Could not load the Replayr watermark.", null)
      return
    }

    val left = (cropX / srcW) * 2f - 1f
    val right = ((cropX + cropW) / srcW) * 2f - 1f
    val top = 1f - (cropY / srcH) * 2f
    val bottom = 1f - ((cropY + cropH) / srcH) * 2f
    val videoEffects = mutableListOf<androidx.media3.common.Effect>(
      Crop(left, right, bottom, top),
      Presentation.createForWidthAndHeight(outW, outH, Presentation.LAYOUT_SCALE_TO_FIT),
    )
    if (watermark && watermarkPath != null) {
      val bitmap = BitmapFactory.decodeFile(watermarkPath)
        ?: run {
          promise.reject("EXPORT_WATERMARK", "Could not load the Replayr watermark.", null)
          return
        }
      val settings = OverlaySettings.Builder()
        .setScale(0.22f, 0.22f)
        .setBackgroundFrameAnchor(0.78f, -0.78f)
        .setOverlayFrameAnchor(0f, 0f)
        .build()
      videoEffects.add(OverlayEffect(listOf(BitmapOverlay.createStaticBitmapOverlay(bitmap, settings))))
    }

    val audio = if (muted || volume <= 0f || volume >= 0.999f) {
      emptyList()
    } else {
      val mix = ChannelMixingAudioProcessor()
      mix.putChannelMixingMatrix(ChannelMixingMatrix(1, 1, floatArrayOf(volume)))
      mix.putChannelMixingMatrix(ChannelMixingMatrix(2, 2, floatArrayOf(volume, 0f, 0f, volume)))
      listOf(mix)
    }
    val item = MediaItem.Builder()
      .setUri(android.net.Uri.fromFile(File(sourcePath)))
      .setClippingConfiguration(
        MediaItem.ClippingConfiguration.Builder()
          .setStartPositionMs(startMs)
          .setEndPositionMs(endMs)
          .build(),
      )
      .build()
    val edited = EditedMediaItem.Builder(item)
      .setRemoveAudio(muted || volume <= 0f)
      .setEffects(Effects(audio, videoEffects))
      .build()

    File(outputPath).delete()
    val active = Transformer.Builder(context)
      .setVideoMimeType(MimeTypes.VIDEO_H264)
      .setAudioMimeType(MimeTypes.AUDIO_AAC)
      .addListener(object : Transformer.Listener {
        override fun onCompleted(composition: androidx.media3.transformer.Composition, exportResult: ExportResult) {
          stopProgress()
          transformer = null
          sendEvent("onExportProgress", bundleOf("progress" to 1.0, "status" to "complete"))
          promise.resolve(mapOf("path" to outputPath, "durationMs" to (endMs - startMs)))
        }

        override fun onError(
          composition: androidx.media3.transformer.Composition,
          exportResult: ExportResult,
          exportException: ExportException,
        ) {
          stopProgress()
          transformer = null
          File(outputPath).delete()
          val cancelled = exportException.errorCode == ExportException.ERROR_CODE_FAILED_RUNTIME_CHECK &&
            exportException.message?.contains("cancel", ignoreCase = true) == true
          if (cancelled) {
            sendEvent("onExportProgress", bundleOf("progress" to 0.0, "status" to "cancelled"))
            promise.reject("EXPORT_CANCELLED", "Export cancelled.", exportException)
          } else {
            sendEvent("onExportProgress", bundleOf("progress" to 0.0, "status" to "failed"))
            promise.reject("EXPORT_FAILED", exportException.message ?: "Export failed.", exportException)
          }
        }
      })
      .build()
    transformer = active
    active.start(edited, outputPath)
    val holder = ProgressHolder()
    val tick = object : Runnable {
      override fun run() {
        val current = transformer ?: return
        if (current.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) {
          sendEvent(
            "onExportProgress",
            bundleOf("progress" to (holder.progress / 100.0), "status" to "rendering"),
          )
        }
        main.postDelayed(this, 300)
      }
    }
    progressRunnable = tick
    main.post(tick)
  }

  private fun stopProgress() {
    progressRunnable?.let { main.removeCallbacks(it) }
    progressRunnable = null
  }

  private fun num(request: Map<String, Any?>, key: String): Double {
    val value = request[key]
    if (value is Number) return value.toDouble()
    throw IllegalArgumentException("Missing $key")
  }

  private fun filePath(value: Any?): String? {
    val raw = value as? String ?: return null
    if (raw.isEmpty()) return null
    return if (raw.startsWith("file://")) android.net.Uri.parse(raw).path else raw
  }

  private fun hasHardwareH264(): Boolean {
    val list = MediaCodecList(MediaCodecList.REGULAR_CODECS)
    return list.codecInfos.any { info ->
      if (!info.isEncoder) return@any false
      val avc = info.supportedTypes.any { it.equals(MimeTypes.VIDEO_H264, ignoreCase = true) }
      if (!avc) return@any false
      if (Build.VERSION.SDK_INT >= 29) !info.isSoftwareOnly else !info.name.contains("OMX.google", ignoreCase = true)
    }
  }
}
