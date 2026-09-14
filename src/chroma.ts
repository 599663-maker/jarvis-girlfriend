// Chroma-key support for the live digital human.
//
// Vidu renders the character into an ordinary video stream, so the background is
// removed here instead of asking for an alpha channel the platform does not
// offer. The same keying lifts the background off generated portraits, which is
// what lets a character stand on the HUD rather than inside a video rectangle.
//
// Live frames are only ever shown fully keyed: when no chroma backdrop can be
// sampled the canvas stays transparent (the still portrait keeps the stage), so
// a stray studio set can never appear as a coloured rectangle behind the
// character.

export type KeyColor = { r: number; g: number; b: number };

export type KeySample = {
  color: KeyColor;
  /** Per-channel standard deviation of the sampled background. */
  spread: number;
};

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * Reads the background colour from the edge of a frame. Keying is only safe
 * when the backdrop is flat, so the caller gets the measured spread back and
 * can decide to leave the frame alone instead of punching holes in it.
 */
export function detectKeyColor(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): KeySample | null {
  if (width < 8 || height < 8 || pixels.length < width * height * 4) return null;
  const rows = [0.02, 0.06, 0.12, 0.88, 0.94, 0.98];
  const columns = [0.02, 0.06, 0.94, 0.98];
  const samples: Array<[number, number, number]> = [];
  const push = (x: number, y: number) => {
    const px = Math.min(width - 1, Math.max(0, Math.round(x * (width - 1))));
    const py = Math.min(height - 1, Math.max(0, Math.round(y * (height - 1))));
    const offset = (py * width + px) * 4;
    samples.push([pixels[offset], pixels[offset + 1], pixels[offset + 2]]);
  };
  for (const y of rows) for (let step = 0; step <= 12; step += 1) push(step / 12, y);
  for (const x of columns) for (let step = 0; step <= 8; step += 1) push(x, step / 8);
  if (samples.length === 0) return null;

  const mean = [0, 1, 2].map(
    (channel) => samples.reduce((total, sample) => total + sample[channel], 0) / samples.length,
  );
  const deviation = Math.sqrt(
    [0, 1, 2].reduce((total, channel) => {
      const variance =
        samples.reduce((sum, sample) => sum + (sample[channel] - mean[channel]) ** 2, 0) /
        samples.length;
      return total + variance;
    }, 0) / 3,
  );
  return {
    color: {
      r: Math.round(clamp255(mean[0])),
      g: Math.round(clamp255(mean[1])),
      b: Math.round(clamp255(mean[2])),
    },
    spread: deviation,
  };
}

/** How the keying behaves: similarity grows with the measured noise floor. */
export function keyThresholds(spread: number): { similarity: number; smoothness: number } {
  // Key harder than a general-purpose keyer: a residual backdrop is worse than
  // a slightly tighter cut, and the reveal gate in live.ts only puts the frame
  // on stage once the edges are actually transparent.
  const similarity = Math.min(0.45, 0.16 + spread / 180);
  return { similarity, smoothness: 0.1 };
}

/**
 * Whether a measured backdrop is worth keying at all.
 *
 * The reference artwork is composited over chroma green, so a live frame that
 * has moved onto the model's own studio set — usually a near-white or grey
 * wall — must be rejected instead of keyed: keying a pale set would punch
 * holes in skin and hair, and the owner asked for no background colour, not a
 * different one. Only flat, saturated green/blue/magenta backdrops qualify.
 */
export function usableChromaSample(sample: KeySample | null): KeySample | null {
  if (!sample) return null;
  if (sample.spread > 30) return null;
  const { r, g, b } = sample.color;
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  if (chroma < 40) return null;
  const green = g >= r * 1.15 && g >= b * 0.9;
  const blue = b >= r * 1.15 && b >= g * 0.9;
  const magenta = r >= g * 1.15 && b >= g * 1.15;
  return green || blue || magenta ? sample : null;
}

/**
 * Colour distance used by both the CPU and GPU paths: the angle between the
 * pixel and the key colour (so uneven green-screen lighting still keys) plus a
 * small luminance term, with very dark pixels pinned to "foreground" because a
 * keyed-out black would punch holes in hair and shadows.
 */
export function keyDistance(
  r: number, g: number, b: number,
  key: KeyColor, unitLength: number,
): number {
  const keyUnitR = key.r / 255 / unitLength;
  const keyUnitG = key.g / 255 / unitLength;
  const keyUnitB = key.b / 255 / unitLength;
  const length = Math.sqrt(r * r + g * g + b * b);
  if (length < 0.02) return 1;
  const dot = (r * keyUnitR + g * keyUnitG + b * keyUnitB) / length;
  const angle = 1 - Math.max(-1, Math.min(1, dot));
  const intensity = Math.abs(length - unitLength);
  if (length < 0.15) return Math.max(angle * 1.7 + intensity * 0.15, 0.6);
  return angle * 1.7 + intensity * 0.15;
}

/** Unit length of a key colour, shared by both keying paths. */
export function keyUnitLength(color: KeyColor): number {
  return Math.sqrt(color.r ** 2 + color.g ** 2 + color.b ** 2) / 255 || 0.0001;
}

/**
 * Replaces the sampled backdrop with transparency. Pure so the maths can be
 * unit tested; the browser path feeds it pixels from a canvas.
 */
export function keyPixels(
  pixels: Uint8ClampedArray,
  color: KeyColor,
  similarity: number,
  smoothness: number,
): number {
  const unitLength = keyUnitLength(color);
  let removed = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const r = pixels[offset] / 255;
    const g = pixels[offset + 1] / 255;
    const b = pixels[offset + 2] / 255;
    const distance = keyDistance(r, g, b, color, unitLength);
    const alpha = Math.max(0, Math.min(1, (distance - similarity) / smoothness));
    if (alpha <= 0) {
      pixels[offset + 3] = 0;
      removed += 1;
      continue;
    }
    if (alpha < 1) {
      pixels[offset + 3] = Math.round(pixels[offset + 3] * alpha);
      // Spill suppression: pull the backdrop's cast out of soft edges.
      const grey = (pixels[offset] + pixels[offset + 2]) / 2;
      if (color.g > color.r && color.g > color.b && pixels[offset + 1] > grey) {
        pixels[offset + 1] = Math.round(grey + (pixels[offset + 1] - grey) * alpha);
      } else if (color.b > color.r && color.b > color.g && pixels[offset + 2] > grey) {
        pixels[offset + 2] = Math.round(grey + (pixels[offset + 2] - grey) * alpha);
      }
    }
  }
  return removed;
}

const MAX_PORTRAIT_EDGE = 1400;

/**
 * Turns a portrait into a transparent PNG. Returns null when the backdrop is
 * not flat enough to key, which keeps a painted illustration intact instead of
 * shredding it.
 */
export async function cutPortraitBackground(source: string): Promise<string | null> {
  const image = new Image();
  image.src = source;
  await new Promise<void>((resolve) => {
    if (image.complete && image.naturalWidth) {
      resolve();
      return;
    }
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => resolve(), { once: true });
  });
  if (!image.naturalWidth) return null;
  const scale = Math.min(1, MAX_PORTRAIT_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, width, height);
  let frame: ImageData;
  try {
    frame = context.getImageData(0, 0, width, height);
  } catch {
    return null;
  }
  const sample = detectKeyColor(frame.data, width, height);
  if (!sample || sample.spread > 26) return null;
  // Portraits keep the gentler legacy key: painted artwork wears its own
  // colours, so the harder live key would eat into skin and clothing.
  const similarity = Math.min(0.55, 0.12 + sample.spread / 255);
  const smoothness = 0.16;
  const removed = keyPixels(frame.data, sample.color, similarity, smoothness);
  // A key that eats almost everything means the "background" was the subject.
  if (removed > width * height * 0.94 || removed < width * height * 0.05) return null;
  context.putImageData(frame, 0, 0);
  return canvas.toDataURL("image/png");
}

const VERTEX_SHADER = `attribute vec2 a_position;
varying vec2 v_texCoord;
void main() {
  v_texCoord = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `precision mediump float;
varying vec2 v_texCoord;
uniform sampler2D u_frame;
uniform vec3 u_key;
uniform float u_similarity;
uniform float u_smoothness;
uniform float u_keyLength;
uniform float u_enabled;
void main() {
  vec4 colour = texture2D(u_frame, v_texCoord);
  if (u_enabled < 0.5) {
    // No usable backdrop sample: draw nothing. The raw frame may carry the
    // model's own studio set, which must never reach the HUD.
    gl_FragColor = vec4(0.0);
    return;
  }
  float length_ = length(colour.rgb);
  float alpha = colour.a;
  vec3 rgb = colour.rgb;
  if (length_ >= 0.02) {
    float dot_ = dot(colour.rgb, u_key) / max(length_ * u_keyLength, 0.0001);
    float angle = 1.0 - clamp(dot_, -1.0, 1.0);
    float intensity = abs(length_ - u_keyLength);
    float distance = angle * 1.7 + intensity * 0.15;
    if (length_ < 0.15) distance = max(distance, 0.6);
    alpha = clamp((distance - u_similarity) / u_smoothness, 0.0, 1.0) * colour.a;
  }
  float grey = (rgb.r + rgb.b) * 0.5;
  if (u_key.g > u_key.r && u_key.g > u_key.b && rgb.g > grey) {
    // Spill suppression: soft edges keep none of the backdrop's colour, only
    // its luminance, so the cut-out stays neutral instead of tinted.
    rgb.g = mix(rgb.g, grey, min(1.0, (1.0 - alpha) * 1.5));
  } else if (u_key.b > u_key.r && u_key.b > u_key.g && rgb.b > grey) {
    rgb.b = mix(rgb.b, grey, min(1.0, (1.0 - alpha) * 1.5));
  }
  gl_FragColor = vec4(rgb * alpha, alpha);
}`;

/**
 * How much of the frame's edge the keying actually clears, 0..1.
 *
 * A live render is only worth showing when its border is transparent: the
 * digital human arrives inside a rendered set — sometimes a chroma screen,
 * sometimes the model's own studio — and a frame that still has its edges is a
 * video rectangle on the HUD, which is exactly what the keying exists to avoid.
 * The caller uses this to decide when the picture may take the stage.
 *
 * The maths is the shader's, run over a small probe so the answer is known
 * without reading the GPU back.
 */
export function readBackdropClearance(
  video: HTMLVideoElement,
  probe: HTMLCanvasElement,
  key: KeyColor | null,
  thresholds: { similarity: number; smoothness: number },
): number | null {
  const context = probe.getContext("2d", { willReadFrequently: true });
  if (!context || !video.videoWidth) return null;
  context.clearRect(0, 0, probe.width, probe.height);
  try {
    context.drawImage(video, 0, 0, probe.width, probe.height);
  } catch {
    return null;
  }
  let frame: ImageData;
  try {
    frame = context.getImageData(0, 0, probe.width, probe.height);
  } catch {
    return null;
  }
  // The band hugs the very edge of the frame: a head or a raised arm can reach
  // a tenth of the way in, and a point that lands on the character would read
  // as an unkeyed backdrop.
  const rows = [0.005, 0.02, 0.045, 0.955, 0.98, 0.995];
  const columns = [0.005, 0.02, 0.98, 0.995];
  const points: Array<[number, number]> = [];
  for (const y of rows) {
    for (let step = 0; step <= 16; step += 1) points.push([step / 16, y]);
  }
  for (const x of columns) {
    for (let step = 0; step <= 12; step += 1) points.push([x, step / 12]);
  }
  if (!key) return 0;
  const unitLength = keyUnitLength(key);
  let clear = 0;
  for (const [fx, fy] of points) {
    const x = Math.min(probe.width - 1, Math.max(0, Math.round(fx * (probe.width - 1))));
    const y = Math.min(probe.height - 1, Math.max(0, Math.round(fy * (probe.height - 1))));
    const offset = (y * probe.width + x) * 4;
    const distance = keyDistance(
      frame.data[offset] / 255,
      frame.data[offset + 1] / 255,
      frame.data[offset + 2] / 255,
      key,
      unitLength,
    );
    const alpha = Math.max(
      0,
      Math.min(1, (distance - thresholds.similarity) / thresholds.smoothness),
    );
    if (alpha <= 0.08) clear += 1;
  }
  return points.length ? clear / points.length : null;
}

export type VideoKeyer = {
  /** Draws one frame; returns false when the video has no frame yet. */
  render(video: HTMLVideoElement): boolean;
  setKey(color: KeyColor | null): void;
  key(): KeyColor | null;
  /** Samples the current frame and adopts its backdrop as the key colour. */
  detect(video: HTMLVideoElement): KeySample | null;
  /** The similarity/smoothness the shader is keying with at this moment. */
  thresholds(): { similarity: number; smoothness: number };
  dispose(): void;
};

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

/** WebGL keyer: a 720p frame is one draw call, which keeps the CPU free. */
export function createVideoKeyer(canvas: HTMLCanvasElement): VideoKeyer | null {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const uniforms = {
    key: gl.getUniformLocation(program, "u_key"),
    similarity: gl.getUniformLocation(program, "u_similarity"),
    smoothness: gl.getUniformLocation(program, "u_smoothness"),
    keyLength: gl.getUniformLocation(program, "u_keyLength"),
    enabled: gl.getUniformLocation(program, "u_enabled"),
  };
  let current: KeyColor | null = null;
  let thresholds = { similarity: 0.2, smoothness: 0.16 };
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = 160;
  sampleCanvas.height = 90;
  const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });

  const applyKey = () => {
    const colour = current ?? { r: 0, g: 0, b: 0 };
    const length = keyUnitLength(colour);
    gl.uniform3f(uniforms.key, colour.r / 255, colour.g / 255, colour.b / 255);
    gl.uniform1f(uniforms.keyLength, length);
    gl.uniform1f(uniforms.similarity, thresholds.similarity);
    gl.uniform1f(uniforms.smoothness, thresholds.smoothness);
    gl.uniform1f(uniforms.enabled, current ? 1 : 0);
  };

  return {
    render(video: HTMLVideoElement) {
      if (!video.videoWidth || video.readyState < 2) return false;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      } catch {
        return false;
      }
      applyKey();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    },
    setKey(color: KeyColor | null) {
      current = color;
      thresholds = keyThresholds(color ? 8 : 0);
    },
    key() {
      return current;
    },
    thresholds() {
      return { ...thresholds };
    },
    detect(video: HTMLVideoElement) {
      if (!sampleContext || !video.videoWidth) return null;
      sampleContext.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);
      let frame: ImageData;
      try {
        frame = sampleContext.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
      } catch {
        return null;
      }
      const sample = detectKeyColor(frame.data, sampleCanvas.width, sampleCanvas.height);
      const usable = usableChromaSample(sample);
      if (!usable) return null;
      current = usable.color;
      thresholds = keyThresholds(usable.spread);
      return usable;
    },
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}
