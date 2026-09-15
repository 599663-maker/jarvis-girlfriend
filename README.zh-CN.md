<p align="center">
  <img src="docs/images/characters/xiaorourou.png" width="240" alt="小肉肉立绘">
</p>

<h1 align="center">AI Girlfriend · 桌面 AI 女友</h1>

<p align="center">
  嗨，小肉肉 —— 一声呼唤，她从你的 Mac 桌面醒来。
</p>

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

<p align="center">
  <a href="https://github.com/599663-maker/jarvis-girlfriend/releases/latest">下载最新版 DMG</a>
  ·
  <a href="INTRO.md">项目介绍</a>
  ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>

<p align="center">
  <img src="docs/images/scene-greet.png" width="560" alt="小肉肉打招呼挥手">
</p>

桌面 AI 女友是一个 macOS 本地语音伴侣，由 Codex 驱动。说一句「嗨小肉肉」或
「嗨张元英」，透明窗口就从桌面升起，她会挥手和你打招呼；随后通过 Codex
app-server WebRTC 进入同一个 Codex 线程。你可以自然对话、打断回复、继续追问，
也可以让 Codex 在选定项目中真正执行任务。

- 多角色：小肉肉、张元英已经登场，还可以创建最多 10 个自定义角色。
- 每个角色都有提前渲染好的三幕本地动画：打招呼挥手、等待踱步、静态立绘。
- 只有明确说「呼叫她」才会拨通 Vidu S1 实时视频通话，平时不消耗任何积分。
- 想要了解角色设定与功能特色，请阅读单独的[项目介绍](INTRO.md)。

> 当前状态：已在 macOS 26 Apple Silicon 实机验证唤醒、实时转写、语音回复和
> Codex 任务执行。Realtime conversation 仍是实验性的 Codex app-server 能力，
> 上游协议升级时可能需要同步适配。

## 角色阵容

<p align="center">
  <img src="docs/images/characters/xiaorourou.png" width="200" alt="小肉肉">
  <img src="docs/images/characters/zhangyuanying.png" width="200" alt="张元英">
</p>

- **小肉肉** —— 小可爱女生，实时通话音色 Momo，问候语「Hi 主人，小肉肉来了」，
  拥有完整的挥手、踱步、静态三幕动画，是当前默认角色。
- **张元英** —— 温柔甜美、元气满满，实时通话音色 Cindy，问候语
  「元英在呢，主人！今天想让我陪你做点什么呀？」。
- **你的自定义角色** —— 最多创建 10 个：定名字、写人设、选音色，用 Vidu 生成
  形象，或导入本地图片自动抠出人物主体。

每个角色都自带人设、音色和专属唤醒词「嗨 + 名字」；说一句「切换成 &lt;名字&gt;」
就能直接变身。

## 三幕式本地动画

三幕动画都是提前渲染好的本地视频，全程离线播放、不消耗积分，只在对应场景出现：

| ① 打招呼挥手 | ② 等待踱步 | ③ 静态立绘 |
| --- | --- | --- |
| <img src="docs/images/scene-greet.png" width="300" alt="打招呼挥手"> | <img src="docs/images/scene-wait.png" width="300" alt="等待踱步"> | <img src="docs/images/scene-static.png" width="300" alt="静态立绘"> |
| 刚打开窗口时挥手，并说「Hi 主人，小肉肉来了」 | 你提问、Codex 回答期间，手放身前轻轻踱步 | 没有指令时保持静态立绘，随时待命 |

## 实时视频通话（可选）

说「呼叫小肉肉」或「打开视频」，才会拨通 Vidu S1 实时数字人通话：她会同步开口
说话，画面实时抠像透明显示在桌面上。挂断后自动回到本地三幕动画。

## 主要能力

- 本机语音识别唤醒词：嗨/嘿 + 角色名（嗨小肉肉、嗨张元英）
- Tauri 2 + Rust + TypeScript 透明无边框桌面界面
- 通过 app-server V3 WebRTC 直接连接 Codex Voice
- 语音、文字、工具事件和任务执行共用同一个 Codex 线程
- 按规范化后的工作目录持久化并续接不同线程
- 支持自然轮流说话、回复中打断、连续追问和 STOP
- 可选摄像头视觉感知，画面只在本机处理
- 提供安全、自动办公和完全访问三档权限
- 登录时后台启动，冷启动或暖启动唤醒后升起窗口
- Voice 临时不可用时可以使用文字输入

应用不模拟点击 Codex 或 ChatGPT 窗口，不绑定全局热键，也不创建第二套
GPT-Live 会话。它复用本机 Codex 的登录状态和 app-server runtime。

## 工作原理

```text
唤醒监听（本机语音识别「嗨 + 角色名」）
        ↓
Tauri / Rust 宿主升起透明窗口，播放打招呼挥手
        ↓
唤醒监听器释放麦克风
        ↓
WebView 创建 WebRTC offer
        ↓
Codex app-server V3 realtime conversation
        ↓
语音、文字、工具和项目任务共用一个 Codex 线程
```

Swift 唤醒 helper 与 Voice 会话不会同时采集麦克风。运行时、线程生命周期和信任
边界详见[架构文档](docs/ARCHITECTURE.md)。

## 快速开始

1. 在 Mac 上安装并登录 Codex App、ChatGPT App 或 Codex CLI。
2. 下载最新 DMG，把应用拖入「应用程序」。
3. 首次启动时允许麦克风和语音识别权限。
4. 打开设置，选择希望 Codex 工作的项目目录。
5. 关闭窗口，让她留在后台监听。
6. 对电脑说「嗨小肉肉」，窗口升起后直接说出任务。
7. 将鼠标移到角色上显示控制按钮；点击 `STOP` 可中断 Voice 和当前任务。

Voice 暂时不可用时，可以使用底部文字输入框。语音和文字都会进入当前工作目录所
对应的线程。

## 权限模式

| 模式 | Sandbox | 审批策略 | 使用场景 |
| --- | --- | --- | --- |
| 安全模式 | `workspace-write` | `on-request` | 需要时确认操作 |
| 自动办公 | `workspace-write` | `never` | 在当前工作目录内自主执行 |
| 完全访问 | `danger-full-access` | `never` | 用户明确启用的高信任任务 |

权限配置由 Rust 宿主验证，前端不能传入任意 sandbox 或审批策略字符串。

## 系统要求

普通使用：

- macOS 13 或更高版本
- 当前发布的 DMG 面向 Apple Silicon
- 已安装并登录 Codex App、ChatGPT App 或 Codex CLI
- 麦克风和语音识别权限

源码开发：

- Node.js 20 或更高版本
- Rust stable，并安装 `rustfmt` 和 `clippy`
- Xcode Command Line Tools 和 Swift

## 本地开发

```bash
npm ci
npm run check
npm run dev
```

设置开发时的初始工作目录：

```bash
JARVIS_WORKSPACE=/absolute/path npm run dev
```

也可以在设置面板中保存工作目录。

## 测试

提交 Pull Request 前请运行：

```bash
npm run check
npm run build
```

如果修改了唤醒、麦克风、Voice、STOP、线程续接、权限或打包逻辑，还需要在真实
macOS 环境执行 smoke test。现有自动化测试会检查重要协议与生命周期约束，但不能
证明实验性 realtime 服务和 macOS 隐私授权端到端正常。

## 构建

```bash
npm run build
```

预期产物：

- `src-tauri/target/release/bundle/macos/Jarvis Girlfriend.app`
- `src-tauri/target/release/bundle/dmg/Jarvis Girlfriend_0.2.0_aarch64.dmg`

构建脚本会生成并签名 `JarvisWakeListener.app`，生成的 app bundle 不进入 Git。

## 生产发布

本地构建默认使用 ad-hoc 签名身份 `-`。公开分发必须使用 Apple Developer ID
Application 证书并完成 notarization，不应把 ad-hoc 构建描述为生产版本。

签名、公证、entitlement 和 smoke test 要求见[生产发布清单](docs/PRODUCTION.md)。

## 隐私与安全

- 唤醒词强制使用本机语音识别。
- 只有唤醒后，麦克风音频才进入 Codex Voice。
- 不保存原始音频和登录凭据。
- WebView 使用限制性内容安全策略。
- 自动办公模式限制在选定工作目录内。
- 完全访问必须由用户主动选择。
- Siri 不参与主链路。

安全问题请按照 [SECURITY.md](SECURITY.md) 私下报告，不要创建公开 Issue。

## 开源许可证

使用 [GNU General Public License v3.0](LICENSE) 开源，基于 Big-Guan 的开源语音
Codex 项目构建，保留原始 GPL-3.0 许可证与署名。

## 参与贡献

欢迎参与项目贡献。`main` 分支受到保护，不接受直接推送。贡献者需要先 Fork 仓库，
在自己的 Fork 中创建分支，然后提交 Pull Request。开始开发前请阅读
[CONTRIBUTING.md](CONTRIBUTING.md)。
