// Pre-rendered scene playback.
//
// Each scene is a local mp4 generated once by Vidu from the character's
// green-screen portrait:
//
//   "greet"  — the friendly wave shown once when the window opens;
//   "wait"   — hands folded in front, small steps in place, played while the
//              master asks questions and Jarvis answers;
//   "static" — no video at all, the still portrait keeps the stage.
//
// The video element itself is never shown: every frame is drawn through the
// WebGL chroma keyer onto the character canvas, so the HUD shows only the
// moving character — no rectangles, no patch layers, no extra mouths or eyes.
// Vidu is not involved at playback time; only dialing a realtime call
// connects to Vidu again.

import { invoke } from "@tauri-apps/api/core";
import {
  createVideoKeyer,
  readBackdropClearance,
  type KeyColor,
  type VideoKeyer,
} from "./chroma";

export type Scene = "greet" | "wait" | "static";

export type SceneHandlers = {
  /** Fired when a keyed frame takes the stage; the still can step aside. */
  onRevealed?(): void;
  /** Fired when the picture has to go back to the still. */
  onHidden?(): void;
  /** Fired when the greeting wave has played through once. */
  onGreetFinished?(): void;
};

export type SceneSources = { greet: string | null; wait: string | null };

const REVEAL_CLEARANCE = 0.85;
const REVEAL_CHECK_MS = 400;
const KEY_RETRY_MS = 900;

function trace(message: string) {
  void invoke("web_log", { message: `场景动画：${message}` }).catch(() => {});
}

function shellBusy(): boolean {
  const shell = document.querySelector(".shell");
  if (!shell) return false;
  return (
    shell.classList.contains("video-live") ||
    shell.classList.contains("is-dialing") ||
    shell.classList.contains("is-transforming") ||
    shell.classList.contains("is-reforming")
  );
}

/** Whether two green samples describe the same studio backdrop. */
function keyColorClose(a: KeyColor, b: KeyColor): boolean {
  return (
    Math.abs(a.r - b.r) < 20 &&
    Math.abs(a.g - b.g) < 20 &&
    Math.abs(a.b - b.b) < 20
  );
}

/**
 * Plays scene animations for the active character. The canvas only ever shows
 * a frame whose backdrop is actually keyed out; while detection is pending —
 * or after the backdrop drifted — the still portrait keeps the stage, exactly
 * like the live-call reveal.
 */
export class ScenePlayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly keyer: VideoKeyer | null;
  private readonly probe: HTMLCanvasElement;
  private readonly handlers: SceneHandlers;
  private avatarId = "";
  private scenes: SceneSources = { greet: null, wait: null };
  private activeScene: Scene = "static";
  private greetWatchdog = 0;
  private visible = false;
  private revealed = false;
  private keyAttempts = 0;
  private keyStale = false;
  private driftStrikes = 0;
  private frameHandle = 0;
  private detectTimer = 0;
  private lastRevealCheck = 0;

  constructor(canvas: HTMLCanvasElement, handlers: SceneHandlers = {}) {
    this.canvas = canvas;
    this.handlers = handlers;
    const video = document.createElement("video");
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    // `display: none` never decodes on WebKit, and an off-screen element stops
    // decoding too. The element therefore lives inside the viewport as a
    // two-pixel speck that the keyer reads from, mirroring the live call.
    video.style.cssText =
      "position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;";
    video.addEventListener("error", () => {
      trace(`动画读取失败（形象 ${this.avatarId || "无"}）`);
      this.hideCanvas();
    });
    video.addEventListener("ended", () => {
      // Only the greeting is played once; the waiting pose loops.
      if (this.activeScene === "greet") {
        this.handlers.onGreetFinished?.();
      }
    });
    document.body.appendChild(video);
    this.video = video;
    this.keyer = createVideoKeyer(canvas);
    this.probe = document.createElement("canvas");
    this.probe.width = 160;
    this.probe.height = 90;
  }

  /** Points the player at another character's scene set. */
  async setScenes(avatarId: string, scenes: SceneSources) {
    if (this.avatarId === avatarId && this.scenes.greet === scenes.greet && this.scenes.wait === scenes.wait) {
      return;
    }
    this.avatarId = avatarId;
    this.scenes = scenes;
    this.stopPlayback();
    this.activeScene = "static";
    this.applyVisibility();
  }

  /**
   * Switches the stage to a scene. "static" parks the video; "greet" plays the
   * wave once; "wait" loops the waiting pose while a question is in the air.
   */
  playScene(scene: Scene) {
    if (scene === this.activeScene) {
      if (scene !== "static" && this.video.paused && this.visible) {
        void this.video.play().catch(() => {});
      }
      return;
    }
    this.activeScene = scene;
    this.stopPlayback();
    if (scene === "static") {
      this.applyVisibility();
      return;
    }
    const source = this.scenes[scene];
    if (!source) {
      this.applyVisibility();
      return;
    }
    this.revealed = false;
    this.keyAttempts = 0;
    this.keyStale = false;
    this.driftStrikes = 0;
    this.video.loop = scene === "wait";
    this.video.src = source;
    this.video.load();
    if (this.visible) void this.video.play().catch(() => {});
    this.applyVisibility();
    this.startRenderLoop();
    if (scene === "greet") {
      // The wave must hand the stage back even when the browser never fires
      // the ended event (a hidden or throttled video can skip it entirely).
      const seconds = this.video.duration;
      const grace = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 + 3000 : 9000;
      window.clearTimeout(this.greetWatchdog);
      this.greetWatchdog = window.setTimeout(() => {
        if (this.activeScene === "greet") this.handlers.onGreetFinished?.();
      }, grace);
    }
  }

  /**
   * Whether an animation may own the stage at all. It stands down for a
   * realtime call, the ringer and both halves of the transformation, where
   * the still portrait or Vidu's own frames are the picture on purpose.
   */
  setVisible(visible: boolean) {
    const next = visible && !shellBusy();
    if (next === this.visible) {
      if (this.activeScene !== "static" && this.video.paused && next) {
        void this.video.play().catch(() => {});
      }
      return;
    }
    this.visible = next;
    this.applyVisibility();
  }

  stop() {
    this.avatarId = "";
    this.scenes = { greet: null, wait: null };
    this.stopPlayback();
    this.activeScene = "static";
    this.hideCanvas();
  }

  private stopPlayback() {
    window.clearTimeout(this.greetWatchdog);
    this.greetWatchdog = 0;
    window.clearInterval(this.detectTimer);
    this.detectTimer = 0;
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.keyer?.setKey(null);
    this.revealed = false;
  }

  private applyVisibility() {
    const shown = this.visible && this.revealed && this.activeScene !== "static";
    this.canvas.hidden = !shown;
    if (shown) this.handlers.onRevealed?.();
    else this.handlers.onHidden?.();
    // The backdrop detection needs live frames, so the video keeps decoding
    // while a reveal is pending; only a scene that must not own the stage at
    // all pauses it. A paused video would never reveal, because there would
    // be no new frame to measure the green edge on.
    const wanted = this.visible && this.activeScene !== "static";
    if (wanted && this.video.paused) {
      void this.video.play().catch(() => {});
    }
    if (!wanted && !this.video.paused) {
      this.video.pause();
    }
  }

  private hideCanvas() {
    this.revealed = false;
    this.applyVisibility();
  }

  private startRenderLoop() {
    window.clearInterval(this.detectTimer);
    this.detectTimer = window.setInterval(() => this.detectBackdrop(), KEY_RETRY_MS);
    const draw = () => {
      if (!this.video.src || this.activeScene === "static") return;
      if (this.keyer && this.video.videoWidth) {
        this.keyer.render(this.video);
        this.checkBackdrop(performance.now());
      }
      this.frameHandle = requestAnimationFrame(draw);
    };
    const anyVideo = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    if (typeof anyVideo.requestVideoFrameCallback === "function") {
      const tick = () => {
        if (!this.video.src || this.activeScene === "static") return;
        if (this.keyer && this.video.videoWidth) {
          this.keyer.render(this.video);
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
    if (this.activeScene === "static" || !this.keyer || !this.video.videoWidth) return;
    // A healthy key stays; re-sampling a good frame makes the cut flicker.
    if (this.revealed && this.keyer.key() && !this.keyStale) return;
    this.keyAttempts += 1;
    const sample = this.keyer.detect(this.video);
    if (!sample) {
      // No flat chroma backdrop in this frame. With the key unset the shader
      // paints nothing, so the still portrait keeps the stage.
      if (this.keyAttempts === 1) {
        trace(`首帧没有可用的绿幕背景（形象 ${this.avatarId}），继续显示立绘`);
      }
      return;
    }
    this.keyer.setKey(sample.color);
    this.keyStale = false;
    if (this.keyAttempts === 1) {
      trace(
        `背景已采样 rgb(${sample.color.r},${sample.color.g},${sample.color.b})，波动 ${sample.spread.toFixed(1)}`,
      );
    }
  }

  private checkBackdrop(now: number) {
    if (!this.keyer || !this.video.videoWidth || now - this.lastRevealCheck < REVEAL_CHECK_MS) {
      return;
    }
    this.lastRevealCheck = now;
    const key = this.keyer.key();
    if (!key) {
      this.hideCanvas();
      return;
    }
    const clearance = readBackdropClearance(
      this.video,
      this.probe,
      key,
      this.keyer.thresholds(),
    );
    if (clearance === null) return;
    if (!this.revealed) {
      if (clearance >= REVEAL_CLEARANCE) {
        this.revealed = true;
        trace(`动画已透明（边缘透明 ${(clearance * 100).toFixed(0)}%），立绘退场`);
        this.applyVisibility();
      }
      return;
    }
    if (clearance >= REVEAL_CLEARANCE) {
      this.driftStrikes = 0;
      return;
    }
    if (clearance < REVEAL_CLEARANCE) {
      this.driftStrikes += 1;
      // Low edge coverage alone is not drift: a waving hand can cross the
      // sampled border while the backdrop itself stays exactly the same.
      // Only a backdrop that actually changed colour — or a blank frame that
      // persists for two checks — stands the animation down.
      const sample = this.keyer.detect(this.video);
      if (sample && keyColorClose(sample.color, key)) {
        this.driftStrikes = 0;
        return;
      }
      if (this.driftStrikes < 2) return;
      this.driftStrikes = 0;
      this.revealed = false;
      this.keyer.setKey(null);
      this.keyStale = true;
      trace(`动画背景漂移（边缘透明 ${(clearance * 100).toFixed(0)}%），暂回立绘并重新采样`);
      this.applyVisibility();
    }
  }
}
