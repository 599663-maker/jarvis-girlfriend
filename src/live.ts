// Realtime video call with the active character, powered by Vidu S1.
//
// Two links run in parallel: AliRTC carries the media (we publish the
// microphone, Vidu pushes the digital human back) and a control WebSocket
// carries text, barge-in and hang-up. The socket authenticates with the
// per-session `client_secret`, so the account API key stays in the Rust side.
//
// The digital human arrives as an ordinary video stream with a background, so
// every frame is drawn through the chroma keyer in chroma.ts. That is what puts
// the character on the HUD instead of inside a video rectangle.

import { invoke } from "@tauri-apps/api/core";
import { createVideoKeyer, readBackdropClearance, type KeySample, type VideoKeyer } from "./chroma";

export type LiveStage =
  | "idle"
  | "preparing"
  | "connecting"
  | "waiting"
  | "live"
  | "ending"
  | "error";

export type LiveHandlers = {
  onStage(stage: LiveStage, detail?: string): void;
  onUserText?(text: string): void;
  onBotText?(text: string): void;
  onError?(message: string): void;
  onHangup?(reason: string): void;
  onBackdrop?(mode: "keyed" | "rekeyed" | "plain", sample: KeySample | null): void;
  /** Fired once a keyed frame has taken the stage; see `revealFrames`. */
  onVideo?(): void;
  /** Fired when the picture has to go back to the still, keying having failed. */
  onVideoLost?(): void;
  onBilling?(info: { seconds: number; credits: number | null }): void;
};

type RtcCredentials = {
  app_id?: string;
  appId?: string;
  channel_id?: string;
  channelId?: string;
  user_id?: string;
  userId?: string;
  token: string;
  token_expire_at?: string;
  nonce?: string;
};

const RTC_SDK_URL = "/vendor/aliyun-rtc-sdk.js";
/** Aliyun's connection states, spelled out because the log is the only trace. */
const CONNECTION_STATES = [
  "初始化",
  "已断开",
  "连接中",
  "已连接",
  "重连中",
  "失败",
];
const CONTROL_HOST = "api.vidu.cn";
const CONN_INIT_BACKOFF = [2000, 4000, 8000];
const KEY_RETRY_MS = 700;

type AnyEngine = Record<string, any>;

let sdkPromise: Promise<any> | null = null;

function loadRtcSdk(): Promise<any> {
  const existing = (window as any).AliRtcEngine;
  if (existing) return Promise.resolve(existing);
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = RTC_SDK_URL;
      script.async = true;
      script.onload = () => {
        const sdk = (window as any).AliRtcEngine;
        if (sdk) resolve(sdk);
        else reject(new Error("阿里云 RTC SDK 没有加载成功"));
      };
      script.onerror = () => reject(new Error("阿里云 RTC SDK 没有加载成功"));
      document.head.appendChild(script);
    });
  }
  return sdkPromise;
}

/** Progress notes land in web.log so a stuck call can be read after the fact. */
function trace(message: string) {
  void invoke("web_log", { message: `实时通话：${message}` }).catch(() => {});
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function rtcEnum(group: string, key: string, fallback: number): number {
  const namespace = (window as any).AliRtcEngine ?? {};
  const engine = namespace.default ?? namespace.AliRtcEngine ?? namespace;
  return engine?.[group]?.[key] ?? namespace?.[group]?.[key] ?? fallback;
}

/** How much of two lines is the same speech, ignoring punctuation. */
export function speechOverlap(a: string, b: string): number {
  const normalize = (value: string) => value.replace(/[，。！？、,.!?～~\s“”"'：:]/g, "");
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  const shorter = x.length < y.length ? x : y;
  const longer = x.length < y.length ? y : x;
  let best = 0;
  const previous = new Array<number>(shorter.length + 1).fill(0);
  for (let i = 1; i <= longer.length; i += 1) {
    const current = new Array<number>(shorter.length + 1).fill(0);
    for (let j = 1; j <= shorter.length; j += 1) {
      if (longer[i - 1] === shorter[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    for (let j = 0; j <= shorter.length; j += 1) previous[j] = current[j];
  }
  return (2 * best) / (x.length + y.length);
}

export class LiveCall {
  private readonly canvas: HTMLCanvasElement;
  private readonly handlers: LiveHandlers;
  private readonly video: HTMLVideoElement;
  private keyer: VideoKeyer | null = null;
  private engine: AnyEngine | null = null;
  private socket: WebSocket | null = null;
  private frameHandle = 0;
  private retryTimer = 0;
  private detectionTimer = 0;
  private connAttempt = 0;
  private stage: LiveStage = "idle";
  private liveId = "";
  private clientSecret = "";
  private botUserId = "";
  private startedAtMs = 0;
  private stopping = false;
  private keyAttempts = 0;
  private framesSeen = 0;
  /** Whether the keyed picture (rather than the still) is on the stage. */
  private revealed = false;
  private revealChecks = 0;
  private lastRevealCheck = 0;
  /** The keyed backdrop drifted and the frame is waiting for a fresh sample. */
  private keyStale = false;
  private probe: HTMLCanvasElement | null = null;
  private opened = false;
  private localOptions: { publishCamera?: boolean } = {};
  /** Users the platform uses for the digital human's picture and voice. */
  private readonly mediaUsers = new Set<string>();
  /**
   * Last subscribe state per remote user. AliRTC reports 0 idle, 1 no-subscribe,
   * 2 subscribing, 3 subscribed — and asking again while a request is running
   * throws the state back to 2, which is exactly how the picture never arrives.
   */
  private readonly subState = new Map<string, number>();
  private readonly subRequested = new Set<string>();
  /** Lines waiting to be read out, so one utterance never cuts another off. */
  private readonly speechQueue: string[] = [];
  private speechTimer = 0;
  /** What the digital human was asked to say recently, for echo detection. */
  private readonly spokenLog: Array<{ text: string; at: number }> = [];
  /** Lines sent as "朗读：…" while they are still in her mouth. */
  private readonly sentLines: Array<{ text: string; at: number }> = [];
  /** Debounces the interrupt that cuts off a self-started answer. */
  private botInterruptTimer = 0;
  /** A "朗读：…" line is expected to be on her lips until this moment. */
  private readingUntil = 0;
  private static readonly SPEECH_CHARS_PER_SECOND = 4.5;
  private static readonly SPEECH_TAIL_MS = 800;
  private static readonly ECHO_WINDOW_MS = 90000;
  private static readonly SENT_LINE_WINDOW_MS = 120000;

  constructor(canvas: HTMLCanvasElement, handlers: LiveHandlers) {
    this.canvas = canvas;
    this.handlers = handlers;
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    // `display: none` never decodes on WebKit: the frames (and with them
    // `videoWidth`) only exist while the element is part of the layout, so the
    // element is parked off-screen instead of hidden.
    // It has to sit inside the viewport: WebKit stops decoding video elements
    // that are parked off-screen, and an undecoded element never reports a
    // picture size for the keyer to draw.
    video.style.cssText =
      "position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;";
    video.addEventListener("loadedmetadata", () => trace(`画面参数 ${video.videoWidth}x${video.videoHeight}`));
    video.addEventListener("resize", () => trace(`画面尺寸 ${video.videoWidth}x${video.videoHeight}`));
    document.body.appendChild(video);
    this.video = video;
    this.keyer = createVideoKeyer(canvas);
  }

  get active(): boolean {
    return this.stage !== "idle" && this.stage !== "error";
  }

  get startedAt(): number {
    return this.startedAtMs;
  }

  get callId(): string {
    return this.liveId;
  }

  private setStage(stage: LiveStage, detail?: string) {
    this.stage = stage;
    this.handlers.onStage(stage, detail);
  }

  /** Creates the session, joins the RTC channel and starts the control socket. */
  async start(avatarId?: string | null, options: { publishCamera?: boolean } = {}): Promise<void> {
    if (this.active) return;
    this.stopping = false;
    this.keyAttempts = 0;
    this.framesSeen = 0;
    this.revealed = false;
    this.revealChecks = 0;
    this.lastRevealCheck = 0;
    this.keyStale = false;
    this.opened = false;
    this.mediaUsers.clear();
    this.subState.clear();
    this.subRequested.clear();
    this.setStage("preparing", "正在创建 Vidu 实时会话…");
    const session = await invoke<{
      liveId: string;
      rtc: RtcCredentials;
      clientSecret: string;
      avatarId: string;
      avatarName: string;
      voice: string;
    }>("videolive_start", { avatarId: avatarId ?? null });

    this.liveId = session.liveId;
    this.clientSecret = session.clientSecret;
    this.botUserId = botUserIdFrom(session.rtc, session.liveId);
    this.setStage("connecting", `${session.avatarName} · ${session.voice}`);
    trace(
      `来源 ${location.origin} · 安全上下文 ${describe(window.isSecureContext)}`
      + ` · 采集 ${navigator.mediaDevices ? "可用" : "不可用"}`,
    );
    trace(`会话已创建 ${session.liveId}`);
    // Vidu only counts the call as joined once the control link says hello, and
    // it hangs the session up if that hello never lands. The media join can take
    // a while on WebKit, so the control link goes first and the two run in
    // parallel instead of one waiting behind the other.
    this.connectControl();

    const sdk = await loadRtcSdk();
    trace("RTC SDK 已加载");
    const support = await sdk?.isSupported?.().catch(() => null);
    if (support && support.support === false) {
      throw new Error("这台机器的 WebView 不支持阿里云 RTC");
    }
    trace(`WebView 能力 ${describe(support?.detail ?? support)}`);
    const Engine = sdk?.default ?? sdk?.AliRtcEngine ?? sdk;
    const engine: AnyEngine = Engine?.createInstance ? Engine.createInstance() : Engine.getInstance();
    this.engine = engine;
    this.bindEngineEvents(engine);
    engine.setChannelProfile?.(
      rtcEnum("AliRtcSdkChannelProfile", "AliRtcSdkInteractiveLive", 1) || "interactive_live",
    );
    await engine.setClientRole?.(rtcEnum("AliRtcSdkClientRole", "AliRtcSdkInteractive", 2) || "interactive");
    engine.setAudioOnlyMode?.(false);
    engine.setDefaultSubscribeAllRemoteAudioStreams?.(false);
    engine.setDefaultSubscribeAllRemoteVideoStreams?.(false);
    // The order matches Vidu's own client: join, publish the microphone, then
    // subscribe. Subscribing before the engine is in the channel is what left
    // the earlier builds on a still picture.
    this.localOptions = options;
    await this.joinChannelWithTimeout(engine, session.rtc, 15000);
    await this.openCall(engine);
  }

  /** Publishes the microphone (and the camera when the eyes are open). */
  private async readyLocalMedia(engine: AnyEngine, options: { publishCamera?: boolean }) {
    try {
      await engine.publishLocalAudioStream?.(true);
      await engine.startAudioCapture?.();
      trace("麦克风已接入通话");
    } catch (error) {
      trace(`麦克风不可用：${describe(error)}`);
    }
    if (!options.publishCamera) return;
    try {
      await engine.publishLocalVideoStream?.(true);
      trace("摄像头已接入通话");
    } catch (error) {
      trace(`摄像头不可用：${describe(error)}`);
    }
  }

  /**
   * Joining takes a moment and WebKit may settle the promise late, so this runs
   * from either signal — the join promise or the "connected" status — and only
   * the first one through does the work.
   */
  private async openCall(engine: AnyEngine) {
    if (this.opened) return;
    this.opened = true;
    this.startedAtMs = Date.now();
    this.startRenderLoop();
    await this.readyLocalMedia(engine, this.localOptions);
    this.subscribeAll(engine);
    this.ensureFrames();
  }

  /** Every user the platform uses to carry the digital human's media. */
  private subscribeAll(engine: AnyEngine) {
    const targets = new Set<string>(this.mediaUsers);
    if (this.botUserId) targets.add(this.botUserId);
    for (const uid of targets) void this.subscribe(engine, uid);
  }

  /**
   * Joining can take a dozen seconds on WebKit and older builds never settle
   * the promise at all, so the wait is bounded: the call stays usable and the
   * trace records which side gave up.
   */
  private async joinChannelWithTimeout(engine: AnyEngine, rtc: RtcCredentials, limit = 45000) {
    const started = Date.now();
    const joined = this.joinChannel(engine, rtc)
      .then(() => {
        trace(`已入会，用时 ${Math.round((Date.now() - started) / 1000)} 秒`);
        if (!this.stopping) void this.openCall(engine);
        return true;
      })
      .catch((error) => {
        trace(`入会失败：${describe(error)}`);
        return false;
      });
    const expired = new Promise<boolean>((resolve) => {
      window.setTimeout(() => resolve(false), limit);
    });
    const ok = await Promise.race([joined, expired]);
    if (!ok && Date.now() - started >= limit) {
      trace(`入会等待超过 ${Math.round(limit / 1000)} 秒，先继续`); 
    }
  }

  private async joinChannel(engine: AnyEngine, rtc: RtcCredentials) {
    const user = rtc.user_id ?? rtc.userId ?? "";
    try {
      await engine.joinChannel(rtc.token, user);
      return;
    } catch (error) {
      // Older builds want the split auth object instead of the packed token.
      const authInfo = {
        appId: rtc.app_id ?? rtc.appId,
        channelId: rtc.channel_id ?? rtc.channelId,
        userId: user,
        token: rtc.token,
        timestamp: Number(rtc.token_expire_at ?? Math.floor(Date.now() / 1000) + 600),
        nonce: rtc.nonce,
      };
      await engine.joinChannel(authInfo, user);
    }
  }

  private bindEngineEvents(engine: AnyEngine) {
    const on = engine.on?.bind(engine);
    if (!on) return;
    const consider = (uid?: string) => {
      if (!uid || !isDigitalHumanUser(uid, this.botUserId)) return;
      if (uid.startsWith("live-video-push-") || uid.startsWith("live-bot-")) this.botUserId = this.botUserId || uid;
      this.mediaUsers.add(uid);
      void this.subscribe(engine, uid);
    };
    on("connectionStatusChange", (status: number, reason: number) => {
      trace(`RTC 连接状态 ${CONNECTION_STATES[status] ?? status}（原因 ${reason}）`);
      // The join promise is the official signal, but the status event is the
      // one WebKit always delivers: whichever lands first opens the call.
      if (status === 3 && !this.stopping) void this.openCall(engine);
    });
    on("remoteUserOnLineNotify", (uid: string) => {
      trace(`远端用户上线 ${uid}`);
      consider(uid);
    });
    on("remoteTrackAvailableNotify", (uid: string) => {
      trace(`远端媒体可用 ${uid}`);
      consider(uid);
    });
    on("remoteUserOffLineNotify", (uid: string) => trace(`远端用户离线 ${uid}`));
    on("audioSubscribeStateChanged", (uid: string, _old: number, state: number) => {
      if (isDigitalHumanUser(uid, this.botUserId)) trace(`声音订阅状态 ${state}`);
    });
    on("screenShareSubscribeStateChanged", (uid: string, _old: number, state: number) => {
      if (isDigitalHumanUser(uid, this.botUserId) && state === 3) this.attachView(engine, uid, 2);
    });
    on("videoSubscribeStateChanged", (uid: string, _old: number, state: number) => {
      if (!isDigitalHumanUser(uid, this.botUserId)) return;
      this.subState.set(uid, state);
      trace(`视频订阅状态 ${state}`);
      if (state === 3) this.attachView(engine, uid);
    });
    on("remoteAudioAutoPlayFail", () => {
      this.handlers.onError?.("浏览器的自动播放策略挡住了数字人的声音，点一下窗口再试。");
    });
    on("bye", (code: number) => {
      if (!this.stopping) this.handlers.onHangup?.(`连接被关闭（${code}）`);
    });
  }

  private async subscribe(engine: AnyEngine, uid: string) {
    if (!uid) return;
    const state = this.subState.get(uid) ?? 0;
    // 0 idle · 1 no subscribe · 2 subscribing · 3 subscribed. Only the first
    // two are worth asking for: repeating a live request restarts it.
    if (this.subRequested.has(uid) && state !== 1) return;
    this.subRequested.add(uid);
    const track = rtcEnum("AliRtcVideoTrack", "AliRtcVideoTrackCamera", 1);
    try {
      if (typeof engine.subscribeRemoteMediaStream === "function") {
        await engine.subscribeRemoteMediaStream(uid, track, true, true);
      } else {
        engine.subscribeAllRemoteAudioStreams?.(true);
        engine.subscribeAllRemoteVideoStreams?.(true);
      }
      trace(`已请求订阅 ${uid}`);
      this.attachView(engine, uid);
    } catch (error) {
      trace(`订阅失败：${describe(error)}`);
      console.warn("jarvis: 订阅数字人媒体流失败", error);
    }
  }

  private attachView(engine: AnyEngine, uid: string, track = 1) {
    try {
      engine.setRemoteViewConfig?.(this.video, uid, track);
      void this.video.play?.().catch(() => null);
    } catch (error) {
      console.warn("jarvis: 绑定远端画面失败", error);
    }
  }

  private connectControl() {
    const url = `wss://${CONTROL_HOST}/live/ws/live/connect?live_id=${encodeURIComponent(this.liveId)}`
      + `&client_secret=${encodeURIComponent(this.clientSecret)}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.connAttempt = 0;
      trace("控制链路已连接");
      this.sendConnInit();
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let payload: any;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      this.handleSignal(payload);
    });
    socket.addEventListener("close", (event) => {
      if (this.stopping || this.stage === "idle") return;
      trace(`控制链路断开 ${event.code || "未知"}`);
      this.handlers.onHangup?.(`控制链路断开（${event.code || "未知"}）`);
    });
    socket.addEventListener("error", () => {
      if (!this.stopping) this.handlers.onError?.("控制链路出错，正在重试…");
    });
  }

  private sendConnInit() {
    this.connAttempt += 1;
    this.socket?.send(
      JSON.stringify({
        type: 1,
        live_id: this.liveId,
        seq_id: this.connAttempt,
        payload: { conn_init: { version: 1 } },
      }),
    );
  }

  private handleSignal(payload: any) {
    const type = Number(payload?.type ?? 0);
    if (type === 2) {
      const ack = payload?.payload?.conn_init_ack ?? {};
      if (ack.success) {
        trace("数字人已就绪");
        this.setStage("live", "数字人已就绪");
        return;
      }
      const code = String(ack.error_code ?? "");
      if (code === "NOT_READY") {
        const delay = CONN_INIT_BACKOFF[Math.min(this.connAttempt - 1, CONN_INIT_BACKOFF.length - 1)] ?? 8000;
        this.setStage("waiting", `数字人正在准备（${Math.round(delay / 1000)} 秒后重试）`);
        window.clearTimeout(this.retryTimer);
        this.retryTimer = window.setTimeout(() => this.sendConnInit(), delay);
        return;
      }
      this.handlers.onError?.(`实时会话初始化失败：${code || ack.error_msg || "未知错误"}`);
      return;
    }
    if (type === 6) {
      const reason = String(payload?.payload?.hangup?.hangup_reason ?? "服务端挂断");
      this.handlers.onHangup?.(reason);
      return;
    }
    if (type === 9 || type === 10) {
      const text = extractText(payload);
      if (!text) return;
      const brief = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      if (type === 9) {
        trace(`听写用户：${brief}`);
        this.handlers.onUserText?.(text);
      } else {
        trace(`听写数字人：${brief}`);
        this.noteBotSpeech(text);
        this.handlers.onBotText?.(text);
      }
    }
  }

  /**
   * The digital human only ever speaks two ways: reading a "朗读：…" line the
   * app sent, or answering on her own because the built-in LLM heard the room.
   * Her own words re-enter through the microphone as user text, so both are
   * logged for the echo filter — and a self-started answer is cut off the
   * moment the transcription gives it away, before it can collide with the
   * line the agent is about to hand over.
   */
  private noteBotSpeech(text: string) {
    const bare = text.replace(/^朗读[:：]\s*/, "").trim();
    if (!bare) return;
    const now = Date.now();
    while (this.sentLines.length > 0 && now - this.sentLines[0].at > LiveCall.SENT_LINE_WINDOW_MS) {
      this.sentLines.shift();
    }
    const reading = this.sentLines.some((sent) => bare.includes(sent.text));
    this.spokenLog.push({ text: bare, at: now });
    while (this.spokenLog.length > 6) this.spokenLog.shift();
    if (reading || now < this.readingUntil || this.stopping) return;
    window.clearTimeout(this.botInterruptTimer);
    this.botInterruptTimer = window.setTimeout(() => {
      trace(`打断自发回答：${bare.length > 40 ? `${bare.slice(0, 40)}…` : bare}`);
      this.interrupt();
    }, 500);
  }

  /**
   * Feeds a line to the digital human so it is spoken with matching lips.
   * Sends are serialized: a new text_msg takes over the line immediately, so
   * firing several at once is exactly what made her cut one sentence off to
   * start another. Each queued line waits for the previous one to finish.
   */
  say(text: string) {
    const content = text.trim();
    if (!content) return;
    this.speechQueue.push(content);
    this.drainSpeechQueue();
  }

  private drainSpeechQueue() {
    if (this.speechTimer) return;
    const send = () => {
      this.speechTimer = 0;
      if (this.stopping) {
        this.speechQueue.length = 0;
        return;
      }
      const content = this.speechQueue.shift();
      if (content === undefined) return;
      if (this.socket?.readyState !== WebSocket.OPEN) {
        this.speechQueue.length = 0;
        return;
      }
      trace(`朗读发送：${content.length > 50 ? `${content.slice(0, 50)}…` : content}`);
      this.socket.send(
        JSON.stringify({
          type: 99,
          live_id: this.liveId,
          seq_id: Date.now() % 100000,
          payload: {
            text_msg: {
              msg_id: `jarvis-${Date.now()}`,
              content: `朗读：${content}`,
              timestamp: Date.now(),
            },
          },
        }),
      );
      this.spokenLog.push({ text: content, at: Date.now() });
      while (this.spokenLog.length > 6) this.spokenLog.shift();
      this.sentLines.push({ text: content, at: Date.now() });
      while (this.sentLines.length > 3) this.sentLines.shift();
      const seconds = Math.min(
        40,
        Math.max(1.8, content.length / LiveCall.SPEECH_CHARS_PER_SECOND + LiveCall.SPEECH_TAIL_MS / 1000),
      );
      this.readingUntil = Date.now() + (seconds + 0.4) * 1000;
      this.speechTimer = window.setTimeout(send, seconds * 1000);
    };
    send();
  }

  /**
   * True when the line sounds like the digital human's own recent speech.
   * Her voice plays on the speakers and comes straight back into the
   * microphone, where Vidu transcribes it as user input; without this check
   * every answer is heard again as a new order and the conversation loops.
   */
  isEcho(text: string): boolean {
    const now = Date.now();
    for (const spoken of this.spokenLog) {
      if (now - spoken.at > LiveCall.ECHO_WINDOW_MS) continue;
      if (speechOverlap(text, spoken.text) >= 0.6) return true;
    }
    return false;
  }

  /** Barge-in: stop the current answer without dropping the call. */
  interrupt() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: 7, live_id: this.liveId, payload: {} }));
  }

  /**
   * A dropped subscribe is invisible from the outside, so while no frame has
   * arrived the request is repeated — cheaper than asking the user to hang up
   * and dial again.
   */
  private ensureFrames() {
    let tries = 0;
    const timer = window.setInterval(() => {
      const done = this.stage === "idle" || this.stage === "error" || this.framesSeen > 0 || tries >= 8;
      if (done) {
        window.clearInterval(timer);
        return;
      }
      tries += 1;
      if (!this.engine) return;
      const engine = this.engine;
      const online = this.mediaUsers.size
        ? [...this.mediaUsers].map((uid) => `${uid.slice(-6)}:${describe(engine.isUserOnline?.(uid))}`).join(" ")
        : "无远端用户";
      const states = [...this.mediaUsers]
        .map((uid) => `${uid.slice(-6)}=${this.subState.get(uid) ?? "-"}`)
        .join(" ");
      // The element only reports a picture size once the SDK has bound a live
      // stream to it, so the trace doubles as proof that media ever arrived.
      const element = `画面 ${this.video.videoWidth}x${this.video.videoHeight}`
        + ` 就绪 ${this.video.readyState} 流 ${this.video.srcObject ? "有" : "无"}`;
      trace(`等待画面，第 ${tries} 次重试（在线 ${online} · 订阅 ${states} · ${element}）`);
      // A substitution that is already running is left alone: asking again
      // would push it back to "subscribing" and the picture would never land.
      for (const uid of this.mediaUsers) {
        // Only the camera track is re-bound here: pointing the view at the
        // screen track of a user that never published one would unbind the
        // picture that is already there.
        this.attachView(engine, uid, 1);
        if ((this.subState.get(uid) ?? 0) === 1) this.subRequested.delete(uid);
      }
      this.subscribeAll(engine);
    }, 4000);
  }

  private noteFrame() {
    this.framesSeen += 1;
    if (this.framesSeen === 1) trace(`数字人画面已到达 ${this.video.videoWidth}x${this.video.videoHeight}`);
  }

  /**
   * Is what was just drawn fit to be seen?
   *
   * Vidu renders the digital human inside a set of its own: when the artwork
   * carries a chroma background the keying lifts it cleanly, and when it does
   * not — or before the model settles on one — the backdrop survives as a video
   * rectangle. The still is a far better look than that, so the frame only
   * reaches the HUD once the edge of the canvas is actually transparent, and it
   * is taken away the moment the set comes back — the master asked for no
   * background colour at all, not for a brief coloured rectangle. The keyer
   * keeps re-sampling, so the picture returns on its own once the chroma set
   * is back.
   */
  private checkBackdrop(now: number) {
    if (!this.keyer) return;
    if (!this.keyer.key()) {
      // No usable backdrop sample: the canvas is fully transparent and the
      // still keeps the stage. Nothing to measure until a sample arrives.
      if (this.revealed) {
        this.revealed = false;
        this.handlers.onVideoLost?.();
      }
      return;
    }
    if (!this.probe) {
      const probe = document.createElement("canvas");
      probe.width = 160;
      probe.height = 90;
      this.probe = probe;
    }
    const limit = this.revealed ? 2000 : 400;
    if (now - this.lastRevealCheck < limit) return;
    this.lastRevealCheck = now;
    const clearance = readBackdropClearance(
      this.video,
      this.probe,
      this.keyer.key(),
      this.keyer.thresholds(),
    );
    if (clearance === null) return;
    if (!this.revealed) {
      if (clearance >= 0.9) {
        this.revealed = true;
        trace(`数字人画面可用（边缘透明 ${(clearance * 100).toFixed(0)}%）`);
        this.handlers.onVideo?.();
        return;
      }
      this.revealChecks += 1;
      // A slow start is normal (the model warms up on its own studio); a
      // minute of it means the backdrop cannot be keyed at all.
      if (this.revealChecks % 12 === 0) {
        trace(`数字人画面仍未透明（边缘透明 ${(clearance * 100).toFixed(0)}%），继续显示立绘`);
      }
      return;
    }
    if (clearance < 0.85) {
      // The set drifted or switched: blank the frame immediately instead of
      // letting the wrong backdrop through, then re-sample so the picture can
      // come back without a redial.
      this.revealed = false;
      this.keyer.setKey(null);
      this.keyStale = true;
      trace(`数字人背景漂移（边缘透明 ${(clearance * 100).toFixed(0)}%），画面暂回立绘并重新采样`);
      this.handlers.onVideoLost?.();
    }
  }

  private startRenderLoop() {
    // The key colour is sampled from a live frame, never assumed: a wrong key
    // would punch holes in the character.
    this.detectionTimer = window.setInterval(() => this.detectBackdrop(), KEY_RETRY_MS);
    const draw = () => {
      if (this.stage === "idle" || this.stage === "error") return;
      if (this.keyer && this.video.videoWidth) {
        this.keyer.render(this.video);
        this.noteFrame();
        this.checkBackdrop(performance.now());
      }
      this.frameHandle = requestAnimationFrame(draw);
    };
    const anyVideo = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    if (typeof anyVideo.requestVideoFrameCallback === "function") {
      const tick = () => {
        if (this.stage === "idle" || this.stage === "error") return;
        if (this.keyer && this.video.videoWidth) {
          this.keyer.render(this.video);
          this.noteFrame();
          this.checkBackdrop(performance.now());
        }
        this.frameHandle = anyVideo.requestVideoFrameCallback!(tick);
      };
      this.frameHandle = anyVideo.requestVideoFrameCallback(tick);
      return;
    }
    this.frameHandle = requestAnimationFrame(draw);
  }

  private detectBackdrop() {
    if (!this.keyer || !this.video.videoWidth) return;
    // A healthy key stays: re-sampling a good frame would make the cut flicker
    // as the character moves along the sampled edge.
    if (this.revealed && this.keyer.key() && !this.keyStale) {
      return;
    }
    this.keyAttempts += 1;
    const sample = this.keyer.detect(this.video);
    if (!sample) {
      // This frame carries no flat chroma backdrop — the model may still be on
      // its own studio set. With the key unset the shader draws nothing, so
      // the still keeps the stage and the raw set never appears.
      if (this.keyAttempts === 1) this.handlers.onBackdrop?.("plain", null);
      return;
    }
    const previous = this.keyer.key();
    this.keyer.setKey(sample.color);
    this.keyStale = false;
    if (previous) {
      trace(
        `背景重新采样 rgb(${sample.color.r},${sample.color.g},${sample.color.b})，波动 ${sample.spread.toFixed(1)}`,
      );
      this.handlers.onBackdrop?.("rekeyed", sample);
    } else {
      this.handlers.onBackdrop?.("keyed", sample);
    }
  }

  /** Hangs up: control signal, media teardown, then the final bill. */
  async stop(reason = "user_end"): Promise<{ seconds: number; credits: number | null } | null> {
    if (this.stage === "idle") return null;
    this.stopping = true;
    this.setStage("ending", "正在挂断…");
    window.clearTimeout(this.speechTimer);
    this.speechTimer = 0;
    window.clearTimeout(this.botInterruptTimer);
    this.botInterruptTimer = 0;
    this.speechQueue.length = 0;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.detectionTimer);
    cancelAnimationFrame(this.frameHandle);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 5, live_id: this.liveId, payload: { hangup: { hangup_reason: reason } } }));
    }
    const socket = this.socket;
    this.socket = null;
    window.setTimeout(() => socket?.close(), 250);
    // Leaving can block for as long as joining did, and the HUD must not sit on
    // "正在挂断…" while it does, so the teardown is bounded too.
    try {
      await Promise.race([
        (async () => {
          await this.engine?.leaveChannel?.();
          await this.engine?.destroy?.();
        })().catch(() => undefined),
        new Promise((resolve) => window.setTimeout(resolve, 3000)),
      ]);
    } catch {
      /* the channel is already gone */
    }
    this.engine = null;
    this.keyer?.setKey(null);
    const seconds = this.startedAtMs ? Math.round((Date.now() - this.startedAtMs) / 1000) : 0;
    let credits: number | null = null;
    try {
      const billing = await invoke<{ billedSeconds?: number; creditsCost?: number }>("videolive_billing", {
        liveId: this.liveId,
      });
      credits = typeof billing.creditsCost === "number" ? billing.creditsCost : null;
    } catch {
      /* billing is best effort */
    }
    this.handlers.onBilling?.({ seconds, credits });
    this.liveId = "";
    this.startedAtMs = 0;
    this.stage = "idle";
    this.handlers.onStage("idle");
    return { seconds, credits };
  }
}

/** Vidu names the bot's audio and video publishers, and only those carry media. */
export function isDigitalHumanUser(uid: string, botUserId: string): boolean {
  if (!uid) return false;
  if (botUserId && uid === botUserId) return true;
  return uid.startsWith("live-video-push-") || uid.startsWith("live-bot-");
}

export function botUserIdFrom(rtc: RtcCredentials, liveId: string): string {
  if (!rtc) return "";
  const explicit = (rtc as any).bot_user_id;
  if (explicit) return String(explicit);
  const userId = rtc.user_id ?? rtc.userId ?? "";
  const match = /^live-user-(.+)-([^-]+)$/.exec(userId);
  if (match) return `live-bot-${match[1]}-${match[2]}`;
  const creator = userId.replace(/^live-user-/, "").replace(new RegExp(`-${liveId}$`), "");
  return creator && liveId ? `live-bot-${creator}-${liveId}` : "";
}

/** The platform reports transcriptions under a couple of shapes. */
export function extractText(payload: any): string {
  const candidates = [
    payload?.payload?.text_msg?.content,
    payload?.payload?.input_transcription?.content,
    payload?.payload?.output_transcription?.content,
    payload?.payload?.content,
    payload?.content,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}
