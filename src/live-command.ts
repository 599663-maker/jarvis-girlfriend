import type { AvatarName } from "./avatar-command";

// Spoken control of the realtime video call with the current character.
//
// "打开视频" means a video call; the camera-only phrases ("视频组件",
// "摄像头", "你能看到我吗") stay with the vision matcher, so the two never
// fight over the same sentence. Kept DOM-free so the table can be unit tested.

const VISION_KEYS = [
  "组件", "窗口", "功能", "摄像头", "相机", "视觉", "眼睛", "感知",
  "看看我", "看到我", "看见我", "看得到我", "看得见我",
];

const CALL_WORDS = [
  "视频对话", "视频通话", "视频聊天", "视频电话", "实时对话", "实时通话", "实时聊天",
  "面对面", "数字人对话", "视频聊", "视频见", "视频模式", "视频连线",
];

/// Short orders in which "视频" alone already means a call.
const BARE_VIDEO = ["打开视频", "开视频", "启动视频", "开启视频", "来个视频", "视频一下", "视频吧"];

/// Sentences about video *files* are tasks, not call control.
const FILE_WORDS = [
  "转成", "转换", "剪", "编辑", "下载", "文件", "发给", "发送", "压缩", "格式", "字幕",
  "上传", "导出", "mp3", "mp4", "mov", "gif",
];

const START_VERBS = [
  "启动", "开启", "打开", "开始", "进入", "来个", "来一个", "来一段", "打", "开",
  "要", "想", "能不能", "可以", "帮我",
];

const STOP_PHRASES = [
  "挂断", "挂掉", "挂了", "停掉", "收线", "结束通话", "结束对话", "结束交流", "结束视频",
  "结束实时", "关闭视频", "关掉视频", "关视频", "退出视频", "停止视频", "不聊了", "别聊了",
  "先这样", "拜拜", "再见", "退下",
];

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[\s，。！？、,.!?"'“”‘’~～]/g, "");
}

export type LiveCommand = "start" | "stop";

/**
 * True when the sentence asks to open or close the realtime video call. Longer
 * sentences are left to Codex, because they are tasks, not call control.
 */
export function matchLiveCommand(text: string): LiveCommand | null {
  const normalized = normalize(text);
  if (!normalized || normalized.length > 22) return null;
  if (STOP_PHRASES.some((phrase) => normalized.includes(phrase))) return "stop";
  if (VISION_KEYS.some((key) => normalized.includes(key))) return null;
  if (FILE_WORDS.some((word) => normalized.includes(word))) return null;
  if (BARE_VIDEO.some((phrase) => normalized.includes(phrase))) return "start";
  if (!CALL_WORDS.some((word) => normalized.includes(word))) return null;
  if (START_VERBS.some((verb) => normalized.includes(verb))) return "start";
  return normalized.length <= 8 ? "start" : null;
}

/// Ordering a call by name: "呼叫张元英" / "拨打张元英" / "给张元英打电话".
/// Kept apart from the "打开视频" rules because a name makes it a direct dial.
const CALL_VERBS = [
  "拨打", "拨通", "打给", "接通", "连线", "打电话", "视频电话",
];

/// Words that mean "call" only when almost nothing else is in the sentence:
/// "叫张元英" is an order, "叫张元英写诗" is a task for Codex.
const CALL_HINTS = ["呼叫", "呼一下", "呼", "找", "叫", "让"];

const BUILTIN_ALIASES = ["jarvis", "贾维斯"];

export function matchCallCommand(text: string, avatars: AvatarName[]): string | null {
  const normalized = normalize(text);
  if (!normalized || normalized.length > 18) return null;
  const strong = CALL_VERBS.filter((verb) => normalized.includes(verb));
  const hints = CALL_HINTS.filter((hint) => normalized.includes(hint));
  if (strong.length === 0 && hints.length === 0) return null;
  // Longest name first, so "小美" never shadows a character called 小美美.
  const candidates = [...avatars].sort((left, right) => right.name.length - left.name.length);
  for (const avatar of candidates) {
    const keys = [avatar.name.trim().toLowerCase()];
    if (avatar.id === "jarvis") keys.push(...BUILTIN_ALIASES);
    const named = keys.find((key) => key && normalized.includes(key));
    if (!named) continue;
    let rest = normalized;
    for (const key of keys) rest = rest.split(key).join("");
    for (const word of [...strong, ...hints]) rest = rest.split(word).join("");
    rest = rest.replace(/^(给|和|跟|帮我|请|快|一下|吧|呀|啊|喂)/, "");
    // "给张元英打电话" leaves one character ("给"); a sentence that asks for
    // something ("叫张元英写首诗") must stay a task.
    const budget = strong.length > 0 ? 3 : 1;
    if (rest.length > budget) return null;
    return avatar.id;
  }
  return null;
}
