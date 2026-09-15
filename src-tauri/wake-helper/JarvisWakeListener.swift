import AppKit
import AVFoundation
import Foundation
import Speech

final class WakeListener {
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var hasWoken = false
    private let eventFile: URL?
    private let hostApp: URL?
    private let captureCommand: Bool
    private var commandText = ""
    private var silenceTimer: DispatchWorkItem?
    private var captureDeadline = Date.distantFuture
    private let conversationEnabled: Bool
    private let controlFile: URL?
    private var controlOffset: UInt64 = 0
    private var controlTimer: Timer?
    private var idleTimer: DispatchWorkItem?
    private var muted = false
    private var inConversation = false
    private var restartAttempts = 0
    private var recognitionGeneration = 0
    private var spokenText = ""
    /// Everything Jarvis said recently. On-device recognition transcribes the
    /// speakers almost perfectly, so a sentence heard right after playback is
    /// Jarvis's own tail, not the user.
    private var recentSpoken: [(text: String, at: Date)] = []
    private var bargeStartedAt: Date?
    /// Format the microphone tap was installed with. The tap is only rebuilt
    /// when this changes (the input device switched), never on a recognition
    /// restart: tearing the tap down reconfigures CoreAudio, and a reconfigure
    /// at the end of an answer repeated the last syllable of the sentence.
    private var tapFormat: AVAudioFormat?
    /// Transcript of the playback so far. The recognizer keeps one running
    /// string for the whole answer, so only the part that is new since the
    /// last check can be the user talking over it.
    private var mutedTranscript = ""
    private var echoLogAt = Date.distantPast
    /// True when macOS is cancelling Jarvis's own voice out of the microphone.
    /// Without it the recognizer transcribes the answer that is playing out
    /// loud, and the echo filter that protects against that is also what
    /// swallowed a person talking over Jarvis — the interruption the user
    /// complained about.
    private var echoCanceled = false
    /// Quiet level of the microphone while Jarvis talks, used by the loudness
    /// interruption. Echo cancellation leaves only room noise there, so a
    /// person speaking stands out by an order of magnitude.
    private var voiceFloor: Double?
    /// Slow average of the same signal. It follows whatever the speakers are
    /// leaking, so turning the volume up cannot push the echo over a fixed
    /// threshold and make Jarvis cut itself off.
    private var voiceBaseline: Double?
    private var loudBuffers = 0
    private var taskStartedAt = Date()
    private var restartWorkItem: DispatchWorkItem?
    private var lastSummonAt = Date.distantPast
    private var hostWatchdog: Timer?
    /// No app behind this microphone any more: only listen for the wake word
    /// and open Jarvis with it.
    private var cold = false

    private let conversationStopPrefixes = [
        "结束对话", "退出对话", "停止对话", "结束语音", "退出语音", "关闭对话",
    ]
    private let conversationStopExact = [
        "结束", "退出", "再见", "拜拜", "不聊了", "不用了", "停止", "退下",
    ]
    /// "停一下" is not "end the conversation": talking over Jarvis with one of
    /// these cuts the answer short and leaves the microphone with the user,
    /// which is the interruption people actually expect.
    private let bargeStopPrefixes = [
        "停", "打住", "安静", "闭嘴", "别说了", "不要说了", "不用说了",
        "先别说", "等一下", "等等", "暂停",
    ]

    /// The built-in character answers to a fixed set of phrases. Every other
    /// character answers to "嗨 <名字>" / "嘿 <名字>", so the phrase is derived
    /// from the name the master gave it instead of being hard-coded here.
    private let builtinPhrases = [
        "嗨jarvis",
        "嘿jarvis",
        "hijarvis",
        "heyjarvis",
        "嗨贾维斯",
        "嘿贾维斯",
    ]

    private let builtinPatterns = [
        "嗨\\s*jarvis",
        "嘿\\s*jarvis",
        "hi\\s*jarvis",
        "hey\\s*jarvis",
        "嗨\\s*贾维斯",
        "嘿\\s*贾维斯",
        "hi\\s*贾维斯",
        "hey\\s*贾维斯",
    ]

    /// Characters loaded from the app\'s own store: "嗨张元英" wakes the
    /// character called 张元英, whoever is currently on screen.
    private struct WakeCharacter {
        let id: String
        let name: String
    }

    private var namesFile: URL?
    private var characters: [WakeCharacter] = []
    private var namesStamp: Date?
    private var namesTimer: Timer?
    /// Wake phrases and stripping patterns rebuilt whenever the store changes,
    /// so a character created a second ago is wake-able without a restart.
    private var characterPhrases: [String] = []
    private var characterPatterns: [String] = []
    private var characterTokens: [String] = []
    private var characterAliases: [(phrase: String, token: String, avatar: String)] = []

    private var phrases: [String] { builtinPhrases + characterPhrases }
    private var wakePatterns: [String] { builtinPatterns + characterPatterns }

    init() {
        if
            let index = CommandLine.arguments.firstIndex(of: "--event-file"),
            CommandLine.arguments.indices.contains(index + 1)
        {
            eventFile = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        } else {
            eventFile = nil
        }
        if
            let index = CommandLine.arguments.firstIndex(of: "--host-app"),
            CommandLine.arguments.indices.contains(index + 1)
        {
            hostApp = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        } else {
            hostApp = nil
        }
        captureCommand = CommandLine.arguments.contains("--capture-command")
        conversationEnabled = CommandLine.arguments.contains("--conversation")
        if
            let index = CommandLine.arguments.firstIndex(of: "--names-file"),
            CommandLine.arguments.indices.contains(index + 1)
        {
            namesFile = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        } else {
            namesFile = nil
        }
        if
            let index = CommandLine.arguments.firstIndex(of: "--control-file"),
            CommandLine.arguments.indices.contains(index + 1)
        {
            controlFile = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        } else if let eventFile {
            controlFile = eventFile.deletingPathExtension().appendingPathExtension("ctl")
        } else {
            controlFile = nil
        }
    }

    func run() {
        // The wake-only listener (no event file) is the one that survives a
        // closed Jarvis. Never keep two of them: they would both sit on the
        // microphone and both try to open Jarvis.
        if eventFile == nil, let identifier = Bundle.main.bundleIdentifier {
            let running = NSRunningApplication
                .runningApplications(withBundleIdentifier: identifier)
                .count
            if running > 1 {
                print("another wake listener is already running, exiting")
                exit(0)
            }
        }
        emit(["type": "boot"])
        if CommandLine.arguments.contains("--test-wake") {
            emit(["type": "wake", "phrase": "automated cold-launch test"])
            openHostApp()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) {
                exit(0)
            }
            RunLoop.main.run()
            return
        }

        // Wake phrases come from the app's character store: a character made a
        // minute ago answers to "嗨 <名字>" without restarting anything.
        refreshCharactersIfNeeded(force: true)
        startNamesWatch()

        guard let recognizer, recognizer.isAvailable else {
            emit(["type": "error", "message": "speech recognizer unavailable"])
            exit(2)
        }

        let currentAuthorization = SFSpeechRecognizer.authorizationStatus()
        emit([
            "type": "authorization",
            "status": authorizationName(currentAuthorization),
        ])
        if currentAuthorization == .authorized {
            startRecognition()
            RunLoop.main.run()
            return
        }

        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self else { return }
                guard status == .authorized else {
                    self.emit([
                        "type": "authorization",
                        "status": self.authorizationName(status),
                    ])
                    exit(3)
                }
                self.emit(["type": "authorization", "status": "authorized"])
                self.startRecognition()
            }
        }

        RunLoop.main.run()
    }

    private func startRecognition() {
        let input = audioEngine.inputNode
        // Apple's echo canceller takes Jarvis's own voice out of the microphone
        // before recognition sees it: the reference is the default output
        // device, which is exactly where the answer comes from. Measured on
        // this Mac it drops the playback echo from 0.021 to 0.002 RMS, which is
        // the difference between "the recognizer only hears Jarvis" and "the
        // recognizer hears whoever talks over it".
        if echoCancelEnabled() {
            do {
                try input.setVoiceProcessingEnabled(true)
                echoCanceled = true
                log("echo cancellation enabled")
                minimiseDucking(of: input)
            } catch {
                echoCanceled = false
                log("echo cancellation unavailable: \(error.localizedDescription)")
            }
        } else {
            echoCanceled = false
            log("echo cancellation disabled in config.json")
        }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            emit(["type": "error", "message": "microphone input unavailable"])
            exit(4)
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        guard recognizer?.supportsOnDeviceRecognition == true else {
            emit(["type": "error", "message": "on-device speech recognition unavailable"])
            exit(7)
        }
        request.requiresOnDeviceRecognition = true
        if #available(macOS 13.0, *) {
            request.addsPunctuation = false
        }
        self.request = request

        attachTap(to: request)

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            emit(["type": "error", "message": "microphone start failed"])
            exit(5)
        }

        if conversationEnabled {
            // The app drives the listener through the control file, and it must
            // be able to do so before the first wake word: a cold wake opens
            // the conversation without one.
            startControlPolling()
        }
        startHostWatchdog()

        emit(["type": "ready"])
        recognitionGeneration += 1
        let generation = recognitionGeneration
        taskStartedAt = Date()
        task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            // Cancelling a task always reports an error, so a callback from a
            // superseded task must never drive the next restart.
            guard let self, generation == self.recognitionGeneration else { return }
            if let result {
                self.restartAttempts = 0
                self.handleTranscript(result.bestTranscription.formattedString)
            }
            if error != nil {
                self.recognitionTaskDidEnd()
            }
        }
    }

    private func handleTranscript(_ raw: String) {
        if muted {
            detectBargeIn(from: raw)
            return
        }
        if hasWoken {
            collectCommand(from: raw)
            return
        }
        let spoken = normalize(raw)
        guard phrases.contains(where: spoken.contains) else { return }
        beginWake(with: raw, named: namedCharacter(spoken))
    }

    /// On-device recognition ends a task by itself after a stretch of silence,
    /// and an ended task never reports another transcript. Restarting it is
    /// what keeps the microphone alive: forgetting this is exactly what made
    /// Jarvis deaf a few seconds after it answered or after the wake word.
    private func recognitionTaskDidEnd() {
        if muted || inConversation {
            if commandText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                scheduleRecognitionRestart(after: 0.25)
            } else {
                finishCommand()
            }
            return
        }
        if hasWoken && captureCommand {
            finishCommand()
            return
        }
        scheduleRecognitionRestart(after: 0.35)
    }

    private func scheduleRecognitionRestart(after delay: TimeInterval) {
        restartWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.restartRecognition()
        }
        restartWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    private func beginWake(with raw: String, named: (token: String, avatar: String)? = nil) {
        hasWoken = true
        log("wake phrase=\(raw) character=\(named?.avatar ?? "builtin")")
        var wake: [String: String] = ["type": "wake", "phrase": raw]
        if let named {
            wake["avatar"] = named.avatar
            wake["name"] = named.token
            recordLastWake(avatar: named.avatar, name: named.token)
        }
        emit(wake)
        openHostApp()
        guard captureCommand, !cold else {
            stop()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) {
                exit(0)
            }
            return
        }
        inConversation = conversationEnabled
        startControlPolling()
        // Keep the microphone and the recognition stream alive so the sentence
        // that follows the wake phrase becomes the spoken command. A pause
        // after the wake word must never end the capture: that used to drop
        // the whole conversation four seconds after the wake.
        captureDeadline = Date().addingTimeInterval(inConversation ? 90 : 15)
        taskStartedAt = Date()
        commandText = commandRemainder(from: raw)
        if commandText.isEmpty {
            log("listening for the command after the wake phrase")
        }
        scheduleSilenceTimer()
    }

    private func collectCommand(from raw: String) {
        if muted {
            return
        }
        if !inConversation, Date() > captureDeadline {
            finishCommand()
            return
        }
        let stripped = commandRemainder(from: raw)
        let remainder = inConversation ? clean(stripped) : stripped
        if remainder.isEmpty {
            return
        }
        if inConversation, isConversationStop(remainder) {
            endConversation()
            return
        }
        if isWakeRemnant(raw, remainder) {
            // The wake word said again during a running conversation is not a
            // command: it means "show yourself". The window is raised again
            // (with the assembly animation) instead of being answered.
            if inConversation, hasWakePhrase(raw), wakeLeftover(remainder).count <= 2,
                Date().timeIntervalSince(lastSummonAt) > 2.5
            {
                lastSummonAt = Date()
                log("summon: window raised again")
                emit(["type": "wake", "phrase": raw])
            }
            log("ignored wake remnant: \(remainder)")
            // The wake phrase is still being spoken; keep the conversation
            // alive but never answer the tail of it as a command.
            captureDeadline = Date().addingTimeInterval(90)
            scheduleIdleTimer(180)
            return
        }
        if isRecognizerArtifact(remainder) {
            log("ignored recognizer artifact: \(remainder)")
            captureDeadline = Date().addingTimeInterval(90)
            scheduleIdleTimer(180)
            return
        }
        if isSelfEcho(remainder) {
            log("ignored own voice: \(remainder)")
            // A sentence that is still ringing in the room must not be
            // answered twice.
            captureDeadline = Date().addingTimeInterval(90)
            scheduleIdleTimer(180)
            return
        }
        commandText = remainder
        captureDeadline = Date().addingTimeInterval(90)
        scheduleIdleTimer()
        scheduleSilenceTimer()
        log("heard command: \(remainder)")
    }

    /// On-device recognition hallucinates repeated syllables out of a faint
    /// tail ("吱吱吱", "点点点", "给了给了"). Answering them is worse than
    /// dropping them: the sentence can simply be said again.
    private func isRecognizerArtifact(_ value: String) -> Bool {
        let compact = normalize(value).filter { $0.isLetter || $0.isNumber }
        guard (2...8).contains(compact.count) else { return false }
        for size in 1...2 where compact.count % size == 0 {
            let repeats = compact.count / size
            // One syllable needs three copies ("吱吱吱"); a two-syllable
            // stutter only two ("给了给了"), while "谢谢" is left alone.
            guard repeats >= (size == 1 ? 3 : 2) else { continue }
            let unit = String(compact.prefix(size))
            if compact == String(repeating: unit, count: repeats) {
                return true
            }
        }
        return false
    }

    private func clean(_ value: String) -> String {
        value.trimmingCharacters(in: CharacterSet(charactersIn: " ,，.。!！?？、:："))
    }

    private func isConversationStop(_ value: String) -> Bool {
        let normalized = value
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "，", with: "")
            .replacingOccurrences(of: ",", with: "")
            .replacingOccurrences(of: "。", with: "")
            .replacingOccurrences(of: ".", with: "")
            .replacingOccurrences(of: "！", with: "")
            .replacingOccurrences(of: "!", with: "")
        if conversationStopPrefixes.contains(where: normalized.hasPrefix) {
            return true
        }
        return conversationStopExact.contains(normalized)
    }

    private func isBargeStop(_ value: String) -> Bool {
        let normalized = normalize(value)
        guard !normalized.isEmpty else { return false }
        return bargeStopPrefixes.contains(where: normalized.hasPrefix)
    }

    private func scheduleSilenceTimer() {
        silenceTimer?.cancel()
        let delay: TimeInterval = commandText.isEmpty ? 4 : 1.2
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if self.commandText.isEmpty {
                if self.inConversation {
                    // Nothing was said after the wake word yet. Stay on the
                    // microphone instead of dropping the conversation; the
                    // idle timer is the only thing allowed to end it.
                    self.captureDeadline = Date().addingTimeInterval(90)
                    self.scheduleIdleTimer(180)
                } else {
                    self.cancelCapture()
                }
            } else {
                self.finishCommand()
            }
        }
        silenceTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    private func finishCommand() {
        guard hasWoken else { return }
        silenceTimer?.cancel()
        let text = commandText.trimmingCharacters(in: .whitespacesAndNewlines)
        commandText = ""
        if text.isEmpty {
            if !inConversation {
                hasWoken = false
                stop()
                exit(0)
            }
            return
        }
        log("command: \(text)")
        emit(["type": "command", "text": text])
        if inConversation {
            // Jarvis is about to answer: drop the microphone so the reply
            // cannot be recognised as the next command, and wait for the app
            // to hand the microphone back once playback finished.
            beginMutedListening()
            return
        }
        hasWoken = false
        stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            exit(0)
        }
    }

    private func beginMutedListening() {
        muted = true
        mutedTranscript = ""
        voiceFloor = nil
        voiceBaseline = nil
        loudBuffers = 0
        // The microphone stays open while Jarvis talks: the transcript is
        // matched against the sentence being spoken, so only a real person
        // talking over it can interrupt.
        bargeStartedAt = Date()
        restartAttempts = 0
        restartRecognition()
        log("muted for playback")
        // A slow provider can take minutes to answer, so the idle countdown
        // must not run while Jarvis is speaking. The long backstop only exists
        // so a crashed host can never leave the microphone muted forever.
        scheduleIdleTimer(480)
        emit(["type": "conversation", "state": "speaking"])
    }

    private func resumeConversation() {
        muted = false
        bargeStartedAt = nil
        mutedTranscript = ""
        commandText = ""
        log("playback done, listening again (restarts=\(restartAttempts))")
        captureDeadline = Date().addingTimeInterval(90)
        restartAttempts = 0
        restartRecognition()
        emit(["type": "conversation", "state": "listening"])
        scheduleIdleTimer(180)
    }

    /// Anything heard while Jarvis speaks has to clear the sentence that is
    /// playing: on-device recognition transcribes the speakers almost
    /// perfectly, so a shared run of characters means it is Jarvis, not a
    /// person interrupting.
    private func detectBargeIn(from raw: String) {
        guard let started = bargeStartedAt, Date().timeIntervalSince(started) > 0.7 else { return }
        let heard = Array(comparable(raw))
        let previous = Array(comparable(mutedTranscript))
        let shared = commonPrefixLength(heard, previous)
        let fresh = Array(heard.dropFirst(min(shared, heard.count)))
        mutedTranscript = raw
        // "嗨贾维斯" and "停一下" always win, even when they arrive inside a
        // transcript that is otherwise Jarvis's own answer.
        let freshText = clean(String(fresh))
        let wakeOnly = hasWakePhrase(raw) && clean(wakeLeftover(raw)).count <= 3
        let stopRequested = wakeOnly
            || isConversationStop(clean(raw))
            || isConversationStop(freshText)
            || isBargeStop(freshText)
        if !stopRequested {
            // With echo cancellation the microphone only carries the user, so
            // a two character interruption ("停一下") is enough to stop the
            // answer; without it, four characters are still required before
            // blaming the user for what may be Jarvis's own tail.
            guard fresh.count >= (echoCanceled ? 2 : 4) else { return }
            if matchesOwnVoice(String(trimmingOwnVoiceHead(fresh))) {
                if Date().timeIntervalSince(echoLogAt) > 1.5 {
                    echoLogAt = Date()
                    log("ignored own voice while speaking: \(String(fresh))")
                }
                return
            }
        }
        log("barge-in: \(raw)")
        emit(["type": "barge"])
        // What was said over the answer is the next command — but a stop phrase
        // is not a new question, and the wake phrase is not part of it.
        var command = freshText
        let stripped = clean(wakeLeftover(raw))
        if stopRequested {
            command = ""
        } else if hasWakePhrase(raw), !stripped.isEmpty {
            command = stripped
        }
        handTurnBack(command: command)
    }

    /// Someone talked over Jarvis. The app drops the answer as soon as `barge`
    /// arrives, and the turn belongs to the user again.
    private func handTurnBack(command: String) {
        muted = false
        bargeStartedAt = nil
        mutedTranscript = ""
        voiceBaseline = nil
        loudBuffers = 0
        commandText = command
        captureDeadline = Date().addingTimeInterval(90)
        scheduleSilenceTimer()
        scheduleIdleTimer(180)
        emit(["type": "conversation", "state": "listening"])
    }

    /// Loudness, not words: with echo cancellation the microphone is at the
    /// noise floor while the answer plays, so a voice that keeps the level up
    /// for a syllable is enough to interrupt — no transcript round trip.
    private func bargeIn(byVoice level: Double) {
        guard muted else { return }
        log(String(format: "barge-in by voice (level %.3f)", level))
        emit(["type": "barge"])
        handTurnBack(command: "")
    }

    /// "嗨贾维斯吱吱吱" is the wake phrase coming back out of the speakers with
    /// a bit of room noise, never a command. So is a truncated "嗨贾维": the
    /// recogniser splits the phrase while it is still being spoken, and the
    /// piece it keeps would otherwise be answered as a real command — which
    /// then talks over the instruction the user says next.
    private func isWakeRemnant(_ raw: String, _ remainder: String) -> Bool {
        // "嗨贾维斯现": the wake phrase is still on the transcript, so a couple
        // of characters behind it can still be the phrase breaking apart.
        // Anything longer is the command, even while it is still growing.
        if hasWakePhrase(raw) {
            return wakeLeftover(remainder).count <= 2
        }
        // "嗨贾维": the recogniser splits the phrase while it is still being
        // spoken, and the piece it keeps would otherwise be answered as a real
        // command — which then talks over the instruction the user says next.
        // A bare character name ("小肉肉", "嗨小肉肉") is the tail of its wake
        // phrase, but a name behind a real verb ("呼叫小肉肉") is an order and
        // must be answered: once the name is taken out, no word may remain.
        let normalized = normalize(raw)
        guard normalized.count <= 6 else { return false }
        return wakeLeftover(normalized).count <= 1
    }

    /// What is left of a transcript once every wake word is taken out of it.
    private func wakeLeftover(_ value: String) -> String {
        var leftover = normalize(value).filter { $0.isLetter || $0.isNumber }
        for token in ["jarvis", "贾维斯", "贾维", "维斯", "嗨", "嘿", "hi", "hey"] + characterTokens {
            leftover = leftover.replacingOccurrences(of: token, with: "")
        }
        return leftover
    }

    private func hasWakePhrase(_ raw: String) -> Bool {
        for pattern in wakePatterns {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
            else { continue }
            let range = NSRange(raw.startIndex..., in: raw)
            if regex.firstMatch(in: raw, range: range) != nil {
                return true
            }
        }
        return false
    }

    private func isSelfEcho(_ text: String) -> Bool {
        matchesOwnVoice(text)
    }

    /// Recognition can rewrite a few characters in the middle of the running
    /// transcript, which pushes a piece of Jarvis's own sentence into the new
    /// part: drop that head before judging what is left.
    private func trimmingOwnVoiceHead(_ heard: [Character]) -> [Character] {
        let references = ownVoiceReferences()
        var fresh = heard
        while fresh.count >= 4 {
            let head = String(fresh.prefix(3))
            guard references.contains(where: { $0.contains(head) }) else { break }
            fresh.removeFirst()
        }
        return fresh
    }

    private func ownVoiceReferences() -> [String] {
        let now = Date()
        recentSpoken = recentSpoken.filter { now.timeIntervalSince($0.at) < 30 }
        var references = recentSpoken.map { comparable($0.text) }.filter { $0.count >= 3 }
        let window = comparable(recentSpoken.suffix(4).map(\.text).joined())
        if window.count >= 6 {
            references.append(window)
        }
        return references
    }

    private func ownVoiceSoundReferences() -> [String] {
        var references = recentSpoken.map { soundFolded($0.text) }.filter { !$0.isEmpty }
        let window = soundFolded(recentSpoken.suffix(4).map(\.text).joined())
        if window.count >= 6 {
            references.append(window)
        }
        return references
    }

    /// On-device recognition hears the speakers almost perfectly, so what is
    /// left of a transcript once the sentences Jarvis is saying have been
    /// taken out of it tells who is talking: nothing left means the microphone
    /// is only hearing Jarvis, a chunk left means someone is talking over it.
    private func matchesOwnVoice(_ text: String) -> Bool {
        let references = ownVoiceReferences()
        let soundReferences = ownVoiceSoundReferences()
        // Nothing was spoken lately, so there is no echo this could be. Short
        // commands ("停", "安静") must survive this check.
        guard !references.isEmpty || !soundReferences.isEmpty else { return false }
        let heard = Array(comparable(text))
        guard heard.count >= 3 else {
            // Two characters are too short to judge against a whole sentence,
            // but with echo cancellation they cannot be Jarvis — the
            // microphone only carries the user, so "停了" has to interrupt.
            return !echoCanceled
        }
        var unexplained = Int.max
        for reference in references {
            unexplained = min(unexplained, unexplainedLength(heard, Array(reference)))
        }
        if unexplained <= 2 {
            return true
        }
        if echoCanceled {
            // Jarvis is already cancelled out of the microphone, so words the
            // recognizer did pick up are the user's: only a literal piece of
            // the sentence on the speakers counts as echo here. The fuzzy sound
            // match below used to swallow short interruptions ("更口语化"),
            // which is what made talking over Jarvis do nothing.
            return false
        }
        let heardSound = Array(soundFolded(text))
        var similarity = 0.0
        for reference in soundReferences where !reference.isEmpty {
            similarity = max(similarity, soundSimilarity(heardSound, Array(reference)))
        }
        if similarity >= 0.8 {
            return true
        }
        // A short fragment that still sounds like the sentence on the speakers
        // is a recognition hiccup, not a second voice.
        return unexplained <= 5 && similarity >= 0.7
    }

    /// Characters of `heard` that no part of `spoken` explains.
    private func unexplainedLength(_ heard: [Character], _ spoken: [Character]) -> Int {
        guard !heard.isEmpty else { return 0 }
        guard !spoken.isEmpty else { return heard.count }
        var best = 0
        var bestHeard = 0
        var bestSpoken = 0
        var previous = [Int](repeating: 0, count: spoken.count + 1)
        var current = [Int](repeating: 0, count: spoken.count + 1)
        for row in 1...heard.count {
            for column in 1...spoken.count {
                if heard[row - 1] == spoken[column - 1] {
                    current[column] = previous[column - 1] + 1
                    if current[column] > best {
                        best = current[column]
                        bestHeard = row - best
                        bestSpoken = column - best
                    }
                } else {
                    current[column] = 0
                }
            }
            swap(&previous, &current)
            for column in 0...spoken.count {
                current[column] = 0
            }
        }
        guard best >= 2 else { return heard.count }
        let left = unexplainedLength(
            Array(heard[0..<bestHeard]),
            Array(spoken[0..<bestSpoken])
        )
        let right = unexplainedLength(
            Array(heard[(bestHeard + best)...]),
            Array(spoken[(bestSpoken + best)...])
        )
        return left + right
    }

    private func comparable(_ value: String) -> String {
        value.lowercased().filter { $0.isLetter || $0.isNumber }
    }

    private func soundFolded(_ value: String) -> String {
        let mutable = NSMutableString(string: value) as CFMutableString
        CFStringTransform(mutable, nil, kCFStringTransformToLatin, false)
        CFStringTransform(mutable, nil, kCFStringTransformStripCombiningMarks, false)
        var folded = ""
        var previous: Character = " "
        for character in (mutable as String).lowercased() where character.isLetter {
            if character == "h", "zcs".contains(previous) {
                continue
            }
            folded.append(character)
            previous = character
        }
        return folded
    }

    /// How much of `heard` the closest stretch of `reference` can explain: 1 is
    /// "this is the sentence that is playing", 0 is "nothing of it is".
    private func soundSimilarity(_ heard: [Character], _ reference: [Character]) -> Double {
        guard !heard.isEmpty, !reference.isEmpty else { return 0 }
        var previous = [Int](repeating: 0, count: reference.count + 1)
        var current = [Int](repeating: 0, count: reference.count + 1)
        for row in 1...heard.count {
            current[0] = row
            for column in 1...reference.count {
                let cost = heard[row - 1] == reference[column - 1] ? 0 : 1
                current[column] = min(
                    previous[column] + 1,
                    current[column - 1] + 1,
                    previous[column - 1] + cost
                )
            }
            swap(&previous, &current)
        }
        let best = previous.min() ?? 0
        return max(0, 1 - Double(best) / Double(heard.count))
    }

    private func commonPrefixLength(_ left: [Character], _ right: [Character]) -> Int {
        var shared = 0
        while shared < left.count, shared < right.count, left[shared] == right[shared] {
            shared += 1
        }
        return shared
    }

    private func commonSubstringLength(_ left: [Character], _ right: [Character]) -> Int {
        guard !left.isEmpty, !right.isEmpty else { return 0 }
        var previous = [Int](repeating: 0, count: right.count + 1)
        var current = [Int](repeating: 0, count: right.count + 1)
        var best = 0
        for row in 1...left.count {
            for column in 1...right.count {
                if left[row - 1] == right[column - 1] {
                    current[column] = previous[column - 1] + 1
                    best = max(best, current[column])
                } else {
                    current[column] = 0
                }
            }
            swap(&previous, &current)
        }
        return best
    }

    /// `echoCancel: false` in the Jarvis config takes the microphone back to
    /// the plain device signal: for a Mac (or an output device) where voice
    /// processing misbehaves, the older echo filtering below still applies.
    private func echoCancelEnabled() -> Bool {
        guard let home = ProcessInfo.processInfo.environment["HOME"] else { return true }
        let url = URL(fileURLWithPath: home)
            .appendingPathComponent(".jarvis-codex/config.json")
        guard
            let data = try? Data(contentsOf: url),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let enabled = object["echoCancel"] as? Bool
        else { return true }
        return enabled
    }

    /// The tap feeds whichever request is current, so restarting recognition
    /// never has to rewire the microphone.
    /// macOS treats a microphone held with voice processing as a phone call and
    /// ducks everything else that plays, Jarvis's own answers included: the
    /// level in the file was right and the speakers still sounded quiet. Asking
    /// for the minimum ducking level gives the voice back its volume; the
    /// property only exists from macOS 14 on, which is the same release the
    /// voice processing API itself needs.
    private func minimiseDucking(of input: AVAudioInputNode) {
        guard #available(macOS 14.0, *) else { return }
        guard let unit = input.audioUnit else {
            log("other audio ducking: no audio unit to configure")
            return
        }
        // The levels come from AudioUnitProperties.h: default 0, minimum 10,
        // medium 20, maximum 30.
        let minimumDucking = AUVoiceIOOtherAudioDuckingLevel(rawValue: 10)
        var configuration = AUVoiceIOOtherAudioDuckingConfiguration(
            mEnableAdvancedDucking: false,
            mDuckingLevel: minimumDucking ?? AUVoiceIOOtherAudioDuckingLevel(rawValue: 0)!
        )
        let status = AudioUnitSetProperty(
            unit,
            kAUVoiceIOProperty_OtherAudioDuckingConfiguration,
            kAudioUnitScope_Global,
            0,
            &configuration,
            UInt32(MemoryLayout<AUVoiceIOOtherAudioDuckingConfiguration>.size)
        )
        if status == noErr {
            log("other audio ducking set to minimum")
        } else {
            log("other audio ducking not configurable (\(status))")
        }
    }

    private func attachTap(to request: SFSpeechAudioBufferRecognitionRequest) {
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        if tapFormat == format {
            return
        }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            // With voice processing the microphone node reports the eight
            // reference channels next to the processed one, all carrying the
            // same signal. Recognition wants one channel, and the loudness
            // detector must not read a reference channel by accident.
            let mono = self.monoBuffer(buffer)
            self.request?.append(mono)
            self.watchForVoice(mono)
        }
        tapFormat = format
        log(
            "microphone tap installed (input format \(Int(format.sampleRate)) Hz, "
                + "\(format.channelCount) ch, echo cancel \(echoCanceled))"
        )
    }

    /// One channel of the tap, so the same buffer can feed both recognition and
    /// the loudness interruption no matter how many channels voice processing
    /// reports.
    private func monoBuffer(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer {
        guard buffer.format.channelCount > 1, let source = buffer.floatChannelData else {
            return buffer
        }
        guard
            let format = AVAudioFormat(
                standardFormatWithSampleRate: buffer.format.sampleRate,
                channels: 1
            ),
            let mono = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: buffer.frameLength),
            let destination = mono.floatChannelData
        else { return buffer }
        mono.frameLength = buffer.frameLength
        memcpy(
            destination[0],
            source[0],
            Int(buffer.frameLength) * MemoryLayout<Float>.size
        )
        return mono
    }

    /// Talking over Jarvis has to stop the answer, and waiting for a transcript
    /// makes that feel slow. While the answer plays, the microphone with echo
    /// cancellation sits at the noise floor; a voice is many times that for as
    /// long as a syllable lasts, which is a signal available ~100 ms in.
    private func watchForVoice(_ buffer: AVAudioPCMBuffer) {
        guard echoCanceled, muted, let started = bargeStartedAt,
            Date().timeIntervalSince(started) > 0.5,
            let data = buffer.floatChannelData
        else {
            loudBuffers = 0
            return
        }
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return }
        var sum = 0.0
        for index in 0..<frames {
            let value = Double(data[0][index])
            sum += value * value
        }
        let level = (sum / Double(frames)).squareRoot()
        // The floor follows the room down quickly and up slowly, so a voice
        // never becomes the new baseline while it is still being spoken.
        if let floor = voiceFloor {
            voiceFloor = level < floor ? floor * 0.7 + level * 0.3 : floor * 0.995 + level * 0.005
        } else {
            voiceFloor = level
        }
        if let baseline = voiceBaseline {
            voiceBaseline = baseline * 0.94 + level * 0.06
        } else {
            voiceBaseline = level
        }
        // Two anchors: the quiet floor of the room and the level of whatever
        // is playing. The second one is why a loud answer cannot be mistaken
        // for a person talking — the echo rises with the volume and so does
        // the threshold, while a voice jumps straight over both.
        let threshold = max(0.012, max((voiceFloor ?? level) * 4, (voiceBaseline ?? level) * 2.4))
        if level > threshold {
            loudBuffers += 1
        } else {
            loudBuffers = 0
        }
        guard loudBuffers >= 5 else { return }
        loudBuffers = 0
        let measured = level
        DispatchQueue.main.async { [weak self] in
            self?.bargeIn(byVoice: measured)
        }
    }

    private func restartRecognition() {
        restartWorkItem?.cancel()
        restartWorkItem = nil
        // A task that lived for a while simply timed out on silence; only a
        // task that dies instantly counts towards the failure budget.
        if Date().timeIntervalSince(taskStartedAt) > 1.2 {
            restartAttempts = 0
        }
        restartAttempts += 1
        if restartAttempts > 25 {
            log("recognition kept failing (\(restartAttempts) attempts)")
            if inConversation {
                endConversation()
            } else {
                emit(["type": "error", "message": "speech recognition unavailable"])
                stop()
                exit(6)
            }
            return
        }
        log("restart recognition attempt \(restartAttempts)")
        if muted {
            // The echo filter compares against the previous transcript, which
            // belongs to the task that just ended.
            mutedTranscript = ""
        }
        task?.cancel()
        request?.endAudio()
        let fresh = SFSpeechAudioBufferRecognitionRequest()
        fresh.shouldReportPartialResults = true
        fresh.requiresOnDeviceRecognition = true
        if #available(macOS 13.0, *) {
            fresh.addsPunctuation = false
        }
        request = fresh
        // The tap has to feed the newest request: after a mute/unmute cycle
        // the previous microphone tap kept appending to the cancelled request,
        // so recognition starved and the conversation ended after one turn.
        attachTap(to: fresh)
        if !audioEngine.isRunning {
            do {
                audioEngine.prepare()
                try audioEngine.start()
            } catch {
                emit(["type": "error", "message": "microphone restart failed"])
                exit(5)
            }
        }
        recognitionGeneration += 1
        let generation = recognitionGeneration
        taskStartedAt = Date()
        task = recognizer?.recognitionTask(with: fresh) { [weak self] result, error in
            guard let self, generation == self.recognitionGeneration else { return }
            if let result {
                self.restartAttempts = 0
                self.handleTranscript(result.bestTranscription.formattedString)
            }
            if error != nil {
                self.recognitionTaskDidEnd()
            }
        }
    }

    private func scheduleIdleTimer(_ seconds: TimeInterval = 180) {
        idleTimer?.cancel()
        guard inConversation else { return }
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.endConversation()
        }
        idleTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
    }

    private func endConversation() {
        idleTimer?.cancel()
        silenceTimer?.cancel()
        log("conversation ended")
        emit(["type": "conversation-end"])
        stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            exit(0)
        }
    }

    private func startControlPolling() {
        guard let controlFile, controlTimer == nil else { return }
        controlOffset = (try? FileManager.default.attributesOfItem(atPath: controlFile.path)[.size] as? NSNumber)??.uint64Value ?? 0
        let timer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
            self?.drainControlFile()
        }
        controlTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func drainControlFile() {
        guard let controlFile else { return }
        guard
            let handle = try? FileHandle(forReadingFrom: controlFile),
            let end = try? handle.seekToEnd()
        else { return }
        if end < controlOffset {
            controlOffset = 0
        }
        handle.seek(toFileOffset: controlOffset)
        let data = handle.readDataToEndOfFile()
        controlOffset = end
        try? handle.close()
        guard let text = String(data: data, encoding: .utf8) else { return }
        for rawLine in text.split(separator: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("speaking ") {
                // The sentence on the speakers, used to tell Jarvis's own
                // voice apart from someone talking over it.
                let sentence = String(line.dropFirst("speaking ".count))
                spokenText = sentence
                recentSpoken.append((text: sentence, at: Date()))
                if recentSpoken.count > 8 {
                    recentSpoken.removeFirst(recentSpoken.count - 8)
                }
                if muted {
                    // A new sentence is starting: never carry a half-finished
                    // loudness count across the seam between two sentences.
                    loudBuffers = 0
                }
                continue
            }
            switch line {
            case "mute":
                log("control: mute")
                if inConversation, !muted {
                    beginMutedListening()
                }
            case "unmute":
                log("control: unmute")
                if inConversation, muted {
                    resumeConversation()
                }
            case "listen":
                log("control: listen")
                if inConversation, muted {
                    resumeConversation()
                }
            case "awake":
                // The app was opened by the wake word itself (the wake-only
                // listener heard it and exited), so this listener starts the
                // conversation instead of waiting for the phrase again.
                log("control: awake")
                if !hasWoken, !muted {
                    hasWoken = true
                    inConversation = conversationEnabled
                    commandText = ""
                    captureDeadline = Date().addingTimeInterval(90)
                    taskStartedAt = Date()
                    scheduleSilenceTimer()
                    scheduleIdleTimer()
                    emit(["type": "conversation", "state": "listening"])
                }
            case "end":
                log("control: end")
                endConversation()
            default:
                break
            }
        }
    }

    private func cancelCapture() {
        hasWoken = false
        silenceTimer?.cancel()
        stop()
        exit(0)
    }

    private func commandRemainder(from raw: String) -> String {
        var remainder = raw
        for pattern in wakePatterns {
            guard
                let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
                let match = regex.firstMatch(
                    in: remainder,
                    range: NSRange(remainder.startIndex..., in: remainder)
                ),
                let range = Range(match.range, in: remainder)
            else { continue }
            remainder = String(remainder[range.upperBound...])
            break
        }
        return remainder.trimmingCharacters(in: CharacterSet(charactersIn: " ,，.。!！?？、:："))
    }

    private func hostAppIsRunning() -> Bool {
        guard let hostApp, let identifier = Bundle(url: hostApp)?.bundleIdentifier else {
            return true
        }
        return !NSRunningApplication
            .runningApplications(withBundleIdentifier: identifier)
            .isEmpty
    }

    /// Every exit path has to end with a listener that still knows the wake
    /// word, including exits nobody announced (crash, `pkill`, menu quit while
    /// the control file is already gone). Watched here instead of relying on
    /// the app's shutdown handshake.
    private func startHostWatchdog() {
        guard hostApp != nil, hostWatchdog == nil else { return }
        let timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            guard let self, !self.cold, !self.hostAppIsRunning() else { return }
            self.becomeColdListener()
        }
        hostWatchdog = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    /// Drops the conversation (and its microphone state) so the next
    /// "嗨 Jarvis" opens the app again instead of being answered into nothing.
    private func becomeColdListener() {
        cold = true
        muted = false
        voiceFloor = nil
        voiceBaseline = nil
        loudBuffers = 0
        inConversation = false
        hasWoken = false
        commandText = ""
        mutedTranscript = ""
        recentSpoken = []
        bargeStartedAt = nil
        silenceTimer?.cancel()
        idleTimer?.cancel()
        controlTimer?.invalidate()
        controlTimer = nil
        captureDeadline = Date.distantFuture
        log("host app is gone: back to wake-only listening")
        emit(["type": "conversation-end"])
    }

    private func stop() {
        restartWorkItem?.cancel()
        restartWorkItem = nil
        voiceFloor = nil
        voiceBaseline = nil
        loudBuffers = 0
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine.inputNode.removeTap(onBus: 0)
        tapFormat = nil
        request?.endAudio()
        task?.cancel()
    }

    private func openHostApp() {
        guard let hostApp else { return }
        // A wake must never spawn a second copy of Jarvis: the instance that
        // is already running owns the wake listener and the Codex thread, and
        // a duplicate re-registers the login item and tears the original down.
        if
            let identifier = Bundle(url: hostApp)?.bundleIdentifier,
            let running = NSRunningApplication
                .runningApplications(withBundleIdentifier: identifier)
                .first
        {
            running.activate(options: [])
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.arguments = ["--jarvis-wake"]
        NSWorkspace.shared.openApplication(
            at: hostApp,
            configuration: configuration
        ) { [weak self] _, error in
            if let error {
                self?.emit([
                    "type": "error",
                    "message": "could not open Jarvis: \(error.localizedDescription)",
                ])
            }
        }
    }

    private func normalize(_ value: String) -> String {
        value
            .lowercased()
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: ",", with: "")
            .replacingOccurrences(of: "，", with: "")
            .replacingOccurrences(of: ".", with: "")
            .replacingOccurrences(of: "。", with: "")
            .replacingOccurrences(of: "！", with: "")
            .replacingOccurrences(of: "!", with: "")
    }

    private func authorizationName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    /// Diagnostics land next to the other Jarvis state so a conversation that
    /// ends early can be explained without a debugger.
    private func log(_ message: String) {
        guard let home = ProcessInfo.processInfo.environment["HOME"] else { return }
        let url = URL(fileURLWithPath: home).appendingPathComponent(".jarvis-codex/wake-helper.log")
        let stamp = ISO8601DateFormatter().string(from: Date())
        guard let data = "[\(stamp)] \(message)\n".data(using: .utf8) else { return }
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }

    // MARK: - Characters

    /// Reads the app's character store. The file is small and rewritten
    /// whenever a character is created, renamed or deleted, so watching its
    /// timestamp is enough to keep the wake phrases current.
    private func refreshCharactersIfNeeded(force: Bool = false) {
        guard let namesFile else { return }
        let stamp = (try? FileManager.default.attributesOfItem(atPath: namesFile.path))?[.modificationDate] as? Date
        if !force, let stamp, stamp == namesStamp { return }
        namesStamp = stamp
        guard
            let data = try? Data(contentsOf: namesFile),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let list = root["avatars"] as? [[String: Any]]
        else { return }
        var loaded: [WakeCharacter] = []
        for item in list {
            guard
                let id = item["id"] as? String,
                let name = (item["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                !name.isEmpty, id != "jarvis"
            else { continue }
            loaded.append(WakeCharacter(id: id, name: name))
        }
        characters = loaded
        rebuildCharacterPhrases()
        log("characters loaded: \(loaded.map(\.name).joined(separator: "/"))")
    }

    /// "嗨 张元英" is the wake phrase of the character called 张元英: the fixed
    /// prefix plus the name the master gave it. Chinese names have no spaces,
    /// so the recogniser may or may not insert one.
    private func rebuildCharacterPhrases() {
        var phrases: [String] = []
        var patterns: [String] = []
        var tokens: [String] = []
        var aliases: [(phrase: String, token: String, avatar: String)] = []
        for character in characters {
            let name = character.name
            let compact = normalize(name).filter { $0.isLetter || $0.isNumber }
            guard !compact.isEmpty else { continue }
            let escaped = NSRegularExpression.escapedPattern(for: name)
            for prefix in ["嗨", "嘿"] {
                phrases.append("\(prefix)\(compact)")
                patterns.append("\(prefix)\\s*\(escaped)")
                aliases.append((phrase: "\(prefix)\(compact)", token: compact, avatar: character.id))
            }
            for prefix in ["hi", "hey"] {
                phrases.append("\(prefix)\(compact)")
                patterns.append("\(prefix)\\s*\(escaped)")
                aliases.append((phrase: "\(prefix)\(compact)", token: compact, avatar: character.id))
            }
            tokens.append(compact)
        }
        // Longest name first, so "小美" never shadows a character called 小美美.
        characterPhrases = phrases
        characterPatterns = patterns
        characterTokens = tokens
        characterAliases = aliases.sorted { $0.phrase.count > $1.phrase.count }
    }

    /// Which character the wake sentence named, if any.
    private func namedCharacter(_ spoken: String) -> (token: String, avatar: String)? {
        for alias in characterAliases where spoken.contains(alias.phrase) {
            return (alias.token, alias.avatar)
        }
        return nil
    }

    /// Remembered for the wake-only listener: that process is gone before the
    /// app finishes launching, so the name has to survive on disk.
    private func recordLastWake(avatar: String, name: String) {
        guard let namesFile else { return }
        let url = namesFile.deletingLastPathComponent().appendingPathComponent("last-wake.json")
        let payload: [String: Any] = [
            "avatar": avatar,
            "name": name,
            "at": Int(Date().timeIntervalSince1970 * 1000),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        try? data.write(to: url, options: .atomic)
    }

    private func startNamesWatch() {
        guard namesFile != nil, namesTimer == nil else { return }
        let timer = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            self?.refreshCharactersIfNeeded()
        }
        RunLoop.main.add(timer, forMode: .common)
        namesTimer = timer
    }

    private func emit(_ value: [String: String]) {
        guard
            let data = try? JSONSerialization.data(withJSONObject: value),
            let line = String(data: data, encoding: .utf8)
        else { return }
        if let eventFile {
            let data = Data((line + "\n").utf8)
            if let handle = try? FileHandle(forWritingTo: eventFile) {
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
                try? handle.close()
            } else {
                try? data.write(to: eventFile, options: .atomic)
            }
        } else {
            print(line)
            fflush(stdout)
        }
    }
}

let listener = WakeListener()
listener.run()
