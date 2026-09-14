import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./style.css";
import { matchShutdownCommand } from "./shutdown-command";
import { VOICE_PACK_SPEECH, matchVoicePackCommand } from "./voice-pack-command";
import { matchAvatarCommand, type AvatarName } from "./avatar-command";
import { matchVisionCommand } from "./vision-command";
import { matchCallCommand, matchLiveCommand } from "./live-command";
import { LiveCall, type LiveStage } from "./live";
import { cutPortraitBackground } from "./chroma";
import { IdlePlayer } from "./idle";

type Mode = "booting" | "ready" | "voice-starting" | "listening" | "working" | "speaking" | "degraded" | "stopped";
type Message = { id?: number | string; method?: string; params?: any };
type Session = { threadId: string; cwd: string };
type DirectVoice = {
  codexConnected: boolean;
  voiceActive: boolean;
  phase: string;
  protocol: string;
  threadId?: string;
  realtimeSessionId?: string;
};
type WakeStatus = {
  enabled: boolean;
  ready: boolean;
  authorization: string;
};
type WakeEvent = {
  ok: boolean;
  error?: string;
  cold?: boolean;
  /** The character whose name was in the wake phrase ("嗨张元英"). */
  avatar?: string;
  name?: string;
};
type PermissionMode = "safe" | "auto" | "full";
type AvatarInfo = AvatarName & {
  voicePack: string;
  voiceLabel: string;
  persona: string;
  hasPortrait: boolean;
  hasImage: boolean;
  isBuiltin: boolean;
  greeting: string;
  liveVoice: string;
  liveVoiceLabel: string;
  hasGreenPortrait: boolean;
  /** A pre-rendered idle animation video is ready to play locally. */
  hasIdleVideo: boolean;
};
type AvatarSnapshot = {
  activeId: string;
  limit: number;
  avatars: AvatarInfo[];
  vidu: { configured: boolean; creditRemain: number | null; concurrencyLimit?: number | null; error?: string };
};
type VisionSignal = {
  faces?: number;
  emotion?: string;
  confidence?: number;
  distance?: number;
};
type VisionStatus = {
  enabled: boolean;
  running: boolean;
  preferred: boolean;
  error?: string | null;
};

const state = {
  mode: "booting" as Mode,
  session: null as Session | null,
  directVoice: null as DirectVoice | null,
  wake: null as WakeStatus | null,
  level: 0,
  manualStop: false,
  agentWorking: false,
};

const WORKSPACE_KEY = "jarvis.workspace";
const THREAD_KEY_PREFIX = "jarvis.threadId:";
const PERMISSION_KEY = "jarvis.permissionMode";
const permissionLabels: Record<PermissionMode, string> = {
  safe: "安全模式 · 需要时确认",
  auto: "自动办公 · 当前目录自主执行",
  full: "完全访问 · 高风险",
};
function storedPermissionMode(): PermissionMode {
  const value = localStorage.getItem(PERMISSION_KEY);
  return value === "safe" || value === "full" ? value : "auto";
}
let workspace = "";
let permissionMode = storedPermissionMode();
const savedThreadId = () => localStorage.getItem(`${THREAD_KEY_PREFIX}${workspace}`);
let peer: RTCPeerConnection | null = null;
let microphoneStream: MediaStream | null = null;
let remoteStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let microphoneAnalyser: AnalyserNode | null = null;
let remoteAnalyser: AnalyserNode | null = null;
let userTranscriptBuffer = "";
let assistantTranscriptBuffer = "";
let agentMessageBuffer = "";
let voiceStartInFlight = false;
let recoverableColdStartError = false;
let textOnlyMode = false;
let speakReplies = false;
type VoicePackInfo = { id: string; label: string; online: boolean; active: boolean };
let voicePack = "jarvis";
const voiceAudio = new Audio();
voiceAudio.autoplay = true;
const previewParams = new URLSearchParams(window.location.search);
const tauriInternals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
const currentWindow = typeof tauriInternals?.invoke === "function" ? getCurrentWindow() : null;
const previewModeValue = previewParams.get("preview");
const previewActionValue = previewParams.get("action");
const visualPreviewMode: Mode = ["booting", "ready", "voice-starting", "listening", "working", "speaking", "degraded", "stopped"].includes(previewModeValue ?? "")
  ? previewModeValue as Mode
  : "ready";
if (!currentWindow) {
  document.documentElement.classList.add("visual-preview");
  if (previewParams.get("grid") === "1") document.documentElement.classList.add("transparency-grid");
}
if (currentWindow) {
  void currentWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    setCameraLoop(false);
    void invoke("camera_active", { active: false }).catch(() => {});
    await currentWindow.hide();
  });
}

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
<main class="shell" data-mode="booting">
  <canvas id="particle-field" width="1440" height="900" aria-hidden="true"></canvas>
  <header class="topbar hud-panel">
    <div class="brand"><i></i><strong id="brand-name">JARVIS</strong><span></span><em>CODEX VOICE SYSTEM</em></div>
    <div class="status"><i></i><b id="mode-label">INITIALIZING</b></div>
    <button id="settings" class="icon-button" aria-label="设置">⌘</button>
  </header>
  <section class="stage">
    <div class="avatar-window">
      <div class="character-aura"></div>
      <div class="character-rig">
        <div class="assembly-orbits" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="armor-shards" aria-hidden="true"></div>
        <img id="jarvis-character" class="helmet-character" src="/assets/jarvis-character-v2.png" alt="Jarvis holographic helmet">
        <canvas id="idle-character" class="idle-character" hidden aria-hidden="true"></canvas>
        <canvas id="live-character" class="live-character" hidden aria-hidden="true"></canvas>
        <div class="helmet-scan"><i></i></div>
        <div class="assembly-flash" aria-hidden="true"></div>
      </div>
      <canvas id="wave" width="900" height="120"></canvas>
      <div id="live-chip" class="live-chip" hidden>
        <i></i><b>实时对话</b><span id="live-timer">00:00</span>
        <span id="live-note">正在连接…</span>
        <button id="live-hangup" type="button">挂断</button>
      </div>
      <div id="call-chip" class="call-chip" hidden>
        <span id="call-name">呼叫</span>
        <button id="call-start" type="button">拨通</button>
      </div>
    </div>
    <figure class="self-view" id="self-view" hidden>
      <img id="self-view-image" alt="摄像头中的你">
      <figcaption><b id="mood-label">视觉感知中</b><small id="mood-detail">等待摄像头…</small></figcaption>
    </figure>
    <div class="identity"><span id="identity-role">JARVIS CORE</span><b id="identity-state">SYSTEM BOOT</b></div>
  </section>
  <aside class="workers">
    <article class="worker active" data-role="orchestrator"><span>›_</span><div><b>Codex</b><small>Connecting</small></div><i></i></article>
    <article class="worker" data-role="developer"><span>⌬</span><div><b>Developer</b><small>Standby</small></div><i></i></article>
    <article class="worker" data-role="researcher"><span>⌕</span><div><b>Researcher</b><small>Standby</small></div><i></i></article>
    <article class="worker" data-role="reviewer"><span>✓</span><div><b>Reviewer</b><small>Standby</small></div><i></i></article>
  </aside>
  <section class="dialogue hud-panel">
    <b>YOU</b><p id="user-transcript">“嗨，Jarvis”</p>
    <b class="jarvis" id="speaker-label">JARVIS</b><p id="assistant-transcript">正在连接 Codex 原生任务线程…</p>
  </section>
  <footer class="controls">
    <button id="mic" class="control mic"><span aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="8.25" y="3" width="7.5" height="11.5" rx="3.75"></rect><path d="M5.5 11.25v.75a6.5 6.5 0 0 0 13 0v-.75M12 18.5V22M8.75 22h6.5"></path></svg></span><b>CODEX VOICE</b><small>V3 WEBRTC · DIRECT</small></button>
    <form id="command-form" class="command"><input id="command-input" aria-label="文字指令" placeholder="Voice 不可用时，发送本地 Codex 文字任务…" autocomplete="off"><button>EXECUTE</button></form>
    <button id="stop" class="control stop"><span aria-hidden="true"><svg viewBox="0 0 24 24"><rect class="stop-mark" x="6.5" y="6.5" width="11" height="11" rx="1.8"></rect></svg></span><b>STOP</b><small>INTERRUPT ALL</small></button>
  </footer>
  <div id="degraded-banner" class="degraded-banner" hidden><b>JARVIS NEEDS PERMISSION</b><span id="degraded-copy">首次使用请允许麦克风和语音识别。</span></div>
  <dialog id="approval"><h2>高风险操作确认</h2><p id="approval-copy">Codex 请求执行需要确认的动作。</p><div><button id="deny">拒绝</button><button id="approve">允许一次</button></div></dialog>
  <dialog id="settings-dialog"><h2>JARVIS SYSTEM</h2><dl><dt>Wake phrase</dt><dd>嗨 Jarvis / Hey Jarvis</dd><dt>Wake listener</dt><dd id="wake-auth">检测中</dd><dt>Codex thread</dt><dd id="thread-id">—</dd><dt>Workspace</dt><dd id="workspace">—</dd><dt>Permission</dt><dd id="permission-mode-label">—</dd><dt>Voice kernel</dt><dd id="voice-auth">检测中</dd></dl><label class="workspace-setting">工作目录<input id="workspace-setting" autocomplete="off" spellcheck="false"></label><fieldset class="avatar-setting"><legend>人物形象 · 新建与切换</legend><div id="avatar-list" class="avatar-list"><p class="voice-loading">加载中…</p></div><p class="voice-hint">每个形象自带人设与固定的语音包；说一句“切换成 &lt;名字&gt;”就能直接变身。</p><details class="avatar-create"><summary>＋ 新建形象（最多 10 个）</summary><label>名字<input id="avatar-name" maxlength="12" placeholder="例如：小美 / 钢铁管家"></label><label>人设<textarea id="avatar-persona" rows="3" placeholder="她是主人的贴身小助手，说话软软的、爱撒娇…"></textarea></label><label>形象描述<textarea id="avatar-prompt" rows="3" placeholder="银发蓝眼的少女，白色科技感制服，微笑看向镜头…"></textarea></label><label>语音包<select id="avatar-voice"></select></label><div class="avatar-create-actions"><span id="avatar-progress"></span><button type="button" id="avatar-create">用 Vidu 生成形象</button></div>
<div class="avatar-import"><label>本地图片<input type="file" id="avatar-file" accept="image/png,image/jpeg,image/webp"></label><button type="button" id="avatar-import">导入图片并抠图</button></div>
<p class="voice-hint">导入的图片会自动用 macOS 视觉能力抠出人物主体：只保留人物、去掉背景；需要实时视频对话时，同一个形象会自动生成绿幕版本。</p></details><label class="camera-setting"><input type="checkbox" id="camera-toggle"><span><b>视觉感知（默认关闭）</b><small>说“启动视频组件”或“你能看到我吗”就会打开摄像头；说“别看我了”就关闭。画面只在本机处理。</small></span></label><p class="vidu-status" id="vision-status" hidden></p><p class="vidu-status" id="vidu-status">Vidu：检查中…</p></fieldset><fieldset class="voice-setting"><legend>语音包 · 当前形象的音色</legend><div id="voice-packs" class="voice-packs"><p class="voice-loading">加载中…</p></div><p class="voice-hint">语音包使用免费的微软 Edge 神经语音在线合成（首次播放需联网，之后自动缓存到本机）；断网或合成失败时自动退回本机“婷婷”朗读。这里改的是<b>当前形象</b>的音色，形象会一直记住它。</p></fieldset><fieldset class="permission-setting"><legend>Codex 操作权限</legend><label><input type="radio" name="permission-mode" value="safe"><span><b>安全模式</b><small>超出当前目录或高风险操作时询问</small></span></label><label class="recommended"><input type="radio" name="permission-mode" value="auto"><span><b>自动办公</b><small>当前目录内自主执行，越界操作直接阻止</small></span><em>推荐</em></label><label class="danger"><input type="radio" name="permission-mode" value="full"><span><b>完全访问</b><small>不限制目录且不询问，请谨慎使用</small></span></label></fieldset><p>权限切换会停止当前任务并重建 Codex 运行时，但会继续使用当前工作目录保存的 thread。</p><p>修改工作目录后，下次重启 Jarvis 生效。每个工作目录会续接自己的 Codex thread。</p><p>“新开线程”会结束当前任务并创建一个全新的 Codex thread；原线程仍保留在 Codex 历史记录中。</p><p>唤醒词在本机识别；Jarvis 页面通过 Codex app-server V3 WebRTC 进入官方 Voice 线程。认证复用本机 Codex 登录，不读取凭据、不模拟点击，也不建立第二套 GPT-Live。</p><div class="settings-actions"><button id="new-thread" class="new-thread">＋ 新开线程</button><span></span><button id="save-settings">保存</button><button id="close-settings">关闭</button></div></dialog>
</main>`;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const shell = $<HTMLElement>(".shell");
const transcript = $("#user-transcript");
const response = $("#assistant-transcript");
const banner = $("#degraded-banner") as HTMLDivElement;
const mic = $("#mic") as HTMLButtonElement;
const approval = $("#approval") as HTMLDialogElement;
const settings = $("#settings-dialog") as HTMLDialogElement;
const characterRig = $<HTMLElement>(".character-rig");
const hoverControls = $<HTMLElement>(".controls");
const settingsButton = $<HTMLButtonElement>("#settings");
let controlsHideTimer: number | undefined;
let characterActionTimer: number | undefined;

function revealControls() {
  if (controlsHideTimer !== undefined) window.clearTimeout(controlsHideTimer);
  shell.classList.add("controls-visible");
}

function scheduleControlsHide() {
  if (controlsHideTimer !== undefined) window.clearTimeout(controlsHideTimer);
  controlsHideTimer = window.setTimeout(() => shell.classList.remove("controls-visible"), 1500);
}

type CharacterAction = "acknowledge" | "approval" | "complete" | "error";

function triggerCharacterAction(action: CharacterAction, duration = 1100) {
  if (characterActionTimer !== undefined) window.clearTimeout(characterActionTimer);
  for (const name of ["acknowledge", "approval", "complete", "error"] as const) {
    shell.classList.remove(`action-${name}`);
  }
  void shell.clientWidth;
  shell.classList.add(`action-${action}`);
  characterActionTimer = window.setTimeout(() => shell.classList.remove(`action-${action}`), duration);
}

for (const area of [characterRig, hoverControls, settingsButton]) {
  area.addEventListener("pointerenter", revealControls);
  area.addEventListener("pointerleave", scheduleControlsHide);
}
shell.addEventListener("focusin", (event) => {
  if (event.target instanceof Element && (hoverControls.contains(event.target) || settingsButton.contains(event.target))) revealControls();
});
shell.addEventListener("focusout", scheduleControlsHide);

let approvalId: number | string | undefined;
const copy: Record<Mode, [string, string]> = {
  booting: ["INITIALIZING", "SYSTEM BOOT"], ready: ["READY", "CODEX VOICE STANDBY"],
  "voice-starting": ["VOICE LINKING", "OPENING CODEX VOICE"], listening: ["LISTENING", "OFFICIAL VOICE ONLINE"],
  working: ["CODEX WORKING", "TASK EXECUTION"], speaking: ["JARVIS SPEAKING", "VOICE OUTPUT"],
  degraded: ["PERMISSION NEEDED", "WAKE SYSTEM OFFLINE"], stopped: ["INTERRUPTED", "ALL SYSTEMS HALTED"],
};

/// The armour assembly is a class, not a mode: the boot sequence and the
/// Voice handshake both need it, and text mode must not lose it.
let formationAnimationTimer = 0;

function playFormation() {
  shell.classList.remove("is-forming");
  void shell.clientWidth;
  shell.classList.add("is-forming");
  // Drop the class once the armour is assembled: while it is set the CSS
  // animation owns the transform, which would freeze the voice pulse.
  window.clearTimeout(formationAnimationTimer);
  formationAnimationTimer = window.setTimeout(
    () => shell.classList.remove("is-forming"),
    FORMATION_DURATION + 160,
  );
  startParticleFormation();
}
function setMode(mode: Mode) {
  noteActivity();
  state.mode = mode; shell.setAttribute("data-mode", mode);
  $("#mode-label").textContent = copy[mode][0]; $("#identity-state").textContent = copy[mode][1];
  if (mode === "voice-starting" || mode === "booting") playFormation();
}
function setWorker(role: string, label: string, active = true) {
  const card = document.querySelector<HTMLElement>(`.worker[data-role="${role}"]`);
  if (!card) return;
  card.classList.toggle("active", active); card.querySelector("small")!.textContent = label;
}
function roleOf(params: any) {
  const text = JSON.stringify(params ?? {}).toLowerCase();
  return text.includes("research") ? "researcher" : text.includes("review") ? "reviewer" :
    text.includes("developer") || text.includes("commandexecution") || text.includes("filechange") ? "developer" : "orchestrator";
}
/// The wave used to carry `shadowBlur = 15`: a per-frame gaussian blur over a
/// path as wide as the stage. Two strokes (wide + faint, narrow + bright) look
/// the same and cost a fraction of it.
/// The transparent surface hides #wave outright, so painting it every frame
/// was pure work: the element and its context are looked up once and the whole
/// pass is skipped while it has no boxes to fill.
let waveTarget: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | null | undefined;

function wavePainter() {
  if (waveTarget === undefined) {
    const canvas = $("#wave") as HTMLCanvasElement | null;
    waveTarget = canvas && canvas.getClientRects().length
      ? { canvas, context: canvas.getContext("2d")! }
      : null;
  }
  return waveTarget;
}

function drawWaveFrame() {
  const painter = wavePainter();
  if (!painter) return;
  const canvas = painter.canvas, context = painter.context;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const time = performance.now() / 370, amplitude = 5 + state.level * 42 + (state.mode === "speaking" ? 22 : 0);
  context.beginPath();
  for (let x = 0; x <= canvas.width; x += 3) {
    const y = canvas.height / 2 + (Math.sin(x * .085 + time * 2.2) + Math.sin(x * .031 - time) * .55) * amplitude * Math.sin(x / canvas.width * Math.PI) * .48;
    x ? context.lineTo(x, y) : context.moveTo(x, y);
  }
  const accent = state.mode === "working" ? "#ff9d2e" : state.mode === "stopped" ? "#ff3d33" : "#22c7ff";
  context.lineWidth = 5;
  context.strokeStyle = state.mode === "working" ? "rgba(255,157,46,.18)" : state.mode === "stopped" ? "rgba(255,61,51,.18)" : "rgba(34,199,255,.18)";
  context.stroke();
  context.lineWidth = 1.8;
  context.strokeStyle = accent;
  context.stroke();
}

type VisualParticle = {
  fromX: number;
  fromY: number;
  targetX: number;
  targetY: number;
  size: number;
  phase: number;
  delay: number;
  curve: number;
  amber: boolean;
  vortexAngle: number;
  vortexRadius: number;
  vortexRise: number;
};

const particleCanvas = $("#particle-field") as HTMLCanvasElement;
const particleContext = particleCanvas.getContext("2d")!;
const characterImage = $("#jarvis-character") as HTMLImageElement;

/// Every particle is a soft dot, so one pre-rendered sprite can be stamped with
/// `drawImage` instead of building a gradient-free `arc` + `fill` path per
/// particle per frame (thousands of paths at 60fps is what pinned WebKit's GPU
/// process at ~135% CPU and starved `afplay` into stuttering).
const particleSprites = new Map<string, HTMLCanvasElement>();
function particleSprite(rgb: string) {
  const cached = particleSprites.get(rgb);
  if (cached) return cached;
  const sprite = document.createElement("canvas");
  sprite.width = 32;
  sprite.height = 32;
  const context = sprite.getContext("2d")!;
  const glow = context.createRadialGradient(16, 16, 0, 16, 16, 16);
  glow.addColorStop(0, `rgba(${rgb},1)`);
  glow.addColorStop(.45, `rgba(${rgb},.42)`);
  glow.addColorStop(1, `rgba(${rgb},0)`);
  context.fillStyle = glow;
  context.fillRect(0, 0, 32, 32);
  particleSprites.set(rgb, sprite);
  return sprite;
}
const armorShardLayer = $<HTMLElement>(".armor-shards");
const armorShardSpecs = [
  ["polygon(35% 4%,65% 4%,63% 23%,37% 23%)", 0, -390, -8, 80],
  ["polygon(17% 9%,37% 4%,38% 31%,22% 35%)", -430, -280, -24, 0],
  ["polygon(63% 4%,83% 9%,78% 35%,62% 31%)", 430, -280, 24, 20],
  ["polygon(37% 22%,63% 22%,61% 45%,39% 45%)", 30, -320, 10, 170],
  ["polygon(20% 31%,39% 27%,43% 48%,19% 49%)", -470, -120, -32, 100],
  ["polygon(61% 27%,80% 31%,81% 49%,57% 48%)", 470, -120, 32, 120],
  ["polygon(16% 45%,43% 44%,46% 57%,20% 59%)", -520, -20, -18, 220],
  ["polygon(57% 44%,84% 45%,80% 59%,54% 57%)", 520, -20, 18, 240],
  ["polygon(42% 43%,58% 43%,59% 70%,41% 70%)", 0, 390, -10, 300],
  ["polygon(19% 56%,42% 54%,41% 73%,24% 78%)", -480, 180, -28, 280],
  ["polygon(58% 54%,81% 56%,76% 78%,59% 73%)", 480, 180, 28, 300],
  ["polygon(24% 73%,42% 68%,45% 84%,31% 88%)", -340, 330, 22, 390],
  ["polygon(58% 68%,76% 73%,69% 88%,55% 84%)", 340, 330, -22, 410],
  ["polygon(41% 68%,59% 68%,56% 88%,44% 88%)", 40, 430, 14, 470],
  ["polygon(31% 85%,45% 82%,44% 96%,36% 94%)", -250, 460, -30, 500],
  ["polygon(55% 82%,69% 85%,64% 94%,56% 96%)", 250, 460, 30, 520],
  ["polygon(43% 86%,57% 86%,56% 98%,44% 98%)", 0, 520, -12, 560],
  ["polygon(12% 25%,24% 19%,22% 45%,14% 52%)", -560, -210, -38, 180],
  ["polygon(76% 19%,88% 25%,86% 52%,78% 45%)", 560, -210, 38, 200],
] as const;

for (const [clip, translateX, translateY, rotation, delay] of armorShardSpecs) {
  const shard = document.createElement("i");
  shard.className = "armor-shard";
  shard.style.setProperty("--shard-clip", clip);
  shard.style.setProperty("--shard-x", `${translateX}px`);
  shard.style.setProperty("--shard-y", `${translateY}px`);
  shard.style.setProperty("--shard-rotation", `${rotation}deg`);
  shard.style.setProperty("--shard-delay", `${delay}ms`);
  if (Math.abs(rotation) >= 28 || delay % 3 === 0) shard.classList.add("amber-edge");
  armorShardLayer.append(shard);
}

let visualParticles: VisualParticle[] = [];
let formationStartedAt = -10_000;
let particleTargetBounds = { left: 0, top: 0, width: 1, height: 1 };
const FORMATION_DURATION = 3200;
/// The character transform re-forms the silhouette faster than a cold boot:
/// long enough to read as a tornado, short enough not to feel like a stall.
const TRANSFORM_DURATION = 2600;
const TRANSFORM_FUNNEL = 1150;
/// While set, the particle field draws a spinning funnel instead of the
/// character silhouette.
let tornadoUntil = -1;
let tornadoStartedAt = -1;
let tornadoTotal = TRANSFORM_FUNNEL;
let formationDuration = FORMATION_DURATION;

/** Where a particle sits inside the tornado: a tapered, spinning funnel. */
function funnelPoint(particle: VisualParticle, spin: number, progress: number, out: { x: number; y: number }) {
  const centreX = particleTargetBounds.left + particleTargetBounds.width / 2;
  const baseY = particleTargetBounds.top + particleTargetBounds.height * .96;
  const height = Math.max(120, particleTargetBounds.height);
  const angle = particle.vortexAngle + spin;
  const taper = 1 - particle.vortexRise * .74;
  const radius = particleTargetBounds.width * particle.vortexRadius * taper * (.5 + progress * .85);
  out.x = centreX + Math.cos(angle) * radius;
  out.y = baseY - particle.vortexRise * height * (.34 + progress * .84) - 18 * progress;
  return out;
}

const funnelScratch = { x: 0, y: 0 };
const funnelScratchPrevious = { x: 0, y: 0 };

function scatterParticleIntoFunnel(particle: VisualParticle) {
  funnelPoint(particle, 0, 1, funnelScratch);
  particle.fromX = funnelScratch.x;
  particle.fromY = funnelScratch.y;
}

function scatterParticleFromWindowEdge(particle: VisualParticle) {
  const edge = Math.floor(Math.random() * 4);
  const inset = Math.random() * 24;
  if (edge === 0) {
    particle.fromX = inset;
    particle.fromY = Math.random() * particleCanvas.height;
  } else if (edge === 1) {
    particle.fromX = particleCanvas.width - inset;
    particle.fromY = Math.random() * particleCanvas.height;
  } else {
    particle.fromX = Math.random() * particleCanvas.width;
    particle.fromY = edge === 2 ? inset : particleCanvas.height - inset;
  }
}

function syncParticleCanvasSize() {
  const bounds = shell.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  if (particleCanvas.width !== width) particleCanvas.width = width;
  if (particleCanvas.height !== height) particleCanvas.height = height;
}

/// Layout box of the character, ignoring CSS transforms. `getBoundingClientRect`
/// reports the animated box, which would smear the sampled silhouette while the
/// transform animation is running.
function characterLayoutBox() {
  const parent = (characterImage.offsetParent as HTMLElement | null) ?? shell;
  const parentRect = parent.getBoundingClientRect();
  return {
    left: parentRect.left + characterImage.offsetLeft,
    top: parentRect.top + characterImage.offsetTop,
    width: characterImage.offsetWidth || characterImage.naturalWidth,
    height: characterImage.offsetHeight || characterImage.naturalHeight,
  };
}

function prepareVisualParticles(useLayoutBox = false) {
  if (!characterImage.naturalWidth) return;
  syncParticleCanvasSize();
  const sample = document.createElement("canvas");
  sample.width = particleCanvas.width;
  sample.height = particleCanvas.height;
  const context = sample.getContext("2d", { willReadFrequently: true })!;
  const shellBounds = shell.getBoundingClientRect();
  const characterBounds = useLayoutBox ? characterLayoutBox() : characterImage.getBoundingClientRect();
  const left = characterBounds.left - shellBounds.left;
  const top = characterBounds.top - shellBounds.top;
  particleTargetBounds = { left, top, width: characterBounds.width, height: characterBounds.height };
  context.drawImage(characterImage, left, top, characterBounds.width, characterBounds.height);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  visualParticles = [];
  for (let y = 0; y < sample.height; y += 7) {
    for (let x = 0; x < sample.width; x += 7) {
      const alpha = pixels[(y * sample.width + x) * 4 + 3];
      if (alpha < 46 || Math.random() > .82) continue;
      const particle: VisualParticle = {
        fromX: 0,
        fromY: 0,
        targetX: x + (Math.random() - .5) * 5,
        targetY: y + (Math.random() - .5) * 5,
        size: Math.random() > .965 ? 2.6 + Math.random() * 1.8 : .45 + Math.random() * 1.65,
        phase: Math.random() * Math.PI * 2,
        delay: Math.random() * .3,
        curve: (Math.random() - .5) * (90 + Math.random() * 190),
        amber: Math.random() < .16,
        vortexAngle: Math.random() * Math.PI * 2,
        vortexRadius: .10 + Math.random() * .26,
        vortexRise: Math.random(),
      };
      scatterParticleFromWindowEdge(particle);
      visualParticles.push(particle);
    }
  }
}

let waitingForCharacter = false;

function startParticleFormation(fromFunnel = false, duration = FORMATION_DURATION) {
  if (!visualParticles.length) prepareVisualParticles();
  if (!visualParticles.length) {
    // A cold launch reaches the boot animation before the character bitmap is
    // decoded, so replay it as soon as the particles can be sampled.
    if (!waitingForCharacter) {
      waitingForCharacter = true;
      characterImage.addEventListener("load", () => {
        waitingForCharacter = false;
        if (shell.classList.contains("is-forming")) startParticleFormation();
      }, { once: true });
    }
    return;
  }
  formationDuration = duration;
  formationStartedAt = performance.now();
  for (const particle of visualParticles) {
    if (fromFunnel) scatterParticleIntoFunnel(particle);
    else scatterParticleFromWindowEdge(particle);
  }
}

function easeFormation(value: number) {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function particlePosition(particle: VisualParticle, progress: number) {
  const eased = easeFormation(progress);
  const deltaX = particle.targetX - particle.fromX;
  const deltaY = particle.targetY - particle.fromY;
  const distance = Math.max(1, Math.hypot(deltaX, deltaY));
  const bend = Math.sin(eased * Math.PI) * particle.curve;
  return {
    x: particle.fromX + deltaX * eased - deltaY / distance * bend,
    y: particle.fromY + deltaY * eased + deltaX / distance * bend,
  };
}

function drawFormationEnergy(now: number, rawProgress: number) {
  if (rawProgress < 0 || rawProgress > 1.12) return;
  const progress = Math.max(0, Math.min(1, rawProgress));
  const centerX = particleTargetBounds.left + particleTargetBounds.width / 2;
  const centerY = particleTargetBounds.top + particleTargetBounds.height / 2;
  const intensity = Math.sin(progress * Math.PI);
  const outerRadius = Math.max(particleCanvas.width, particleCanvas.height) * .56;
  const targetRadius = Math.max(particleTargetBounds.width, particleTargetBounds.height) * .48;
  const radius = outerRadius + (targetRadius - outerRadius) * easeFormation(progress);

  particleContext.save();
  particleContext.globalCompositeOperation = "lighter";
  particleContext.translate(centerX, centerY);
  particleContext.scale(1, .72);
  for (let index = 0; index < 4; index += 1) {
    const ringRadius = radius + index * 34;
    particleContext.beginPath();
    particleContext.setLineDash([16 + index * 5, 34 + index * 7]);
    particleContext.lineDashOffset = (index % 2 ? 1 : -1) * now / (12 + index * 3);
    particleContext.arc(0, 0, ringRadius, 0, Math.PI * 2);
    particleContext.lineWidth = index === 0 ? 1.8 : .75;
    particleContext.strokeStyle = index === 2
      ? `rgba(255,155,47,${intensity * .48})`
      : `rgba(34,199,255,${intensity * (.56 - index * .08)})`;
    particleContext.stroke();
  }
  particleContext.restore();

  const shock = Math.max(0, Math.min(1, (progress - .68) / .25));
  if (shock > 0 && shock < 1) {
    particleContext.save();
    particleContext.globalCompositeOperation = "lighter";
    particleContext.beginPath();
    particleContext.ellipse(
      centerX,
      centerY,
      targetRadius * (.65 + shock * 1.35),
      targetRadius * (.48 + shock * .95),
      0,
      0,
      Math.PI * 2,
    );
    particleContext.strokeStyle = `rgba(134,229,255,${(1 - shock) * .85})`;
    particleContext.shadowColor = "#22c7ff";
    particleContext.shadowBlur = 28;
    particleContext.lineWidth = 2.4;
    particleContext.stroke();
    particleContext.restore();
  }
}

function drawTornado(now: number) {
  const progress = Math.max(0, Math.min(1, (now - tornadoStartedAt) / tornadoTotal));
  const spin = now / 210 + progress * 7;
  const centreX = particleTargetBounds.left + particleTargetBounds.width / 2;
  const baseY = particleTargetBounds.top + particleTargetBounds.height * .96;
  const height = Math.max(120, particleTargetBounds.height);
  particleContext.globalCompositeOperation = "lighter";

  // The funnel body: a few translucent walls make the vortex read as volume
  // before the individual sparks are drawn on top of it.
  particleContext.save();
  particleContext.translate(centreX, baseY);
  for (let ring = 0; ring < 5; ring += 1) {
    const rise = ring / 5;
    const taper = 1 - rise * .78;
    particleContext.beginPath();
    particleContext.ellipse(
      0,
      -height * (.34 + progress * .84) * rise,
      particleTargetBounds.width * .34 * taper * (.5 + progress * .85),
      particleTargetBounds.width * .10 * taper * (.5 + progress * .85),
      0,
      0,
      Math.PI * 2,
    );
    particleContext.lineWidth = 1.2;
    particleContext.strokeStyle = ring % 2
      ? `rgba(255,155,47,${.14 * (1 - progress)})`
      : `rgba(34,199,255,${.2 * (1 - progress)})`;
    particleContext.stroke();
  }
  particleContext.restore();

  const step = visualParticles.length > 1400 ? 2 : 1;
  for (let index = 0; index < visualParticles.length; index += step) {
    const particle = visualParticles[index];
    const point = funnelPoint(particle, spin, progress, funnelScratch);
    const depth = Math.sin(particle.vortexAngle + spin);
    const alpha = (1 - progress * .35) * (.16 + .62 * Math.abs(depth));
    const size = particle.size * (1 + progress * .5) * (.75 + Math.abs(depth) * .6);
    const colour = particle.amber ? "255,155,47" : "34,199,255";
    const previous = funnelPoint(particle, spin - .34, progress, funnelScratchPrevious);
    particleContext.beginPath();
    particleContext.moveTo(previous.x, previous.y);
    particleContext.lineTo(point.x, point.y);
    particleContext.strokeStyle = `rgba(${colour},${alpha * .34})`;
    particleContext.lineWidth = particle.size > 2.5 ? 1.4 : .6;
    particleContext.stroke();
    particleContext.beginPath();
    particleContext.arc(point.x, point.y, Math.max(.6, size), 0, Math.PI * 2);
    particleContext.fillStyle = `rgba(${colour},${alpha})`;
    particleContext.fill();
  }
  particleContext.globalCompositeOperation = "source-over";
}

function drawParticleFrame(now: number) {
  particleContext.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
  if (visualParticles.length && now < tornadoUntil) {
    drawTornado(now);
    return;
  }
  if (visualParticles.length) {
    const rawProgress = (now - formationStartedAt) / formationDuration;
    const forming = rawProgress >= 0 && rawProgress < 1.08;
    const busy = forming || state.mode === "speaking" || state.mode === "working";
    const idleStrength = state.mode === "speaking" ? .18 + state.level * .48 : state.mode === "working" ? .12 : .045;
    particleContext.globalCompositeOperation = "lighter";
    // Idle drift at alpha .045 does not need every dot: skipping every other
    // one halves the fill work and is invisible over the character.
    const step = busy ? 1 : 3;
    for (let index = 0; index < visualParticles.length; index += step) {
      const particle = visualParticles[index];
      const localRaw = forming ? (rawProgress - particle.delay) / (1 - particle.delay) : 1;
      const progress = Math.max(0, Math.min(1, localRaw));
      const point = particlePosition(particle, progress);
      const previous = particlePosition(particle, Math.max(0, progress - (.035 + particle.size * .008)));
      const drift = forming ? 0 : Math.sin(now / 760 + particle.phase) * (1.1 + state.level * 3.2);
      const x = point.x + drift;
      const y = point.y + Math.cos(now / 830 + particle.phase) * (forming ? 0 : 1.4);
      const alpha = forming
        ? localRaw < 0
          ? .12 + Math.sin(now / 180 + particle.phase) * .08
          : .34 + Math.sin(progress * Math.PI) * .66
        : idleStrength;
      const color = state.mode === "working"
        ? "255,155,47"
        : state.mode === "stopped"
          ? "255,73,62"
          : particle.amber
            ? "255,155,47"
            : "34,199,255";
      if (!forming) {
        const radius = Math.max(1.6, particle.size * 4.6);
        particleContext.globalAlpha = Math.min(1, alpha * 1.5);
        particleContext.drawImage(particleSprite(color), x - radius, y - radius, radius * 2, radius * 2);
        continue;
      }
      particleContext.beginPath();
      particleContext.moveTo(previous.x, previous.y);
      particleContext.lineTo(x, y);
      particleContext.strokeStyle = `rgba(${color},${alpha * (particle.size > 2.5 ? .62 : .28)})`;
      particleContext.lineWidth = particle.size > 2.5 ? 1.5 : .65;
      particleContext.stroke();
      particleContext.beginPath();
      particleContext.arc(x, y, particle.size * (forming ? 1.3 : 1), 0, Math.PI * 2);
      particleContext.fillStyle = `rgba(${color},${alpha})`;
      particleContext.fill();
    }
    particleContext.globalAlpha = 1;
    if (forming) drawFormationEnergy(now, rawProgress);
    particleContext.globalCompositeOperation = "source-over";
  }
}

if (characterImage.complete && characterImage.naturalWidth) prepareVisualParticles();
else characterImage.addEventListener("load", () => prepareVisualParticles(), { once: true });
new ResizeObserver(() => prepareVisualParticles()).observe(shell);

function analyserLevel(analyser: AnalyserNode | null) {
  if (!analyser) return 0;
  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);
  let energy = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    energy += normalized * normalized;
  }
  return Math.min(1, Math.sqrt(energy / samples.length) * 5);
}

let lastPulse = -1;
let lastGlow = -1;

/// CSS variables are written only when the rounded value actually moves: a
/// `style.setProperty` per frame re-runs style resolution for the whole shell,
/// and `--voice-glow` used to sit inside the character's `drop-shadow`, so
/// every frame re-rasterised that filter chain (the second half of the CPU
/// spike). The filters are static now and the pulse is a plain transform.
function publishVoiceVars() {
  const pulse = Math.round((1 + state.level * .026) * 200) / 200;
  if (pulse !== lastPulse) {
    lastPulse = pulse;
    shell.style.setProperty("--voice-pulse", String(pulse));
  }
  const glow = Math.round((.45 + state.level * .55) * 40) / 40;
  if (glow !== lastGlow) {
    lastGlow = glow;
    shell.style.setProperty("--voice-glow", String(glow));
  }
}

function sampleAudioLevels() {
  if (!currentWindow) {
    const time = performance.now();
    state.level = state.mode === "speaking"
      ? .52 + Math.sin(time / 125) * .16
      : state.mode === "working"
        ? .2 + Math.sin(time / 310) * .08
        : state.mode === "listening"
          ? .08 + Math.sin(time / 430) * .035
          : 0;
    publishVoiceVars();
    return;
  }
  const micLevel = analyserLevel(microphoneAnalyser);
  const speakerLevel = analyserLevel(remoteAnalyser);
  state.level = Math.max(state.level, micLevel, speakerLevel);
  publishVoiceVars();
  if (state.directVoice?.voiceActive && !state.agentWorking) {
    if (speakerLevel > 0.08 && state.mode !== "speaking") setMode("speaking");
    if (speakerLevel < 0.025 && state.mode === "speaking") setMode("listening");
  }
}

/// One loop for the wave, the particles and the meters. Three independent
/// `requestAnimationFrame` loops meant three full passes over the same frame
/// budget; a hidden window (how Jarvis usually sits) now renders nothing.
const FRAME_BUSY_MS = 1000 / 30;
const FRAME_IDLE_MS = 1000 / 8;
const FRAME_REST_MS = 1000 / 2;
const REST_AFTER_MS = 20_000;
let animationRunning = false;
let lastAnimationFrame = 0;
let lastActivityAt = performance.now();

let resting = false;

/// The decorative CSS animations (the sweep, the spinning rings, the breathing
/// aura) run in the compositor and cannot be budgeted by a frame timer, so a
/// window nobody is talking to must be told to hold still — otherwise the
/// renderer keeps re-compositing the masked sweep for as long as the app is on
/// screen. Anything the user does wakes the ambience back up immediately.
function syncResting(next: boolean) {
  if (next === resting) return;
  resting = next;
  shell.classList.toggle("is-resting", next);
}

/// Anything the user did — a wake, an answer, a task — brings the ambience back
/// to full speed; a window that nobody is looking at falls back to 2fps.
function noteActivity() {
  lastActivityAt = performance.now();
  syncResting(false);
}

function animationBusy() {
  return state.mode === "speaking" || state.mode === "working" || shell.classList.contains("is-forming");
}

function animationBudget(now: number) {
  if (animationBusy()) {
    noteActivity();
    return FRAME_BUSY_MS;
  }
  return now - lastActivityAt < REST_AFTER_MS ? FRAME_IDLE_MS : FRAME_REST_MS;
}

function animationFrame(now: number) {
  if (!animationRunning) return;
  syncResting(!animationBusy() && now - lastActivityAt >= REST_AFTER_MS);
  // The idle video is driven by a handful of shell classes: re-deriving its
  // visibility here means the still can never get stuck after a hang-up,
  // whatever order things unwound in.
  updateIdleVisibility();
  if (now - lastAnimationFrame >= animationBudget(now) - .6) {
    lastAnimationFrame = now;
    state.level *= .9;
    sampleAudioLevels();
    drawWaveFrame();
    drawParticleFrame(now);
  }
  requestAnimationFrame(animationFrame);
}

function startAnimation() {
  noteActivity();
  if (animationRunning) return;
  animationRunning = true;
  lastAnimationFrame = 0;
  requestAnimationFrame(animationFrame);
}

for (const event of ["pointerdown", "keydown", "wheel"] as const) {
  window.addEventListener(event, noteActivity, { passive: true });
}

function stopAnimation() {
  animationRunning = false;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) { stopAnimation(); syncResting(true); } else startAnimation();
});
if (!document.hidden) startAnimation();

function updateVoiceInfo(info: DirectVoice) {
  state.directVoice = info;
  mic.classList.toggle("active", info.voiceActive);
  $("#voice-auth").textContent = info.codexConnected
    ? `${info.protocol} · ${info.voiceActive ? "connected" : info.phase}`
    : `${info.protocol} · standby`;
  if (info.threadId) {
    state.session = { threadId: info.threadId, cwd: workspace };
    $("#thread-id").textContent = info.threadId;
    localStorage.setItem(`${THREAD_KEY_PREFIX}${workspace}`, info.threadId);
  }
}

async function handle(message: Message) {
  if (message.id !== undefined && message.method) {
    triggerCharacterAction("approval", 1800);
    approvalId = message.id; $("#approval-copy").textContent = `Codex 请求：${message.method}`; approval.showModal(); return;
  }
  const method = message.method, params = message.params;
  if (method === "thread/realtime/sdp") {
    if (!peer || !params?.sdp) return;
    try {
      await peer.setRemoteDescription({ type: "answer", sdp: params.sdp });
    } catch (error) {
      triggerCharacterAction("error");
      setMode("degraded");
      response.textContent = `Codex Voice SDP 连接失败：${String(error)}`;
    }
  } else if (method === "thread/realtime/started") {
    updateVoiceInfo({
      codexConnected: true,
      voiceActive: true,
      phase: "connected",
      protocol: "Codex app-server V3 · WebRTC",
      threadId: params?.threadId,
      realtimeSessionId: params?.realtimeSessionId,
    });
    banner.hidden = true;
    setMode("listening");
    triggerCharacterAction("acknowledge");
    setWorker("orchestrator", "Official Voice online");
    response.textContent = "Codex 官方 Voice 已上线。你现在可以直接和 Jarvis 对话。";
  } else if (method === "thread/realtime/transcript/delta") {
    const delta = typeof params?.delta === "string" ? params.delta : "";
    if (params?.role === "assistant") {
      assistantTranscriptBuffer += delta;
      response.textContent = assistantTranscriptBuffer;
      if (!state.agentWorking) setMode("speaking");
    } else {
      userTranscriptBuffer += delta;
      transcript.textContent = userTranscriptBuffer;
      if (!state.agentWorking) setMode("listening");
    }
  } else if (method === "thread/realtime/transcript/done") {
    const text = typeof params?.text === "string" ? params.text.trim() : "";
    if (params?.role === "assistant") {
      if (text) response.textContent = text;
      assistantTranscriptBuffer = "";
      if (!state.agentWorking) setMode("listening");
    } else {
      if (text) transcript.textContent = text;
      userTranscriptBuffer = "";
      if (text) triggerCharacterAction("acknowledge");
    }
  } else if (method === "thread/realtime/itemAdded") {
    const itemType = String(params?.item?.type ?? "");
    if (itemType.includes("handoff") || itemType.includes("delegation")) {
      setMode("working");
      setWorker("orchestrator", "Delegating to Codex");
    }
  } else if (method === "thread/realtime/error") {
    triggerCharacterAction("error");
    setMode("degraded");
    banner.hidden = false;
    const detail = params?.message ?? "Codex Voice realtime error";
    $("#degraded-copy").textContent = detail;
    response.textContent = detail;
  } else if (method === "thread/realtime/closed") {
    cleanupPeer();
    updateVoiceInfo({
      codexConnected: true,
      voiceActive: false,
      phase: "closed",
      protocol: "Codex app-server V3 · WebRTC",
      threadId: params?.threadId ?? state.session?.threadId,
    });
    if (!state.manualStop) {
      setMode("ready");
      response.textContent = "Codex Voice 已结束。再次说“嗨 Jarvis”即可唤醒。";
      await armWakeListener();
    }
  } else if (method === "turn/started") {
    if (state.manualStop) return;
    agentMessageBuffer = "";
    spokenLength = 0;
    speakCanceled = false;
    state.agentWorking = true;
    setMode("working"); setWorker("orchestrator", "Codex working");
  } else if (method === "item/agentMessage/delta") {
    const delta = typeof params?.delta === "string" ? params.delta : "";
    agentMessageBuffer += delta;
    if (agentMessageBuffer) response.textContent = agentMessageBuffer;
    flushAgentSpeech(false);
  } else if (method === "turn/completed" || method === "turn/failed") {
    state.agentWorking = false;
    // The answer is complete, but its last sentence may still be playing: the
    // microphone only comes back once the speakers are quiet.
    void invoke("speak_turn_end");
    if (!state.manualStop) triggerCharacterAction("complete", 1400);
    setMode(state.manualStop ? "stopped" : state.directVoice?.voiceActive ? "listening" : "ready");
    setWorker("orchestrator", state.manualStop ? "Interrupted" : "Ready", !state.manualStop);
    for (const role of ["developer", "researcher", "reviewer"]) {
      setWorker(role, state.manualStop ? "Interrupted" : "Standby", false);
    }
  } else if (method === "item/started") {
    if (!state.manualStop) setWorker(roleOf(params), "Working");
  }
  else if (method === "item/completed") {
    setWorker(roleOf(params), "Complete", false);
    if (params?.item?.type === "agentMessage") {
      const text = typeof params.item.text === "string" ? params.item.text : agentMessageBuffer;
      if (text) response.textContent = text;
      flushAgentSpeech(true);
    }
  }
}

let spokenLength = 0;
let speakCanceled = false;

/// Speech starts as soon as the model streams a finished sentence instead of
/// waiting for the whole answer, which is what makes a turn feel like a call
/// rather than a request.
function lastSentenceBoundary(text: string): number {
  let boundary = 0;
  for (let index = 0; index < text.length; index += 1) {
    if ("。！？!?\n".includes(text[index])) boundary = index + 1;
  }
  if (boundary > 0) return boundary;
  if (text.length < 140) return 0;
  const soft = Math.max(text.lastIndexOf("，", 140), text.lastIndexOf("、", 140), text.lastIndexOf(",", 140));
  return soft > 40 ? soft + 1 : 140;
}

function flushAgentSpeech(final: boolean) {
  if (!speakReplies || state.manualStop || speakCanceled) return;
  const pending = agentMessageBuffer.slice(spokenLength);
  if (!pending) return;
  const length = final ? pending.length : lastSentenceBoundary(pending);
  if (length <= 0) return;
  const spoken = plainForSpeech(pending.slice(0, length));
  spokenLength += length;
  if (!spoken || (spoken.length < 4 && !final)) return;
  // A connected digital human is the only mouth in the room: the agent's own
  // synthesiser stays silent, so the answer cannot double up with Vidu.
  if (liveCall?.active) {
    liveCall.say(spoken);
  } else {
    speakLine(spoken);
  }
}

async function waitForIceGathering(connection: RTCPeerConnection) {
  if (connection.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      connection.removeEventListener("icegatheringstatechange", changed);
      reject(new Error("WebRTC ICE gathering timed out"));
    }, 12_000);
    const changed = () => {
      if (connection.iceGatheringState !== "complete") return;
      window.clearTimeout(timer);
      connection.removeEventListener("icegatheringstatechange", changed);
      resolve();
    };
    connection.addEventListener("icegatheringstatechange", changed);
  });
}

function attachAnalyser(stream: MediaStream, target: "microphone" | "remote") {
  audioContext ??= new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  if (target === "microphone") microphoneAnalyser = analyser;
  else remoteAnalyser = analyser;
}

function cleanupPeer() {
  peer?.close();
  peer = null;
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
  remoteStream?.getTracks().forEach((track) => track.stop());
  remoteStream = null;
  voiceAudio.pause();
  voiceAudio.srcObject = null;
  microphoneAnalyser = null;
  remoteAnalyser = null;
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

function isNotAllowedError(error: unknown) {
  return error instanceof DOMException
    ? error.name === "NotAllowedError"
    : String(error).includes("NotAllowedError");
}

async function acquireMicrophone(coldStart: boolean) {
  const attempts = coldStart ? 6 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      if (!coldStart || !isNotAllowedError(error) || attempt === attempts) throw error;
      response.textContent = `正在等待系统释放麦克风… ${attempt}/${attempts - 1}`;
      await sleep(700);
    }
  }
  throw new Error("麦克风初始化失败");
}

async function startDirectVoice({ coldStart = false } = {}) {
  // DeepSeek has no /live endpoint: the official Codex Voice can only answer
  // with a 404, so text mode keeps the wake listener instead.
  textOnlyMode = await invoke<boolean>("voice_text_only").catch(() => textOnlyMode);
  if (textOnlyMode) {
    banner.hidden = true;
    setMode("ready");
    setWorker("orchestrator", "Text mode · DeepSeek");
    response.textContent = "语音指挥模式：直接说“嗨 Jarvis”，不用点麦克风按钮。";
    await armWakeListener();
    return;
  }
  if (!currentWindow) {
    setMode("voice-starting");
    window.setTimeout(() => setMode("listening"), FORMATION_DURATION);
    return;
  }
  if (voiceStartInFlight || peer || state.directVoice?.voiceActive) return;
  voiceStartInFlight = true;
  state.manualStop = false;
  recoverableColdStartError = false;
  setMode("voice-starting");
  banner.hidden = true;
  response.textContent = "正在建立 Codex 官方 Voice V3 WebRTC 会话…";
  try {
    const microphoneAuthorization = await invoke<string>("request_microphone_permission");
    if (microphoneAuthorization !== "authorized") {
      throw new Error("请在系统设置 → 隐私与安全性 → 麦克风中允许 Jarvis Codex。");
    }
    await invoke("disarm_wake_listener");
    if (coldStart) {
      // A newly created WKWebView can reject an otherwise-authorized
      // getUserMedia call until its first visible/focused render cycle.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await sleep(900);
    }
    microphoneStream = await acquireMicrophone(coldStart);
    attachAnalyser(microphoneStream, "microphone");

    const connection = new RTCPeerConnection();
    peer = connection;
    const track = microphoneStream.getAudioTracks()[0];
    if (!track) throw new Error("未找到麦克风音轨");
    connection.addTrack(track, microphoneStream);
    connection.createDataChannel("oai-events");
    connection.ontrack = (event) => {
      remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      voiceAudio.srcObject = remoteStream;
      attachAnalyser(remoteStream, "remote");
      void audioContext?.resume();
      void voiceAudio.play();
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed") {
        setMode("degraded");
        response.textContent = "Codex Voice WebRTC 连接失败。";
      }
    };
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIceGathering(connection);
    const sdp = connection.localDescription?.sdp;
    if (!sdp) throw new Error("WebRTC 未生成 SDP offer");

    const info = await invoke<DirectVoice>("start_codex_voice", {
      cwd: workspace,
      threadId: savedThreadId(),
      permissionMode,
      sdp,
      voice: "cove",
    });
    updateVoiceInfo(info);
  } catch (error) {
    cleanupPeer();
    recoverableColdStartError = coldStart && isNotAllowedError(error);
    setMode("degraded");
    banner.hidden = false;
    const detail = String(error);
    $("#degraded-copy").textContent = /\/live|404/.test(detail)
      ? "当前模型提供方（DeepSeek）没有实时语音端点。请说“嗨 Jarvis”用连续对话，或直接打字。"
      : detail;
    response.textContent = detail;
    await armWakeListener();
  } finally {
    voiceStartInFlight = false;
  }
}

async function stopDirectVoice() {
  try {
    const info = await invoke<DirectVoice>("stop_codex_voice");
    updateVoiceInfo(info);
  } finally {
    cleanupPeer();
  }
}

trackLiveChip();
setupCallChip();

if (currentWindow) {
  await listen<Message>("codex-event", ({ payload }) => void handle(payload));
  await listen<WakeStatus>("jarvis-wake-status", ({ payload }) => {
    state.wake = payload;
    $("#wake-auth").textContent = payload.ready
      ? "Local listener ready"
      : payload.authorization === "authorized"
        ? "Waiting to re-arm"
        : payload.authorization;
    if (payload.ready) {
      if (recoverableColdStartError && state.mode === "degraded") {
        recoverableColdStartError = false;
        banner.hidden = true;
        setMode("ready");
      }
      if (state.mode === "ready") {
        response.textContent = "我在。直接说“嗨 Jarvis”。";
        setWorker("orchestrator", "Wake word armed");
      }
    }
  });
  await listen<WakeEvent>("jarvis-wake", async ({ payload }) => {
    transcript.textContent = "“嗨，Jarvis”";
    state.manualStop = false;
    // Read the mode again instead of trusting the startup value: a wake can
    // arrive while the window is still booting (that is exactly what happens
    // when the wake helper cold-launches Jarvis), and the official Codex Voice
    // is not reachable on DeepSeek.
    textOnlyMode = await invoke<boolean>("voice_text_only").catch(() => textOnlyMode);
    if (textOnlyMode) {
      banner.hidden = true;
      // A wake brings the window back: only resume the camera if it was left on.
      await refreshVision();
      if (visionEnabled && currentWindow) void invoke("camera_active", { active: true }).catch(() => {});
      // Jarvis usually waits in the background with the window hidden, so the
      // summon has to assemble the armour: booting it only at launch means the
      // animation plays where nobody can see it.
      setMode("voice-starting");
      window.setTimeout(() => {
        if (state.mode === "voice-starting") setMode("listening");
      }, FORMATION_DURATION);
      setWorker("orchestrator", "Text mode · DeepSeek");
      // The wake phrase carries the name ("嗨张元英"): she takes the line in
      // person, with the dialling animation, instead of the helmet answering.
      const dialTarget = await wakeDialTarget(payload);
      if (dialTarget && (await dialCharacter(dialTarget, true))) return;
      if (dialTarget) {
        const name = avatars.find((avatar) => avatar.id === dialTarget)?.name ?? "她";
        response.textContent = `${response.textContent ?? ""} 先按普通对话继续，说「呼叫${name}」可以再拨一次。`;
      } else {
        response.textContent = "我在，请说指令…（也可以直接打字）";
      }
      ($("#command-input") as HTMLInputElement).focus();
      return;
    }
    if (!payload.ok) {
      setMode("degraded");
      banner.hidden = false;
      $("#degraded-copy").textContent = payload.error ?? "无法打开官方 Codex Voice。";
      response.textContent = payload.error ?? "无法打开官方 Codex Voice。";
      return;
    }
    banner.hidden = true;
    void startDirectVoice({ coldStart: payload.cold === true });
  });
  await listen<{ text: string }>("jarvis-command", ({ payload }) => {
    const text = (payload?.text ?? "").trim();
    if (!text) return;
    ($("#command-input") as HTMLInputElement).value = "";
    void runCommand(text);
  });
  await listen<{ state?: string }>("jarvis-conversation", ({ payload }) => {
    // Continuous conversation: the listener stays on the microphone, so the
    // HUD has to follow the helper's own listening/speaking phases.
    if (payload?.state === "speaking") {
      setWorker("orchestrator", "对话中 · Jarvis 回答");
      setMode("speaking");
    } else if (payload?.state === "listening") {
      setWorker("orchestrator", "对话中 · 聆听指令");
      setMode("listening");
    }
  });
  await listen<VisionSignal>("jarvis-vision", ({ payload }) => applyVisionSignal(payload));
  await listen<{ stage?: string; message?: string; avatarId?: string }>("avatar-progress", ({ payload }) => {
    const progress = document.querySelector<HTMLElement>("#avatar-progress");
    if (progress && payload?.message) progress.textContent = payload.message;
    if (payload?.stage === "done" && payload.avatarId) {
      // The one-off render finished: drop the cached video and refresh the
      // list so the "动态形象" state and the on-stage loop catch up.
      idleVideoCache.delete(payload.avatarId);
      void refreshAvatars();
    }
  });
  await listen<{ message?: string }>("avatarlive-progress", ({ payload }) => {
    const progress = document.querySelector<HTMLElement>("#avatar-progress");
    if (progress && payload?.message) progress.textContent = payload.message;
  });
  await listen("jarvis-barge", () => {
    // Talking over Jarvis drops the answer and hands the turn back to the user.
    speakCanceled = true;
    transcript.textContent = "（打断）";
    response.textContent = "好，你说。";
    setMode("listening");
    setWorker("orchestrator", "已打断 · 聆听新指令");
    void invoke("interrupt_turn");
  });
}
async function runCommand(text: string, clearInput = true) {
  if (!text) return;
  // A new instruction — typed or spoken — drops whatever Jarvis is still
  // reading out. Queueing behind it is what made Jarvis finish the old answer
  // while the user was already talking over it.
  if (state.mode === "speaking") {
    speakCanceled = true;
    void invoke("interrupt_turn");
  }
  if (matchShutdownCommand(text)) {
    if (clearInput) ($("#command-input") as HTMLInputElement).value = "";
    transcript.textContent = text;
    state.manualStop = true;
    setMode("stopped");
    setWorker("orchestrator", "Closing Jarvis");
    response.textContent = "好，我关了。想再叫我，说一声「嗨 Jarvis」。";
    // The app answers this one itself: it stops the keeper from opening Jarvis
    // on its own, but leaves a wake-only listener so the wake word still works.
    try {
      await invoke("close_jarvis", { farewell: "好，我关了，喊我一声就回来。" });
    } catch { /* the app is already gone */ }
    return;
  }
  const liveCommand = matchLiveCommand(text);
  if (liveCommand) {
    // "打开视频" starts the realtime call, "挂断" ends it — both are answered
    // by the HUD so they never wait on a model round trip.
    if (clearInput) ($("#command-input") as HTMLInputElement).value = "";
    transcript.textContent = text;
    if (liveCommand === "start") await startLiveCall();
    else await endLiveCall("user_end");
    return;
  }
  const spokenVision = matchVisionCommand(text);
  if (spokenVision) {
    // "启动视频组件" / "你能看到我吗" / "别看我了" never reach Codex: the HUD
    // owns the camera, and answering in the same voice is the whole point.
    if (clearInput) ($("#command-input") as HTMLInputElement).value = "";
    transcript.textContent = text;
    await applyVisionCommand(spokenVision, true);
    return;
  }
  const called = matchCallCommand(text, avatars);
  if (called) {
    // "呼叫张元英" is a call, not a task: the HUD dials her itself.
    if (clearInput) ($("#command-input") as HTMLInputElement).value = "";
    transcript.textContent = text;
    await dialCharacter(called, true);
    return;
  }
  const spokenAvatar = matchAvatarCommand(text, avatars);
  if (spokenAvatar) {
    // "切换成小美" is answered by the HUD with the transformation, so the
    // 2.6s animation never races a model round trip.
    if (clearInput) ($("#command-input") as HTMLInputElement).value = "";
    transcript.textContent = text;
    await applyAvatar(spokenAvatar, true, true);
    return;
  }
  const spokenPack = matchVoicePackCommand(text);
  if (spokenPack) {
    // "换成可爱女声" never reaches Codex; the HUD answers in the new voice.
    if (clearInput) ($("#command-input") as HTMLInputElement).value = "";
    transcript.textContent = text;
    await applyVoicePack(spokenPack, true);
    return;
  }
  state.manualStop = false;
  transcript.textContent = text;
  if (clearInput) ($("#command-input") as HTMLInputElement).value = "";
  if (!currentWindow) {
    response.textContent = "视觉预览：文字任务已切换为 Codex 工作态。";
    setMode("working");
    return;
  }
  if (state.directVoice?.voiceActive) {
    response.textContent = "已将文字作为用户话语注入当前 Codex Voice 会话。";
    await invoke("append_codex_voice_text", { text });
    return;
  }
  if (!state.session) {
    state.session = await invoke<Session>("start_jarvis", {
      cwd: workspace,
      threadId: savedThreadId(),
      permissionMode,
    });
    localStorage.setItem(`${THREAD_KEY_PREFIX}${workspace}`, state.session.threadId);
    $("#thread-id").textContent = state.session.threadId;
    $("#workspace").textContent = state.session.cwd;
  }
  setMode("working");
  await invoke("send_text", { text });
}

function plainForSpeech(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " 代码块 ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " 链接 ")
    .replace(/[*_#>|]/g, "")
    .trim()
    .slice(0, 600);
}

$("#avatar-create").addEventListener("click", () => void createAvatarFromForm());
$("#avatar-import").addEventListener("click", () => void importAvatarFromFile());
$("#live-hangup").addEventListener("click", () => void endLiveCall("user_end"));
$("#command-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#command-input") as HTMLInputElement;
  await runCommand(input.value.trim());
});
mic.addEventListener("click", async () => {
  if (state.directVoice?.voiceActive || peer) {
    void stopDirectVoice();
    return;
  }
  if (textOnlyMode) {
    // Official Voice is not available here, so the button re-arms the wake
    // listener instead of failing with a provider error.
    await armWakeListener();
    const wake = await invoke<WakeStatus>("wake_listener_status").catch(() => null);
    if (wake?.ready) {
      banner.hidden = true;
      setMode("ready");
      setWorker("orchestrator", "Wake word armed");
      response.textContent = "我在。直接说“嗨 Jarvis”。";
    } else {
      setMode("degraded");
      banner.hidden = false;
      $("#degraded-copy").textContent = wake?.authorization === "notDetermined"
        ? "等系统弹窗里点“允许”，麦克风和语音识别都要授权。"
        : "监听没起来，请检查系统设置 → 隐私与安全性里的麦克风/语音识别。";
    }
    return;
  }
  void startDirectVoice();
});
$("#stop").addEventListener("click", async () => {
  triggerCharacterAction("error", 700);
  state.manualStop = true; setMode("stopped");
  state.agentWorking = false;
  for (const role of ["orchestrator", "developer", "researcher", "reviewer"]) setWorker(role, "Interrupted", false);
  if (!currentWindow) return;
  if (state.directVoice?.voiceActive || peer) {
    try { await stopDirectVoice(); } catch { /* task interruption still continues */ }
  }
  await invoke("stop_all");
  await armWakeListener();
});
// ---------------------------------------------------------------------------
// Characters: the built-in Jarvis plus up to nine created companions. Each one
// owns a portrait, a persona and a voice pack, and switching is a transformation
// rather than a settings trip.
// ---------------------------------------------------------------------------

const BUILTIN_ART = "/assets/jarvis-character-v2.png";
const MOOD_LABELS: Record<string, string> = {
  happy: "开心", surprised: "惊讶", sad: "低落", angry: "不满", tired: "疲惫",
  neutral: "平静", unknown: "—",
};
const selfView = $("#self-view") as HTMLElement;
const selfViewImage = $("#self-view-image") as HTMLImageElement;
let avatars: AvatarInfo[] = [];
let activeAvatar = "jarvis";
let avatarLimit = 10;
let transformBusy = false;
const portraitCache = new Map<string, string>();

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function decodeImage(image: HTMLImageElement) {
  return new Promise<void>((resolve) => {
    if (image.complete && image.naturalWidth) { resolve(); return; }
    const done = () => resolve();
    image.addEventListener("load", done, { once: true });
    image.addEventListener("error", done, { once: true });
  });
}

function updateCharacterChrome(avatar: AvatarInfo | undefined) {
  void refreshIdle(avatar);
  const name = (avatar?.name ?? "Jarvis").trim() || "Jarvis";
  $("#brand-name").textContent = name.toUpperCase();
  $("#identity-role").textContent = `${name.toUpperCase()} CORE`;
  $("#speaker-label").textContent = name.toUpperCase();
}

// ---------------------------------------------------------------------------
// The idle loop. A pre-rendered local video replaces the still portrait: the
// character breathes, blinks and shifts her weight without any patch layers.
// Vidu renders it once; playback is entirely local. Only dialing a realtime
// call connects to Vidu again.
// ---------------------------------------------------------------------------

const idleVideoCache = new Map<string, string>();
const idleCanvas = $("#idle-character") as HTMLCanvasElement;
const idlePlayer = new IdlePlayer(idleCanvas, {
  onRevealed: () => {
    // Vidu's live picture owns the stage during a call; only the idle loop
    // may push the still portrait aside.
    if (!shell.classList.contains("video-live")) characterImage.hidden = true;
  },
  onHidden: () => {
    if (!shell.classList.contains("video-live")) characterImage.hidden = false;
  },
});
let idleSourceFor = "";
let idleWanted = false;

function updateIdleVisibility() {
  const live =
    shell.classList.contains("video-live") ||
    shell.classList.contains("is-dialing") ||
    shell.classList.contains("is-transforming") ||
    shell.classList.contains("is-reforming");
  const portrait = shell.classList.contains("custom-character");
  const wanted = Boolean(idleSourceFor) && portrait && !live;
  if (wanted !== idleWanted) {
    idleWanted = wanted;
    void invoke("web_log", {
      message: `静息动画：${wanted ? "接管画面" : `退场：动图 ${live} · 立绘形象 ${portrait}`}`,
    }).catch(() => {});
  }
  idlePlayer.setVisible(wanted);
}

/** Loads the active character's idle animation and lets it take the stage. */
async function refreshIdle(avatar: AvatarInfo | undefined) {
  if (!avatar || !avatar.hasIdleVideo) {
    idleSourceFor = "";
    idlePlayer.stop();
    return;
  }
  let source = idleVideoCache.get(avatar.id) ?? null;
  if (source === null) {
    const fetched = await invoke<string | null>("avatar_idle_video", { id: avatar.id }).catch(() => null);
    source = fetched;
    if (source) idleVideoCache.set(avatar.id, source);
  }
  if (!source) {
    idleSourceFor = "";
    idlePlayer.setVisible(false);
    return;
  }
  idleSourceFor = avatar.id;
  await idlePlayer.setSource(avatar.id, source);
  updateIdleVisibility();
}

async function portraitFor(avatar: AvatarInfo): Promise<string | null> {
  if (!avatar.hasImage) return null;
  const cached = portraitCache.get(avatar.id);
  if (cached) return cached;
  try {
    const source = await invoke<string | null>("avatar_image", { id: avatar.id });
    if (!source) return null;
    // Imported art keeps its own background; generated art ships a flat
    // chroma-key backdrop. Either way the HUD shows the character alone.
    const keyed = await cutPortraitBackground(source).catch(() => null);
    const portrait = keyed ?? source;
    portraitCache.set(avatar.id, portrait);
    return portrait;
  } catch {
    return null;
  }
}

/** Swaps the artwork without the transformation, for the launch path. */
async function applyAvatarArt(avatar: AvatarInfo) {
  const source = avatar.isBuiltin ? BUILTIN_ART : (await portraitFor(avatar)) ?? BUILTIN_ART;
  if (characterImage.src.endsWith(source)) return;
  characterImage.src = source;
  await decodeImage(characterImage).catch(() => {});
  shell.classList.toggle("custom-character", !avatar.isBuiltin);
  await refreshIdle(avatar);
  updateIdleVisibility();
}

/// The particle tornado: the current character spins apart into the funnel,
/// the artwork is swapped while nothing is on screen, and the new silhouette is
/// wound back out of the same funnel.
async function playTransform(avatar: AvatarInfo) {
  if (transformBusy) return;
  transformBusy = true;
  const source = avatar.isBuiltin ? BUILTIN_ART : await portraitFor(avatar) ?? BUILTIN_ART;
  try {
    shell.classList.add("is-transforming");
    prepareVisualParticles(true);
    tornadoStartedAt = performance.now();
    tornadoTotal = TRANSFORM_FUNNEL;
    tornadoUntil = tornadoStartedAt + TRANSFORM_FUNNEL;
    await wait(TRANSFORM_FUNNEL);
    characterImage.src = source;
    await decodeImage(characterImage);
    shell.classList.remove("is-transforming");
    shell.classList.toggle("custom-character", !avatar.isBuiltin);
    await refreshIdle(avatar);
    updateIdleVisibility();
    shell.classList.add("is-reforming");
    prepareVisualParticles(true);
    startParticleFormation(true, TRANSFORM_DURATION - TRANSFORM_FUNNEL);
    await wait(TRANSFORM_DURATION - TRANSFORM_FUNNEL + 60);
    tornadoUntil = -1;
    shell.classList.remove("is-reforming");
  } finally {
    transformBusy = false;
  }
}

function describeAvatar(avatar: AvatarInfo) {
  const where = avatar.isBuiltin ? "内置形象" : "自定义形象";
  return `${avatar.name} · ${where} · 音色：${avatar.voiceLabel}`;
}

async function applyAvatar(id: string, animate = true, announce = false) {
  const target = avatars.find((avatar) => avatar.id === id);
  if (!target) return;
  if (currentWindow) {
    try {
      await invoke("set_active_avatar", { id });
    } catch (error) {
      response.textContent = `切换形象失败：${String(error)}`;
      return;
    }
  }
  activeAvatar = id;
  updateCharacterChrome(target);
  if (animate) await playTransform(target);
  await refreshVoicePacks().catch(() => {});
  renderAvatarList();
  const line = target.greeting?.trim() || `${target.name}在此，主人请吩咐！`;
  response.textContent = announce
    ? `变身完成：${line}`
    : `现在是「${target.name}」，音色固定为${target.voiceLabel}。`;
  if (announce && currentWindow) {
    speakLine(line);
  }
}

function renderAvatarList() {
  const container = $("#avatar-list");
  container.innerHTML = "";
  for (const avatar of avatars) {
    const row = document.createElement("label");
    row.className = "avatar-row";
    if (avatar.id === activeAvatar) row.classList.add("active");

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "avatar";
    radio.value = avatar.id;
    radio.checked = avatar.id === activeAvatar;
    radio.addEventListener("change", () => {
      if (radio.checked) void applyAvatar(avatar.id, true, true);
    });

    const frame = document.createElement("span");
    frame.className = "avatar-thumb";
    if (avatar.isBuiltin) {
      const img = document.createElement("img");
      img.src = BUILTIN_ART;
      img.alt = avatar.name;
      frame.append(img);
    } else {
      frame.textContent = avatar.name.slice(0, 1);
      void portraitFor(avatar).then((source) => {
        if (!source) return;
        const img = document.createElement("img");
        img.src = source;
        img.alt = avatar.name;
        frame.textContent = "";
        frame.append(img);
      });
    }

    const text = document.createElement("span");
    text.className = "avatar-text";
    const title = document.createElement("b");
    title.textContent = avatar.name;
    const note = document.createElement("small");
    note.textContent = avatar.isBuiltin ? `内置 · ${avatar.voiceLabel}` : `音色：${avatar.voiceLabel}`;
    text.append(title, note);
    const live = document.createElement("small");
    live.className = "avatar-live-note";
    live.textContent = `实时：${avatar.liveVoiceLabel}`;
    text.append(live);

    row.append(radio, frame, text);

    const liveSelect = document.createElement("select");
    liveSelect.className = "avatar-live-voice";
    liveSelect.title = "实时数字人音色";
    for (const voice of liveVoices) {
      const option = document.createElement("option");
      option.value = voice.id;
      option.textContent = voice.label;
      liveSelect.append(option);
    }
    liveSelect.value = avatar.liveVoice;
    liveSelect.addEventListener("change", async () => {
      try {
        await invoke("set_avatar_live_voice", { id: avatar.id, voice: liveSelect.value });
        await refreshAvatars();
      } catch (error) {
        response.textContent = `实时音色切换失败：${String(error)}`;
      }
    });
    const actions = document.createElement("span");
    actions.className = "avatar-actions";
    actions.append(liveSelect);

    if (!avatar.isBuiltin) {
      const idle = document.createElement("button");
      idle.type = "button";
      idle.className = "avatar-idle";
      idle.textContent = avatar.hasIdleVideo ? "重做动画" : "生成动画";
      idle.title = avatar.hasIdleVideo
        ? "重新渲染一次静息动画（会消耗 Vidu 积分）"
        : "用 Vidu 渲染一次静息动画，之后本机循环播放，不再连接 Vidu";
      idle.addEventListener("click", async (event) => {
        event.preventDefault();
        idle.disabled = true;
        idle.textContent = "渲染中…";
        const progress = document.querySelector<HTMLElement>("#avatar-progress");
        try {
          await invoke("generate_idle_video", { id: avatar.id });
          await refreshAvatars();
          if (progress) progress.textContent = `${avatar.name} 的动态形象已就绪，静息时自动循环播放。`;
          if (avatar.id === activeAvatar) {
            void refreshIdle(avatars.find((item) => item.id === activeAvatar));
          }
        } catch (error) {
          if (progress) progress.textContent = String(error);
        } finally {
          idle.disabled = false;
        }
      });
      actions.append(idle);
    }

    if (!avatar.isBuiltin) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "avatar-delete";
      remove.textContent = "删除";
      remove.addEventListener("click", async (event) => {
        event.preventDefault();
        remove.disabled = true;
        try {
          await invoke("delete_avatar", { id: avatar.id });
          portraitCache.delete(avatar.id);
          idleVideoCache.delete(avatar.id);
          if (avatar.id === activeAvatar) {
            const builtin = avatars.find((item) => item.isBuiltin);
            activeAvatar = "jarvis";
            if (builtin) {
              updateCharacterChrome(builtin);
              await playTransform(builtin);
            }
          }
          await refreshAvatars();
        } catch (error) {
          response.textContent = `删除失败：${String(error)}`;
        } finally {
          remove.disabled = false;
        }
      });
      actions.append(remove);
    }
    row.append(actions);
    container.append(row);
  }
}

function fillVoiceSelect() {
  const select = $("#avatar-voice") as HTMLSelectElement;
  const previous = select.value;
  select.innerHTML = "";
  for (const [id, label] of Object.entries(VOICE_PACK_SPEECH)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = label;
    select.append(option);
  }
  const ids = Object.keys(VOICE_PACK_SPEECH);
  select.value = ids.includes(previous) ? previous : "girl";
}

async function refreshAvatars() {
  if (!currentWindow) return;
  const container = $("#avatar-list");
  let snapshot: AvatarSnapshot;
  try {
    snapshot = await invoke<AvatarSnapshot>("avatars");
  } catch (error) {
    container.innerHTML = `<p class="voice-loading">形象库不可用：${String(error)}</p>`;
    return;
  }
  avatars = snapshot.avatars;
  avatarLimit = snapshot.limit;
  activeAvatar = snapshot.activeId;
  if (liveVoices.length === 0) {
    liveVoices = await invoke<Array<{ id: string; label: string }>>("videolive_voices").catch(() => []);
  }
  updateCharacterChrome(avatars.find((avatar) => avatar.id === activeAvatar));
  renderAvatarList();
  fillVoiceSelect();
  const status = $("#vidu-status");
  // Vidu is only contacted on demand: the list loads from the local store,
  // credits are fetched once while the settings panel is actually open.
  const creditsInfo = snapshot.vidu?.configured && settings.open
    ? await invoke<{ affordableSeconds?: number; creditRemain?: number }>("videolive_credits").catch(() => null)
    : null;
  const creditRemain = creditsInfo?.creditRemain ?? snapshot.vidu?.creditRemain ?? null;
  if (!snapshot.vidu?.configured) {
    status.textContent = "Vidu：还没有配置 API Key。在 ~/.jarvis-codex/config.json 里填入 viduKey 就能新建形象。";
  } else if (creditRemain === null || creditRemain === undefined) {
    status.textContent = "Vidu：已配置。余额只在拨号或打开本面板时查询。";
  } else {
    const talk = creditsInfo?.affordableSeconds
      ? `，实时对话还能说约 ${Math.round(creditsInfo.affordableSeconds / 60)} 分钟`
      : "";
    status.textContent = `Vidu：剩余 ${creditRemain} 积分（生成一个形象约 6 积分）${talk}。实时数字人 3 积分 / 2 秒。`;
  }
  const remaining = Math.max(0, avatarLimit - avatars.length);
  const summary = document.querySelector<HTMLElement>("#avatar-create summary");
  if (summary) {
    // The number the master asks for first: how much credit is left to make
    // another character, right next to the button that spends it.
    const money = typeof creditRemain === "number" ? ` · 剩余 ${creditRemain} 积分` : "";
    summary.textContent = `＋ 新建形象（还能建 ${remaining} 个${money}）`;
  }
}

async function importAvatarFromFile() {
  const button = $("#avatar-import") as HTMLButtonElement;
  const progress = $("#avatar-progress");
  const fileInput = $("#avatar-file") as HTMLInputElement;
  const nameInput = $("#avatar-name") as HTMLInputElement;
  const personaInput = $("#avatar-persona") as HTMLTextAreaElement;
  const voiceSelect = $("#avatar-voice") as HTMLSelectElement;
  const file = fileInput.files?.[0];
  if (!file) { progress.textContent = "先选一张图片吧。"; return; }
  const name = nameInput.value.trim() || file.name.replace(/\.[^.]+$/, "").slice(0, 12);
  button.disabled = true;
  progress.textContent = "正在抠出人物主体…";
  try {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(file);
    });
    const created = await invoke<AvatarInfo>("create_avatar_from_image", {
      name,
      persona: personaInput.value.trim(),
      voicePack: voiceSelect.value,
      fileName: file.name,
      data,
    });
    progress.textContent = `${created.name} 已导入（背景已去除）`;
    fileInput.value = "";
    nameInput.value = "";
    personaInput.value = "";
    await refreshAvatars();
    await applyAvatar(created.id, true, true);
  } catch (error) {
    progress.textContent = String(error);
  } finally {
    button.disabled = false;
  }
}

async function createAvatarFromForm() {
  const button = $("#avatar-create") as HTMLButtonElement;
  const progress = $("#avatar-progress");
  const nameInput = $("#avatar-name") as HTMLInputElement;
  const personaInput = $("#avatar-persona") as HTMLTextAreaElement;
  const promptInput = $("#avatar-prompt") as HTMLTextAreaElement;
  const voiceSelect = $("#avatar-voice") as HTMLSelectElement;
  const name = nameInput.value.trim();
  const prompt = promptInput.value.trim();
  if (!name) { progress.textContent = "先起个名字吧。"; nameInput.focus(); return; }
  if (!prompt) { progress.textContent = "用一句话描述一下形象吧。"; promptInput.focus(); return; }
  button.disabled = true;
  progress.textContent = "正在提交给 Vidu…";
  try {
    const created = await invoke<AvatarInfo>("create_avatar", {
      name,
      persona: personaInput.value.trim(),
      voicePack: voiceSelect.value,
      prompt,
    });
    progress.textContent = `${created.name} 已生成`;
    nameInput.value = "";
    personaInput.value = "";
    promptInput.value = "";
    await refreshAvatars();
    await applyAvatar(created.id, true, true);
  } catch (error) {
    progress.textContent = String(error);
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Realtime video call: Vidu renders the character, AliRTC carries the media and
// the control socket feeds transcriptions back here, so spoken orders still
// reach the HUD while the character does the talking.
// ---------------------------------------------------------------------------

let liveCall: LiveCall | null = null;
let liveVoices: Array<{ id: string; label: string }> = [];
let liveTimer: number | undefined;
let liveElapsed = 0;

function formatClock(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes.toString().padStart(2, "0")}:${rest.toString().padStart(2, "0")}`;
}

/**
 * The call bar keeps a low profile: it is visible while the call is setting up
 * or ending, and otherwise only while the pointer rests on the digital human
 * (or on the bar itself).
 */
const CHIP_HOVER_GRACE_MS = 900;
let chipHideTimer: number | undefined;
let pointerX = -1;
let pointerY = -1;

function evaluateLiveChipHover() {
  const chip = $("#live-chip") as HTMLElement;
  const rig = $(".character-rig") as HTMLElement;
  const clearTimer = () => {
    if (chipHideTimer !== undefined) {
      window.clearTimeout(chipHideTimer);
      chipHideTimer = undefined;
    }
  };
  if (chip.hidden || pointerX < 0) {
    clearTimer();
    chip.classList.remove("is-hovered");
    return;
  }
  const inside = (rect: DOMRect, x: number, y: number) =>
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  const hovering =
    inside(rig.getBoundingClientRect(), pointerX, pointerY) ||
    inside(chip.getBoundingClientRect(), pointerX, pointerY);
  if (hovering) {
    clearTimer();
    chip.classList.add("is-hovered");
    return;
  }
  // The bar floats above the head, so reaching the hang-up button means
  // crossing a gap where the pointer is on neither: a short grace period keeps
  // the button clickable instead of yanking it away mid-travel.
  if (chipHideTimer !== undefined) window.clearTimeout(chipHideTimer);
  chipHideTimer = window.setTimeout(() => {
    chipHideTimer = undefined;
    chip.classList.remove("is-hovered");
  }, CHIP_HOVER_GRACE_MS);
}

function trackLiveChip() {
  const chip = $("#live-chip") as HTMLElement;
  window.addEventListener(
    "pointermove",
    (event) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      evaluateLiveChipHover();
    },
    { passive: true },
  );
  // The pointer left the window entirely: nothing is being hovered any more.
  window.addEventListener("pointerleave", () => {
    pointerX = -1;
    pointerY = -1;
    evaluateLiveChipHover();
  });
}

function updateLiveChip(stage: LiveStage, detail?: string) {
  const chip = $("#live-chip") as HTMLElement;
  const note = $("#live-note") as HTMLElement;
  const timer = $("#live-timer") as HTMLElement;
  const hangup = $("#live-hangup") as HTMLButtonElement;
  if (stage === "idle" || stage === "ending") {
    // Hanging up clears the bar at once: the teardown can take seconds, and the
    // master asked for the call, not for a progress report on it. The dialler
    // takes the same spot the moment the line is closed.
    chip.hidden = true;
    chip.classList.remove("is-hovered");
    window.clearInterval(liveTimer);
    liveTimer = undefined;
    return;
  }
  chip.hidden = false;
  chip.dataset.stage = stage;
  showCallChip(false);
  // The pointer may already be resting on the character when the stage
  // changes (a live call beginning, most of all): re-check instead of waiting
  // for the next mouse move to reveal or hide the bar.
  evaluateLiveChipHover();
  const labels: Record<LiveStage, string> = {
    idle: "",
    preparing: "正在准备形象…",
    connecting: "正在接通…",
    waiting: "数字人准备中…",
    live: "通话中",
    ending: "挂断中…",
    error: "出错了",
  };
  note.textContent = detail ?? labels[stage];
  hangup.disabled = false;
  hangup.textContent = "挂断";
  if (stage === "live" && liveTimer === undefined) {
    liveElapsed = 0;
    liveTimer = window.setInterval(() => {
      liveElapsed += 1;
      timer.textContent = formatClock(liveElapsed);
    }, 1000);
  }
  timer.textContent = formatClock(liveElapsed);
}

/** Spoken orders that stay local: the character keeps talking, the HUD acts. */
let liveTranscribeTimer: number | undefined;
let liveTranscribeBuffer = "";

async function handleLiveUserText(text: string) {
  const line = text.trim();
  if (!line || line === liveTranscribeBuffer) return;
  // Vidu streams the sentence as it is recognised: wait for it to settle so
  // one utterance becomes exactly one order instead of several agent turns
  // answering over each other.
  liveTranscribeBuffer = line;
  window.clearTimeout(liveTranscribeTimer);
  liveTranscribeTimer = window.setTimeout(() => {
    liveTranscribeTimer = undefined;
    const settled = liveTranscribeBuffer;
    liveTranscribeBuffer = "";
    void deliverLiveUserText(settled);
  }, 800);
}

async function deliverLiveUserText(text: string) {
  if (!text) return;
  transcript.textContent = text;
  if (matchLiveCommand(text) === "stop") {
    await endLiveCall("user_end");
    return;
  }
  const vision = matchVisionCommand(text);
  if (vision) {
    await applyVisionCommand(vision, false);
    liveCall?.say(vision === "on" ? "好，我看到你了。" : "好，我不看了。");
    return;
  }
  const called = matchCallCommand(text, avatars);
  if (called && called !== activeAvatar) {
    await dialCharacter(called, true);
    return;
  }
  const avatar = matchAvatarCommand(text, avatars);
  if (avatar && avatar !== activeAvatar) {
    await applyAvatar(avatar, true, false);
    return;
  }
  const pack = matchVoicePackCommand(text);
  if (pack) {
    await applyVoicePack(pack, false);
    return;
  }
  // Everything else is an order for Codex, not small talk: the digital human is
  // the master's face and voice, and Codex stays the brain behind it. The
  // answer comes back through speakLine(), so it is read out with matching lips.
  void runCommand(text, false);
}

/**
 * Which character the wake phrase named, if it named one. The listener reads
 * the names straight out of the character store, so a wake can arrive before
 * this window has ever listed them.
 */
async function wakeDialTarget(payload: WakeEvent): Promise<string | null> {
  const named = (payload.avatar ?? "").trim();
  if (!named || !currentWindow) return null;
  await refreshAvatars().catch(() => {});
  const target = avatars.find((avatar) => avatar.id === named);
  return target && canDial(target) ? target.id : null;
}

/** Characters with artwork of their own are the ones Vidu can render. */
function canDial(avatar: AvatarInfo | undefined): boolean {
  return Boolean(avatar && !avatar.isBuiltin && avatar.hasImage);
}

function showCallChip(show: boolean) {
  const chip = $("#call-chip") as HTMLElement;
  const name = $("#call-name") as HTMLElement;
  const live = $("#live-chip") as HTMLElement;
  const active = avatars.find((avatar) => avatar.id === activeAvatar);
  if (show && active) name.textContent = `呼叫 ${active.name}`;
  chip.hidden = !show;
  chip.classList.toggle("is-visible", show);
  // The two bars share the top of the stage: offering the dialler means the
  // call bar is done, picture or not.
  if (show) {
    live.hidden = true;
    live.classList.remove("is-hovered");
  }
}

/**
 * Clicking the still character offers the call again: the bar above her head
 * carries the dial button, and clicking anywhere else puts it away.
 */
function setupCallChip() {
  const rig = $(".character-rig") as HTMLElement;
  const chip = $("#call-chip") as HTMLElement;
  const start = $("#call-start") as HTMLButtonElement;
  rig.addEventListener("click", (event) => {
    if (liveCall?.active) return;
    event.stopPropagation();
    const active = avatars.find((avatar) => avatar.id === activeAvatar);
    if (!canDial(active)) {
      response.textContent = `${active?.name ?? "这个形象"}还没有实时形象：新建人物并导入图片后才能拨通。`;
      return;
    }
    showCallChip(!chip.classList.contains("is-visible"));
  });
  chip.addEventListener("click", (event) => event.stopPropagation());
  start.addEventListener("click", () => {
    showCallChip(false);
    void dialCharacter(activeAvatar);
  });
  document.addEventListener("click", () => showCallChip(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") showCallChip(false);
  });
}

/**
 * Dialling by name: switches to the character first (with the transformation)
 * and then opens the realtime call on her.
 */
let pendingLiveGreeting = "";

async function dialCharacter(id: string, greet = false): Promise<boolean> {
  const target = avatars.find((avatar) => avatar.id === id);
  if (!target) return false;
  if (liveCall?.active) {
    if (id === activeAvatar) return true;
    await endLiveCall("switch", false);
  }
  if (id !== activeAvatar) await applyAvatar(id, true, false);
  if (!canDial(target)) {
    response.textContent = `${target.name}还没有实时形象，先给她导入一张图片吧。`;
    speakLine(`${target.name}还没有实时形象，先给她导入一张图片吧。`);
    return false;
  }
  pendingLiveGreeting = greet && !liveCall?.active ? target.greeting?.trim() ?? "" : "";
  await startLiveCall();
  return Boolean(liveCall?.active);
}

async function startLiveCall() {
  if (liveCall?.active) return;
  showCallChip(false);
  const canvas = $("#live-character") as HTMLCanvasElement;
  response.textContent = "正在接通实时数字人…";
  setMode("voice-starting");
  // One voice in the room: a connected digital human owns the line, so the
  // official Codex Voice session (if one is open) stands down and the local
  // wake listener releases the microphone before WebRTC asks for it.
  if (state.directVoice?.voiceActive || peer) {
    await stopDirectVoice().catch(() => {});
  }
  await invoke("disarm_wake_listener").catch(() => {});
  const call = new LiveCall(canvas, {
    onStage: (stage, detail) => {
      updateLiveChip(stage, detail);
      // Dialling has its own look: the character stays on screen while the
      // line is being opened, so the wait reads as "connecting", not "broken".
      const dialing = stage === "preparing" || stage === "connecting" || stage === "waiting";
      shell.classList.toggle("is-dialing", dialing);
      updateIdleVisibility();
      if (stage === "live") {
        setMode("listening");
        if (pendingLiveGreeting) {
          const line = pendingLiveGreeting;
          pendingLiveGreeting = "";
          window.setTimeout(() => call.say(line), 450);
        }
      } else if (dialing) {
        setMode("voice-starting");
      } else if (stage === "idle") {
        setMode(state.manualStop ? "stopped" : "ready");
      }
    },
    onUserText: (text) => void handleLiveUserText(text),
    onBotText: (text) => {
      response.textContent = text;
    },
    onError: (message) => {
      response.textContent = message;
    },
    onHangup: (reason) => void endLiveCall(reason, false),
    onVideo: () => {
      // The character stays on screen until a frame arrives whose backdrop is
      // actually gone (see the reveal in live.ts), so the HUD never shows the
      // digital human inside a video rectangle — not even for a moment.
      canvas.hidden = false;
      characterImage.hidden = true;
      shell.classList.add("video-live");
      updateIdleVisibility();
    },
    onVideoLost: () => {
      // The set came back mid-call: the idle animation is the better picture,
      // and it keeps moving instead of freezing over a video rectangle.
      canvas.hidden = true;
      characterImage.hidden = false;
      shell.classList.remove("video-live");
      updateIdleVisibility();
    },
    onBackdrop: (mode, sample) => {
      // Logged so a bad key on a real machine can be diagnosed after the fact.
      const detail = sample
        ? `背景色 rgb(${sample.color.r},${sample.color.g},${sample.color.b})，波动 ${sample.spread.toFixed(1)}`
        : "未采样";
      const label = mode === "rekeyed" ? "背景已重新采样" : "背景处理";
      void invoke("web_log", { message: `实时${label}：${mode}（${detail}）` }).catch(() => {});
    },
    onBilling: ({ seconds, credits }) => {
      const cost = credits === null ? "" : ` · 消耗 ${credits} 积分`;
      response.textContent = `通话结束，共 ${formatClock(seconds)}${cost}。`;
    },
  });
  liveCall = call;
  shell.classList.remove("video-live");
  try {
    await call.start(activeAvatar, { publishCamera: visionEnabled });
    shell.classList.add("is-live-call");
    updateIdleVisibility();
  } catch (error) {
    liveCall = null;
    canvas.hidden = true;
    shell.classList.remove("is-live-call");
    shell.classList.remove("is-dialing");
    updateLiveChip("idle");
    setMode("degraded");
    response.textContent = `实时对话打不开：${String(error)}`;
    void invoke("web_log", { message: `实时通话打不开：${String(error)}` }).catch(() => {});
    // The dial failed: hand the microphone back so "嗨 Jarvis" still works.
    await armWakeListener().catch(() => {});
  }
}

async function endLiveCall(reason = "user_end", announce = true) {
  const call = liveCall;
  liveCall = null;
  // The bar goes first: teardown talks to the network, and the master should
  // not be left looking at a "挂断中" chip afterwards.
  updateLiveChip("idle");
  if (call) await call.stop(reason).catch(() => null);
  const canvas = $("#live-character") as HTMLCanvasElement;
  canvas.hidden = true;
  characterImage.hidden = false;
  shell.classList.remove("is-live-call");
  shell.classList.remove("is-dialing");
  shell.classList.remove("video-live");
  // Back to the idle animation; the local loop picks up where the call left
  // off instead of leaving a frozen portrait on screen.
  updateIdleVisibility();
  pendingLiveGreeting = "";
  await armWakeListener().catch(() => {});
  if (announce) setMode("ready");
  // The next call is one click away, so the dialler is what stays on screen.
  const active = avatars.find((avatar) => avatar.id === activeAvatar);
  if (canDial(active)) showCallChip(true);
}

/// Local speech goes through the digital human while a call is up, so there is
/// only ever one voice in the room: the agent never answers with its own voice
/// while Vidu is connected, it hands the line to the digital human instead.
function speakLine(text: string) {
  const line = text.trim();
  if (!line) return;
  if (liveCall?.active) {
    liveCall.say(line);
    return;
  }
  void invoke("speak", { text: line }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Camera presence: the helper publishes small JPEG frames, the HUD polls them
// and shows the self view. The same helper reports the expression estimate.
// ---------------------------------------------------------------------------

let cameraTimer: number | undefined;
let cameraBusy = false;
let lastCameraFrame = "";
let visionEnabled = false;

async function pumpCameraFrame() {
  if (cameraBusy || !currentWindow) return;
  cameraBusy = true;
  try {
    const frame = await invoke<string | null>("camera_frame");
    if (frame) {
      if (frame !== lastCameraFrame) {
        lastCameraFrame = frame;
        selfViewImage.src = frame;
      }
      selfView.hidden = false;
      visionPollCounter += 1;
      if (visionPollCounter % 40 === 0) void pollVisionStatus();
    } else if (lastCameraFrame) {
      lastCameraFrame = "";
      selfView.hidden = true;
    }
  } catch {
    // The camera is optional: a refused permission must not break the HUD.
  } finally {
    cameraBusy = false;
  }
}

/// Only the polling loop lives here; the helper process is owned by
/// `set_vision_enabled`, so "off" really means no camera.
function setCameraLoop(active: boolean) {
  if (active) {
    if (cameraTimer === undefined) cameraTimer = window.setInterval(() => void pumpCameraFrame(), 145);
  } else {
    if (cameraTimer !== undefined) window.clearInterval(cameraTimer);
    cameraTimer = undefined;
    lastCameraFrame = "";
    selfView.hidden = true;
  }
}

function syncCameraToggle(enabled: boolean) {
  const toggle = $("#camera-toggle") as HTMLInputElement | null;
  if (toggle) toggle.checked = enabled;
}

/// One-shot capability probe for the realtime digital human: a WKWebView that
/// refuses WebRTC would make the whole video mode impossible, and there is no
/// console to ask.
async function probeRealtimeSupport() {
  const notes: string[] = [
    `peer=${typeof RTCPeerConnection}`,
    `mediaDevices=${navigator.mediaDevices ? "yes" : "no"}`,
    `getUserMedia=${typeof navigator.mediaDevices?.getUserMedia}`,
    `codecs=${typeof RTCRtpSender?.getCapabilities === "function" ? "ok" : "n/a"}`,
  ];
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    notes.push(`gum=ok tracks=${stream.getTracks().map((track) => track.kind).join("+")}`);
    for (const track of stream.getTracks()) track.stop();
  } catch (error) {
    notes.push(`gum=failed:${String(error)}`);
  }
  void invoke("web_log", { message: notes.join(" | ") }).catch(() => {});
}

async function refreshVision() {
  if (!currentWindow) return;
  let status: VisionStatus | null = null;
  try {
    status = await invoke<VisionStatus>("vision_status");
  } catch {
    return;
  }
  visionEnabled = status.enabled === true;
  applyVisionError(status.error);
  syncCameraToggle(visionEnabled);
  setCameraLoop(visionEnabled);
}

/// Turning the camera on asks macOS first: a refused permission must not look
/// like a broken component, it must send the master to the right checkbox.
async function startVision(): Promise<{ ok: boolean; message: string }> {
  if (!currentWindow) return { ok: false, message: "视觉组件只在本机运行。" };
  const authorization = await invoke<string>("request_camera_permission").catch(() => "unknown");
  if (authorization !== "authorized") {
    applyVisionError("摄像头权限被拒绝，视觉感知暂时不可用。");
    return { ok: false, message: "摄像头权限被拒绝了，请到系统设置 → 隐私与安全性 → 摄像头里允许 Jarvis Codex。" };
  }
  await invoke("set_vision_enabled", { enabled: true }).catch(() => null);
  await refreshVision();
  return { ok: true, message: "好，视觉组件启动了，我能看到你了。" };
}

async function stopVision(): Promise<string> {
  if (!currentWindow) return "视觉组件已经关闭。";
  await invoke("set_vision_enabled", { enabled: false }).catch(() => null);
  await refreshVision();
  return "好，我把眼睛闭上，不看了。";
}

async function applyVisionCommand(command: "on" | "off", announce: boolean) {
  if (command === "on") {
    const result = await startVision();
    response.textContent = result.message;
    if (announce && currentWindow && result.ok) speakLine(result.message);
    return;
  }
  const message = await stopVision();
  response.textContent = message;
  if (announce && currentWindow) speakLine(message);
}

function applyVisionSignal(payload: VisionSignal | null) {
  const faces = payload?.faces ?? 0;
  const label = $("#mood-label");
  const detail = $("#mood-detail");
  if (!faces) {
    label.textContent = "视觉感知中";
    detail.textContent = "还没看到人，坐到我面前吧";
    return;
  }
  const emotion = payload?.emotion ?? "neutral";
  label.textContent = `看到你了 · ${MOOD_LABELS[emotion] ?? "平静"}`;
  const distance = payload?.distance ?? 0;
  detail.textContent = distance > 0.34 ? "离得很近" : distance < 0.13 ? "离得有点远" : "距离刚好";
}

/// A refused camera must be one click away from being fixed: macOS remembers
/// the refusal, so waiting for another prompt would never resolve.
function applyVisionError(message: string | null | undefined) {
  const hint = $("#vision-status") as HTMLElement;
  if (!message) {
    hint.hidden = true;
    hint.textContent = "";
    selfView.classList.remove("blocked");
    return;
  }
  hint.hidden = false;
  hint.textContent = "";
  const text = document.createElement("span");
  text.textContent = `${message} `;
  const fix = document.createElement("button");
  fix.type = "button";
  fix.className = "vision-fix";
  fix.textContent = "打开系统设置";
  fix.addEventListener("click", () => void invoke("open_camera_settings").catch(() => {}));
  hint.append(text, fix);
  selfView.classList.add("blocked");
}

let visionPollCounter = 0;

async function pollVisionStatus() {
  if (!currentWindow) return;
  try {
    const status = await invoke<{ enabled: boolean; running: boolean; preferred: boolean; error?: string | null }>("vision_status");
    applyVisionError(status.error);
  } catch {
    // Status is advisory; a failure here must not disturb the HUD.
  }
}

async function initCameraToggle() {
  const toggle = $("#camera-toggle") as HTMLInputElement | null;
  if (!toggle || !currentWindow) return;
  await refreshVision();
  toggle.addEventListener("change", () => {
    void applyVisionCommand(toggle.checked ? "on" : "off", false);
  });
}

async function applyVoicePack(id: string, announce = false) {
  try {
    await invoke("set_voice_pack", { id });
  } catch (error) {
    response.textContent = `切换语音包失败：${String(error)}`;
    return;
  }
  voicePack = id;
  if (settings.open) void refreshVoicePacks();
  response.textContent = `语音包已切换为“${VOICE_PACK_SPEECH[id] ?? id}”。`;
  if (announce) {
    speakLine(`好，已经换成${VOICE_PACK_SPEECH[id] ?? id}。`);
  }
}

async function refreshVoicePacks() {
  const container = $("#voice-packs");
  let packs: VoicePackInfo[];
  try {
    packs = await invoke<VoicePackInfo[]>("voice_packs");
  } catch (error) {
    container.innerHTML = "";
    const failed = document.createElement("p");
    failed.className = "voice-loading";
    failed.textContent = `语音包不可用：${String(error)}`;
    container.append(failed);
    return;
  }
  container.innerHTML = "";
  for (const pack of packs) {
    const row = document.createElement("label");
    if (pack.active) {
      voicePack = pack.id;
      row.classList.add("active");
    }
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "voice-pack";
    radio.value = pack.id;
    radio.checked = pack.active;
    radio.addEventListener("change", async () => {
      if (!radio.checked) return;
      voicePack = pack.id;
      try {
        await invoke("set_voice_pack", { id: pack.id });
      } catch (error) {
        response.textContent = `切换语音包失败：${String(error)}`;
        return;
      }
      for (const other of container.querySelectorAll("label")) {
        other.classList.toggle("active", other === row);
      }
      response.textContent = `语音包已切换为“${pack.label}”。Jarvis 下一次回答就会用这个音色。`;
    });
    const text = document.createElement("span");
    const title = document.createElement("b");
    title.textContent = pack.label;
    const note = document.createElement("small");
    note.textContent = pack.online ? "微软神经语音 · 在线合成后本机缓存" : "本机离线语音";
    text.append(title, note);
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "voice-preview";
    preview.textContent = "试听";
    preview.addEventListener("click", async (event) => {
      event.preventDefault();
      preview.disabled = true;
      try {
        await invoke("preview_voice", { id: pack.id });
      } catch (error) {
        response.textContent = `试听失败：${String(error)}`;
      } finally {
        preview.disabled = false;
      }
    });
    row.append(radio, text, preview);
    container.append(row);
  }
}

function syncPermissionControls() {
  const input = document.querySelector<HTMLInputElement>(
    `input[name="permission-mode"][value="${permissionMode}"]`,
  );
  if (input) input.checked = true;
  $("#permission-mode-label").textContent = permissionLabels[permissionMode];
}

$("#settings").addEventListener("click", () => {
  syncPermissionControls();
  void refreshVoicePacks();
  settings.showModal();
  void refreshAvatars();
});
$("#close-settings").addEventListener("click", () => settings.close());
$("#new-thread").addEventListener("click", async () => {
  const button = $("#new-thread") as HTMLButtonElement;
  button.disabled = true;
  state.manualStop = true;
  settings.close();
  response.textContent = "正在结束当前任务并创建新的 Codex thread…";
  try {
    if (state.directVoice?.voiceActive || peer) {
      try { await stopDirectVoice(); } catch { cleanupPeer(); }
    }
    try { await invoke("stop_all"); } catch { /* no active runtime */ }
    await invoke("shutdown");
    const freshSession = await invoke<Session>("start_jarvis", {
      cwd: workspace,
      threadId: null,
      permissionMode,
    });
    state.session = freshSession;
    state.directVoice = null;
    localStorage.setItem(`${THREAD_KEY_PREFIX}${workspace}`, freshSession.threadId);
    $("#thread-id").textContent = freshSession.threadId;
    $("#workspace").textContent = freshSession.cwd;
    userTranscriptBuffer = "";
    assistantTranscriptBuffer = "";
    agentMessageBuffer = "";
    transcript.textContent = "“新开线程”";
    response.textContent = "新的 Codex thread 已创建。下一次唤醒和文字任务都会进入这个线程。";
    setMode("ready");
    setWorker("orchestrator", "Fresh thread ready");
  } catch (error) {
    try { await invoke("shutdown"); } catch { /* already stopped */ }
    state.session = null;
    state.directVoice = null;
    setMode("degraded");
    response.textContent = `新建线程失败，原线程仍可续接：${String(error)}`;
  } finally {
    button.disabled = false;
    await armWakeListener();
  }
});
$("#save-settings").addEventListener("click", async () => {
  const nextWorkspace = ($("#workspace-setting") as HTMLInputElement).value.trim();
  if (!nextWorkspace) return;
  const selectedPermission = document.querySelector<HTMLInputElement>(
    'input[name="permission-mode"]:checked',
  )?.value as PermissionMode | undefined;
  const nextPermission = selectedPermission ?? permissionMode;
  if (nextWorkspace !== workspace) {
    localStorage.setItem(WORKSPACE_KEY, nextWorkspace);
    response.textContent = "工作目录已保存，重启 Jarvis 后生效。";
  }
  if (nextPermission !== permissionMode) {
    state.manualStop = true;
    if (state.directVoice?.voiceActive || peer) {
      try { await stopDirectVoice(); } catch { cleanupPeer(); }
    }
    try { await invoke("stop_all"); } catch { /* no active runtime */ }
    await invoke("shutdown");
    permissionMode = nextPermission;
    localStorage.setItem(PERMISSION_KEY, permissionMode);
    state.session = null;
    state.directVoice = null;
    syncPermissionControls();
    setMode("ready");
    response.textContent = `权限已切换为“${permissionLabels[permissionMode]}”，下一次任务将续接当前 Codex thread。`;
    await armWakeListener();
  }
  settings.close();
});
for (const [selector, approved] of [["#approve", true], ["#deny", false]] as const) {
  $(selector).addEventListener("click", async () => { await invoke("resolve_server_request", { requestId: approvalId, approved }); approval.close(); });
}

if (currentWindow) {
  try {
    workspace = localStorage.getItem(WORKSPACE_KEY)
      ?? await invoke<string>("default_workspace");
    localStorage.setItem(WORKSPACE_KEY, workspace);
    $("#thread-id").textContent = "Not started";
    $("#workspace").textContent = workspace;
    ($("#workspace-setting") as HTMLInputElement).value = workspace;
    syncPermissionControls();
    setWorker("orchestrator", "Wake word starting");
    // Jarvis boots out of the particle field every launch, in every mode:
    // text mode used to jump straight to ready and never showed the assembly.
    setMode("booting");
    window.setTimeout(() => {
      if (state.mode === "booting") setMode("ready");
    }, FORMATION_DURATION);
    // Read the mode before arming: a wake that arrives while this window is
    // still booting must already know that Codex Voice is off.
    textOnlyMode = await invoke<boolean>("voice_text_only");
    speakReplies = await invoke<boolean>("speak_replies");
    // Arm the listener early: the macOS microphone sheet can take a long time
    // (and never answers when Jarvis was launched by the wake helper), while a
    // wake without a listener would end the conversation it just started.
    await armWakeListener();
    const backgroundStart = await invoke<boolean>("startup_is_background");
    if (!backgroundStart) void requestMicrophoneAuthorization();
    updateVoiceInfo(await invoke<DirectVoice>("direct_voice_status"));
    await refreshVoicePacks();
    await refreshAvatars();
    // Whoever is active is who is on screen: the HUD launching with the helmet
    // while the character store says 张元英 would make every dial ambiguous.
    const startingAvatar = avatars.find((item) => item.id === activeAvatar);
    if (startingAvatar && !startingAvatar.isBuiltin) {
      await applyAvatarArt(startingAvatar).catch(() => {});
    }
    await initCameraToggle();
    const cameraStatus = await invoke<{ preferred: boolean }>("vision_status").catch(() => null);
    // The camera stays off until it is asked for by voice or by the switch.
    await refreshVision();
    void probeRealtimeSupport();
    if (textOnlyMode) {
      $("#voice-auth").textContent = "Voice off · DeepSeek text mode";
      ($("#command-input") as HTMLInputElement).placeholder = "输入任务后回车，交给 Codex 执行…";
    }
    if (await invoke<boolean>("consume_cold_wake")) {
      transcript.textContent = "“嗨，Jarvis”";
      if (textOnlyMode) {
        setMode("ready");
        setWorker("orchestrator", "Wake word armed");
        response.textContent = "我在，请说指令…（也可以直接打字）";
        ($("#command-input") as HTMLInputElement).focus();
        // Text mode keeps the spoken conversation, so the microphone has to
        // stay armed after a cold wake too.
        await armWakeListener();
        // The wake-only listener that heard "嗨 Jarvis" is gone with the launch,
        // and the new one never heard the phrase: open the conversation so the
        // repeated sentence is captured.
        await invoke("resume_wake_conversation").catch(() => {});
        // A cold wake means Jarvis was not running: the sentence that woke it
        // could not be executed, so greet the master and invite the order —
        // with the microphone open, so it is not swallowed by the greeting.
        void invoke("wake_greeting");
      }
    }
  } catch (error) { setMode("stopped"); response.textContent = `启动失败：${String(error)}`; }
} else {
  workspace = "Visual preview · native systems disconnected";
  $("#thread-id").textContent = "Preview only";
  $("#workspace").textContent = workspace;
  ($("#workspace-setting") as HTMLInputElement).value = workspace;
  $("#wake-auth").textContent = "Preview · not connected";
  $("#voice-auth").textContent = "Preview · not connected";
  transcript.textContent = visualPreviewMode === "stopped" ? "“停下”" : "“嗨，Jarvis”";
  response.textContent = visualPreviewMode === "voice-starting"
    ? "正在从粒子中重构 Jarvis 核心…"
    : visualPreviewMode === "working"
      ? "Codex 正在执行任务，装甲能量切换为工作态。"
      : visualPreviewMode === "speaking"
        ? "语音输出正在驱动角色光效与声波。"
        : visualPreviewMode === "stopped"
          ? "所有任务已中断，等待下一次唤醒。"
          : "Jarvis 视觉系统预览就绪。";
  setMode(visualPreviewMode);
  if (["acknowledge", "approval", "complete", "error"].includes(previewActionValue ?? "")) {
    window.setTimeout(() => triggerCharacterAction(previewActionValue as CharacterAction, 1800), 180);
  }
  setWorker("orchestrator", visualPreviewMode === "working" ? "Codex working" : "Visual preview");
  if (visualPreviewMode === "working") {
    setWorker("developer", "Working");
  }
}

async function requestMicrophoneAuthorization() {
  try {
    const authorization = await invoke<string>("request_microphone_permission");
    if (authorization === "authorized") return;
    setMode("degraded");
    banner.hidden = false;
    $("#degraded-copy").textContent =
      "请在系统设置 → 隐私与安全性 → 麦克风中允许 Jarvis Codex。";
  } catch (error) {
    setMode("degraded");
    banner.hidden = false;
    $("#degraded-copy").textContent = String(error);
  }
}

async function armWakeListener() {
  try {
    state.wake = await invoke<WakeStatus>("arm_wake_listener");
    $("#wake-auth").textContent = state.wake.ready ? "Local listener ready" : state.wake.authorization;
    if (["denied", "restricted"].includes(state.wake.authorization)) {
      setMode("degraded");
      banner.hidden = false;
      $("#degraded-copy").textContent = "请在系统设置 → 隐私与安全性中允许麦克风和语音识别。";
    }
  } catch (error) {
    $("#wake-auth").textContent = String(error);
  }
}
