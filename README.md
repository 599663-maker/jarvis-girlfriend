<p align="center">
  <img src="docs/images/characters/xiaorourou.png" width="240" alt="Xiaorourou portrait">
</p>

<h1 align="center">AI Girlfriend · Desktop AI Companion</h1>

<p align="center">
  Say "Hi Xiaorourou" — and she rises from your Mac desktop.
</p>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/599663-maker/jarvis-girlfriend/releases/latest">Download the latest DMG</a>
  ·
  <a href="INTRO.md">Project intro</a>
  ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img src="docs/images/scene-greet.png" width="560" alt="Xiaorourou waving hello">
</p>

AI Girlfriend is a local voice companion for macOS, powered by Codex. Say
"Hi Xiaorourou" or "Hi Zhang Yuanying" and a transparent window rises from your
desktop; she waves hello, then joins the same Codex thread through the Codex
app-server WebRTC connection. You can chat naturally, interrupt replies, ask
follow-ups, or let Codex actually execute tasks in a project directory you
choose.

- Multiple characters: Xiaorourou (小肉肉) and Zhang Yuanying (张元英) are here,
  and you can create up to 10 of your own.
- Every character has three pre-rendered local scenes: a greeting wave, a
  waiting pace, and a static portrait.
- Vidu S1 realtime video calls are dialed only when you explicitly ask — no
  credits are consumed otherwise.
- Read the [project intro](INTRO.md) for the characters, features and design.

> Current status: wake word, live transcription, voice replies and Codex task
> execution are verified on macOS 26 Apple Silicon. Realtime conversation is
> still an experimental Codex app-server capability and may need adaptations
> when the upstream protocol changes.

## Characters

<p align="center">
  <img src="docs/images/characters/xiaorourou.png" width="200" alt="Xiaorourou">
  <img src="docs/images/characters/zhangyuanying.png" width="200" alt="Zhang Yuanying">
</p>

- **Xiaorourou (小肉肉)** — a cute, soft-spoken girl; realtime call voice Momo;
  greeting "Hi, master — Xiaorourou is here"; ships with the full wave / pace /
  static scene set and is the current default character.
- **Zhang Yuanying (张元英)** — gentle, sweet and energetic; realtime call voice
  Cindy; greeting "Yuanying is here, master! What shall we do today?".
- **Your own characters** — create up to 10: pick a name, write a persona,
  choose a voice pack, generate art with Vidu or import a local image that gets
  cut out automatically.

Every character carries its own persona, voice and a name-based wake phrase
("Hi + name"); say "switch to &lt;name&gt;" to change on the fly.

## Three local scenes

All three scenes are pre-rendered local videos — fully offline playback with no
credit cost — and appear only in their matching situation:

| ① Greeting wave | ② Waiting pace | ③ Static portrait |
| --- | --- | --- |
| <img src="docs/images/scene-greet.png" width="300" alt="Greeting wave"> | <img src="docs/images/scene-wait.png" width="300" alt="Waiting pace"> | <img src="docs/images/scene-static.png" width="300" alt="Static portrait"> |
| Waves and says "Hi, master — Xiaorourou is here" when the window opens | Hands folded, pacing gently while you ask and Codex answers | Stands still whenever there is nothing to do |

## Realtime video calls (optional)

Say "call Xiaorourou" or "open the video" to dial a Vidu S1 realtime digital
human: she speaks in sync, keyed live onto your desktop as a transparent
overlay. Hanging up returns to the local scenes automatically.

## Key features

- On-device speech recognition for the wake phrase: Hi/Hey + character name
- Tauri 2 + Rust + TypeScript transparent, frameless desktop UI
- Connects to Codex Voice directly through the app-server V3 WebRTC API
- Voice, text, tool events and task execution share one Codex thread
- Threads are persisted and resumed per normalized working directory
- Natural turn-taking, mid-reply interruption, follow-ups and STOP
- Optional camera vision — frames are processed locally only
- Three permission levels: safe, auto office, and full access
- Starts in the background at login; the window rises on cold or warm wake
- Text input fallback when Voice is temporarily unavailable

The app does not simulate clicks on the Codex or ChatGPT windows, does not
register global hotkeys, and does not create a second GPT-Live session. It
reuses your local Codex login and the app-server runtime.

## How it works

```text
Wake listener (on-device "Hi + character name")
        ↓
Tauri / Rust host raises the transparent window and plays the greeting wave
        ↓
The wake listener releases the microphone
        ↓
The WebView creates the WebRTC offer
        ↓
Codex app-server V3 realtime conversation
        ↓
Voice, text, tools and project tasks share one Codex thread
```

The Swift wake helper and the Voice session never capture the microphone at the
same time. See the [architecture docs](docs/ARCHITECTURE.md) for runtime, thread
lifecycle and trust boundaries.

## Quick start

1. Install and sign in to the Codex app, ChatGPT app or Codex CLI on your Mac.
2. Download the latest DMG and drag the app into Applications.
3. Allow microphone and speech recognition on first launch.
4. Open settings and pick the project directory Codex should work in.
5. Close the window and leave her listening in the background.
6. Say "Hi Xiaorourou" to your Mac, then speak your task.
7. Move the mouse over the character to reveal controls; `STOP` interrupts the
   Voice session and the current task.

Use the text input at the bottom while Voice is unavailable. Both voice and
text go to the thread for the current working directory.

## Permission modes

| Mode | Sandbox | Approval policy | Use case |
| --- | --- | --- | --- |
| Safe | `workspace-write` | `on-request` | Confirm actions when needed |
| Auto office | `workspace-write` | `never` | Autonomous work inside the directory |
| Full access | `danger-full-access` | `never` | High-trust tasks you opt into |

Permission config is validated by the Rust host; the frontend cannot pass
arbitrary sandbox or approval strings.

## Requirements

Everyday use:

- macOS 13 or later
- The published DMG targets Apple Silicon
- Codex app, ChatGPT app or Codex CLI installed and signed in
- Microphone and speech recognition permissions

Development:

- Node.js 20 or later
- Stable Rust with `rustfmt` and `clippy`
- Xcode Command Line Tools and Swift

## Development

```bash
npm ci
npm run check
npm run dev
```

Set the initial working directory for development:

```bash
JARVIS_WORKSPACE=/absolute/path npm run dev
```

You can also save the working directory in the settings panel.

## Testing

Run before opening a pull request:

```bash
npm run check
npm run build
```

If you changed wake, microphone, Voice, STOP, thread resumption, permissions or
packaging, run a smoke test on a real macOS machine as well. The automated
tests cover important protocol and lifecycle constraints, but cannot prove the
experimental realtime service or macOS privacy grants end to end.

## Building

```bash
npm run build
```

Expected artifacts:

- `src-tauri/target/release/bundle/macos/Jarvis Girlfriend.app`
- `src-tauri/target/release/bundle/dmg/Jarvis Girlfriend_0.2.0_aarch64.dmg`

The build script generates and signs `JarvisWakeListener.app`; generated app
bundles are not committed to Git.

## Production releases

Local builds default to the ad-hoc signing identity `-`. Public distribution
must use an Apple Developer ID Application certificate and notarization; never
describe an ad-hoc build as production. See the [production checklist](docs/PRODUCTION.md)
for signing, notarization, entitlements and smoke test requirements.

## Privacy & security

- The wake phrase always uses on-device speech recognition.
- Microphone audio reaches Codex Voice only after a wake.
- Raw audio and login credentials are never stored.
- The WebView uses a restrictive Content Security Policy.
- Auto office mode is limited to the working directory you selected.
- Full access must be opted into explicitly.
- Siri is not part of the main path.

Report security issues privately as described in [SECURITY.md](SECURITY.md), not
in public issues.

## License

Licensed under [GNU General Public License v3.0](LICENSE). Built on Big-Guan's
open-source voice Codex project; the original GPL-3.0 license and attribution
are retained.

## Contributing

Contributions are welcome. The `main` branch is protected against direct
pushes. Fork the repository, create a branch in your fork and open a pull
request. Read [CONTRIBUTING.md](CONTRIBUTING.md) before you start.
