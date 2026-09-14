// JarvisVision — the eyes of Jarvis.
//
// Owns the webcam while the HUD is on screen and publishes two things:
//   * a small JPEG (--frame-file) that the HUD renders as the self view, so the
//     master can see themselves in front of the computer;
//   * one JSON line per analysis (--event-file) with face count, coarse
//     expression estimate and the raw geometry it was derived from.
//
// The expression estimate is deliberately explainable: Vision gives face
// landmarks, and the scores below are plain ratios (mouth corner lift, mouth
// opening, eye opening, brow-to-eye distance) instead of an opaque classifier.
// Every event also carries the raw ratios, so the mapping can be tuned without
// recompiling the heuristics from scratch.

import AVFoundation
import CoreImage
import Foundation
import Vision

// MARK: - Arguments

struct Options {
    var eventFile: String = ""
    var frameFile: String = ""
    var fps: Double = 10
    var hostPid: pid_t = 0

    static func parse(_ arguments: [String]) -> Options {
        var options = Options()
        var index = 0
        while index < arguments.count {
            let key = arguments[index]
            let value = index + 1 < arguments.count ? arguments[index + 1] : ""
            switch key {
            case "--event-file": options.eventFile = value; index += 2
            case "--frame-file": options.frameFile = value; index += 2
            case "--fps": options.fps = max(2, min(24, Double(value) ?? 10)); index += 2
            case "--host-pid": options.hostPid = pid_t(value) ?? 0; index += 2
            default: index += 1
            }
        }
        return options
    }
}

// MARK: - Event channel

final class EventWriter {
    private let handle: FileHandle?
    private let lock = NSLock()

    init(path: String) {
        guard !path.isEmpty else { handle = nil; return }
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: Data())
        }
        handle = FileHandle(forWritingAtPath: path)
        handle?.seekToEndOfFile()
    }

    func send(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []) else { return }
        lock.lock()
        defer { lock.unlock() }
        handle?.write(data)
        handle?.write(Data("\n".utf8))
    }
}

// MARK: - Expression heuristics

struct Expression {
    var label: String
    var confidence: Double
    var metrics: [String: Double]
}

enum ExpressionReader {
    /// Distances come back normalised inside the face box, so every ratio below
    /// is scale free: the same face at any distance scores the same.
    static func read(_ observation: VNFaceObservation) -> Expression {
        guard let landmarks = observation.landmarks else {
            return Expression(label: "neutral", confidence: 0.2, metrics: [:])
        }
        var metrics: [String: Double] = [:]

        // Vision reports landmark points in the face box coordinate space with
        // the origin at the bottom left, which is also the direction "up".
        var mouthWidth = 0.0
        var smile = 0.0
        var mouthOpen = 0.0
        if let lips = landmarks.outerLips {
            let points = lips.normalizedPoints
            let xs = points.map { Double($0.x) }
            let ys = points.map { Double($0.y) }
            mouthWidth = (xs.max() ?? 0) - (xs.min() ?? 0)
            if mouthWidth > 0.001 {
                let leftCorner = points.enumerated().min { $0.element.x < $1.element.x }
                let rightCorner = points.enumerated().max { $0.element.x < $1.element.x }
                let cornerY = (Double(leftCorner?.element.y ?? 0) + Double(rightCorner?.element.y ?? 0)) / 2
                let centreY = ys.reduce(0, +) / Double(ys.count)
                smile = (cornerY - centreY) / mouthWidth
            }
        }
        if let inner = landmarks.innerLips {
            let ys = inner.normalizedPoints.map { Double($0.y) }
            let height = (ys.max() ?? 0) - (ys.min() ?? 0)
            mouthOpen = mouthWidth > 0.001 ? height / mouthWidth : 0
        }
        var eyeOpen = 0.0
        var eyeSamples = 0
        for eye in [landmarks.leftEye, landmarks.rightEye] {
            guard let eye else { continue }
            let points = eye.normalizedPoints
            let xs = points.map { Double($0.x) }
            let ys = points.map { Double($0.y) }
            let width = (xs.max() ?? 0) - (xs.min() ?? 0)
            guard width > 0.001 else { continue }
            eyeOpen += ((ys.max() ?? 0) - (ys.min() ?? 0)) / width
            eyeSamples += 1
        }
        if eyeSamples > 0 { eyeOpen /= Double(eyeSamples) }

        var browGap = 0.0
        var browSamples = 0
        for (brow, eye) in [(landmarks.leftEyebrow, landmarks.leftEye), (landmarks.rightEyebrow, landmarks.rightEye)] {
            guard let brow, let eye else { continue }
            let browY = brow.normalizedPoints.map { Double($0.y) }
            let eyeY = eye.normalizedPoints.map { Double($0.y) }
            guard !browY.isEmpty, !eyeY.isEmpty else { continue }
            let browMean = browY.reduce(0, +) / Double(browY.count)
            let eyeMean = eyeY.reduce(0, +) / Double(eyeY.count)
            let eyeXs = eye.normalizedPoints.map { Double($0.x) }
            let eyeWidth = (eyeXs.max() ?? 0) - (eyeXs.min() ?? 0)
            if eyeWidth > 0.001 {
                browGap += (browMean - eyeMean) / eyeWidth
                browSamples += 1
            }
        }
        if browSamples > 0 { browGap /= Double(browSamples) }

        metrics["smile"] = smile
        metrics["mouthOpen"] = mouthOpen
        metrics["eyeOpen"] = eyeOpen
        metrics["browGap"] = browGap

        // A resting face measures roughly smile -0.08..0.02, browGap
        // 0.64..0.88, eyeOpen 0.25..0.36, mouthOpen 0.01..0.17 (measured on a
        // real webcam, including while talking). Every threshold below is set outside that
        // band: calling a calm master "sad" is far worse than missing a mood,
        // so the estimator only speaks up on a clearly readable expression.
        func clamp(_ value: Double) -> Double { min(1, max(0, value)) }
        var scores: [String: Double] = [:]
        scores["happy"] = clamp((smile - 0.03) * 16) * clamp(1.2 - mouthOpen * 1.6)
        scores["surprised"] = clamp((mouthOpen - 0.32) * 2.6) * clamp((browGap - 0.90) * 4) * clamp(eyeOpen * 7)
        scores["sad"] = clamp((-smile - 0.14) * 14) * clamp(1.1 - eyeOpen * 3.4)
        scores["tired"] = clamp((0.15 - eyeOpen) * 6)
        scores["angry"] = clamp((0.45 - browGap) * 7) * clamp(1.1 - mouthOpen)

        let best = scores.max { $0.value < $1.value }
        guard let best, best.value > 0.3 else {
            return Expression(label: "neutral", confidence: 0.4, metrics: metrics)
        }
        return Expression(label: best.key, confidence: min(0.95, 0.35 + best.value * 0.6), metrics: metrics)
    }
}

// MARK: - Capture pipeline

final class VisionPipeline: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let options: Options
    private let writer: EventWriter
    private let frameURL: URL?
    private let context = CIContext(options: [.useSoftwareRenderer: false])
    private let analysisQueue = DispatchQueue(label: "com.bigguan.jarvis.vision.analysis")
    private var lastFrameAt = Date.distantPast
    private var analysisInFlight = false
    private var lastAnalysisAt = Date.distantPast
    private var loggedFrame = false

    init(options: Options) {
        self.options = options
        self.writer = EventWriter(path: options.eventFile)
        self.frameURL = options.frameFile.isEmpty ? nil : URL(fileURLWithPath: options.frameFile)
        super.init()
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let now = Date()
        let interval = 1.0 / options.fps

        guard now.timeIntervalSince(lastFrameAt) >= interval else { return }
        lastFrameAt = now

        // The self view is a presence indicator, not a video call: 400px at
        // ~10fps is smooth enough to read a face and costs a fraction of a
        // full rate GPU encode, which matters because this helper shares the
        // machine with speech synthesis.
        let image = CIImage(cvPixelBuffer: buffer)
        let width = image.extent.width
        let scale = width > 400 ? 400 / width : 1
        let scaled = scale < 1 ? image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) : image
        guard let jpeg = context.jpegRepresentation(of: scaled, colorSpace: CGColorSpaceCreateDeviceRGB(), options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.5]) else { return }
        if let frameURL {
            try? jpeg.write(to: frameURL, options: .atomic)
            if !loggedFrame {
                loggedFrame = true
                writer.send(["type": "frame", "bytes": jpeg.count])
            }
        }

        // The expression estimate does not need the preview frame rate.
        guard now.timeIntervalSince(lastAnalysisAt) >= 0.9, !analysisInFlight else { return }
        lastAnalysisAt = now
        analysisInFlight = true
        analysisQueue.async { [weak self] in
            guard let self else { return }
            let event = self.analyse(jpeg: jpeg)
            self.writer.send(event)
            self.analysisInFlight = false
        }
    }

    private func analyse(jpeg: Data) -> [String: Any] {
        let request = VNDetectFaceLandmarksRequest()
        let handler = VNImageRequestHandler(data: jpeg, orientation: .up, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return ["type": "face", "faces": 0, "emotion": "unknown", "error": error.localizedDescription]
        }
        let observations = (request.results ?? []).sorted { $0.boundingBox.width > $1.boundingBox.width }
        guard let face = observations.first else {
            return ["type": "face", "faces": 0, "emotion": "unknown", "ts": Date().timeIntervalSince1970]
        }
        let expression = ExpressionReader.read(face)
        var event: [String: Any] = [
            "type": "face",
            "faces": observations.count,
            "emotion": expression.label,
            "confidence": expression.confidence,
            "distance": Double(face.boundingBox.width),
            "yaw": Double(face.yaw?.doubleValue ?? 0),
            "pitch": Double(face.pitch?.doubleValue ?? 0),
            "ts": Date().timeIntervalSince1970,
        ]
        for (key, value) in expression.metrics { event[key] = value }
        return event
    }
}

// MARK: - Entry point

func fail(_ message: String, writer: EventWriter?) -> Never {
    writer?.send(["type": "error", "message": message])
    FileHandle.standardError.write(Data("JarvisVision: \(message)\n".utf8))
    exit(1)
}

let options = Options.parse(Array(CommandLine.arguments.dropFirst()))
let bootstrapWriter = EventWriter(path: options.eventFile)

let device = AVCaptureDevice.default(for: .video)
guard let device else {
    fail("没有找到可用的摄像头。", writer: bootstrapWriter)
}

func describe(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    default: return "unknown(\(status.rawValue))"
    }
}

// The status is reported before and after the request: a refusal that never
// showed a prompt looks identical to a click on "don't allow" otherwise, and
// the HUD needs to know which one it is to give the right advice.
var status = AVCaptureDevice.authorizationStatus(for: .video)
bootstrapWriter.send(["type": "permission", "status": describe(status), "phase": "before"])
if status == .notDetermined {
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .video) { granted = $0; semaphore.signal() }
    _ = semaphore.wait(timeout: .now() + 90)
    status = AVCaptureDevice.authorizationStatus(for: .video)
    bootstrapWriter.send([
        "type": "permission", "status": describe(status), "phase": "after", "granted": granted,
    ])
}
switch status {
case .authorized:
    break
case .denied, .restricted:
    fail("摄像头权限被拒绝，请在系统设置 → 隐私与安全性 → 摄像头里勾选 Jarvis Vision。", writer: bootstrapWriter)
default:
    fail("摄像头授权没有完成（\(describe(status))）。", writer: bootstrapWriter)
}

let pipeline = VisionPipeline(options: options)
let session = AVCaptureSession()
session.sessionPreset = .medium
do {
    // Capping the sensor keeps the capture pipeline from running at 30fps for
    // a preview that never shows more than ten.
    if let format = device.activeFormat as AVCaptureDevice.Format? {
        let maxRate = 15.0
        if format.videoSupportedFrameRateRanges.contains(where: { $0.maxFrameRate >= maxRate }) {
            try? device.lockForConfiguration()
            device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: CMTimeScale(maxRate))
            device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: CMTimeScale(maxRate))
            device.unlockForConfiguration()
        }
    }
    let input = try AVCaptureDeviceInput(device: device)
    guard session.canAddInput(input) else { fail("无法使用摄像头输入。", writer: bootstrapWriter) }
    session.addInput(input)
    let output = AVCaptureVideoDataOutput()
    output.alwaysDiscardsLateVideoFrames = true
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    output.setSampleBufferDelegate(pipeline, queue: DispatchQueue(label: "com.bigguan.jarvis.vision.capture"))
    guard session.canAddOutput(output) else { fail("无法使用摄像头输出。", writer: bootstrapWriter) }
    session.addOutput(output)
} catch {
    fail("摄像头初始化失败：\(error.localizedDescription)", writer: bootstrapWriter)
}

session.startRunning()
bootstrapWriter.send(["type": "ready", "camera": device.localizedName])

// A helper outliving its host would hold the green camera light on forever.
if options.hostPid > 0 {
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
    timer.schedule(deadline: .now() + 2, repeating: 2)
    timer.setEventHandler {
        if kill(options.hostPid, 0) != 0 {
            session.stopRunning()
            exit(0)
        }
    }
    timer.resume()
}

RunLoop.main.run()
