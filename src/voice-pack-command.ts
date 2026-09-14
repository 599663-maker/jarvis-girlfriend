// Spoken voice-pack switching: a short sentence such as "换成可爱女声" is
// intercepted by the HUD and never reaches Codex. Kept DOM-free so the rule
// table can be unit tested.
const VOICE_PACK_KEYS: Array<[string, string[]]> = [
  ["female", ["温柔", "晓晓"]],
  ["girl", ["可爱", "少女", "女孩子", "小女孩", "晓伊"]],
  ["male", ["男声", "男生", "男人", "男音", "云希"]],
  ["jarvis", ["机器人", "机械", "金属", "贾维斯的声音", "原来的声音", "原来的音色", "云扬"]],
  ["local", ["离线", "本机", "婷婷", "本地"]],
  ["girl", ["女声", "女音", "女生"]],
];

export const VOICE_PACK_SPEECH: Record<string, string> = {
  jarvis: "JARVIS 机器人音",
  male: "男声",
  girl: "可爱女声",
  female: "温柔女声",
  local: "本机离线语音",
};

const VOICE_PACK_VERBS = [
  "换成", "换个", "换一个", "换一下", "切换", "改成", "改为", "改用", "变成",
  "调成", "用一下", "试试", "试一下", "我想听", "我要听", "来一个", "来段",
];

export function matchVoicePackCommand(text: string): string | null {
  const normalized = text.replace(/[\s，。！？、,.!?"'“”‘’]/g, "");
  if (!normalized || normalized.length > 20) return null;
  if (!VOICE_PACK_VERBS.some((verb) => normalized.includes(verb))) return null;
  for (const [id, keys] of VOICE_PACK_KEYS) {
    if (keys.some((key) => normalized.includes(key))) return id;
  }
  return null;
}
