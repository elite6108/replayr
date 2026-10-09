import AVFoundation
import ExpoModulesCore
import UIKit

public class ReplayrExportModule: Module {
  private var session: AVAssetExportSession?
  private var progressTimer: Timer?
  private let queue = DispatchQueue(label: "tv.elite.replay.export")

  public func definition() -> ModuleDefinition {
    Name("ReplayrExport")
    Events("onExportProgress")

    AsyncFunction("getExportCapabilities") { () -> [String: Any] in
      let hardware = Self.hardwareH264()
      return [
        "h264": hardware,
        "maxWidth": 1920,
        "maxHeight": 1920,
        "maxFps": 60,
        "recommendedWidth": 1920,
        "recommendedHeight": 1080,
        "recommendedFps": 60,
      ]
    }

    AsyncFunction("exportProject") { (request: [String: Any], promise: Promise) in
      self.queue.async {
        self.startExport(request, promise: promise)
      }
    }

    Function("cancelExport") {
      self.session?.cancelExport()
    }
  }

  private func startExport(_ request: [String: Any], promise: Promise) {
    if session != nil {
      promise.reject("EXPORT_BUSY", "An export is already running.")
      return
    }
    guard
      let sourcePath = Self.filePath(request["sourcePath"]),
      let outputPath = Self.filePath(request["outputPath"]),
      let startMs = Self.number(request["startMs"]),
      let endMs = Self.number(request["endMs"]),
      let cropX = Self.number(request["cropX"]),
      let cropY = Self.number(request["cropY"]),
      let cropWidth = Self.number(request["cropWidth"]),
      let cropHeight = Self.number(request["cropHeight"]),
      let outWidth = Self.number(request["outWidth"]),
      let outHeight = Self.number(request["outHeight"]),
      let volume = Self.number(request["volume"])
    else {
      promise.reject("EXPORT_INPUT", "Export request is incomplete.")
      return
    }
    let muted = (request["muted"] as? Bool) ?? false
    let watermark = (request["watermark"] as? Bool) ?? false
    let watermarkPath = Self.filePath(request["watermarkPath"])
    if watermark && (watermarkPath == nil || !FileManager.default.fileExists(atPath: watermarkPath!)) {
      promise.reject("EXPORT_WATERMARK", "Could not load the Replayr watermark.")
      return
    }
    if endMs - startMs < 1000 || outWidth < 2 || outHeight < 2 || cropWidth < 2 || cropHeight < 2 {
      promise.reject("EXPORT_INPUT", "Select at least one second.")
      return
    }

    let sourceURL = URL(fileURLWithPath: sourcePath)
    let outputURL = URL(fileURLWithPath: outputPath)
    try? FileManager.default.removeItem(at: outputURL)
    let asset = AVURLAsset(url: sourceURL)
    if let failure = Self.loadTracks(asset) {
      promise.reject("EXPORT_SOURCE", failure)
      return
    }
    let start = CMTime(value: CMTimeValue(startMs), timescale: 1000)
    let duration = CMTime(value: CMTimeValue(endMs - startMs), timescale: 1000)
    let range = CMTimeRange(start: start, duration: duration)

    let composition = AVMutableComposition()
    guard
      let sourceVideo = asset.tracks(withMediaType: .video).first,
      let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
    else {
      promise.reject("EXPORT_SOURCE", "That clip has no video.")
      return
    }
    do {
      try videoTrack.insertTimeRange(range, of: sourceVideo, at: .zero)
    } catch {
      promise.reject("EXPORT_SOURCE", error.localizedDescription)
      return
    }
    videoTrack.preferredTransform = sourceVideo.preferredTransform

    var audioMix: AVMutableAudioMix?
    if let sourceAudio = asset.tracks(withMediaType: .audio).first,
       let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
      try? audioTrack.insertTimeRange(range, of: sourceAudio, at: .zero)
      let params = AVMutableAudioMixInputParameters(track: audioTrack)
      params.setVolume(muted ? 0 : Float(min(1, max(0, volume))), at: .zero)
      let mix = AVMutableAudioMix()
      mix.inputParameters = [params]
      audioMix = mix
    }

    let videoComposition = AVMutableVideoComposition()
    let fps = max(1, min(60, Int(sourceVideo.nominalFrameRate.rounded())))
    videoComposition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(fps == 0 ? 30 : fps))
    videoComposition.renderSize = CGSize(width: outWidth, height: outHeight)
    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: composition.duration)
    let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
    let crop = CGRect(x: cropX, y: cropY, width: cropWidth, height: cropHeight)
    let output = CGSize(width: outWidth, height: outHeight)
    layerInstruction.setTransform(Self.cropTransform(track: sourceVideo, crop: crop, output: output), at: .zero)
    instruction.layerInstructions = [layerInstruction]
    videoComposition.instructions = [instruction]

    if watermark, let watermarkPath, let image = UIImage(contentsOfFile: watermarkPath)?.cgImage {
      let size = videoComposition.renderSize
      DispatchQueue.main.sync {
        let parent = CALayer()
        let videoLayer = CALayer()
        parent.frame = CGRect(origin: .zero, size: size)
        videoLayer.frame = parent.frame
        parent.isGeometryFlipped = true
        parent.addSublayer(videoLayer)
        let mark = CALayer()
        mark.contents = image
        let markWidth = size.width * 0.22
        let markHeight = markWidth * (CGFloat(image.height) / CGFloat(max(image.width, 1)))
        mark.frame = CGRect(x: size.width - markWidth - 28, y: 28, width: markWidth, height: markHeight)
        mark.opacity = 0.92
        parent.addSublayer(mark)
        videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(postProcessingAsVideoLayer: videoLayer, in: parent)
      }
    } else if watermark {
      promise.reject("EXPORT_WATERMARK", "Could not load the Replayr watermark.")
      return
    }

    guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
      promise.reject("EXPORT_ENCODER", "Could not start the hardware encoder.")
      return
    }
    exporter.outputURL = outputURL
    exporter.outputFileType = .mp4
    exporter.shouldOptimizeForNetworkUse = true
    exporter.videoComposition = videoComposition
    exporter.audioMix = audioMix
    session = exporter
    DispatchQueue.main.async {
      self.progressTimer?.invalidate()
      self.progressTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { _ in
        let progress = Double(exporter.progress)
        self.sendEvent("onExportProgress", ["progress": progress, "status": "rendering"])
      }
    }
    exporter.exportAsynchronously { [weak self] in
      guard let self else { return }
      DispatchQueue.main.async { self.progressTimer?.invalidate() }
      self.session = nil
      switch exporter.status {
      case .completed:
        let ms = Int(CMTimeGetSeconds(composition.duration) * 1000)
        self.sendEvent("onExportProgress", ["progress": 1, "status": "complete"])
        promise.resolve(["path": outputPath, "durationMs": ms])
      case .cancelled:
        try? FileManager.default.removeItem(at: outputURL)
        self.sendEvent("onExportProgress", ["progress": Double(exporter.progress), "status": "cancelled"])
        promise.reject("EXPORT_CANCELLED", "Export cancelled.")
      default:
        try? FileManager.default.removeItem(at: outputURL)
        self.sendEvent("onExportProgress", ["progress": Double(exporter.progress), "status": "failed"])
        promise.reject("EXPORT_FAILED", exporter.error?.localizedDescription ?? "Export failed.")
      }
    }
  }

  private static func cropTransform(track: AVAssetTrack, crop: CGRect, output: CGSize) -> CGAffineTransform {
    let natural = track.naturalSize
    let preferred = track.preferredTransform
    let displayed = CGRect(origin: .zero, size: natural).applying(preferred)
    var transform = preferred
    transform = transform.concatenating(CGAffineTransform(translationX: -displayed.origin.x, y: -displayed.origin.y))
    transform = transform.concatenating(CGAffineTransform(translationX: -crop.origin.x, y: -crop.origin.y))
    let scaleX = output.width / max(crop.width, 1)
    let scaleY = output.height / max(crop.height, 1)
    transform = transform.concatenating(CGAffineTransform(scaleX: scaleX, y: scaleY))
    return transform
  }

  private static func loadTracks(_ asset: AVURLAsset) -> String? {
    let semaphore = DispatchSemaphore(value: 0)
    asset.loadValuesAsynchronously(forKeys: ["tracks"]) { semaphore.signal() }
    semaphore.wait()
    var error: NSError?
    let status = asset.statusOfValue(forKey: "tracks", error: &error)
    if status == .failed { return error?.localizedDescription ?? "Could not read the clip." }
    return nil
  }

  private static func hardwareH264() -> Bool {
    AVAssetExportSession.allExportPresets().contains(AVAssetExportPresetHighestQuality)
  }

  private static func number(_ value: Any?) -> Double? {
    if let number = value as? NSNumber { return number.doubleValue }
    return nil
  }

  private static func filePath(_ value: Any?) -> String? {
    guard let raw = value as? String, !raw.isEmpty else { return nil }
    if raw.hasPrefix("file://"), let url = URL(string: raw) { return url.path }
    return raw
  }
}
