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

/// `--body <image>` reports hands and feet for the idle pose pass. They ride
/// alongside the face geometry so the still character can also fidget, sway
/// and shift her weight while nothing else is happening.
if arguments.count >= 3, arguments[1] == "--body" {
    let url = URL(fileURLWithPath: arguments[2])
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let probe = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        fail("cannot read \(url.path)", 3)
    }
    print(bodyGeometryJSON(in: probe))
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

// ---------------------------------------------------------------------------
// Body geometry: hands and feet
//
// The same portrait gets a second look for the idle pose pass. Vision's body
// pose gives the wrists and ankles, and its hand pose gives a box around each
// hand; the two are merged so a hand that Vision sees only in one pass still
// gets a box. Everything is normalised like the face above.
// ---------------------------------------------------------------------------

func pointBox(_ point: CGPoint, width: CGFloat, height: CGFloat) -> CGRect {
    CGRect(x: point.x - width / 2, y: point.y - height / 2, width: width, height: height)
}

func bodyGeometryJSON(in image: CGImage) -> String {
    let imageW = CGFloat(image.width)
    let imageH = CGFloat(image.height)
    var hands: [[String: Double]] = []
    var feet: [[String: Double]] = []

    let handRequest = VNDetectHumanHandPoseRequest()
    handRequest.maximumHandCount = 2
    let handHandler = VNImageRequestHandler(cgImage: image, options: [:])
    if (try? handHandler.perform([handRequest])) != nil {
        for observation in handRequest.results ?? [] {
            let points = [
                try? observation.recognizedPoint(.wrist),
                try? observation.recognizedPoint(.indexTip),
                try? observation.recognizedPoint(.middleTip),
                try? observation.recognizedPoint(.ringTip),
                try? observation.recognizedPoint(.littleTip),
                try? observation.recognizedPoint(.thumbTip),
            ].compactMap { $0 }.filter { $0.confidence > 0.3 }
            guard points.count >= 2 else { continue }
            let xs = points.map { $0.location.x }
            let ys = points.map { $0.location.y }
            let minX = xs.min()!
            let maxX = xs.max()!
            let minY = ys.min()!
            let maxY = ys.max()!
            let spanX = maxX - minX
            let spanY = maxY - minY
            let box = CGRect(
                x: max(0, minX - spanX * 0.6),
                y: max(0, minY - spanY * 0.7),
                width: min(1, spanX * 2.2),
                height: min(1, spanY * 2.4)
            )
            hands.append([
                "x": Double(box.minX),
                "y": Double(1 - box.maxY),
                "w": Double(box.width),
                "h": Double(box.height),
            ])
        }
    }

    let bodyRequest = VNDetectHumanBodyPoseRequest()
    let bodyHandler = VNImageRequestHandler(cgImage: image, options: [:])
    if (try? bodyHandler.perform([bodyRequest])) != nil,
       let observation = bodyRequest.results?.first
    {
        let joints: [VNHumanBodyPoseObservation.JointName] = [.leftWrist, .rightWrist, .leftAnkle, .rightAnkle]
        var wrists: [CGPoint] = []
        var ankles: [CGPoint] = []
        for joint in joints {
            guard let point = try? observation.recognizedPoint(joint), point.confidence > 0.2 else { continue }
            if joint == .leftWrist || joint == .rightWrist {
                wrists.append(point.location)
            } else {
                ankles.append(point.location)
            }
        }
        // Hands seen only by the body pose (or missed by the hand pose) fall
        // back to a wrist box.
        for wrist in wrists {
            let covered = hands.contains { box in
                let x = CGFloat(box["x"] ?? 0)
                let y = CGFloat(box["y"] ?? 0)
                let w = CGFloat(box["w"] ?? 0)
                let h = CGFloat(box["h"] ?? 0)
                let top = y + h
                return wrist.x > x - w * 0.5 && wrist.x < x + w * 1.5 && wrist.y > top - h * 1.4 && wrist.y < top + h * 0.6
            }
            if covered { continue }
            let box = pointBox(wrist, width: 0.09, height: 0.09)
            hands.append([
                "x": Double(max(0, box.minX)),
                "y": Double(1 - box.maxY),
                "w": Double(min(1, box.width)),
                "h": Double(min(1, box.height)),
            ])
        }
        for ankle in ankles {
            let box = pointBox(ankle, width: 0.075, height: 0.05)
            feet.append([
                "x": Double(max(0, box.minX)),
                "y": Double(1 - box.maxY),
                "w": Double(min(1, box.width)),
                "h": Double(min(1, box.height)),
            ])
        }
    }

    let payload: [String: Any] = ["hands": hands, "feet": feet]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return "{}" }
    return String(data: data, encoding: .utf8) ?? "{}"
}

let faceJSON = faceGeometryJSON(in: image) ?? "null"
if faceJSON == "null" {
    FileHandle.standardError.write("jarvis-matte: no face in the artwork\n".data(using: .utf8)!)
}
print("{\"width\": \(width), \"height\": \(height), \"matted\": \(alreadyTransparent ? "false" : "true"), \"face\": \(faceJSON)}")
