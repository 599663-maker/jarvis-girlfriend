// Spoken "close Jarvis" is answered by the app itself: sending it to Codex
// costs a model round trip, and a surviving wake listener is exactly what
// re-opened Jarvis right after a spoken close. Kept DOM-free so the rules can
// be unit tested.
const SELF_WORDS = ["jarvis", "贾维斯", "你", "自己", "本体", "语音助手"];

const CLOSE_VERBS = [
  "关闭", "关掉", "关上", "关一下", "关了", "退出", "结束", "停止", "关机", "下班", "关",
];

// Objects that mean the sentence is really a task ("关闭 jarvis 的终端"), not a
// request for Jarvis itself to go away.
const OTHER_TARGETS = [
  "终端", "脚本", "文件", "网页", "浏览器", "音乐", "灯", "空调", "电脑", "屏幕",
  "视频", "进程", "任务", "线程", "消息", "对话", "语音", "麦克风", "监听",
  "闹钟", "定时", "窗口", "歌",
];

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * True when the sentence asks Jarvis itself to shut down. Trigger-happy closes
 * are worse than none, so a sentence that also names another target ("关闭
 * jarvis 的终端") stays a task for Codex.
 */
export function matchShutdownCommand(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized || normalized.length > 24) return false;
  if (!SELF_WORDS.some((word) => normalized.includes(word))) return false;
  if (!CLOSE_VERBS.some((verb) => normalized.includes(verb))) return false;
  return !OTHER_TARGETS.some((target) => normalized.includes(target));
}
