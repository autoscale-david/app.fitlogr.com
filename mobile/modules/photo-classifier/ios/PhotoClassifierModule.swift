import ExpoModulesCore
import Photos
import UIKit
import Vision

let defaultMaxLabels = 8
let defaultMinConfidence = 0.05

public class PhotoClassifierModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PhotoClassifier")

    // One bad asset is an error entry. The rest of the batch still returns.
    AsyncFunction("classifyAssets") { (assetIds: [String], options: [String: Any]) async -> [[String: Any]] in
      let maxLabels = intOption(options, "maxLabels", defaultMaxLabels)
      let minConfidence = floatOption(options, "minConfidence", defaultMinConfidence)
      var results: [[String: Any]] = []
      for assetId in assetIds {
        results.append(await classifyAsset(assetId, maxLabels: maxLabels, minConfidence: minConfidence))
      }
      return results
    }

    AsyncFunction("classifyFile") { (uri: String, options: [String: Any]) async -> [String: Any] in
      let maxLabels = intOption(options, "maxLabels", defaultMaxLabels)
      let minConfidence = floatOption(options, "minConfidence", defaultMinConfidence)
      return classifyImage(loadFile(uri), assetId: uri, maxLabels: maxLabels, minConfidence: minConfidence)
    }

    Function("supportedLabels") { () -> [String] in
      supportedLabelIds()
    }
  }
}

private func classifyAsset(_ assetId: String, maxLabels: Int, minConfidence: Float) async -> [String: Any] {
  let localId = assetId.hasPrefix("ph://") ? String(assetId.dropFirst(5)) : assetId
  let fetched = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil)
  guard let asset = fetched.firstObject else {
    return ["assetId": assetId, "error": "Photo is not in the library"]
  }
  let image = await requestImage(asset, allowNetwork: false) ?? await requestImage(asset, allowNetwork: true)
  return classifyImage(image, assetId: assetId, maxLabels: maxLabels, minConfidence: minConfidence)
}

private func requestImage(_ asset: PHAsset, allowNetwork: Bool) async -> UIImage? {
  await withCheckedContinuation { continuation in
    let options = PHImageRequestOptions()
    options.isNetworkAccessAllowed = allowNetwork
    options.deliveryMode = .highQualityFormat
    options.resizeMode = .fast
    options.isSynchronous = false
    var resumed = false
    func finish(_ image: UIImage?) {
      if resumed { return }
      resumed = true
      continuation.resume(returning: image)
    }
    PHImageManager.default().requestImage(
      for: asset,
      targetSize: CGSize(width: 448, height: 448),
      contentMode: .aspectFit,
      options: options
    ) { image, info in
      let cancelled = (info?[PHImageCancelledKey] as? Bool) ?? false
      if cancelled {
        finish(nil)
        return
      }
      let degraded = (info?[PHImageResultIsDegradedKey] as? Bool) ?? false
      if degraded { return }
      finish(image)
    }
  }
}

private func loadFile(_ uri: String) -> UIImage? {
  let path = uri.hasPrefix("file://") ? String(uri.dropFirst(7)) : uri
  return UIImage(contentsOfFile: path)
}

private func classifyImage(_ image: UIImage?, assetId: String, maxLabels: Int, minConfidence: Float) -> [String: Any] {
  guard let cgImage = image?.cgImage else {
    return ["assetId": assetId, "error": "Photo could not be read"]
  }
  let request = VNClassifyImageRequest()
  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  do {
    try handler.perform([request])
  } catch {
    return ["assetId": assetId, "error": error.localizedDescription]
  }
  let observations = (request.results ?? [])
    .filter { $0.confidence >= minConfidence }
    .sorted { $0.confidence > $1.confidence }
    .prefix(maxLabels)
  let labels: [[String: Any]] = observations.map { ["id": $0.identifier, "confidence": $0.confidence] }
  return ["assetId": assetId, "labels": labels]
}

private func supportedLabelIds() -> [String] {
  // Vision's documented return is the identifier strings this OS can emit.
  // currentRevision is the classifier this device actually runs.
  let revision = VNClassifyImageRequest.currentRevision
  return (try? VNClassifyImageRequest.knownClassifications(forRevision: revision)) ?? []
}

private func intOption(_ options: [String: Any], _ key: String, _ fallback: Int) -> Int {
  if let value = options[key] as? Int { return value }
  if let value = options[key] as? Double { return Int(value) }
  return fallback
}

private func floatOption(_ options: [String: Any], _ key: String, _ fallback: Float) -> Float {
  if let value = options[key] as? Double { return Float(value) }
  if let value = options[key] as? Float { return value }
  return fallback
}
