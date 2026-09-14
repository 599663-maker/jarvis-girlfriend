//! jarvis-matte — lifts the subject out of a character portrait.
//!
//! New characters are usually handed to us as a finished illustration with a
//! painted-on background (a checkerboard, a studio wall, a gradient). The live
//! digital human needs the character alone, so this tool runs Apple's
//! foreground-instance matting and writes two files:
//!
//!   portrait.png  the cut-out with a real alpha channel (HUD artwork)
//!   green.png     the same cut-out over chroma-key green (Vidu digital human)
//!
//! Usage: jarvis-matte <input image> <output directory>

import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write("jarvis-matte: \(message)\n".data(using: .utf8)!)
    exit(code)
}

func writePNG(_ image: CGImage, to url: URL) {
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL, UTType.png.identifier as CFString, 1, nil
    ) else {
        fail("cannot create \(url.path)", 6)
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        fail("cannot write \(url.path)", 7)
    }
}

let arguments = CommandLine.arguments

/// `--face <image>` reports the face geometry alone. The HUD needs it for
/// characters that were imported before their still could talk.
if arguments.count >= 3, arguments[1] == "--face" {
    let url = URL(fileURLWithPath: arguments[2])
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let probe = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        fail("cannot read \(url.path)", 3)
    }
    let geometry = faceGeometryJSON(in: probe) ?? "null"
    print("{\"face\": \(geometry)}")
    exit(0)
}

guard arguments.count >= 3 else {
    fail("usage: jarvis-matte <input image> <output directory>", 2)
}
let inputURL = URL(fileURLWithPath: arguments[1])
let outputDirectory = URL(fileURLWithPath: arguments[2])
try? FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

guard let source = CGImageSourceCreateWithURL(inputURL as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail("cannot read \(inputURL.path)", 3)
}

let context = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any])
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
let alphaInfo = image.alphaInfo
let alreadyTransparent = alphaInfo == .premultipliedFirst || alphaInfo == .premultipliedLast
    || alphaInfo == .first || alphaInfo == .last

var cutout = CIImage(cgImage: image)
if !alreadyTransparent {
    let request = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        fail("vision failed: \(error.localizedDescription)", 4)
    }
    guard let observation = request.results?.first, !observation.allInstances.isEmpty else {
        fail("no subject found", 5)
    }
    do {
        let buffer = try observation.generateMaskedImage(
            ofInstances: observation.allInstances,
            from: handler,
            croppedToInstancesExtent: false
        )
        cutout = CIImage(cvPixelBuffer: buffer)
    } catch {
        fail("matting failed: \(error.localizedDescription)", 8)
    }
}

// CIImage from the mask carries the mask's own geometry; normalise to the
// source extent so both outputs keep the original framing.
cutout = cutout.transformed(by: .identity)

guard let cutImage = context.createCGImage(cutout, from: cutout.extent, format: .RGBA8, colorSpace: sRGB) else {
    fail("cannot rasterise cut-out", 9)
}
writePNG(cutImage, to: outputDirectory.appendingPathComponent("portrait.png"))

guard let greenColor = CIColor(red: 0.0, green: 0.694, blue: 0.251, colorSpace: sRGB) else {
    fail("cannot build chroma-key green", 11)
}
let green = CIImage(color: greenColor).cropped(to: cutout.extent)
let composed = cutout.composited(over: green)
guard let greenImage = context.createCGImage(composed, from: composed.extent, format: .RGBA8, colorSpace: sRGB) else {
    fail("cannot rasterise green screen", 10)
}
writePNG(greenImage, to: outputDirectory.appendingPathComponent("green.png"))

let width = Int(cutImage.width)
let height = Int(cutImage.height)

// ---------------------------------------------------------------------------
// Face geometry
//
// The still character has to talk while she is on screen without a call, and
// that means warping the mouth and the eyes of the artwork. Vision gives the
// boxes; everything here is normalised to the image with the origin at the top
// left, which is the space the canvas overlay works in.
// ---------------------------------------------------------------------------

func normalisedBox(_ rect: CGRect) -> [String: Double] {
    [
        "x": Double(rect.minX),
        "y": Double(1 - rect.maxY),
        "w": Double(rect.width),
        "h": Double(rect.height),
    ]
}

/// Landmarks come back in the face box's own space (bottom-left origin), so
/// they are mapped through the face box into image coordinates.
func landmarkBox(_ region: VNFaceLandmarkRegion2D?, face: CGRect) -> [String: Double]? {
    let points = region?.normalizedPoints ?? []
    guard points.count >= 3 else { return nil }
    let xs = points.map { CGFloat($0.x) }
    let ys = points.map { CGFloat($0.y) }
    guard let minX = xs.min(), let maxX = xs.max(), let minY = ys.min(), let maxY = ys.max() else {
        return nil
    }
    let box = CGRect(
        x: face.minX + minX * face.width,
        y: face.minY + minY * face.height,
        width: (maxX - minX) * face.width,
        height: (maxY - minY) * face.height
    )
    return normalisedBox(box)
}

/// Face, mouth and eye boxes, normalised to the image with the origin at the
/// top left — the space the canvas overlay works in.
func faceGeometryJSON(in image: CGImage) -> String? {
    let faceRequest = VNDetectFaceLandmarksRequest()
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    guard (try? handler.perform([faceRequest])) != nil,
          let observation = faceRequest.results?.first
    else { return nil }
    let face = observation.boundingBox
    let landmarks = observation.landmarks
    var payload: [String: Any] = ["face": normalisedBox(face)]
    if let mouth = landmarkBox(landmarks?.innerLips, face: face)
        ?? landmarkBox(landmarks?.outerLips, face: face)
    {
        payload["mouth"] = mouth
    }
    if let left = landmarkBox(landmarks?.leftEye, face: face) {
        payload["leftEye"] = left
    }
    if let right = landmarkBox(landmarks?.rightEye, face: face) {
        payload["rightEye"] = right
    }
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
    return String(data: data, encoding: .utf8)
}

let faceJSON = faceGeometryJSON(in: image) ?? "null"
if faceJSON == "null" {
    FileHandle.standardError.write("jarvis-matte: no face in the artwork\n".data(using: .utf8)!)
}
print("{\"width\": \(width), \"height\": \(height), \"matted\": \(alreadyTransparent ? "false" : "true"), \"face\": \(faceJSON)}")
