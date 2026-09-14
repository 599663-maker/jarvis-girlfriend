// Spoken character switching: "切换成小美" is answered by the HUD, so changing
// character never costs a model round trip. The rule table is dynamic because
// the names come from the local character store. Kept DOM-free so the matcher
// can be unit tested.

const SWITCH_VERBS = [
  "切换成", "切换到", "切换为", "切换", "换成", "换个", "换一个", "换一下", "换回",
  "变成", "变回", "变身成", "变身", "召出", "召唤", "我要见", "我要", "我想见",
  "调成", "改成", "改为", "启用", "换成新", "用",
];

/// "变回你自己" has no name in it, so the built-in character needs its own keys.
const SELF_KEYS = ["你自己", "原来的样子", "原来的形象", "原本的样子", "本体", "本来的样子"];

/// The built-in character answers to its Chinese name too, because the spoken
/// wake phrase is already Chinese.
const BUILTIN_ALIASES = ["jarvis", "贾维斯"];

export type AvatarName = { id: string; name: string };

export function matchAvatarCommand(text: string, avatars: AvatarName[]): string | null {
  const normalized = text.replace(/[\s，。！？、,.!?"'“”‘’]/g, "").toLowerCase();
  if (!normalized || normalized.length > 24) return null;
  if (!SWITCH_VERBS.some((verb) => normalized.includes(verb))) return null;
  if (SELF_KEYS.some((key) => normalized.includes(key))) {
    const builtin = avatars.find((avatar) => avatar.id === "jarvis");
    if (builtin) return builtin.id;
  }
  // Longest name first, so "小美" never shadows a character called "小美美".
  const candidates = [...avatars].sort((left, right) => right.name.length - left.name.length);
  for (const avatar of candidates) {
    const keys = [avatar.name.trim().toLowerCase()];
    if (avatar.id === "jarvis") keys.push(...BUILTIN_ALIASES);
    if (keys.some((key) => key && normalized.includes(key))) return avatar.id;
  }
  return null;
}
