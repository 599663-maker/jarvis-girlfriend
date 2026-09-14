// Pre-rendered idle animation playback.
//
// The idle loop is a local mp4 generated once by Vidu from the character's
// green-screen portrait. It replaces the still image entirely: the video
// element itself is never shown, every frame is drawn through the WebGL
// chroma keyer onto the character canvas, so the HUD shows only the moving
// character — no rectangles, no patch layers, no extra mouths or eyes.
//
// Vidu is not involved at playback time. The file sits on disk; only dialing
// a realtime call connects to Vidu again.

import { invoke } from "@tauri-apps/api/core";
import {
  createVideoKeyer,
  readBackdropClearance,
  type VideoKeyer,
} from "./chroma";

type Visibility = "shown" | "hidden";

const REVEAL_CLEARANCE = 0.85;
const REVEAL_CHECK_MS = 400;
const KEY_RETRY_MS = 900;

function trace(message: string) {
  void invoke("web_log", { message: `静息动画：${message}` }).catch(() => {});
}

function shellLive(): boolean {
  return (
    document.querySelector(".shell")?.classList.contains("video-live") === true ||
    document.querySelector(".shell")?.classList.contains("is-dialing") === true ||
    document.querySelector(".shell")?.classList.contains("is-transforming") === true ||
    document.querySelector(".shell")?.classList.contains("is-reforming") === true
  );
}

/**
 * Plays the idle animation for the active character. The canvas only ever
 * shows a frame whose backdrop is actually keyed out; while detection is
 * pending — or after the backdrop drifted — the still portrait keeps the
 * stage, exactly like the live-call reveal.
 */
export type IdleHandlers = {
  /** Fired when a keyed frame takes the stage; the still can step aside. */
  onRevealed?(): void;
  /** Fired when the picture has to go back to the still. */
  onHidden?(): void;
};

export class IdlePlayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly keyer: VideoKeyer | null;
  private readonly probe: HTMLCanvasElement;
  private readonly handlers: IdleHandlers;
  private avatarId = "";
  private source = "";
  private wanted: Visibility = "hidden";
  private revealed = false;
  private keyAttempts = 0;
  private keyStale = false;
  private frameHandle = 0;
  private detectTimer = 0;
  private lastRevealCheck = 0;

  constructor(canvas: HTMLCanvasElement, handlers: IdleHandlers = {}) {
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
    document.body.appendChild(video);
    this.video = video;
    this.keyer = createVideoKeyer(canvas);
    this.probe = document.createElement("canvas");
    this.probe.width = 160;
    this.probe.height = 90;
  }

  /** Points the player at another character's animation, if it has one. */
  async setSource(avatarId: string, source: string | null) {
    if (this.avatarId === avatarId && (this.source === source)) return;
    this.avatarId = avatarId;
    this.stopPlayback();
    if (!source) {
      this.source = "";
      this.hideCanvas();
      return;
    }
    this.source = source;
    this.revealed = false;
    this.keyAttempts = 0;
    this.keyStale = false;
    this.video.src = source;
    this.video.load();
    try {
      await this.video.play();
    } catch {
      trace(`自动播放被拦下（形象 ${avatarId}），等待下一次交互`);
    }
    this.applyVisibility();
    this.startRenderLoop();
  }

  /**
   * Whether the animation may own the stage. It stands down for a realtime
   * call, the ringer and both halves of the transformation, where the still
   * portrait or Vidu's own frames are the picture on purpose.
   */
  setVisible(visible: boolean) {
    const next: Visibility = visible && !shellLive() ? "shown" : "hidden";
    if (next === this.wanted) {
      if (this.source && this.video.paused && next === "shown") {
        void this.video.play().catch(() => {});
      }
      return;
    }
    this.wanted = next;
    this.applyVisibility();
  }

  stop() {
    this.stopPlayback();
    this.avatarId = "";
    this.source = "";
    this.hideCanvas();
  }

  private stopPlayback() {
    window.clearInterval(this.detectTimer);
    this.detectTimer = 0;
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.keyer?.setKey(null);
  }

  private applyVisibility() {
    const shown = this.wanted === "shown" && this.revealed;
    this.canvas.hidden = !shown;
    if (shown) this.handlers.onRevealed?.();
    else this.handlers.onHidden?.();
    if (shown && this.video.paused) {
      void this.video.play().catch(() => {});
    }
    if (!shown && !this.video.paused) {
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
      if (!this.source) return;
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
        if (!this.source) return;
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
    if (!this.source || !this.keyer || !this.video.videoWidth) return;
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
    if (clearance < REVEAL_CLEARANCE) {
      // The backdrop drifted or switched: blank the frame, show the still and
      // re-sample so the animation can come back without a regeneration.
      this.revealed = false;
      this.keyer.setKey(null);
      this.keyStale = true;
      trace(`动画背景漂移（边缘透明 ${(clearance * 100).toFixed(0)}%），暂回立绘并重新采样`);
      this.applyVisibility();
    }
  }
}
