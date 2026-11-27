import ExpoModulesCore
import ImageIO
import Photos
import UIKit
import Vision

/// On-device image labels from Apple's Vision framework, plus a way to ask iOS for a little more
/// time when the app is woken in the background. Nothing in this module uses the network except
/// fetching a small rendition from iCloud when the photo is not on the phone.
public class PhotoClassifierModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PhotoClassifier")

    // One bad asset is an error entry. The rest of the batch still returns.
    AsyncFunction("classifyAssets") { (assetIds: [String], maxLabels: Int, minConfidence: Double) async -> [[String: Any]] in
      var results: [[String: Any]] = []
      for assetId in assetIds {
        results.append(await classifyAsset(assetId, maxLabels: maxLabels, minConfidence: Float(minConfidence)))
      }
      return results
    }

    AsyncFunction("classifyFile") { (uri: String, maxLabels: Int, minConfidence: Double) async -> [String: Any] in
      return classifyImage(loadFile(uri), assetId: uri, maxLabels: maxLabels, minConfidence: Float(minConfidence))
    }

    Function("supportedLabels") { () -> [String] in
      return supportedLabelIds()
    }

    // iOS suspends a background-launched app within seconds unless it holds a background task.
    // The returned id must be passed to endBackgroundWork. iOS allows roughly 30 seconds.
    AsyncFunction("beginBackgroundWork") { (name: String) -> Int in
      var identifier: UIBackgroundTaskIdentifier = .invalid
      identifier = UIApplication.shared.beginBackgroundTask(withName: name) {
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
      }
      return identifier.rawValue
    }.runOnQueue(.main)

    AsyncFunction("endBackgroundWork") { (rawIdentifier: Int) in
      let identifier = UIBackgroundTaskIdentifier(rawValue: rawIdentifier)
      if identifier != .invalid {
        UIApplication.shared.endBackgroundTask(identifier)
      }
    }.runOnQueue(.main)
  }
}

private func classifyAsset(_ assetId: String, maxLabels: Int, minConfidence: Float) async -> [String: Any] {
  let localId = assetId.hasPrefix("ph://") ? String(assetId.dropFirst(5)) : assetId
  let fetched = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil)
  guard let asset = fetched.firstObject else {
    return ["assetId": assetId, "error": "Photo is not in the library"]
  }
  // iOS keeps small renditions on the phone, so the first try needs no network.
  var image = await requestImage(asset, allowNetwork: false)
  if image == nil {
    image = await requestImage(asset, allowNetwork: true)
  }
  return classifyImage(image, assetId: assetId, maxLabels: maxLabels, minConfidence: minConfidence)
}

private func requestImage(_ asset: PHAsset, allowNetwork: Bool) async -> UIImage? {
  return await withCheckedContinuation { (continuation: CheckedContinuation<UIImage?, Never>) in
    let options = PHImageRequestOptions()
    options.isNetworkAccessAllowed = allowNetwork
    // highQualityFormat calls the handler exactly once, which a continuation requires.
    options.deliveryMode = .highQualityFormat
    options.resizeMode = .fast
    options.isSynchronous = false
    PHImageManager.default().requestImage(
      for: asset,
      targetSize: CGSize(width: 448, height: 448),
      contentMode: .aspectFit,
      options: options
    ) { image, _ in
      continuation.resume(returning: image)
    }
  }
}

private func loadFile(_ uri: String) -> UIImage? {
  if let url = URL(string: uri), url.isFileURL {
    return UIImage(contentsOfFile: url.path)
  }
  return UIImage(contentsOfFile: uri)
}

private func classifyImage(_ image: UIImage?, assetId: String, maxLabels: Int, minConfidence: Float) -> [String: Any] {
  guard let image = image, let cgImage = image.cgImage else {
    return ["assetId": assetId, "error": "Photo could not be read"]
  }
  return autoreleasepool { () -> [String: Any] in
    let request = VNClassifyImageRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, orientation: cgOrientation(image.imageOrientation), options: [:])
    do {
      try handler.perform([request])
    } catch {
      return ["assetId": assetId, "error": error.localizedDescription]
    }
    let observations = (request.results ?? [])
      .filter { $0.confidence >= minConfidence }
      .sorted { $0.confidence > $1.confidence }
      .prefix(max(1, maxLabels))
    let labels: [[String: Any]] = observations.map { observation in
      return ["id": observation.identifier, "confidence": Double(observation.confidence)]
    }
    return ["assetId": assetId, "labels": labels]
  }
}

/// The camera stores most photos rotated and records how to turn them. Vision needs to be told.
private func cgOrientation(_ orientation: UIImage.Orientation) -> CGImagePropertyOrientation {
  switch orientation {
  case .up: return .up
  case .down: return .down
  case .left: return .left
  case .right: return .right
  case .upMirrored: return .upMirrored
  case .downMirrored: return .downMirrored
  case .leftMirrored: return .leftMirrored
  case .rightMirrored: return .rightMirrored
  @unknown default: return .up
  }
}

/// The identifiers this iOS version's classifier can emit.
private func supportedLabelIds() -> [String] {
  let revision = VNClassifyImageRequest.currentRevision
  let known = (try? VNClassifyImageRequest.knownClassifications(forRevision: revision)) ?? []
  return known.map { $0.identifier }
}
