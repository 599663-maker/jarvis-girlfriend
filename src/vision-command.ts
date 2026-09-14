// Spoken control of the camera. The vision component is off by default and is
// switched on by asking for it, so the green camera light is never on just
// because Jarvis is running. Kept DOM-free so the rule table can be unit tested.

const ON_VERBS = [
  "启动", "开启", "打开", "开一下", "开下", "启用", "接入", "连上", "打开一下",
];

const ON_TARGETS = [
  "视频组件", "视频功能", "视频窗口", "视觉组件", "视觉功能", "视觉感知", "视觉系统", "视觉",
  "摄像头", "相机", "眼睛", "视频",
];

/// "你能看到我吗" is a question, not an order, but it means exactly the same
/// thing: the master is asking to be looked at.
const ON_PHRASES = [
  "你能看到我吗", "你能看见我吗", "你能看到我么", "你能看见我么", "你看得到我吗", "你看得见我吗",
  "看得到我吗", "看得见我吗", "能看到我吗", "能看见我吗", "你看到我了吗", "你在看我吗",
  "看看我", "能看看我吗", "能看到我", "能看见我", "你睁开眼", "睁开眼看看",
];

const OFF_VERBS = [
  "关闭", "关掉", "关上", "关一下", "关了", "停用", "停止", "断开", "退出", "别", "不要", "收起",
];

const OFF_TARGETS = [
  "视频组件", "视频功能", "视频窗口", "视觉组件", "视觉功能", "视觉感知", "视觉系统", "视觉",
  "摄像头", "相机", "眼睛", "视频",
];

const OFF_PHRASES = ["别看我了", "别看了", "别看我", "不要看我", "闭上眼睛", "把眼睛闭上", "收起视频"];

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[\s，。！？、,.!?"'“”‘’~～]/g, "");
}

export type VisionCommand = "on" | "off";

/**
 * True when the sentence asks for the camera to be switched on or off. An
 * explicit "别看我了" wins over the generic verbs, and anything longer than a
 * short spoken order is left to Codex.
 */
export function matchVisionCommand(text: string): VisionCommand | null {
  const normalized = normalize(text);
  if (!normalized || normalized.length > 20) return null;
  if (OFF_PHRASES.some((phrase) => normalized.includes(phrase))) return "off";
  if (ON_PHRASES.some((phrase) => normalized.includes(phrase))) return "on";
  const offVerb = OFF_VERBS.some((verb) => normalized.includes(verb));
  if (offVerb && OFF_TARGETS.some((target) => normalized.includes(target))) return "off";
  const onVerb = ON_VERBS.some((verb) => normalized.includes(verb));
  if (onVerb && ON_TARGETS.some((target) => normalized.includes(target))) return "on";
  return null;
}
