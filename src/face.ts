// Talking stills: the character keeps her face on screen between calls, so the
// artwork itself has to move — lips while she speaks, eyes that blink, a small
// expression shift that follows the conversation, and now an idle pass that
// keeps the whole body alive: hands that drift and gesture, feet that shift
// weight, a chest that breathes.
//
// Everything is drawn as feathered patches taken from the portrait: the jaw and
// lip band are stretched downward for each syllable, a soft shadow opens
// between the lips, the eyes are squashed shut for a blink, and the whole head
// is tilted a degree or two for the mood. Working on patches instead of
// redrawing the portrait keeps the rest of the artwork untouched, which is what
// stops the face from looking painted on.

export type FaceBox = { x: number; y: number; w: number; h: number };

export type FaceGeometry = {
  face: FaceBox;
  mouth?: FaceBox;
  leftEye?: FaceBox;
  rightEye?: FaceBox;
  /** Hands and feet for the idle pose pass; absent for portraits without them. */
  hands?: FaceBox[];
  feet?: FaceBox[];
};

export type Mood = "idle" | "happy" | "curious" | "thinking";

/** How open the mouth is right now, 0..1, with the pauses of real speech. */
export function syllableEnvelope(ms: number): number {
  const t = ms / 1000;
  const carrier =
    0.55 +
    0.28 * Math.sin(t * 2 * Math.PI * 4.7) +
    0.17 * Math.sin(t * 2 * Math.PI * 7.3 + 1.7);
  const phrase = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 0.9 + 0.4);
  const gate = phrase < 0.18 ? 0 : 1;
  return Math.max(0, Math.min(1, carrier)) * gate;
}

/**
 * Blink amount, 0..1. A natural blink is a quick close with a slightly slower
 * open, and real people do not blink on a metronome: the interval drifts, a
 * double blink happens now and then, and every so often the eyes stay closed a
 * beat longer. All of that is folded into the phase maths below so the loop
 * stays stateless and cheap.
 */
export function blinkAt(ms: number): number {
  const t = ms / 1000;
  // Which blink slot are we in? The slot length itself wanders between
  // roughly 2.6s and 6s, so the rhythm never reads as a loop.
  const slot = 3.9 + 1.35 * Math.sin(t * 0.42 + 1.3);
  const slotPhase = (t % slot) / slot;
  // Most slots hold one blink; one in five holds two, back to back.
  const slotIndex = Math.floor(t / slot);
  const double = hash01(slotIndex) < 0.2;
  const blinkPos = double ? 0.06 : 0.08;
  const close = 0.075; // fraction of the slot spent closing/opening
  if (slotPhase < blinkPos) return 0;
  const progress = (slotPhase - blinkPos) / close;
  if (progress > 1) {
    if (double) {
      const second = (slotPhase - blinkPos - close * 2.1) / close;
      if (second >= 0 && second < 1) {
        return second < 0.42 ? second / 0.42 : 1 - (second - 0.42) / 0.58;
      }
    }
    return 0;
  }
  // Down fast, up a touch slower.
  return progress < 0.42 ? progress / 0.42 : 1 - (progress - 0.42) / 0.58;
}

/** Deterministic 0..1 hash so a blink decision does not jump between frames. */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Which face to wear. Read from the sentence in hand, so the expression follows
 * the conversation instead of a timer.
 */
export function moodFor(text: string): Mood {
  const line = text.trim();
  if (!line) return "idle";
  if (/[?？]$|吗[?？]?$|呢[?？]?$|怎么|为什么|是不是|能不能/.test(line)) return "curious";
  if (/[!！]|哈哈|太棒|真好|开心|喜欢|谢谢|厉害|漂亮|爱你/.test(line)) return "happy";
  if (/想一下|想想|考虑|研究|分析|计算|查一下|稍等|让我|麻烦/.test(line)) return "thinking";
  return "idle";
}

type PatchTransform = {
  scaleX?: number;
  scaleY?: number;
  /** Where the stretch is anchored: the edge that stays put. */
  anchor?: "top" | "bottom" | "center";
  brightness?: number;
  /** Whole-patch drift in canvas pixels, used by the idle limb passes. */
  shiftX?: number;
  shiftY?: number;
  /** Small rotation around the patch centre, in radians. */
  rotate?: number;
};

export type FaceAnimator = {
  setGeometry(geometry: FaceGeometry | null): void;
  setMood(mood: Mood): void;
  setSpeaking(speaking: boolean): void;
  /**
   * The still only speaks for the character between calls: once Vidu is on
   * screen its own animation owns the face, so the patch layer goes dormant
   * instead of painting a second mouth over the video.
   */
  setActive(active: boolean): void;
  start(): void;
  stop(): void;
};

type Patches = {
  face: FaceBox;
  /** Lip line plus the skin around it: what actually parts when she talks. */
  lips: FaceBox;
  /** Lower lip to chin, for the jaw drop. */
  jaw: FaceBox;
  eyes: FaceBox[];
  /** Idle pose patches: hands, feet and the breathing chest. */
  hands: FaceBox[];
  feet: FaceBox[];
  chest: FaceBox | null;
};

/**
 * The landmark pass traces the lip line itself, which on a photograph is a
 * couple of pixels tall — far too thin to stretch into a talking mouth. The
 * lip band and the jaw patch are grown from it so the motion stays on the
 * mouth instead of smearing the cheeks.
 */
function patchesFor(boxes: FaceGeometry): Patches {
  const face = boxes.face;
  const raw = boxes.mouth ?? {
    x: face.x + face.w * 0.34,
    y: face.y + face.h * 0.62,
    w: face.w * 0.32,
    h: face.h * 0.06,
  };
  const centreX = raw.x + raw.w / 2;
  const centreY = raw.y + raw.h / 2;
  // The landmark pass traces thin bands — the lip line and the eye opening are
  // a handful of pixels each. A shadow or a blink drawn on those alone is
  // invisible at portrait scale, so every patch is grown around the same centre
  // until it covers the feature the master actually recognises: lips that part,
  // eyes that shut.
  const lipW = Math.max(raw.w * 1.8, face.w * 0.28);
  const lipH = Math.max(raw.h * 5, face.h * 0.05);
  const lips = { x: centreX - lipW / 2, y: centreY - lipH * 0.62, w: lipW, h: lipH };
  // Below the lip line: a patch that starts higher would copy the lips over
  // themselves and turn the mouth into a red smear.
  const jawTop = lips.y + lips.h * 1.05;
  const jaw = {
    x: centreX - lipW * 0.85,
    y: jawTop,
    w: lipW * 1.7,
    h: Math.max(face.h * 0.16, face.y + face.h - jawTop),
  };
  const eyeW = Math.max(face.w * 0.085, 0.01);
  const eyeH = Math.max(face.h * 0.05, 0.006);
  const eyes = [boxes.leftEye, boxes.rightEye]
    .filter((eye): eye is FaceBox => Boolean(eye))
    .map((eye) => ({
      x: eye.x + eye.w / 2 - Math.max(eye.w, eyeW) * 0.75,
      y: eye.y + eye.h / 2 - Math.max(eye.h * 2.4, eyeH) / 2,
      w: Math.max(eye.w, eyeW) * 1.5,
      h: Math.max(eye.h * 2.4, eyeH),
    }));

  // Hands and feet arrive from the body pass already padded around the actual
  // limb; a small extra margin keeps the feathered edge away from the fingers.
  const hands = (boxes.hands ?? [])
    .slice(0, 2)
    .map((hand) => grow(hand, 0.22, 0.25));
  const feet = (boxes.feet ?? [])
    .slice(0, 2)
    .map((foot) => grow(foot, 0.35, 0.12));

  // The chest rides the breath: a band from below the chin to the bottom of
  // the face box, wider than the face so the shoulders move with the air.
  const chestTop = Math.min(1, face.y + face.h * 1.05);
  const chestH = Math.min(1 - chestTop, Math.max(face.h * 0.85, 0.12));
  const chest = {
    x: Math.max(0, face.x - face.w * 0.42),
    y: chestTop,
    w: Math.min(1, face.w * 1.84),
    h: chestH,
  };

  return { face, lips, jaw, eyes, hands, feet, chest };
}

/** Grows a box around its centre, clamped to the unit image. */
function grow(box: FaceBox, fx: number, fy: number): FaceBox {
  const w = Math.min(1, box.w * (1 + fx));
  const h = Math.min(1, box.h * (1 + fy));
  const x = Math.max(0, box.x + box.w / 2 - w / 2);
  const y = Math.max(0, box.y + box.h / 2 - h / 2);
  return { x, y, w, h };
}

let scratch: HTMLCanvasElement | null = null;

/** Half the display rate is plenty for a still, and half the cost. */
const FRAME_INTERVAL = 1000 / 30;

function scratchContext(width: number, height: number): CanvasRenderingContext2D | null {
  if (!scratch) scratch = document.createElement("canvas");
  scratch.width = Math.max(2, Math.round(width));
  scratch.height = Math.max(2, Math.round(height));
  const context = scratch.getContext("2d");
  if (context) {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, scratch.width, scratch.height);
    context.globalCompositeOperation = "source-over";
    context.filter = "none";
  }
  return context;
}

export function createFaceAnimator(
  canvas: HTMLCanvasElement,
  source: HTMLImageElement,
  geometry: FaceGeometry,
): FaceAnimator {
  const context = canvas.getContext("2d");
  let patches: Patches | null = patchesFor(geometry);
  let mood: Mood = "idle";
  let speaking = false;
  let frame = 0;
  let running = false;
  let active = true;
  let lastDraw = 0;

  const layout = () => {
    const width = source.offsetWidth || source.clientWidth;
    const height = source.offsetHeight || source.clientHeight;
    if (!width || !height) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    canvas.style.left = `${source.offsetLeft}px`;
    canvas.style.top = `${source.offsetTop}px`;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    return { width: pixelWidth, height: pixelHeight, scale: dpr };
  };

  /** One patch, stretched and faded at its edges so it blends into the still. */
  const drawPatch = (
    box: FaceBox,
    size: { width: number; height: number; scale: number },
    transform: PatchTransform,
  ) => {
    const image = source;
    if (!image.naturalWidth || !context) return;
    const scale = size.scale;
    const dx = box.x * size.width;
    const dy = box.y * size.height;
    const dw = Math.max(2, box.w * size.width);
    const dh = Math.max(2, box.h * size.height);
    const scaleX = transform.scaleX ?? 1;
    const scaleY = transform.scaleY ?? 1;
    const anchor = transform.anchor ?? "center";
    const anchorY = anchor === "top" ? 0 : anchor === "bottom" ? 1 : 0.5;
    // The patch grows away from its anchor, so the chin or the brow stays put.
    const outW = dw * scaleX;
    const outH = dh * scaleY;
    const rotate = transform.rotate ?? 0;
    const cos = Math.abs(Math.cos(rotate));
    const sin = Math.abs(Math.sin(rotate));
    const outX = dx + (dw - outW) / 2 + (transform.shiftX ?? 0);
    const outY = dy + (dh - outH) * anchorY + (transform.shiftY ?? 0);
    // A rotated patch needs a square-ish scratch canvas to hold its corners.
    const padX = outW * 0.55 + outH * sin * 0.5;
    const padY = outH * 0.55 + outW * sin * 0.5;
    const scratchW = outW + padX * 2;
    const scratchH = outH + padY * 2;
    const scratchCtx = scratchContext(scratchW * scale, scratchH * scale);
    if (!scratchCtx) return;
    scratchCtx.setTransform(scale, 0, 0, scale, 0, 0);
    scratchCtx.drawImage(
      image,
      box.x * image.naturalWidth,
      box.y * image.naturalHeight,
      Math.max(1, box.w * image.naturalWidth),
      Math.max(1, box.h * image.naturalHeight),
      padX,
      padY,
      outW,
      outH,
    );
    // Feathered edge: a soft ellipse so the stretched patch melts into the
    // artwork underneath instead of showing a seam.
    scratchCtx.globalCompositeOperation = "destination-in";
    scratchCtx.save();
    scratchCtx.translate(scratchW / 2, scratchH / 2);
    scratchCtx.scale(1, Math.max(0.05, scratchH / scratchW));
    const gradient = scratchCtx.createRadialGradient(0, 0, 0, 0, 0, scratchW / 2);
    gradient.addColorStop(0, "rgba(0,0,0,1)");
    gradient.addColorStop(0.5, "rgba(0,0,0,1)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    scratchCtx.fillStyle = gradient;
    scratchCtx.beginPath();
    scratchCtx.arc(0, 0, scratchW / 2, 0, Math.PI * 2);
    scratchCtx.fill();
    scratchCtx.restore();
    scratchCtx.globalCompositeOperation = "source-over";
    context.save();
    // The elliptical mask still ends at the patch rectangle, so the edges get a
    // blur as well: without it the stretched patch shows up as a see-through
    // rectangle over her chin.
    const soft = Math.min(
      3 * size.scale,
      Math.max(0.8, Math.min(outW, outH) * 0.14),
    );
    const brightness = transform.brightness && transform.brightness !== 1
      ? ` brightness(${transform.brightness})`
      : "";
    context.filter = `blur(${soft.toFixed(2)}px)${brightness}`;
    context.translate(outX + outW / 2, outY + outH / 2);
    context.rotate(rotate);
    context.translate(-(outX + outW / 2), -(outY + outH / 2));
    context.drawImage(
      scratchCtx.canvas,
      outX - padX,
      outY - padY,
      scratchW,
      scratchH,
    );
    context.restore();
  };

  /**
   * The dark between the lips. A stretched patch can only smear the lip line
   * downwards, so the opening itself is painted: a soft shadow that deepens
   * with the syllable and widens the mouth while she talks.
   */
  const drawMouthShadow = (
    box: FaceBox,
    size: { width: number; height: number; scale: number },
    amount: number,
  ) => {
    if (!context || amount <= 0.04) return;
    const strength = Math.min(1, amount);
    const cx = (box.x + box.w / 2) * size.width;
    const cy = (box.y + box.h * 0.42) * size.height;
    const rx = Math.max(box.w * 0.46 * size.width, 2.5 * size.scale);
    const ry = Math.max(rx * 0.07, rx * 0.5 * strength);
    context.save();
    context.globalCompositeOperation = "multiply";
    context.translate(cx, cy);
    context.scale(1, ry / rx);
    const gradient = context.createRadialGradient(0, 0, 0, 0, 0, rx);
    gradient.addColorStop(0, `rgba(52,16,20,${0.62 * strength})`);
    gradient.addColorStop(0.55, `rgba(70,26,28,${0.38 * strength})`);
    gradient.addColorStop(1, "rgba(74,30,32,0)");
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(0, 0, rx, 0, Math.PI * 2);
    context.fill();
    context.restore();
  };

  const render = (now: number) => {
    if (!running) return;
    frame = window.requestAnimationFrame(render);
    // Between calls the still is the whole picture; during a call the video is,
    // and a dormant layer costs nothing.
    if (!active) return;
    if (now - lastDraw < FRAME_INTERVAL) return;
    lastDraw = now;
    // A hidden canvas (calls, transformations) costs nothing to skip: the
    // padded HUD panel takes the canvas out of the layout.
    if (!canvas.offsetParent) return;
    const size = layout();
    if (!context || !size || !patches || !source.complete || !source.naturalWidth) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);

    const t = now / 1000;
    const amp = speaking ? 0.25 + 0.75 * syllableEnvelope(now) : 0;
    const blink = blinkAt(now);
    const breath = Math.sin(t * 2 * Math.PI * 0.22) * 0.35;
    // The whole character drifts on two very slow, incommensurate cycles so
    // the sway never reads as a loop: a wide ~12.5s swing and a barely-there
    // ~32s wander on top of it.
    const swayX =
      Math.sin(t * 2 * Math.PI * 0.08 + 1.1) * 2.6 +
      Math.sin(t * 2 * Math.PI * 0.031) * 1.4;
    const swayY = Math.sin(t * 2 * Math.PI * 0.11 + 0.6) * 1.1 + breath * 0.4;
    // The portrait itself sways, so the whole body moves as one instead of
    // patches sliding over a frozen photograph. The canvas rides the same
    // transform, which keeps every patch glued to the face it belongs to.
    source.style.transform = `translate3d(${swayX.toFixed(2)}px, ${swayY.toFixed(2)}px, 0) scale(var(--voice-pulse))`;
    canvas.style.transform = `translate3d(${swayX.toFixed(2)}px, ${swayY.toFixed(2)}px, 0)`;

    const tilt =
      mood === "curious" ? -1.6 : mood === "thinking" ? 1.4 : mood === "happy" ? 0.8 : 0;

    // The head moves a little more than the body: a degree of tilt for the
    // mood and, while speaking, a soft nod. The patches ride along with it.
    const face = patches.face;
    context.save();
    const centreX = (face.x + face.w / 2) * size.width;
    const centreY = (face.y + face.h * 0.72) * size.height;
    context.translate(centreX, centreY);
    context.rotate(
      ((tilt +
        Math.sin(t * 2 * Math.PI * 0.05) * 0.45 +
        (speaking ? Math.sin(now / 260) * 0.5 : 0)) *
        Math.PI) /
        180,
    );
    context.translate(
      -centreX,
      -centreY +
        (breath + (speaking ? Math.sin(now / 190) * 0.6 : 0)) * size.scale,
    );

    // A repaint of the whole face is only worth it when the expression calls
    // for one: at rest the artwork is already on screen underneath.
    if (mood !== "idle") {
      drawPatch(face, size, {
        scaleX: mood === "happy" ? 1.006 : 1,
        scaleY: mood === "happy" ? 0.998 : 1,
        anchor: "center",
        brightness: mood === "thinking" ? 0.985 : 1.035,
      });
    }
    // Jaw first, then the lips: the chin drops a little, the lips part.
    if (amp > 0.02) {
      drawPatch(patches.jaw, size, {
        scaleY: 1 + amp * 0.3,
        anchor: "top",
        brightness: mood === "happy" ? 1.02 : 1.0,
      });
    }
    drawMouthShadow(patches.lips, size, amp);
    for (const eye of patches.eyes) {
      if (blink <= 0.02) continue;
      drawPatch(eye, size, {
        scaleY: Math.max(0.18, 1 - blink * 0.86),
        anchor: "bottom",
        brightness: 1.01,
      });
    }
    context.restore();

    // ---- Idle pose pass -------------------------------------------------
    // The chest swells with the breath; hands drift and turn with their own
    // slow phases; the feet take turns carrying the weight. All of it is a
    // few pixels, which is exactly how far a person moves at rest.
    if (patches.chest) {
      const chestSwell = 1 + (breath * 0.5 + Math.sin(t * 2 * Math.PI * 0.13)) * 0.0045;
      drawPatch(patches.chest, size, {
        scaleY: chestSwell,
        anchor: "bottom",
        brightness: 1.0,
      });
    }
    patches.hands.forEach((hand, index) => {
      const phase = index === 0 ? 0 : Math.PI * 0.83;
      const bob = Math.sin(t * 2 * Math.PI * 0.07 + phase);
      const drift = Math.sin(t * 2 * Math.PI * 0.045 + phase * 1.7);
      const gesture = gestureWave(t, index);
      drawPatch(hand, size, {
        shiftX: drift * 1.4 + gesture * 2.2 * (index === 0 ? 1 : -1),
        shiftY: bob * 1.1 + Math.max(0, gesture) * 3.2,
        rotate: (bob * 0.012 + gesture * 0.035) * (index === 0 ? 1 : -1),
        anchor: "center",
        brightness: 1.005,
      });
    });
    patches.feet.forEach((foot, index) => {
      const phase = index === 0 ? 0 : Math.PI;
      const lift = Math.max(0, Math.sin(t * 2 * Math.PI * 0.05 + phase)) * 0.06;
      drawPatch(foot, size, {
        scaleY: 1 - lift * 0.5,
        shiftX: (index === 0 ? 1 : -1) * (0.5 + lift * 1.6),
        anchor: "bottom",
        brightness: 1.0,
      });
    });
  };

  return {
    setGeometry(next) {
      patches = next ? patchesFor(next) : null;
    },
    setMood(next) {
      mood = next;
    },
    setSpeaking(next) {
      speaking = next;
    },
    setActive(next) {
      if (active === next) return;
      active = next;
      if (!active) {
        source.style.transform = "";
        canvas.style.transform = "";
        if (context) context.clearRect(0, 0, canvas.width, canvas.height);
      }
    },
    start() {
      if (running) return;
      running = true;
      frame = window.requestAnimationFrame(render);
    },
    stop() {
      running = false;
      window.cancelAnimationFrame(frame);
      source.style.transform = "";
      canvas.style.transform = "";
      if (context) context.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}

/**
 * A slow, occasional hand gesture: mostly at rest, every ~18s one hand drifts
 * up and back down over about four seconds — a small "adjusting her sleeve"
 * or "resting a thought" movement rather than a wave.
 */
function gestureWave(t: number, index: number): number {
  const period = 18 + index * 3.7;
  const phase = ((t + index * 7.3) % period) / period;
  if (phase < 0.24) {
    const p = phase / 0.24;
    return Math.sin(p * Math.PI) * 0.9;
  }
  return 0;
}
