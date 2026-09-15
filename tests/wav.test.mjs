import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const frontend = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
const backend = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const wakeHelper = await readFile(
  new URL("../src-tauri/wake-helper/JarvisWakeListener.swift", import.meta.url),
  "utf8",
);
const keeper = await readFile(new URL("../scripts/jarvis-keeper.sh", import.meta.url), "utf8");
const shutdownSource = await readFile(
  new URL("../src/shutdown-command.ts", import.meta.url),
  "utf8",
);
const styles = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
const entitlements = await readFile(
  new URL("../src-tauri/Entitlements.plist", import.meta.url),
  "utf8",
);
const helperEntitlements = await readFile(
  new URL("../src-tauri/wake-helper/JarvisWakeListener.entitlements", import.meta.url),
  "utf8",
);
const avatars = await readFile(new URL("../src-tauri/src/avatars.rs", import.meta.url), "utf8");
const vidu = await readFile(new URL("../src-tauri/src/vidu.rs", import.meta.url), "utf8");
const vision = await readFile(new URL("../src-tauri/src/vision.rs", import.meta.url), "utf8");
const visionHelper = await readFile(
  new URL("../src-tauri/wake-helper/JarvisVision.swift", import.meta.url),
  "utf8",
);
const visionEntitlements = await readFile(
  new URL("../src-tauri/wake-helper/JarvisVision.entitlements", import.meta.url),
  "utf8",
);
const visionInfo = await readFile(
  new URL("../src-tauri/wake-helper/JarvisVision.Info.plist", import.meta.url),
  "utf8",
);
const tauriConfig = await readFile(
  new URL("../src-tauri/tauri.conf.json", import.meta.url),
  "utf8",
);

test("Voice uses Codex app-server V3 WebRTC directly", () => {
  assert.match(backend, /"version":\s*"v3"/);
  assert.match(backend, /"transport":\s*\{"type":\s*"webrtc"/);
  assert.match(backend, /"app-server",\s*"--enable",\s*"realtime_conversation",\s*"--stdio"/);
  assert.doesNotMatch(frontend, /OPENAI_API_KEY|ChatGPT.*button|hotkey/i);
});

test("wake phrase opens the same direct Voice path", () => {
  assert.match(frontend, /listen<WakeEvent>\("jarvis-wake"/);
  assert.match(frontend, /void startDirectVoice\(\{ coldStart: payload\.cold === true \}\)/);
  assert.match(frontend, /const attempts = coldStart \? 6 : 1/);
  assert.match(frontend, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
  assert.match(frontend, /recoverableColdStartError/);
  assert.match(backend, /"--host-app"/);
  assert.match(wakeHelper, /NSWorkspace\.shared\.openApplication/);
  assert.match(wakeHelper, /configuration\.arguments\s*=\s*\["--jarvis-wake"\]/);
  assert.match(frontend, /consume_cold_wake/);
  assert.match(backend, /AVAudioEngine releases the input device asynchronously/);
  assert.match(backend, /matches!\(authorization, "denied" \| "restricted"\)/);
  assert.match(backend, /requestAccessForMediaType_completionHandler/);
  assert.match(frontend, /request_microphone_permission/);
  assert.match(frontend, /startup_is_background/);
  assert.match(entitlements, /com\.apple\.security\.device\.audio-input/);
  // Hardened runtime refuses the camera without its own entitlement, which is
  // what made the prompt never appear.
  assert.match(entitlements, /com\.apple\.security\.device\.camera/);
  assert.match(helperEntitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(backend, /tauri_plugin_autostart/);
  assert.match(frontend, /onCloseRequested/);
  assert.match(wakeHelper, /"--test-wake"/);
});

test("STOP suppresses transcript-tail handoffs and interrupts late turns", () => {
  assert.match(backend, /"flushTranscriptTailOnSessionEnd":\s*false/);
  assert.match(backend, /for _ in 0\.\.4 \{\n\s+let _ = runtime\n\s+\.request\(\n\s+"turn\/interrupt"/);
  assert.match(backend, /"turn\/interrupt"/);
});

test("text input can join the active Voice conversation", () => {
  assert.match(frontend, /append_codex_voice_text/);
  assert.match(backend, /"thread\/realtime\/appendText"/);
});

test("non-realtime providers can wake straight into text mode", () => {
  assert.match(backend, /fn voice_text_only\(\) -> bool/);
  assert.match(backend, /\.jarvis-codex\/config\.json/);
  assert.match(backend, /eq_ignore_ascii_case\("off"\)/);
  assert.match(frontend, /textOnlyMode = await invoke<boolean>\("voice_text_only"\)/);
  assert.match(frontend, /if \(textOnlyMode\) \{\n\s+banner\.hidden = true;/);
  assert.match(frontend, /\(\$\("#command-input"\) as HTMLInputElement\)\.focus\(\)/);
});

test("spoken commands reuse the text pipeline and replies are read aloud", () => {
  assert.match(wakeHelper, /"--capture-command"/);
  assert.match(wakeHelper, /"type": "command", "text": text/);
  assert.match(wakeHelper, /commandRemainder\(from:/);
  assert.match(backend, /command\.arg\("--capture-command"\)/);
  assert.match(backend, /Some\("command"\) => \{/);
  assert.match(backend, /app\.emit\("jarvis-command", json!\(\{ "text": text \}\)\)/);
  assert.match(frontend, /listen<\{ text: string \}>\("jarvis-command"/);
  assert.match(frontend, /void runCommand\(text\)/);
  // Replies leave through one door, so a live call can route them to the
  // digital human instead of the local synthesiser.
  assert.match(frontend, /function speakLine\(text: string\)/);
  assert.match(frontend, /speakLine\(spoken\);/);
  assert.match(backend, /\/usr\/bin\/say/);
  assert.match(backend, /fn speak_replies\(\) -> bool/);
});

test("production configuration persists workspace and resumes threads", () => {
  assert.match(frontend, /jarvis\.workspace/);
  assert.match(frontend, /jarvis\.threadId:/);
  assert.match(backend, /"thread\/resume"/);
  assert.match(backend, /validated_workspace/);
  assert.match(wakeHelper, /requiresOnDeviceRecognition = true/);
});

test("user can create a fresh Codex thread without deleting history", () => {
  assert.match(frontend, /id="new-thread"/);
  assert.match(frontend, /threadId:\s*null/);
  assert.match(frontend, /invoke<Session>\("start_jarvis"/);
  assert.match(frontend, /freshSession\.threadId/);
  assert.match(frontend, /原线程仍保留在 Codex 历史记录中/);
});

test("permission profiles are persisted and mapped by the trusted backend", () => {
  assert.match(frontend, /jarvis\.permissionMode/);
  assert.match(frontend, /type PermissionMode = "safe" \| "auto" \| "full"/);
  assert.match(frontend, /permissionMode,/);
  assert.match(backend, /enum PermissionMode/);
  assert.match(backend, /approval_policy: "on-request"/);
  assert.match(backend, /approval_policy: "never"/);
  assert.match(backend, /sandbox: "workspace-write"/);
  assert.match(backend, /sandbox: "danger-full-access"/);
  assert.match(backend, /existing\.permission_mode == permission_mode/);
});

test("wake activates the macOS app before focusing the Jarvis window", () => {
  assert.match(backend, /fn raise_jarvis_window/);
  assert.match(backend, /activateIgnoringOtherApps\(true\)/);
  assert.match(backend, /set_always_on_top\(true\)/);
  assert.match(backend, /set_always_on_top\(false\)/);
  assert.match(backend, /raise_jarvis_window\(&app\)/);
});

test("continuous conversation keeps one listener alive after the first wake", () => {
  assert.match(backend, /fn conversation_enabled\(\) -> bool/);
  assert.match(
    backend,
    /command[\s\S]{0,40}\.arg\("--conversation"\)[\s\S]{0,40}\.arg\("--control-file"\)/,
  );
  assert.match(backend, /Some\("conversation-end"\)/);
  assert.match(backend, /app\.emit\("jarvis-conversation"/);
  assert.match(backend, /if woke \|\| !conversation \|\| !state\.wake_enabled/);
  assert.match(wakeHelper, /private let conversationStopExact/);
  assert.match(wakeHelper, /private func beginMutedListening\(\)/);
  assert.match(wakeHelper, /private func drainControlFile\(\)/);
  assert.match(wakeHelper, /"mute"|case "mute"/);
  assert.match(frontend, /listen<\{ state\?: string \}>\("jarvis-conversation"/);
});

test("voice packs are switchable, previewable and robot-shaded", () => {
  assert.match(backend, /struct VoicePack \{/);
  assert.match(backend, /"zh-CN-YunyangNeural"/);
  assert.match(backend, /"zh-CN-XiaoyiNeural"/);
  assert.match(backend, /fn ring_modulate_wav/);
  assert.match(backend, /async fn preview_voice/);
  assert.match(backend, /fn set_voice_pack/);
  assert.match(backend, /config\["voicePack"\]/);
  assert.match(frontend, /id="voice-packs"/);
  assert.match(frontend, /refreshVoicePacks/);
  assert.match(frontend, /invoke\("preview_voice", \{ id: pack\.id \}\)/);
  assert.match(frontend, /invoke\("set_voice_pack", \{ id: pack\.id \}\)/);
});

test("spoken sentences can switch the voice pack without reaching Codex", async () => {
  const { matchVoicePackCommand } = await import("../src/voice-pack-command.ts");
  assert.equal(matchVoicePackCommand("换成可爱女声"), "girl");
  assert.equal(matchVoicePackCommand("换个男声吧"), "male");
  assert.equal(matchVoicePackCommand("切换成温柔女声"), "female");
  assert.equal(matchVoicePackCommand("换成机器人声音"), "jarvis");
  assert.equal(matchVoicePackCommand("改用离线语音"), "local");
  assert.equal(matchVoicePackCommand("帮我把这段话翻译成英文，语气温柔一点"), null);
  assert.equal(matchVoicePackCommand("现在几点了？"), null);
  assert.match(frontend, /const spokenPack = matchVoicePackCommand\(text\)/);
});

test("a wake reuses the running Jarvis instead of restarting it", () => {
  assert.match(wakeHelper, /runningApplications\(withBundleIdentifier: identifier\)/);
  assert.match(wakeHelper, /running\.activate\(options: \[\]\)/);
  assert.match(frontend, /await armWakeListener\(\);\n\s+const backgroundStart/);
  assert.match(frontend, /void requestMicrophoneAuthorization\(\)/);
  assert.match(frontend, /async function requestMicrophoneAuthorization\(\)/);
});

test("conversation turns keep feeding the newest recognition request", () => {
  assert.match(wakeHelper, /private func attachTap\(to request: SFSpeechAudioBufferRecognitionRequest\)/);
  assert.match(wakeHelper, /attachTap\(to: fresh\)/);
  assert.match(wakeHelper, /input\.removeTap\(onBus: 0\)/);
  // Tearing the tap down reconfigures the input device, and a reconfigure at
  // the end of an answer repeated the last syllable of the sentence, so the
  // tap is only rebuilt when the input format itself changes.
  assert.match(wakeHelper, /if tapFormat == format \{\n\s+return\n\s+\}/);
  assert.match(wakeHelper, /self\.request\?\.append\(mono\)/);
  assert.match(wakeHelper, /echo cancel \\\(echoCanceled\)/);
  assert.match(wakeHelper, /private var tapFormat: AVAudioFormat\?/);
});

test("superseded recognition tasks cannot end the conversation", () => {
  assert.match(wakeHelper, /private var recognitionGeneration = 0/);
  assert.match(wakeHelper, /guard let self, generation == self\.recognitionGeneration else \{ return \}/);
  assert.match(wakeHelper, /recognitionGeneration \+= 1\n\s+let generation = recognitionGeneration/);
});

test("the idle countdown only runs while Jarvis is listening", () => {
  assert.match(wakeHelper, /scheduleIdleTimer\(480\)/);
  assert.match(wakeHelper, /scheduleIdleTimer\(180\)/);
  assert.match(wakeHelper, /private func scheduleIdleTimer\(_ seconds: TimeInterval = 180\)/);
});

test("the wake helper explains its own lifecycle in a log", () => {
  assert.match(wakeHelper, /private func log\(_ message: String\)/);
  assert.match(wakeHelper, /\.jarvis-codex\/wake-helper\.log/);
  assert.match(wakeHelper, /log\("conversation ended"\)/);
  assert.match(wakeHelper, /log\("control: unmute"\)/);
});

test("the microphone comes back only after the room goes quiet", () => {
  assert.match(backend, /fn resume_listening_when_idle\(app: &AppHandle\)/);
  assert.match(backend, /let idle = \|\| \{\n\s+SPEAK_INFLIGHT\.load\(Ordering::SeqCst\) == 0\n\s+&& SPEAK_PENDING\.load\(Ordering::SeqCst\) == 0\n\s+&& !SPEAK_TURN_OPEN\.load\(Ordering::SeqCst\)/);
  assert.match(backend, /speak_log\("microphone back: answer drained"\);\n\s+write_wake_control\(&app, "unmute"\)\.await;/);
  assert.match(backend, /tokio::time::sleep\(std::time::Duration::from_millis\(700\)\)\.await;/);
  assert.match(wakeHelper, /private func restartRecognition\(\) \{/);
  // The microphone goes back at the end of the turn, never between two
  // sentences of the same answer.
  assert.match(backend, /async fn speak_turn_end\(app: AppHandle\) -> Result<\(\), String>/);
  assert.match(backend, /SPEAK_TURN_OPEN\.store\(false, Ordering::SeqCst\);\n\s+speak_log\("turn ended: draining the answer before the microphone returns"\);\n\s+resume_listening_when_idle\(&app\);/);
  assert.match(frontend, /void invoke\("speak_turn_end"\)/);
  // A failed turn must hand the microphone back exactly like a finished one,
  // otherwise the listener stays muted with nobody left to unmute it.
  assert.match(frontend, /method === "turn\/completed" \|\| method === "turn\/failed"/);
  assert.match(backend, /if !SPEAK_TURN_OPEN\.load\(Ordering::SeqCst\) \{\n\s+resume_listening_when_idle\(app\);/);
});

test("talking over Jarvis interrupts the answer and keeps the conversation", () => {
  assert.match(backend, /Some\("barge"\) => \{/);
  assert.match(backend, /app\.emit\("jarvis-barge"/);
  assert.match(backend, /format!\(\s*"speaking \{\}"/);
  assert.match(backend, /async fn interrupt_turn\(app: AppHandle, state: State<'_, AppState>\)/);
  assert.match(backend, /            interrupt_turn,\n/);
  assert.match(backend, /async fn interrupt_active_turn\(state: &State<'_, AppState>\)/);
  assert.match(wakeHelper, /private func detectBargeIn\(from raw: String\)/);
  assert.match(wakeHelper, /private func commonSubstringLength\(/);
  assert.match(wakeHelper, /line\.hasPrefix\("speaking "\)/);
  assert.match(wakeHelper, /detectBargeIn\(from: raw\)/);
  assert.match(frontend, /listen\("jarvis-barge", \(\) => \{/);
  assert.match(frontend, /void invoke\("interrupt_turn"\)/);
});

test("replies are spoken sentence by sentence while they stream", () => {
  assert.match(frontend, /function flushAgentSpeech\(final: boolean\)/);
  assert.match(frontend, /function lastSentenceBoundary\(text: string\): number/);
  assert.match(frontend, /flushAgentSpeech\(false\);/);
  assert.match(frontend, /flushAgentSpeech\(true\);/);
  assert.match(frontend, /speakCanceled = true/);
});

test("Jarvis never answers the echo of its own voice", () => {
  assert.match(wakeHelper, /private var recentSpoken: \[\(text: String, at: Date\)\] = \[\]/);
  assert.match(wakeHelper, /private func isSelfEcho\(_ text: String\) -> Bool/);
  assert.match(wakeHelper, /private func isWakeRemnant\(_ raw: String, _ remainder: String\) -> Bool/);
  assert.match(wakeHelper, /if isWakeRemnant\(raw, remainder\) \{/);
  assert.match(wakeHelper, /if isSelfEcho\(remainder\) \{/);
  // A truncated wake phrase ("嗨贾维") must never be answered as a command.
  assert.match(wakeHelper, /wakeLeftover\(normalized\)\.count <= 1/);
  // …but a real order behind a character name ("呼叫小肉肉") must be heard:
  // once the name is taken out, no more than one character may remain.
  assert.match(wakeHelper, /for token in \["jarvis", "贾维斯", "贾维", "维斯", "嗨", "嘿", "hi", "hey"\] \+ characterTokens \{/);
  assert.match(wakeHelper, /if hasWakePhrase\(raw\) \{\n\s+return wakeLeftover\(remainder\)\.count <= 2/);
  assert.match(wakeHelper, /private func wakeLeftover\(_ value: String\) -> String/);
  assert.match(wakeHelper, /recentSpoken\.append\(\(text: sentence, at: Date\(\)\)\)/);
  assert.match(wakeHelper, /let stripped = commandRemainder\(from: raw\)/);
});

test("sentences of one answer queue up instead of cutting each other", () => {
  assert.match(backend, /static SPEAK_PLAY: tokio::sync::Mutex<\(\)> = tokio::sync::Mutex::const_new\(\(\)\);/);
  assert.match(backend, /static SPEAK_GENERATION: AtomicU64 = AtomicU64::new\(0\);/);
  assert.match(backend, /static SPEAK_PENDING: AtomicU64 = AtomicU64::new\(0\);/);
  assert.match(backend, /SPEAK_GENERATION\.fetch_add\(1, Ordering::SeqCst\);/);
  assert.match(backend, /let _slot = SPEAK_PLAY\.lock\(\)\.await;/);
  assert.match(backend, /dropped queued sentence: answer was cancelled/);
});

test("consecutive sentences play on one stream instead of one player each", () => {
  // A process per sentence costs roughly half a second of silence at every
  // seam, which is what made a five sentence answer sound chopped.
  assert.match(backend, /enum AudioRequest \{\n\s+Play \{\n\s+file: PathBuf,\n\s+done: oneshot::Sender<\(\)>,\n\s+\},\n\s+Stop,/);
  assert.match(backend, /fn audio_queue\(\) -> &'static std::sync::mpsc::Sender<AudioRequest>/);
  assert.match(backend, /rodio::Player::connect_new\(handle\.mixer\(\)\)/);
  assert.match(backend, /player\.append\(source\);\n\s+true/);
  assert.match(backend, /if active\.empty\(\) \{\n\s+if let Some\(done\) = playing\.take\(\) \{\n\s+let _ = done\.send\(\(\)\);\n\s+\}/);
  assert.doesNotMatch(backend, /Command::new\("\/usr\/bin\/afplay"\)/);
  // The card re-emits whatever is still buffered when the microphone comes
  // back, which came out as the last syllable of an answer repeating itself:
  // the answer now ends on silence and the microphone returns later.
  assert.match(backend, /Pad \{\n\s+millis: u64,\n\s+\},/);
  assert.match(backend, /queue\.send\(AudioRequest::Pad \{ millis: 700 \}\)/);
  assert.match(backend, /static SPEAK_INFLIGHT: AtomicU64 = AtomicU64::new\(0\);/);
});

test("a spoken command gets an instant acknowledgement", () => {
  assert.match(backend, /fn schedule_backchannel\(app: &AppHandle, command: &str\)/);
  assert.match(backend, /async fn play_wav\(/);
  assert.match(backend, /async fn prewarm_backchannel\(pack: &VoicePack\)/);
  // The file name carries the loudness it was rendered at, so a cached
  // sentence from an older level can never keep playing at the old volume.
  assert.match(backend, /fn speech_cache_stamp\(\) -> i64 \{/);
  assert.match(backend, /"jarvis-ack-\{\}-\{\}\.wav"/);
  // The greeting cache key carries the character's own line as well, so a
  // switch never replays the previous character's hello.
  assert.match(backend, /"jarvis-greeting-\{\}-\{:x\}-\{\}\.wav"/);
  assert.match(backend, /\.and_then\(Value::as_bool\)\n\s+\.unwrap_or\(true\)/);
  assert.match(backend, /schedule_backchannel\(&app, &text\);/);
  assert.match(backend, /Rendering already counts as "an answer is on its way"/);
  assert.match(backend, /prewarm_greeting\(pack\)\.await;\n\s+prewarm_backchannel\(pack\)\.await;/);
});

test("Jarvis's own sentence is never mistaken for an interruption", () => {
  assert.match(wakeHelper, /private func matchesOwnVoice\(_ text: String\) -> Bool/);
  assert.match(wakeHelper, /private func unexplainedLength\(_ heard: \[Character\], _ spoken: \[Character\]\) -> Int/);
  assert.match(wakeHelper, /private func commonPrefixLength\(/);
  assert.match(wakeHelper, /return unexplained <= 5 && similarity >= 0\.7/);
  assert.match(wakeHelper, /if similarity >= 0\.8 \{/);
  assert.match(wakeHelper, /\|\| isConversationStop\(clean\(raw\)\)/);
  assert.match(wakeHelper, /matchesOwnVoice\(text\)/);
  // Short commands ("停") must not be swallowed by the echo guard.
  assert.match(wakeHelper, /guard !references\.isEmpty \|\| !soundReferences\.isEmpty else \{ return false \}/);
});

test("an interruption is found inside the transcript of Jarvis's own answer", () => {
  assert.match(wakeHelper, /private var mutedTranscript = ""/);
  assert.match(wakeHelper, /let fresh = Array\(heard\.dropFirst\(min\(shared, heard\.count\)\)\)/);
  assert.match(wakeHelper, /guard fresh\.count >= \(echoCanceled \? 2 : 4\) else \{ return \}/);
  assert.match(wakeHelper, /if matchesOwnVoice\(String\(trimmingOwnVoiceHead\(fresh\)\)\) \{/);
  // A stop phrase wins even when it is too short for the echo comparison.
  assert.match(wakeHelper, /let stopRequested = wakeOnly/);
  assert.match(wakeHelper, /let wakeOnly = hasWakePhrase\(raw\) && clean\(wakeLeftover\(raw\)\)\.count <= 3/);
  assert.match(wakeHelper, /private func trimmingOwnVoiceHead\(_ heard: \[Character\]\) -> \[Character\]/);
  assert.match(wakeHelper, /private func ownVoiceReferences\(\) -> \[String\]/);
  assert.match(wakeHelper, /private func soundFolded\(_ value: String\) -> String/);
  assert.match(wakeHelper, /private func soundSimilarity\(_ heard: \[Character\], _ reference: \[Character\]\) -> Double/);
  assert.match(wakeHelper, /kCFStringTransformToLatin/);
  assert.match(wakeHelper, /bargeStartedAt = nil\n\s+mutedTranscript = ""/);
  // "停一下" is a stop, not the next question, and the wake phrase said over
  // the answer belongs to no question at all.
  assert.match(wakeHelper, /private let bargeStopPrefixes/);
  assert.match(wakeHelper, /private func isBargeStop\(_ value: String\) -> Bool/);
  assert.match(wakeHelper, /\|\| isBargeStop\(freshText\)/);
  assert.match(wakeHelper, /var command = freshText/);
  assert.match(wakeHelper, /handTurnBack\(command: command\)/);
});

test("DeepSeek text mode never reaches for the official Voice", () => {
  // The mode has to be known before the wake listener can fire, otherwise a
  // cold wake (helper launches the app) answers with a provider 404.
  const startupAt = frontend.indexOf('setWorker("orchestrator", "Wake word starting")');
  assert.ok(startupAt > 0, "startup block found");
  const startup = frontend.slice(startupAt, startupAt + 900);
  assert.ok(
    startup.indexOf('invoke<boolean>("voice_text_only")') < startup.indexOf("await armWakeListener();"),
    "text mode is read before the listener is armed",
  );
  assert.match(frontend, /await listen<WakeEvent>\("jarvis-wake", async \(\{ payload \}\) => \{/);
  assert.match(frontend, /textOnlyMode = await invoke<boolean>\("voice_text_only"\)\.catch\(\(\) => textOnlyMode\)/);
  assert.match(frontend, /async function startDirectVoice\(\{ coldStart = false \} = \{\}\) \{\n\s+\/\/ DeepSeek has no \/live endpoint/);
  assert.match(frontend, /mic\.addEventListener\("click", async \(\) => \{/);
  assert.match(frontend, /\/\\\/live\|404\/\.test\(detail\)/);
  // A cold wake in text mode must re-arm the microphone, not only the window.
  assert.match(frontend, /await invoke<boolean>\("consume_cold_wake"\)[\s\S]{0,400}await armWakeListener\(\);/);
  assert.match(backend, /if voice_text_only\(\) \{\n\s+\/\/ The helper that launched this window is the only thing listening/);
  assert.match(backend, /raise_jarvis_window\(&app\);\n\s+start_wake_supervisor\(app\.clone\(\)\);/);
  // The cold wake greets out loud too, with the microphone open — through the
  // one greeting source every wake shares.
  assert.match(frontend, /function speakWakeGreeting\(\)/);
  assert.match(frontend, /if \(!greetSpoken && !greetPlayed\) speakWakeGreeting\(\);/);
  assert.match(frontend, /void invoke\("wake_greeting"\)\.catch/);
});

test("a keeper re-opens Jarvis so the microphone never goes deaf", () => {
  assert.match(keeper, /pgrep -x jarvis-codex/);
  assert.match(keeper, /--args --background/);
  assert.match(keeper, /\.jarvis-codex\/disabled/);
});

test("only one Jarvis owns the microphone", () => {
  assert.match(backend, /fn another_instance_owns_the_microphone\(\) -> bool/);
  assert.match(backend, /if another_instance_owns_the_microphone\(\) \{/);
  assert.match(backend, /another instance is already running, exiting/);
  // A helper from a previous instance has to be gone before a new one starts.
  assert.match(backend, /A helper left over from a previous app instance would keep the/);
  assert.ok(
    backend.indexOf("A helper left over from a previous app instance") <
      backend.indexOf('let mut command = Command::new("/usr/bin/open");'),
    "stale helpers are cleared before spawning a new one",
  );
});

test("Jarvis keeps listening after the wake word", () => {
  // The recogniser ends a task by itself after a stretch of silence, and an
  // ended task never reports another transcript. Without a restart the
  // microphone stayed dead until the helper was killed again — the
  // "打开后它就听不到我说话了" report.
  assert.match(wakeHelper, /private func recognitionTaskDidEnd\(\) \{/);
  assert.match(wakeHelper, /private func scheduleRecognitionRestart\(after delay: TimeInterval\) \{/);
  assert.match(wakeHelper, /scheduleRecognitionRestart\(after: 0\.25\)/);
  assert.match(wakeHelper, /self\.recognitionTaskDidEnd\(\)/);
  assert.match(wakeHelper, /private func handleTranscript\(_ raw: String\) \{/);
  // A task that only timed out on silence is not a failure.
  assert.match(wakeHelper, /if Date\(\)\.timeIntervalSince\(taskStartedAt\) > 1\.2 \{\n\s+restartAttempts = 0/);
  // Thinking for a moment after "嗨 Jarvis" must not end the capture.
  assert.match(
    wakeHelper,
    /captureDeadline = Date\(\)\.addingTimeInterval\(inConversation \? 90 : 15\)/,
  );
  assert.match(wakeHelper, /if self\.inConversation \{\n\s+\/\/ Nothing was said after the wake word yet/);
  assert.match(wakeHelper, /if !inConversation, Date\(\) > captureDeadline \{/);
  // The accepted command is now visible in the log.
  assert.match(wakeHelper, /log\("heard command: \\\(remainder\)"\)/);
  assert.match(wakeHelper, /log\("command: \\\(text\)"\)/);
});

test("a spoken close really closes Jarvis", () => {
  assert.match(frontend, /import \{ matchShutdownCommand \} from "\.\/shutdown-command";/);
  assert.match(frontend, /if \(matchShutdownCommand\(text\)\) \{/);
  assert.match(frontend, /invoke\("close_jarvis", \{ farewell: "好，我关了，喊我一声就回来。" \}\)/);
  assert.match(backend, /async fn close_jarvis\(/);
  assert.match(backend, /fn mark_closed_by_user\(reason: &str\)/);
  assert.match(backend, /mark_closed_by_user\("voice"\);/);
  // A real launch clears the marker, so crashes are restarted again.
  assert.match(backend, /clear_closed_by_user\(\);/);
  assert.match(backend, /tauri::RunEvent::Exit/);
  assert.match(backend, /mark_closed_by_user\("exit"\);/);
  assert.match(backend, /on_termination_signal/);
  assert.match(backend, /libc::SIGTERM/);
  // No orphan conversation listener may survive the app, but the wake word
  // must: a wake-only listener is started instead.
  assert.match(backend, /fn stop_wake_helpers_blocking\(\)/);
  assert.match(backend, /fn spawn_cold_wake_listener\(app: &AppHandle\)/);
  assert.ok(
    backend.indexOf("stop_wake_helpers().await;") <
      backend.indexOf("spawn_cold_wake_listener(&app);"),
    "the conversation listener is replaced by the wake-only listener",
  );
  assert.ok(
    backend.indexOf("mark_closed_by_user(\"exit\");") < backend.indexOf("stop_wake_helpers_blocking();"),
    "the closed marker is written before the helpers are killed",
  );
});

test("the keeper restarts a crash but never undoes a close", () => {
  assert.match(keeper, /closed-by-user/);
  const closedCheck = keeper.indexOf('if [[ -f "$state_dir/closed-by-user" ]]');
  assert.ok(closedCheck > 0, "the closed marker is checked");
  assert.ok(
    keeper.indexOf("/usr/bin/pgrep -x jarvis-codex") < closedCheck,
    "a running Jarvis wins over every marker",
  );
  assert.ok(
    closedCheck < keeper.indexOf('open -a "$app"'),
    "a closed Jarvis is never re-opened",
  );
  // The wake word has to survive a closed Jarvis: a wake-only listener is
  // started when nothing is listening.
  assert.match(keeper, /open -n "\$listener" --args --host-app "\$app"/);
  assert.match(keeper, /Contents\/Resources\/wake-helper\/JarvisWakeListener\.app/);
  assert.ok(
    keeper.indexOf('open -n "$listener"') < keeper.indexOf('if [[ -f "$state_dir/closed-by-user" ]]'),
    "the wake listener is started before the closed marker is honoured",
  );
});

test("the armour assembly plays on every launch", () => {
  assert.match(frontend, /function playFormation\(\) \{/);
  assert.match(frontend, /if \(mode === "voice-starting" \|\| mode === "booting"\) playFormation\(\);/);
  assert.match(frontend, /setMode\("booting"\);/);
  assert.match(frontend, /if \(state\.mode === "booting"\) setMode\("ready"\);/);
  assert.match(frontend, /shell\.classList\.add\("is-forming"\);/);
  assert.match(frontend, /startParticleFormation\(\);/);
  assert.match(styles, /^\.shell\.is-forming \.helmet-character\{animation:minimal-materialize/m);
  assert.match(styles, /@keyframes armor-shard-assemble/);
  assert.match(
    styles,
    /^\.shell\.is-forming \.armor-shard\{animation:armor-shard-assemble 3\.2s/m,
  );
});

test("spoken close sentences are recognised without eating real tasks", () => {
  const source = shutdownSource
    .replace(/export function/g, "function")
    .replace(/\(text: string\)/g, "(text)")
    .replace(/: string/g, "")
    .replace(/: boolean/g, "")
    .replace(/^\/\/.*$/gm, "");
  const match = new Function(`${source}\nreturn matchShutdownCommand;`)();
  for (const closing of [
    "关闭 Jarvis",
    "关掉自己",
    "把你关了吧",
    "退出 jarvis",
    "jarvis 关机",
    "请帮我关闭你自己",
    "贾维斯关闭一下",
    "关闭你的本体",
    "关掉你吧",
  ]) {
    assert.equal(match(closing), true, `"${closing}" closes Jarvis`);
  }
  for (const task of [
    "关闭 jarvis 的终端",
    "关闭语音对话",
    "关灯",
    "把音乐关了",
    "帮我关闭这个窗口",
    "贾维斯，帮我写一个关闭窗口的脚本",
    "关掉你的闹钟",
  ]) {
    assert.equal(match(task), false, `"${task}" is a task for Codex`);
  }
});

test("the wake summons Jarvis with the assembly in text mode", () => {
  const wakeAt = frontend.indexOf('await listen<WakeEvent>("jarvis-wake"');
  assert.ok(wakeAt > 0, "the wake handler exists");
  const handler = frontend.slice(wakeAt, wakeAt + 1600);
  assert.match(handler, /if \(textOnlyMode\) \{/);
  assert.match(handler, /setMode\("voice-starting"\);/);
  assert.match(handler, /if \(state\.mode === "voice-starting"\) setMode\("listening"\);/);
});

test("the wake word inside a running conversation only summons the window", () => {
  assert.match(wakeHelper, /private var lastSummonAt = Date\.distantPast/);
  assert.match(wakeHelper, /if inConversation, hasWakePhrase\(raw\), wakeLeftover\(remainder\)\.count <= 2,/);
  assert.match(wakeHelper, /log\("summon: window raised again"\)/);
  assert.ok(
    wakeHelper.indexOf("summon: window raised again") <
      wakeHelper.indexOf('log("ignored wake remnant:'),
    "the summon happens before the remnant is discarded",
  );
});

test("hallucinated syllable repetitions are not answered", () => {
  assert.match(wakeHelper, /private func isRecognizerArtifact\(_ value: String\) -> Bool/);
  assert.match(wakeHelper, /log\("ignored recognizer artifact: \\\(remainder\)"\)/);
});

test("a closed Jarvis still answers to the wake word", () => {
  // The wake-only listener survives the app, so "嗨 Jarvis" works even after
  // Jarvis was closed; nothing else may open the app by itself.
  assert.match(backend, /fn spawn_cold_wake_listener\(app: &AppHandle\)/);
  assert.match(backend, /Keep one listener on the microphone so the wake word still works while/);
  assert.match(backend, /spawn_cold_wake_listener\(app\);/);
  assert.match(keeper, /wake listener started \(app closed\)/);
  // Only one wake-only listener: a duplicate would hold the microphone twice.
  assert.match(wakeHelper, /if eventFile == nil, let identifier = Bundle\.main\.bundleIdentifier \{/);
  assert.match(wakeHelper, /another wake listener is already running, exiting/);
  assert.ok(
    wakeHelper.indexOf("another wake listener is already running") <
      wakeHelper.indexOf('emit(["type": "boot"])'),
    "the duplicate check runs before the listener starts listening",
  );
});

test("a wake that opened the app also opens the conversation", () => {
  // The wake-only listener consumed the phrase, so the listener that starts
  // with the app must not wait for it again.
  assert.match(backend, /async fn resume_wake_conversation\(app: AppHandle\)/);
  assert.match(backend, /write_wake_control\(&app, "awake"\)\.await/);
  assert.match(wakeHelper, /case "awake":/);
  assert.match(wakeHelper, /if !hasWoken, !muted \{/);
  assert.match(wakeHelper, /The app drives the listener through the control file/);
  assert.match(
    frontend,
    /await armWakeListener\(\);[\s\S]{0,400}await invoke\("resume_wake_conversation"\)\.catch\(\(\) => \{\}\);/,
  );
});

test("a listener whose app vanished goes back to wake-only", () => {
  assert.match(wakeHelper, /private func startHostWatchdog\(\)/);
  assert.match(wakeHelper, /private func becomeColdListener\(\)/);
  assert.match(wakeHelper, /log\("host app is gone: back to wake-only listening"\)/);
  assert.match(wakeHelper, /guard captureCommand, !cold else \{/);
  assert.ok(
    wakeHelper.indexOf("becomeColdListener()") > 0 &&
      wakeHelper.indexOf("private var cold = false") < wakeHelper.indexOf("private func stop()"),
    "the cold state is declared before it is used",
  );
});

test("quitting Jarvis never aborts on a missing tokio runtime", () => {
  // `RunEvent::Exit` runs inside AppKit's `applicationWillTerminate`, where a
  // panic cannot unwind: it aborts the process and macOS reports "Jarvis Codex
  // quit unexpectedly". tokio's Command::spawn panics there with "there is no
  // reactor running", so the hand-off must use the std process API.
  const coldListener = backend.slice(
    backend.indexOf("fn spawn_cold_wake_listener"),
    backend.indexOf("async fn close_jarvis"),
  );
  assert.match(coldListener, /std::process::Command::new\("\/usr\/bin\/open"\)/);
  assert.doesNotMatch(
    coldListener,
    /[^:]\bCommand::new/,
    "the cold listener also runs from the exit handler, so it must not use tokio's Command",
  );
  assert.match(backend, /fn stop_wake_helpers_blocking\(\)[\s\S]{0,300}?std::process::Command::new/);
  // Belt and braces: a panic in the hand-off must not become a crash report.
  assert.match(backend, /std::panic::catch_unwind\(std::panic::AssertUnwindSafe/);
  assert.match(backend, /append_state_log\("exit\.log", "exit: menu, window or voice close"\)/);
  assert.match(backend, /hand-off failed, see panic\.log/);
});

test("a panic is written down instead of only aborting", () => {
  assert.match(backend, /fn install_panic_log\(\)/);
  assert.match(backend, /append_state_log\("panic\.log", &format!\("panic at \{location\}: \{info\}"\)\)/);
  assert.match(backend, /install_termination_marker\(\);\n\s*install_panic_log\(\);/);
});

test("the microphone is cleared of Jarvis's own voice before recognition", () => {
  // The recognizer used to transcribe the answer that was playing out loud,
  // and the echo filter that guarded against it is exactly what swallowed a
  // person talking over Jarvis.
  assert.match(wakeHelper, /try input\.setVoiceProcessingEnabled\(true\)/);
  assert.match(wakeHelper, /echoCanceled = true/);
  assert.match(wakeHelper, /log\("echo cancellation enabled"\)/);
  assert.match(wakeHelper, /log\("echo cancellation unavailable: \\\(error\.localizedDescription\)"\)/);
  assert.match(wakeHelper, /private var echoCanceled = false/);
  // A Mac where voice processing misbehaves can take the plain signal back.
  assert.match(wakeHelper, /private func echoCancelEnabled\(\) -> Bool/);
  assert.match(wakeHelper, /object\["echoCancel"\] as\? Bool/);
  assert.match(wakeHelper, /log\("echo cancellation disabled in config\.json"\)/);
  // Voice processing reports the reference channels next to the processed one,
  // so the tap feeds recognition one channel only.
  assert.match(wakeHelper, /private func monoBuffer\(_ buffer: AVAudioPCMBuffer\) -> AVAudioPCMBuffer/);
  assert.match(wakeHelper, /let mono = self\.monoBuffer\(buffer\)/);
  assert.match(wakeHelper, /self\.request\?\.append\(mono\)/);
  assert.match(wakeHelper, /self\.watchForVoice\(mono\)/);
  // With the echo gone, only literal text from the sentence on the speakers
  // counts as Jarvis's own voice.
  assert.match(wakeHelper, /if echoCanceled \{\n\s+\/\/ Jarvis is already cancelled out of the microphone/);
});

test("a voice over the answer stops it without waiting for a transcript", () => {
  assert.match(wakeHelper, /private func watchForVoice\(_ buffer: AVAudioPCMBuffer\)/);
  // Two anchors: the quiet room and the level of the answer that is playing,
  // so a loud playback cannot be mistaken for someone talking over it.
  assert.match(wakeHelper, /voiceBaseline = baseline \* 0\.94 \+ level \* 0\.06/);
  assert.match(wakeHelper, /let threshold = max\(0\.012, max\(\(voiceFloor \?\? level\) \* 4, \(voiceBaseline \?\? level\) \* 2\.4\)\)/);
  assert.match(wakeHelper, /guard loudBuffers >= 5 else \{ return \}/);
  assert.match(wakeHelper, /A new sentence is starting: never carry a half-finished/);
  // Without echo cancellation the microphone is full of Jarvis's own voice and
  // the loudness trigger would cut the answer off at its first loud syllable.
  assert.match(wakeHelper, /guard echoCanceled, muted, let started = bargeStartedAt,/);
  assert.match(wakeHelper, /private func bargeIn\(byVoice level: Double\)/);
  assert.match(wakeHelper, /log\(String\(format: "barge-in by voice \(level %\.3f\)", level\)\)/);
  assert.match(wakeHelper, /emit\(\["type": "barge"\]\)\n\s+handTurnBack\(command: ""\)/);
  // The text path and the loudness path hand the turn back the same way.
  assert.match(wakeHelper, /private func handTurnBack\(command: String\)/);
  assert.match(wakeHelper, /return !echoCanceled/);
  assert.match(wakeHelper, /guard buffer\.format\.channelCount > 1, let source = buffer\.floatChannelData else \{/);
});

test("a new instruction stops the answer that is still playing", () => {
  assert.match(backend, /SPEAK_TURN_OPEN\.store\(true, Ordering::SeqCst\);\n\s+speak_stop_players\(\)\.await;/);
  // The counter of an answer is taken before its sentences are rendered. It
  // used to be read after the render, so a sentence that was already on its way
  // got a fresh counter and the cancelled answer finished over the new reply.
  assert.match(backend, /let generation = SPEAK_GENERATION\.load\(Ordering::SeqCst\);\n\s+\/\/ Rendering already counts as/);
  assert.match(backend, /if generation != SPEAK_GENERATION\.load\(Ordering::SeqCst\) \{\n\s+speak_log\(&format!\(\n\s+"dropped queued sentence: answer was cancelled/);
  assert.match(backend, /play_wav\(app, pack, &trimmed, &file, generation, true\)\.await/);
  assert.match(frontend, /if \(state\.mode === "speaking"\) \{\n\s+speakCanceled = true;\n\s+void invoke\("interrupt_turn"\);/);
  // Interrupting a turn must not kill the command that replaces it.
  assert.match(backend, /let Some\(turn_id\) = runtime\.active_turn\.read\(\)\.await\.clone\(\) else \{\n\s+return;\n\s+\};/);
});

test("every voice pack speaks at the same loudness", () => {
  // The level in the file was right for the local voice and 5 to 10 dB low for
  // the online packs, which is what the master heard as "Jarvis got quiet"
  // after switching to a robot or male voice.
  assert.match(backend, /fn loudness_target\(\) -> f64 \{/);
  assert.match(backend, /let scale = jarvis_config\(\)\n\s+\.get\("volume"\)/);
  assert.match(backend, /\.clamp\(0\.2, 3\.0\)/);
  assert.match(backend, /fn compress_wav_dynamics\(\n\s+path: &std::path::Path,/);
  assert.match(backend, /envelope = if level > envelope \{\n\s+level \+ \(envelope - level\) \* attack/);
  // Turning the gain up on a voice whose peaks sit 20 dB above its average only
  // clipped it; the range has to come down first.
  assert.match(backend, /compress_wav_dynamics\(&file, -20\.0, 3\.0\)/);
  assert.match(backend, /normalize_wav_level\(&file, loudness_target\(\), peak_cap\)/);
  assert.match(backend, /normalize_wav_level\(\n\s+&path,\n\s+loudness_target\(\),\n\s+if pack\.robot \{ 0\.98 \} else \{ 0\.95 \},\n\s+\)/);
  // The metallic carrier can no longer push the robot voice past full scale,
  // so the voice is not flattened by a limiter before the effect any more.
  assert.match(backend, /let scale = 1\.0 \/ \(1\.0 \+ depth\);/);
  assert.ok(
    !backend.includes("normalize_wav_level(&file, 0.115, 0.58)"),
    "the robot voice is no longer squashed before the carrier",
  );
});

test("voice processing does not duck Jarvis's own voice", () => {
  // macOS treats a held microphone with voice processing as a phone call and
  // turns everything else down — including the answer Jarvis is playing.
  assert.match(wakeHelper, /private func minimiseDucking\(of input: AVAudioInputNode\) \{/);
  assert.match(wakeHelper, /guard #available\(macOS 14\.0, \*\) else \{ return \}/);
  assert.match(wakeHelper, /kAUVoiceIOProperty_OtherAudioDuckingConfiguration/);
  assert.match(wakeHelper, /mEnableAdvancedDucking: false,/);
  assert.match(wakeHelper, /mDuckingLevel: minimumDucking/);
  assert.match(wakeHelper, /log\("other audio ducking set to minimum"\)/);
  assert.match(wakeHelper, /log\("other audio ducking not configurable /);
  assert.ok(
    wakeHelper.indexOf("minimiseDucking(of: input)") >
      wakeHelper.indexOf("try input.setVoiceProcessingEnabled(true)"),
    "ducking is configured after voice processing is switched on",
  );
});

test("the wake word is answered out loud", () => {
  assert.match(backend, /const WAKE_GREETING: &str = "主人！我来了！请主人吩咐！"/);
  assert.match(backend, /async fn prewarm_greeting\(pack: &VoicePack\) \{/);
  assert.match(backend, /fn greeting_file\(pack: &VoicePack\) -> PathBuf \{/);
  assert.match(backend, /greeting ready pack=/);
  // The greeting plays with the microphone open: the order that follows the
  // wake word is usually spoken immediately and would otherwise be swallowed.
  assert.match(backend, /async fn wake_greeting\(app: AppHandle\) -> Result<\(\), String> \{[\s\S]{0,900}play_wav\([\s\S]{0,300}false,[\s\S]{0,120}\)\n\s+\.await/);
  // While the Vidu call owns the microphone the local greeting stays silent.
  assert.match(backend, /wake greeting skipped: live call active/);
  assert.match(backend, /if hold_microphone \{\n\s+write_wake_control\(app, "mute"\)\.await;/);
  // One voice per summon: the supervisor no longer greets on its own, the
  // front-end is the single source, and the greeting wave owns the first line.
  assert.doesNotMatch(backend, /greet_on_wake/);
  assert.match(frontend, /function speakWakeGreeting\(\)[\s\S]{0,700}void invoke\("wake_greeting"\)\.catch/);
  assert.match(frontend, /if \(!greetPlayed && !greetSpoken && sceneSources\.greet\)/);
  assert.ok(
    !frontend.includes("我回来了，你再说一次。"),
    "the cold wake greets the master",
  );
});


test("characters are switchable by voice, and a name never steals a voice pack", async () => {
  const { matchAvatarCommand } = await import("../src/avatar-command.ts");
  const roster = [
    { id: "jarvis", name: "Jarvis" },
    { id: "av1", name: "小美" },
    { id: "av2", name: "小美美" },
  ];
  assert.equal(matchAvatarCommand("切换成小美", roster), "av1");
  assert.equal(matchAvatarCommand("变身成小美美", roster), "av2");
  assert.equal(matchAvatarCommand("换成贾维斯", roster), "jarvis");
  assert.equal(matchAvatarCommand("变回你自己", roster), "jarvis");
  assert.equal(matchAvatarCommand("用一下小美", roster), "av1");
  // The voice pack table keeps its own vocabulary.
  assert.equal(matchAvatarCommand("换个可爱女声", roster), null);
  assert.equal(matchAvatarCommand("切换成还没有的人物", roster), null);
  assert.equal(matchAvatarCommand("帮我把这个文件删掉", roster), null);
  // Longest name first, so "小美" never shadows "小美美".
  assert.equal(matchAvatarCommand("切换成小美美", roster), "av2");
});

test("a character owns its portrait, persona and voice pack", () => {
  assert.match(avatars, /pub const MAX_AVATARS: usize = 10;/);
  assert.match(avatars, /内置的 Jarvis 不能删除/);
  assert.match(avatars, /crate::write_voice_pack\(&avatar\.voice_pack\)\?;/);
  assert.match(avatars, /fn active_voice_pack_id\(\) -> String \{/);
  // The Codex thread is rebuilt when the character changes, so the persona
  // lands in the model's own instructions.
  assert.match(backend, /existing\.avatar_id == avatars::active_avatar\(\)\.id/);
  assert.match(backend, /avatars::persona_for_prompt\(\)/);
  assert.ok(
    frontend.indexOf("const spokenAvatar = matchAvatarCommand(text, avatars);") <
      frontend.indexOf("const spokenPack = matchVoicePackCommand(text);"),
    "a spoken character switch is answered before the voice pack table",
  );
});

test("the character transform is a particle tornado", () => {
  assert.match(frontend, /function funnelPoint\(/);
  assert.match(frontend, /shell\.classList\.add\("is-transforming"\)/);
  assert.match(frontend, /startParticleFormation\(true, TRANSFORM_DURATION - TRANSFORM_FUNNEL\)/);
  assert.match(frontend, /prepareVisualParticles\(true\)/);
  assert.match(styles, /@keyframes character-vortex\{/);
  assert.match(styles, /@keyframes character-vortex-in\{/);
  assert.match(styles, /\.shell\.custom-character \.helmet-scan/);
  // Sampling must read the layout box, otherwise the animated box smears the
  // silhouette the particles are supposed to reassemble.
  assert.match(frontend, /function characterLayoutBox\(\) \{/);
});

test("the camera feeds a self view and an expression estimate", () => {
  assert.match(visionHelper, /VNDetectFaceLandmarksRequest/);
  assert.match(visionHelper, /"--frame-file"/);
  assert.match(visionHelper, /kill\(options\.hostPid, 0\)/);
  assert.match(visionEntitlements, /com\.apple\.security\.device\.camera/);
  assert.match(visionInfo, /NSCameraUsageDescription/);
  assert.match(vision, /"data:image\/jpeg;base64,\{\}"/);
  assert.match(vision, /pub fn mood_hint\(\) -> Option<String> \{/);
  assert.match(frontend, /invoke<string \| null>\("camera_frame"\)/);
  assert.match(frontend, /listen<VisionSignal>\("jarvis-vision"/);
  assert.match(frontend, /setCameraLoop\(false\)/);
  // A nested helper cannot raise the camera prompt, so the app asks first.
  assert.match(vision, /pub async fn request_camera_permission\(\) -> Result<String, String> \{/);
  assert.match(frontend, /invoke<string>\("request_camera_permission"\)/);
  assert.match(backend, /Some\(hint\) => format!\("\[\{hint\}\]\\n\{text\}"\)/);
});

test("the Vidu key is local only and image tasks are polled by creations", () => {
  assert.match(vidu, /pub const API_BASE: &str = "https:\/\/api\.vidu\.cn";/);
  assert.match(vidu, /"Authorization: Token \{\}"/);
  assert.match(vidu, /\/ent\/v2\/reference2image/);
  assert.match(vidu, /\/ent\/v2\/tasks\/\{task_id\}\/creations/);
  assert.match(avatars, /"viduKey"/);
  assert.match(avatars, /std::env::var\("VIDU_API_KEY"\)/);
  assert.match(tauriConfig, /wake-helper\/JarvisVision\.app\//);
  // The key must never be baked into the repository.
  assert.doesNotMatch(avatars, /vda_/);
  assert.doesNotMatch(vidu, /vda_/);
  assert.doesNotMatch(frontend, /vda_/);
});


test("the camera is voice controlled and off by default", async () => {
  const { matchVisionCommand } = await import("../src/vision-command.ts");
  assert.equal(matchVisionCommand("启动视频组件"), "on");
  assert.equal(matchVisionCommand("打开视频组件"), "on");
  assert.equal(matchVisionCommand("你能看到我吗？"), "on");
  assert.equal(matchVisionCommand("你能看见我吗"), "on");
  assert.equal(matchVisionCommand("看看我是谁"), "on");
  assert.equal(matchVisionCommand("关闭视频组件"), "off");
  assert.equal(matchVisionCommand("关掉摄像头"), "off");
  assert.equal(matchVisionCommand("别看我了"), "off");
  assert.equal(matchVisionCommand("闭上眼睛"), "off");
  assert.equal(matchVisionCommand("帮我打开 Safari"), null);
  assert.equal(matchVisionCommand("把这个视频转成 mp3"), null);
  assert.equal(matchVisionCommand("你能看到我吗？顺便看看昨天的日志里有没有报错"), null);

  // Off unless asked for: the green light must not follow the app launch.
  assert.match(vision, /\.unwrap_or\(false\)/);
  assert.match(frontend, /const spokenVision = matchVisionCommand\(text\);/);
  assert.ok(
    frontend.indexOf("const spokenVision = matchVisionCommand(text);") <
      frontend.indexOf("const spokenAvatar = matchAvatarCommand(text, avatars);"),
    "the camera answers before the character table",
  );
  assert.match(frontend, /async function startVision\(\): Promise<\{ ok: boolean; message: string \}> \{/);
  assert.match(frontend, /await invoke<string>\("request_camera_permission"\)/);
});

// ---------------------------------------------------------------------------
// Vidu S1 realtime digital human
// ---------------------------------------------------------------------------

const liveSource = await readFile(new URL("../src/live.ts", import.meta.url), "utf8");
const styleSheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
const visionSource = await readFile(new URL("../src-tauri/src/vision.rs", import.meta.url), "utf8");
const chromaSource = await readFile(new URL("../src/chroma.ts", import.meta.url), "utf8");
const liveRust = await readFile(new URL("../src-tauri/src/live.rs", import.meta.url), "utf8");
const liveCommand = await readFile(new URL("../src/live-command.ts", import.meta.url), "utf8");
const idleSource = await readFile(new URL("../src/idle.ts", import.meta.url), "utf8");
const avatarsRust = await readFile(new URL("../src-tauri/src/avatars.rs", import.meta.url), "utf8");
const matteSwift = await readFile(
  new URL("../src-tauri/wake-helper/jarvis-matte.swift", import.meta.url),
  "utf8",
);
const matteRust = await readFile(new URL("../src-tauri/src/matte.rs", import.meta.url), "utf8");
const matte = await readFile(new URL("../src-tauri/wake-helper/jarvis-matte.swift", import.meta.url), "utf8");
const buildScript = await readFile(new URL("../scripts/build-wake-helper.sh", import.meta.url), "utf8");
const liveJson = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const rtcSdk = await readFile(new URL("../public/vendor/aliyun-rtc-sdk.js", import.meta.url), "utf8");

test("spoken sentences open and close the realtime call without reaching Codex", async () => {
  const { matchLiveCommand } = await import("../src/live-command.ts");
  assert.equal(matchLiveCommand("启动视频对话"), "start");
  assert.equal(matchLiveCommand("打开视频"), "start");
  assert.equal(matchLiveCommand("打个视频电话吧"), "start");
  assert.equal(matchLiveCommand("我要和你视频聊天"), "start");
  assert.equal(matchLiveCommand("挂断"), "stop");
  assert.equal(matchLiveCommand("结束视频对话"), "stop");
  assert.equal(matchLiveCommand("先这样，拜拜"), "stop");
  // The camera keeps its own vocabulary.
  assert.equal(matchLiveCommand("启动视频组件"), null);
  assert.equal(matchLiveCommand("你能看到我吗"), null);
  assert.equal(matchLiveCommand("关掉摄像头"), null);
  assert.equal(matchLiveCommand("帮我把这个视频转成 mp3"), null);
  assert.equal(matchLiveCommand("把这个视频剪一下发给我"), null);
  assert.equal(matchLiveCommand("切换成张元英"), null);
  assert.match(frontend, /const liveCommand = matchLiveCommand\(text\);/);
  const liveIndex = frontend.indexOf("const liveCommand = matchLiveCommand(text);");
  assert.ok(liveIndex < frontend.indexOf("const spokenVision = matchVisionCommand(text);"));
  assert.ok(liveIndex < frontend.indexOf("const spokenAvatar = matchAvatarCommand(text, avatars);"));
});

test("the digital human is driven through the session secret, never the account key", () => {
  assert.match(liveSource, /client_secret=\$\{encodeURIComponent\(this\.clientSecret\)\}/);
  assert.match(liveSource, /type: 99/);
  assert.match(liveSource, /type: 7/);
  assert.match(liveSource, /type: 5/);
  assert.match(liveSource, /NOT_READY/);
  assert.doesNotMatch(liveSource, /vda_/);
  assert.match(liveRust, /client_secret/);
  assert.match(liveRust, /"audio": \{"enable_transcription": true\}/);
  assert.match(liveRust, /"type": "server"/);
  assert.match(liveRust, /idle_timeout_seconds/);
});

test("the bot's own publishers are the only ones subscribed", () => {
  assert.match(liveSource, /uid\.startsWith\("live-video-push-"\) \|\| uid\.startsWith\("live-bot-"\)/);
  assert.match(liveSource, /export function botUserIdFrom/);
  assert.match(liveSource, /setDefaultSubscribeAllRemoteAudioStreams\?\.\(false\)/);
  assert.match(liveSource, /setRemoteViewConfig\?\.\(this\.video, uid, track\)/);
  assert.match(liveSource, /requestVideoFrameCallback/);
});

test("the live character is keyed out of its backdrop on the GPU", () => {
  assert.match(chromaSource, /createVideoKeyer/);
  assert.match(chromaSource, /gl\.FRAGMENT_SHADER/);
  assert.match(chromaSource, /premultipliedAlpha: true/);
  // Without a usable sample the canvas draws nothing, so the model's own
  // studio set can never appear behind the character.
  assert.match(chromaSource, /if \(u_enabled < 0\.5\) \{[\s\S]{0,300}gl_FragColor = vec4\(0\.0\);/);
  assert.match(chromaSource, /export function usableChromaSample\(/);
  assert.match(chromaSource, /const chroma = Math\.max\(r, g, b\) - Math\.min\(r, g, b\);/);
  // Dark pixels stay opaque, otherwise hair and shadows get punched out.
  assert.match(chromaSource, /if \(length < 0\.15\) return Math\.max\(angle \* 1\.7 \+ intensity \* 0\.15, 0\.6\);/);
  assert.match(chromaSource, /if \(length_ < 0\.15\) distance = max\(distance, 0\.6\);/);
  assert.match(liveSource, /this\.keyer\.setKey\(null\)/);
  assert.match(frontend, /cutPortraitBackground\(source\)/);
});

test("keying removes a flat backdrop and keeps the character", async () => {
  const { detectKeyColor, keyPixels, keyUnitLength, keyThresholds, usableChromaSample } = await import("../src/chroma.ts");
  const width = 16;
  const height = 16;
  const frame = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    frame[index * 4] = 0;
    frame[index * 4 + 1] = 177;
    frame[index * 4 + 2] = 64;
    frame[index * 4 + 3] = 255;
  }
  const sample = detectKeyColor(frame, width, height);
  assert.ok(sample);
  assert.deepEqual(sample.color, { r: 0, g: 177, b: 64 });
  assert.ok(sample.spread < 0.001);

  const { similarity, smoothness } = keyThresholds(sample.spread);
  const pixels = new Uint8ClampedArray([
    0, 177, 64, 255, // the backdrop itself
    0, 120, 50, 255, // the same green under weaker light
    255, 255, 255, 255, // a white dress
    12, 10, 14, 255, // dark hair
    214, 168, 140, 255, // skin
  ]);
  const removed = keyPixels(pixels, sample.color, similarity, smoothness);
  assert.equal(removed, 2);
  assert.equal(pixels[3], 0);
  assert.equal(pixels[7], 0);
  assert.equal(pixels[11], 255);
  assert.equal(pixels[15], 255);
  assert.equal(pixels[19], 255);
  assert.equal(keyUnitLength(sample.color) > 0, true);

  // A pale studio set is not a key: keying it would punch holes in skin, so it
  // is rejected and the frame stays blank until the chroma set is back.
  assert.equal(
    usableChromaSample({ color: { r: 240, g: 255, b: 234 }, spread: 2 }),
    null,
  );
  assert.ok(usableChromaSample({ color: { r: 0, g: 177, b: 64 }, spread: 2 }));
  assert.equal(
    usableChromaSample({ color: { r: 0, g: 177, b: 64 }, spread: 40 }),
    null,
  );
  // The washed-out studio wall that shipped a fully green screen mid-call:
  // Vidu's own set measured rgb(132,174,162) once, was adopted as the key,
  // and the real chroma green was then never removed again.
  assert.equal(
    usableChromaSample({ color: { r: 132, g: 174, b: 162 }, spread: 15.6 }),
    null,
  );
  // A greenish wall with enough chroma still fails on saturation.
  assert.equal(
    usableChromaSample({ color: { r: 120, g: 200, b: 150 }, spread: 4 }),
    null,
  );
  // Blue and magenta sets keep keying.
  assert.ok(usableChromaSample({ color: { r: 0, g: 20, b: 200 }, spread: 2 }));
  assert.ok(usableChromaSample({ color: { r: 200, g: 20, b: 190 }, spread: 2 }));
});

test("portrait matting is part of the build and the bundle", () => {
  assert.match(matte, /VNGenerateForegroundInstanceMaskRequest/);
  assert.match(matte, /generateMaskedImage/);
  assert.match(matte, /chroma-key green/);
  assert.match(buildScript, /jarvis-matte\.swift/);
  assert.match(buildScript, /-o "\$helper_dir\/JarvisMatte"/);
  assert.ok(liveJson.bundle.resources.includes("wake-helper/JarvisMatte"));
  assert.match(backend, /avatars::create_avatar_from_image/);
  assert.match(backend, /live::videolive_start/);
  assert.match(avatars, /pub fn set_live_asset_id/);
});

test("the realtime stream is allowed through the capability policy", () => {
  const csp = liveJson.app.security.csp;
  // A closed connect-src list is what kept the call on a still picture: Chrome,
  // Safari and WKWebView all refuse to finish the media subscription when the
  // RTC path falls outside it, so the policy opens the schemes instead.
  assert.match(csp, /connect-src [^;]*\bws:/);
  assert.match(csp, /connect-src [^;]*\bwss:/);
  assert.match(csp, /connect-src [^;]*\bhttps:/);
  assert.match(csp, /connect-src [^;]*ipc:/);
  assert.doesNotMatch(csp, /aliyuncs\.com/);
  assert.match(csp, /worker-src 'self' blob:/);
  assert.match(csp, /'wasm-unsafe-eval'/);
  assert.match(csp, /media-src 'self' blob: mediastream:/);
  assert.match(rtcSdk, /AliRtcEngine|createInstance/);
  assert.match(liveSource, /const RTC_SDK_URL = "\/vendor\/aliyun-rtc-sdk\.js"/);
});

test("a live call replaces the local voice and restores the wake word after", () => {
  assert.match(frontend, /function speakLine\(text: string\)/);
  assert.match(frontend, /if \(liveCall\?\.active\) \{\n\s+liveCall\.say\(line\);/);
  // Dialling stands the official Codex Voice down first, so the agent can
  // never answer in its own voice while the digital human owns the line.
  assert.match(frontend, /if \(state\.directVoice\?\.voiceActive \|\| peer\) \{\n\s+await stopDirectVoice\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(frontend, /await invoke\("disarm_wake_listener"\)\.catch\(\(\) => \{\}\);/);
  assert.match(frontend, /await armWakeListener\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(frontend, /liveCall\?\.say\(vision === "on" \? "好，我看到你了。" : "好，我不看了。"\)/);
  assert.match(frontend, /async function endLiveCall\(reason = "user_end", announce = true\)/);
  assert.match(liveSource, /export type LiveStage =/);
});

test("the digital human carries Codex the orders and reads the answers back", () => {
  assert.match(frontend, /\/\*\* Spoken orders that stay local: the character keeps talking, the HUD acts\. \*\//);
  assert.match(frontend, /void runCommand\(text, false\);/);
  // One utterance settles into exactly one order: interim transcriptions are
  // debounced instead of starting an agent turn each.
  assert.match(frontend, /liveTranscribeBuffer = line;/);
  assert.match(frontend, /void deliverLiveUserText\(settled\);/);
  assert.match(liveSource, /content: `朗读：\$\{content\}`/);
  assert.match(liveRust, /只负责「出镜」和「传话」/);
  assert.match(liveRust, /用户说出的每一句话都是发给智能体的指令，不是对你说话/);
  assert.match(liveRust, /绝不抢答/);
  // The token budget is the platform maximum so no answer is ever cut short,
  // and the platform must not rewrite the "never speak first" persona behind
  // our back.
  assert.match(liveRust, /"temperature": 0\.2/);
  assert.match(liveRust, /"max_tokens": 65536/);
  assert.match(liveRust, /"persona_enhance": false/);
  // The platform's default opening line is replaced with the character's real
  // hello, so the call opens with one controlled greeting that is actually
  // spoken instead of a "stay silent" order the avatar used to ack aloud.
  assert.match(liveRust, /"greeting_instruction": format!\("接通后请微笑着说：\{\}", greeting_line\(avatar\)\)/);
  assert.match(liveRust, /"silence_duration_ms": 6000/);
});

test("a live call keeps the microphone and silences self-started answers", () => {
  // The wake listener stays disarmed for the whole call: any "unmute" would
  // open the input device mid-call and clip the digital human's voice.
  assert.match(backend, /static LIVE_CALL_ACTIVE: AtomicBool = AtomicBool::new\(false\)/);
  assert.match(backend, /&& !LIVE_CALL_ACTIVE\.load\(Ordering::SeqCst\)/);
  assert.match(backend, /microphone stays with the live call: wake listener stays disarmed/);
  assert.match(liveRust, /crate::set_live_call_active\(true\)/);
  assert.match(liveRust, /bill as the very last step of hanging up/);
  assert.match(liveRust, /crate::set_live_call_active\(false\);\n\s+result/);
  assert.match(frontend, /await invoke\("videolive_end"\)\.catch\(\(\) => \{\}\);/);
  // Her words join the echo log so they are never answered again when the
  // microphone hears them back. The app never cuts the digital human off on
  // its own: only the master's voice while a line is still on her lips is a
  // barge-in, and it hands the floor to the new order instead of resuming the
  // interrupted line.
  assert.match(liveSource, /private noteBotSpeech\(text: string\)/);
  assert.match(liveSource, /抢断台词，改听新指令/);
  assert.match(liveSource, /private handleBargeIn\(text: string\)/);
  assert.match(liveSource, /this\.readingUntil = sentAt \+ \(seconds \+ 0\.4\) \* 1000/);
  assert.match(liveSource, /this\.speechQueue\.length = 0/);
  assert.doesNotMatch(liveSource, /续念被打断的台词/);
});

test("the digital human arrives frame by frame instead of a green box", () => {
  // WebKit only decodes a video element that sits inside the viewport, so the
  // element is kept there at two pixels instead of being parked off-screen.
  assert.match(liveSource, /position:fixed;left:0;bottom:0;width:2px;height:2px/);
  assert.ok(!/left:-10000px/.test(liveSource));
  assert.ok(!/video\.style\.display = "none"/.test(liveSource));
  assert.match(liveSource, /this\.handlers\.onVideo\?\.\(\)/);
  assert.match(frontend, /onVideo: \(\) => \{/);
  // The picture is only allowed on the HUD once the keying has actually cleared
  // the edges of the frame: Vidu warms up on a studio set of its own, and a
  // frame that still has its backdrop is a video rectangle, not a character.
  assert.match(chromaSource, /export function readBackdropClearance\(/);
  assert.match(liveSource, /private checkBackdrop\(now: number\)/);
  assert.match(liveSource, /if \(clearance >= 0\.9\)/);
  assert.match(liveSource, /this\.handlers\.onVideoLost\?\.\(\)/);
  assert.match(frontend, /onVideoLost: \(\) => \{/);
  // ...and the hunt for a keyable backdrop keeps going while it is off screen,
  // while a healthy key is left alone so re-sampling cannot flicker the cut.
  assert.match(liveSource, /if \(this\.revealed && this\.keyer\.key\(\) && !this\.keyStale\) \{\n\s+return;/);
  assert.match(liveSource, /this\.keyStale = true;/);
  assert.match(liveSource, /背景漂移/);
  assert.match(liveSource, /"keyed" \| "rekeyed" \| "plain"/);
  assert.match(liveSource, /private ensureFrames\(\)/);
  // Hovering the character reveals the bar; leaving it hides the bar again
  // after a short grace period so the hang-up button stays reachable.
  assert.match(frontend, /function evaluateLiveChipHover\(\)/);
  assert.match(frontend, /inside\(rig\.getBoundingClientRect\(\), pointerX, pointerY\)/);
  assert.match(frontend, /CHIP_HOVER_GRACE_MS/);
  assert.match(frontend, /chip\.classList\.add\("is-hovered"\)/);
  assert.match(frontend, /chip\.classList\.remove\("is-hovered"\)/);
  assert.match(styleSheet, /\.live-chip\{position:absolute;left:50%;top:2%/);
  assert.match(styleSheet, /\.live-chip\.is-hovered\{opacity:1/);
});

test("an imported character stands on the desktop without Jarvis's armour", () => {
  // The gold particle silhouette is sampled from the built-in helmet. Behind an
  // imported portrait it reads as a leftover Jarvis ghost, so the field is off
  // for those characters — and off during a call, where it would sit behind the
  // digital human — while the transformation funnel still gets its sparks.
  assert.match(
    styleSheet,
    /\.shell\.custom-character:not\(\.is-transforming\):not\(\.is-reforming\) #particle-field,\s*\n\.shell\.is-live-call #particle-field\{display:none\}/,
  );
  assert.match(frontend, /shell\.classList\.toggle\("custom-character", !avatar\.isBuiltin\)/);
  assert.match(styleSheet, /\.shell\.is-transforming \.character-aura/);
});

test("hanging up clears the call bar and leaves the dialler", () => {
  // The teardown talks to the network, so the bar is taken down before it runs:
  // a "挂断中" chip must not be left on screen, let alone under the dialler.
  assert.match(frontend, /function updateLiveChip\(stage: LiveStage, detail\?: string\)/);
  assert.match(frontend, /if \(stage === "idle" \|\| stage === "ending"\) \{/);
  assert.match(frontend, /chip\.hidden = true;[\s\S]{0,120}window\.clearInterval\(liveTimer\)/);
  assert.match(styleSheet, /\.live-chip\[hidden\],\.call-chip\[hidden\]\{display:none\}/);
  // The dialler and the call bar share the same spot and never overlap.
  assert.match(frontend, /if \(show\) \{\s*\n\s*live\.hidden = true;/);
  assert.match(frontend, /showCallChip\(false\);/);
  assert.match(frontend, /if \(canDial\(active\)\) showCallChip\(true\)/);
});

test("the camera only opens on a spoken order", () => {
  assert.match(visionSource, /pub fn reset_at_launch\(\)/);
  assert.match(visionSource, /pub fn session_enabled\(\) -> bool/);
  assert.match(backend, /vision::reset_at_launch\(\);/);
  assert.match(backend, /if vision::session_enabled\(\) \{/);
  assert.ok(!/else if vision::configured_enabled\(\)/.test(backend));
});

test("a wake phrase carries the character's name", () => {
  // "嗨 <名字>" is assembled from the store, not written into the listener.
  assert.match(wakeHelper, /private var characterPhrases: \[String\] = \[\]/);
  assert.match(wakeHelper, /private var phrases: \[String\] \{ builtinPhrases \+ characterPhrases \}/);
  assert.match(wakeHelper, /refreshCharactersIfNeeded\(force: true\)/);
  assert.match(wakeHelper, /let namesFile: URL\?|private var namesFile: URL\?/);
  assert.match(wakeHelper, /wake\["avatar"\] = named\.avatar/);
  // The wake-only listener is gone before the app is up, so the name is left
  // on disk for the launch that follows.
  assert.match(wakeHelper, /recordLastWake\(avatar:/);
  assert.match(backend, /command\.arg\("--names-file"\)\.arg\(store\)/);
  assert.match(backend, /fn take_last_wake\(\) -> Option<\(String, String\)>/);
  assert.match(backend, /wake\["avatar"\] = json!\(avatar\)/);
});

test("a character is dialled by click, by name, or by her own wake phrase", () => {
  assert.match(liveCommand, /export function matchCallCommand\(text: string, avatars: AvatarName\[]\)/);
  assert.match(frontend, /const called = matchCallCommand\(text, avatars\)/);
  assert.match(frontend, /async function dialCharacter\(id: string, greet = false\)/);
  assert.match(frontend, /rig\.addEventListener\("click"/);
  assert.match(frontend, /Waking is never a dial/);
  assert.match(frontend, /if \(target\.id !== activeAvatar\) await applyAvatar\(target\.id, true, false\)/);
  assert.ok(!/wakeDialTarget/.test(frontend));
  // Dialling has its own look while the line is opened.
  assert.match(styleSheet, /\.shell\.is-dialing \.character-rig:after\{/);
  assert.match(frontend, /shell\.classList\.toggle\("is-dialing", dialing\)/);
});

test("the scene machine plays greet, wait and static videos, never patch layers", () => {
  // Scene videos are fetched from the local avatar store and played back
  // through the same chroma keyer the live call uses.
  assert.match(frontend, /invoke<string \| null>\(\"avatar_scene_video\", \{/);
  assert.match(frontend, /invoke\(\"generate_scene_video\", \{ id: avatar\.id, scene: \"greet\" \}\)/);
  assert.match(frontend, /invoke\(\"generate_scene_video\", \{ id: avatar\.id, scene: \"wait\" \}\)/);
  assert.match(frontend, /new ScenePlayer\(sceneCanvas/);
  assert.match(idleSource, /export class ScenePlayer/);
  assert.match(idleSource, /setScenes\(avatarId: string, scenes: SceneSources\)/);
  assert.match(idleSource, /playScene\(scene: Scene\)/);
  assert.match(idleSource, /createVideoKeyer\(canvas\)/);
  assert.match(idleSource, /readBackdropClearance\(/);
  assert.match(idleSource, /REVEAL_CLEARANCE = 0\.85/);
  // Only a frame whose backdrop is actually gone takes the stage; a drifted
  // backdrop sends the picture back to the still and re-samples.
  assert.match(idleSource, /this\.revealed = true/);
  assert.match(idleSource, /this\.keyer\.setKey\(null\)/);
  assert.match(styleSheet, /\.scene-video\{position:absolute/);
  assert.match(styleSheet, /\.shell\.video-live \.scene-video,[\s\S]{0,160}display:none\}/);
  // Vidu is not involved at playback time: each scene is a data URL from disk.
  assert.match(avatarsRust, /data:video\/mp4/);
  assert.match(avatarsRust, /pub async fn generate_scene_video/);
  assert.match(avatarsRust, /pub fn avatar_scene_video/);
  assert.match(avatarsRust, /img2video\(/);
  assert.match(vidu, /pub fn img2video\(/);
  // Scene 1 greets once on the first visible screen, scene 2 waits while a
  // question is in the air, scene 3 is the still portrait.
  assert.match(avatarsRust, /"greet" => \("greet", GREET_PROMPT, 5u64\)/);
  assert.match(avatarsRust, /"wait" => \("wait", WAIT_PROMPT, 6u64\)/);
  assert.match(frontend, /function desiredScene\(\): Scene \{/);
  assert.match(frontend, /if \(QUESTION_MODES\.has\(state\.mode\)\) return sceneSources\.wait/);
  assert.match(frontend, /if \(!greetPlayed && windowShown\) return sceneSources\.greet/);
  assert.match(frontend, /startup_is_background/);
  assert.match(frontend, /onFocusChanged\(\(\{ payload: focused \}\)/);
  assert.match(idleSource, /video\.loop = scene === \"wait\"/);
  assert.match(idleSource, /"ended"/);
  // The old patch layers are gone for good: no face canvas, no mouth or eye
  // patches, no geometry probes.
  assert.doesNotMatch(frontend, /face-canvas|faceAnimator|refreshFace|avatar_face/);
  assert.doesNotMatch(styleSheet, /\.face-canvas/);
  assert.doesNotMatch(avatarsRust, /pub async fn avatar_face/);
  assert.doesNotMatch(matteRust, /pub fn face_geometry/);
});

test("the credit balance sits next to the button that spends it", () => {
  assert.match(frontend, /const creditsInfo = snapshot\.vidu\?\.configured/);
  assert.match(frontend, /\$\{remaining\} 个\$\{money\}/);
  assert.match(frontend, /剩余 \$\{creditRemain\} 积分/);
});

test("call orders dial the named character and nothing else", async () => {
  const { matchCallCommand } = await import("../src/live-command.ts");
  const cast = [
    { id: "jarvis", name: "Jarvis" },
    { id: "zym", name: "张元英" },
    { id: "xm", name: "小美" },
    { id: "xrr", name: "小肉肉" },
  ];
  assert.equal(matchCallCommand("呼叫张元英", cast), "zym");
  assert.equal(matchCallCommand("拨打张元英", cast), "zym");
  assert.equal(matchCallCommand("给张元英打电话", cast), "zym");
  assert.equal(matchCallCommand("叫张元英", cast), "zym");
  assert.equal(matchCallCommand("呼叫 元英", cast), null, "a wrong name is not a call");
  assert.equal(matchCallCommand("叫张元英写一首诗", cast), null, "tasks stay tasks");
  assert.equal(matchCallCommand("帮我查一下呼叫记录里有多少条", cast), null);
  assert.equal(matchCallCommand("打开视频", cast), null, "that is the video switch");
  assert.equal(matchCallCommand("呼叫小肉肉", cast), "xrr");
  // On-device recognition can settle one syllable early: the same order must
  // still dial when the transcript arrives as "呼叫小肉".
  assert.equal(matchCallCommand("呼叫小肉", cast), "xrr", "a syllable-late transcript still dials");
  assert.equal(matchCallCommand("叫张", cast), null, "one character is not a name");
  assert.equal(matchCallCommand("呼叫小", cast), null, "one character is not a name");
});

test("scene videos stand down for calls and transformations", () => {
  // One moving picture at a time: scene videos pause and hide while Vidu's
  // own picture is on stage, the ringer is dialing, or the particle tornado
  // is swapping characters.
  assert.match(idleSource, /"video-live"/);
  assert.match(idleSource, /"is-dialing"/);
  assert.match(idleSource, /"is-transforming"/);
  assert.match(idleSource, /"is-reforming"/);
  assert.match(frontend, /function updateScenePlayback\(\)/);
  assert.match(frontend, /shell\.classList\.contains\("video-live"\)/);
  assert.match(frontend, /scenePlayer\.setVisible\(scene !== \"static\"\)/);
  // The still portrait is only a fallback now: it steps aside when a keyed
  // frame takes the stage and comes back if the backdrop refuses to key.
  assert.match(frontend, /onRevealed: \(\) => \{/);
  assert.match(frontend, /onHidden: \(\) => \{/);
  assert.match(frontend, /characterImage\.hidden = true/);
  assert.match(frontend, /characterImage\.hidden = false/);
});
