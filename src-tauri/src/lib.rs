use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex, RwLock},
    time::{timeout, Duration},
};

mod avatars;
mod live;
mod matte;
mod vidu;
mod vision;

struct AppState {
    runtime: Mutex<Option<Arc<CodexRuntime>>>,
    cold_wake_pending: AtomicBool,
    background_start: bool,
    wake_enabled: AtomicBool,
    wake_ready: AtomicBool,
    wake_supervisor_running: AtomicBool,
    wake_pid: AtomicU32,
    wake_authorization: RwLock<String>,
    wake_control: RwLock<Option<PathBuf>>,
}

/// A tiny log bridge: a webview that cannot open a dev console has no other way
/// to report what its media stack or realtime session is doing.
#[tauri::command]
fn web_log(message: String) {
    append_state_log("web.log", &message);
}

#[tauri::command]
fn startup_is_background(state: State<'_, AppState>) -> bool {
    state.background_start
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn request_microphone_permission() -> Result<String, String> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    use std::sync::Mutex as StdMutex;

    let media_type =
        unsafe { AVMediaTypeAudio }.ok_or_else(|| "macOS 未提供音频授权类型".to_owned())?;
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
    match status {
        AVAuthorizationStatus::Authorized => return Ok("authorized".to_owned()),
        AVAuthorizationStatus::Denied => return Ok("denied".to_owned()),
        AVAuthorizationStatus::Restricted => return Ok("restricted".to_owned()),
        _ => {}
    }

    let (sender, receiver) = oneshot::channel::<bool>();
    let sender = Arc::new(StdMutex::new(Some(sender)));
    {
        let completion_sender = sender.clone();
        let completion = RcBlock::new(move |granted: Bool| {
            if let Ok(mut guard) = completion_sender.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(granted.as_bool());
                }
            }
        });
        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &completion);
        }
    }
    let granted = receiver
        .await
        .map_err(|_| "macOS 麦克风授权回调中断".to_owned())?;
    Ok(if granted { "authorized" } else { "denied" }.to_owned())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn request_microphone_permission() -> Result<String, String> {
    Ok("authorized".to_owned())
}

struct CodexRuntime {
    writer: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    thread_id: RwLock<Option<String>>,
    active_turn: RwLock<Option<String>>,
    voice_active: AtomicBool,
    voice_phase: RwLock<String>,
    realtime_session_id: RwLock<Option<String>>,
    permission_mode: PermissionMode,
    workspace: String,
    avatar_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum PermissionMode {
    Safe,
    Auto,
    Full,
}

struct PermissionProfile {
    approval_policy: &'static str,
    sandbox: &'static str,
    instructions: &'static str,
}

impl PermissionMode {
    fn profile(self) -> PermissionProfile {
        match self {
            Self::Safe => PermissionProfile {
                approval_policy: "on-request",
                sandbox: "workspace-write",
                instructions: "Require explicit confirmation when Codex requests approval for actions outside the workspace boundary or for risky operations.",
            },
            Self::Auto => PermissionProfile {
                approval_policy: "never",
                sandbox: "workspace-write",
                instructions: "Work autonomously inside the selected workspace. Never request elevated access; if an action is blocked by the sandbox, explain the blocked boundary and continue with the safest in-workspace alternative.",
            },
            Self::Full => PermissionProfile {
                approval_policy: "never",
                sandbox: "danger-full-access",
                instructions: "Full filesystem and network access is enabled. Still avoid destructive or irreversible actions unless the user explicitly requested the exact action and target.",
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    thread_id: String,
    cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectVoiceInfo {
    codex_connected: bool,
    voice_active: bool,
    phase: String,
    protocol: &'static str,
    thread_id: Option<String>,
    realtime_session_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WakeStatus {
    enabled: bool,
    ready: bool,
    authorization: String,
}

fn raise_jarvis_window(app: &AppHandle) {
    if vision::session_enabled() {
        vision::start(app.clone());
    }
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        {
            use objc2::MainThreadMarker;
            use objc2_app_kit::NSApplication;

            if let Some(mtm) = MainThreadMarker::new() {
                let application = NSApplication::sharedApplication(mtm);
                #[allow(deprecated)]
                application.activateIgnoringOtherApps(true);
            }
        }

        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            // A short floating interval lets macOS finish switching the
            // active application before the window returns to normal level.
            let _ = window.set_always_on_top(true);
            let _ = window.set_focus();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(700)).await;
                let _ = window.set_always_on_top(false);
            });
        }
    });
}

impl CodexRuntime {
    async fn spawn(
        app: AppHandle,
        permission_mode: PermissionMode,
        workspace: String,
        avatar_id: String,
    ) -> Result<Arc<Self>, String> {
        let codex_binary = codex_binary_path(&app)?;
        let mut child = Command::new(&codex_binary)
            // Realtime is an experimental app-server surface. Enable it only
            // for this isolated Jarvis child; never mutate ~/.codex/config.toml.
            .args(["app-server", "--enable", "realtime_conversation", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("无法启动 codex app-server：{error}"))?;
        let writer = child.stdin.take().ok_or("无法连接 Codex stdin")?;
        let stdout = child.stdout.take().ok_or("无法连接 Codex stdout")?;
        let stderr = child.stderr.take().ok_or("无法连接 Codex stderr")?;
        let runtime = Arc::new(Self {
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            thread_id: RwLock::new(None),
            active_turn: RwLock::new(None),
            voice_active: AtomicBool::new(false),
            voice_phase: RwLock::new("standby".to_owned()),
            realtime_session_id: RwLock::new(None),
            permission_mode,
            workspace,
            avatar_id,
        });

        let weak = Arc::downgrade(&runtime);
        let event_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                eprintln!(
                    "codex rpc: id={} method={}",
                    message
                        .get("id")
                        .map(Value::to_string)
                        .unwrap_or_else(|| "-".to_owned()),
                    message.get("method").and_then(Value::as_str).unwrap_or("-")
                );
                if message.get("method").is_none() {
                    if let Some(id) = message.get("id").and_then(Value::as_u64) {
                        if let Some(runtime) = weak.upgrade() {
                            if let Some(sender) = runtime.pending.lock().await.remove(&id) {
                                let result = if let Some(error) = message.get("error") {
                                    Err(error
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .unwrap_or("Codex request failed")
                                        .to_owned())
                                } else {
                                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                                };
                                let _ = sender.send(result);
                            }
                        }
                    }
                    continue;
                }
                if let Some(runtime) = weak.upgrade() {
                    match message.get("method").and_then(Value::as_str) {
                        Some("turn/started") => {
                            *runtime.active_turn.write().await = message
                                .pointer("/params/turn/id")
                                .and_then(Value::as_str)
                                .map(str::to_owned);
                        }
                        Some("turn/completed") | Some("turn/failed") => {
                            *runtime.active_turn.write().await = None;
                            // Hand the microphone back to the wake listener when
                            // nothing is being read aloud, so a silent turn
                            // cannot freeze the conversation.
                            if !SPEAK_ACTIVE.load(Ordering::SeqCst)
                                && SPEAK_PENDING.load(Ordering::SeqCst) == 0
                            {
                                let app = event_app.clone();
                                tauri::async_runtime::spawn(async move {
                                    write_wake_control(&app, "unmute").await;
                                });
                            }
                        }
                        Some("thread/realtime/started") => {
                            runtime.voice_active.store(true, Ordering::SeqCst);
                            *runtime.voice_phase.write().await = "connected".to_owned();
                            *runtime.realtime_session_id.write().await = message
                                .pointer("/params/realtimeSessionId")
                                .and_then(Value::as_str)
                                .map(str::to_owned);
                        }
                        Some("thread/realtime/error") => {
                            runtime.voice_active.store(false, Ordering::SeqCst);
                            *runtime.voice_phase.write().await = "error".to_owned();
                        }
                        Some("thread/realtime/closed") => {
                            runtime.voice_active.store(false, Ordering::SeqCst);
                            *runtime.voice_phase.write().await = "closed".to_owned();
                            *runtime.realtime_session_id.write().await = None;
                        }
                        _ => {}
                    }
                }
                let _ = event_app.emit("codex-event", message);
            }
        });
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("codex stderr: {line}");
                if line.contains("ERROR") {
                    let _ = app.emit("codex-diagnostic", line);
                }
            }
        });
        Ok(runtime)
    }

    async fn write(&self, message: &Value) -> Result<(), String> {
        let mut payload = serde_json::to_vec(message).map_err(|error| error.to_string())?;
        payload.push(b'\n');
        let mut writer = self.writer.lock().await;
        writer
            .write_all(&payload)
            .await
            .map_err(|error| error.to_string())?;
        writer.flush().await.map_err(|error| error.to_string())
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        if let Err(error) = self
            .write(&json!({"id": id, "method": method, "params": params}))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        timeout(Duration::from_secs(90), receiver)
            .await
            .map_err(|_| format!("{method} 响应超时"))?
            .map_err(|_| format!("{method} 响应通道关闭"))?
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write(&json!({"method": method, "params": params}))
            .await
    }

    async fn thread(&self) -> Result<String, String> {
        self.thread_id
            .read()
            .await
            .clone()
            .ok_or("Jarvis 尚未连接 Codex 线程".to_owned())
    }
}

fn codex_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(configured) = std::env::var("JARVIS_CODEX_BIN") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("codex");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    let mut candidates = vec![
        PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex"),
        PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(&home).join(".local/bin/codex"));
        candidates.push(PathBuf::from(home).join(".cargo/bin/codex"));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "未找到 Codex 可执行文件；请安装 Codex，或设置 JARVIS_CODEX_BIN。".to_owned()
        })
}

async fn runtime(state: &State<'_, AppState>) -> Result<Arc<CodexRuntime>, String> {
    state
        .runtime
        .lock()
        .await
        .clone()
        .ok_or("Jarvis runtime 尚未启动".to_owned())
}

async fn direct_voice_info(state: &State<'_, AppState>) -> DirectVoiceInfo {
    let runtime = state.runtime.lock().await.clone();
    let Some(runtime) = runtime else {
        return DirectVoiceInfo {
            codex_connected: false,
            voice_active: false,
            phase: "standby".to_owned(),
            protocol: "Codex app-server V3 · WebRTC",
            thread_id: None,
            realtime_session_id: None,
        };
    };
    let phase = runtime.voice_phase.read().await.clone();
    let thread_id = runtime.thread_id.read().await.clone();
    let realtime_session_id = runtime.realtime_session_id.read().await.clone();
    DirectVoiceInfo {
        codex_connected: true,
        voice_active: runtime.voice_active.load(Ordering::SeqCst),
        phase,
        protocol: "Codex app-server V3 · WebRTC",
        thread_id,
        realtime_session_id,
    }
}

#[tauri::command]
async fn direct_voice_status(state: State<'_, AppState>) -> Result<DirectVoiceInfo, String> {
    Ok(direct_voice_info(&state).await)
}

fn wake_helper_path(app: &AppHandle) -> Result<PathBuf, String> {
    let relative = PathBuf::from("wake-helper/JarvisWakeListener.app");
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join(&relative);
        if bundled.exists() {
            return Ok(bundled);
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
    if development.exists() {
        return Ok(development);
    }
    Err("Jarvis 唤醒监听器未找到".to_owned())
}

fn host_app_bundle_path(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let contents_dir = resource_dir.parent()?;
    let bundle = contents_dir.parent()?;
    (bundle.extension().and_then(|value| value.to_str()) == Some("app"))
        .then(|| bundle.to_path_buf())
}

async fn wake_status_value(state: &AppState) -> WakeStatus {
    WakeStatus {
        enabled: state.wake_enabled.load(Ordering::SeqCst),
        ready: state.wake_ready.load(Ordering::SeqCst),
        authorization: state.wake_authorization.read().await.clone(),
    }
}

fn start_wake_supervisor(app: AppHandle) {
    let state = app.state::<AppState>();
    if state.wake_supervisor_running.swap(true, Ordering::SeqCst) {
        return;
    }
    state.wake_enabled.store(true, Ordering::SeqCst);

    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let capture_command = voice_text_only();
        let conversation = capture_command && conversation_enabled();
        let helper = match wake_helper_path(&app) {
            Ok(path) => path,
            Err(error) => {
                *state.wake_authorization.write().await = error.clone();
                state.wake_enabled.store(false, Ordering::SeqCst);
                state.wake_supervisor_running.store(false, Ordering::SeqCst);
                let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
                return;
            }
        };
        // A previous host may have exited while its LaunchServices helper
        // remained alive. Keep exactly one microphone listener.
        let _ = Command::new("/usr/bin/pkill")
            .args(["-x", "JarvisWakeListener"])
            .status()
            .await;

        let mut woke = false;
        while state.wake_enabled.load(Ordering::SeqCst) {
            state.wake_ready.store(false, Ordering::SeqCst);
            let event_file =
                std::env::temp_dir().join(format!("jarvis-wake-{}.jsonl", std::process::id()));
            let control_file =
                std::env::temp_dir().join(format!("jarvis-wake-{}.ctl", std::process::id()));
            let _ = fs::remove_file(&event_file);
            let _ = fs::remove_file(&control_file);
            if let Err(error) = fs::write(&event_file, "") {
                *state.wake_authorization.write().await = format!("无法创建唤醒事件通道：{error}");
                break;
            }
            if conversation {
                let _ = fs::write(&control_file, "");
            }
            *state.wake_control.write().await = conversation.then(|| control_file.clone());
            if !state.wake_enabled.load(Ordering::SeqCst) {
                let _ = fs::remove_file(&event_file);
                break;
            }

            // A helper left over from a previous app instance would keep the
            // microphone busy and both listeners would go deaf.
            let _ = Command::new("/usr/bin/pkill")
                .args(["-x", "JarvisWakeListener"])
                .status()
                .await;
            for _ in 0..20 {
                let alive = Command::new("/usr/bin/pgrep")
                    .args(["-x", "JarvisWakeListener"])
                    .output()
                    .await
                    .map(|out| !out.stdout.is_empty())
                    .unwrap_or(false);
                if !alive {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }

            // LaunchServices is required so macOS attributes microphone and
            // speech-recognition permissions to the helper app bundle.
            let mut command = Command::new("/usr/bin/open");
            command
                .args(["-n", "-W"])
                .arg(&helper)
                .args(["--args", "--event-file"])
                .arg(&event_file);
            if let Some(host_app) = host_app_bundle_path(&app) {
                command.arg("--host-app").arg(host_app);
            }
            // The wake phrases are "嗨 <名字>" per character, so the helper has
            // to see the same store the settings page writes.
            if let Ok(store) = avatars::store_path() {
                command.arg("--names-file").arg(store);
            }
            if capture_command {
                command.arg("--capture-command");
            }
            if conversation {
                command
                    .arg("--conversation")
                    .arg("--control-file")
                    .arg(&control_file);
            }
            let mut child = match command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
            {
                Ok(child) => child,
                Err(error) => {
                    *state.wake_authorization.write().await =
                        format!("无法启动唤醒监听器：{error}");
                    break;
                }
            };
            state
                .wake_pid
                .store(child.id().unwrap_or(0), Ordering::SeqCst);
            let mut processed = 0usize;
            let mut command_text: Option<String> = None;
            let mut conversation_ended = false;

            loop {
                let content = fs::read_to_string(&event_file).unwrap_or_default();
                let lines: Vec<&str> = content.lines().collect();
                for line in lines.iter().skip(processed) {
                    let Ok(message) = serde_json::from_str::<Value>(line) else {
                        continue;
                    };
                    match message.get("type").and_then(Value::as_str) {
                        Some("authorization") => {
                            let authorization = message
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown");
                            *state.wake_authorization.write().await = authorization.to_owned();
                            // `notDetermined` means the helper has just asked
                            // macOS for access. Keep it alive so the native
                            // permission sheet can complete its callback.
                            if matches!(authorization, "denied" | "restricted") {
                                state.wake_enabled.store(false, Ordering::SeqCst);
                            }
                        }
                        Some("ready") => {
                            state.wake_ready.store(true, Ordering::SeqCst);
                        }
                        Some("wake") => {
                            raise_jarvis_window(&app);
                            if capture_command {
                                // The helper stays on the microphone so the
                                // sentence after the wake phrase becomes the
                                // spoken command.
                                let mut wake = json!({"ok": true});
                                if let Some(avatar) = message.get("avatar").and_then(Value::as_str)
                                {
                                    wake["avatar"] = json!(avatar);
                                }
                                if let Some(name) = message.get("name").and_then(Value::as_str) {
                                    wake["name"] = json!(name);
                                }
                                // A named wake ("嗨张元英") is answered by that
                                // character in her own voice once the line is
                                // up, so the local greeting stays out of the way.
                                let named = wake.get("avatar").and_then(Value::as_str).is_some();
                                let _ = app.emit("jarvis-wake", wake);
                                if conversation && !named {
                                    let greeting = app.clone();
                                    tauri::async_runtime::spawn(async move {
                                        greet_on_wake(&greeting).await;
                                    });
                                }
                            } else {
                                woke = true;
                                state.wake_enabled.store(false, Ordering::SeqCst);
                                state.wake_ready.store(false, Ordering::SeqCst);
                            }
                        }
                        Some("command") => {
                            let text = message
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .trim()
                                .to_owned();
                            if !text.is_empty() {
                                schedule_backchannel(&app, &text);
                                if conversation {
                                    // Continuous conversation: hand the spoken
                                    // sentence straight to the renderer and keep
                                    // the same listener alive for the next turn.
                                    let _ = app.emit("jarvis-command", json!({ "text": text }));
                                } else {
                                    command_text = Some(text);
                                }
                            }
                        }
                        Some("conversation") => {
                            let _ = app.emit("jarvis-conversation", message.clone());
                        }
                        Some("barge") => {
                            // The user talked over Jarvis: drop the answer
                            // immediately and let the listener own the turn.
                            speak_stop_players().await;
                            let _ = app.emit("jarvis-barge", json!({}));
                        }
                        Some("conversation-end") => {
                            conversation_ended = true;
                        }
                        Some("error") => {
                            *state.wake_authorization.write().await = message
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("wake listener error")
                                .to_owned();
                        }
                        _ => {}
                    }
                    let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
                    if woke || command_text.is_some() || conversation_ended {
                        break;
                    }
                }
                processed = lines.len();
                if woke
                    || command_text.is_some()
                    || conversation_ended
                    || !state.wake_enabled.load(Ordering::SeqCst)
                {
                    break;
                }
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }

            if let Some(text) = command_text.take() {
                let _ = app.emit("jarvis-command", json!({ "text": text }));
            }
            *state.wake_control.write().await = None;
            if woke || !conversation || !state.wake_enabled.load(Ordering::SeqCst) {
                let _ = Command::new("/usr/bin/pkill")
                    .args(["-x", "JarvisWakeListener"])
                    .status()
                    .await;
            }
            let _ = child.wait().await;
            let _ = fs::remove_file(&event_file);
            let _ = fs::remove_file(&control_file);
            state.wake_pid.store(0, Ordering::SeqCst);
            if woke || !state.wake_enabled.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }

        state.wake_ready.store(false, Ordering::SeqCst);
        state.wake_supervisor_running.store(false, Ordering::SeqCst);
        if woke {
            // The WebView owns the RTCPeerConnection, so wake only raises the
            // Jarvis surface and asks the renderer to begin the official Codex
            // app-server V3 Voice handshake. No keypress or UI automation.
            let mut wake = json!({"ok": true});
            if let Some((avatar, name)) = take_last_wake() {
                wake["avatar"] = json!(avatar);
                wake["name"] = json!(name);
            }
            let _ = app.emit("jarvis-wake", wake);
        }
        let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
    });
}

#[tauri::command]
async fn arm_wake_listener(app: AppHandle) -> Result<WakeStatus, String> {
    start_wake_supervisor(app.clone());
    tokio::time::sleep(Duration::from_millis(80)).await;
    Ok(wake_status_value(&app.state::<AppState>()).await)
}

#[tauri::command]
async fn disarm_wake_listener(app: AppHandle) -> Result<WakeStatus, String> {
    let state = app.state::<AppState>();
    state.wake_enabled.store(false, Ordering::SeqCst);
    state.wake_ready.store(false, Ordering::SeqCst);
    let pid = state.wake_pid.swap(0, Ordering::SeqCst);
    if pid > 0 {
        let _ = Command::new("/bin/kill")
            .arg(pid.to_string())
            .status()
            .await;
    }
    // The supervisor starts asynchronously and can cross this command in
    // flight. Keep terminating until it has observed wake_enabled=false.
    for _ in 0..15 {
        let _ = Command::new("/usr/bin/pkill")
            .args(["-x", "JarvisWakeListener"])
            .status()
            .await;
        if !state.wake_supervisor_running.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // AVAudioEngine releases the input device asynchronously after SIGTERM.
    // Starting WebRTC in the same tick can otherwise fail with NotAllowedError.
    tokio::time::sleep(Duration::from_millis(350)).await;
    Ok(wake_status_value(&state).await)
}

#[tauri::command]
async fn wake_listener_status(app: AppHandle) -> WakeStatus {
    wake_status_value(&app.state::<AppState>()).await
}

/// A cold wake already consumed the wake phrase: the wake-only listener heard
/// "嗨 Jarvis" and opened this window, so the freshly started conversation
/// listener has to open the conversation instead of waiting for the phrase a
/// second time. Without this, Jarvis says "你再说一次" and then ignores it.
#[tauri::command]
async fn resume_wake_conversation(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    for _ in 0..40 {
        if state.wake_ready.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    write_wake_control(&app, "awake").await;
    Ok(())
}

/// The wake-only listener knows which character was called but is gone before
/// the app finishes launching, so it leaves the name on disk. Reading it also
/// clears it: a stale name must never re-dial a character hours later.
fn take_last_wake() -> Option<(String, String)> {
    let path = avatars::jarvis_dir().ok()?.join("last-wake.json");
    let body = fs::read_to_string(&path).ok()?;
    let _ = fs::remove_file(&path);
    let value: Value = serde_json::from_str(&body).ok()?;
    let avatar = value.get("avatar").and_then(Value::as_str)?.to_owned();
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&avatar)
        .to_owned();
    let at = value.get("at").and_then(Value::as_u64).unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0);
    // A cold launch takes a few seconds; anything much older is a leftover.
    if at == 0 || now.saturating_sub(at) > 120_000 {
        return None;
    }
    Some((avatar, name))
}

#[tauri::command]
async fn consume_cold_wake(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    if !state.cold_wake_pending.swap(false, Ordering::SeqCst) {
        return Ok(false);
    }
    if voice_text_only() {
        // The helper that launched this window is the only thing listening:
        // tearing it down here (as the Voice handshake below needs to) would
        // leave Jarvis deaf until the next launch.
        raise_jarvis_window(&app);
        start_wake_supervisor(app.clone());
        let mut wake = json!({"ok": true, "cold": true});
        if let Some((avatar, name)) = take_last_wake() {
            wake["avatar"] = json!(avatar);
            wake["name"] = json!(name);
        }
        let _ = app.emit("jarvis-wake", wake);
        return Ok(true);
    }
    // Replay a cold launch through the same external event path as a normal
    // warm wake, but only after the newly spawned listener fully releases mic.
    state.wake_enabled.store(false, Ordering::SeqCst);
    state.wake_ready.store(false, Ordering::SeqCst);
    let pid = state.wake_pid.swap(0, Ordering::SeqCst);
    if pid > 0 {
        let _ = Command::new("/bin/kill")
            .arg(pid.to_string())
            .status()
            .await;
    }
    for _ in 0..15 {
        let _ = Command::new("/usr/bin/pkill")
            .args(["-x", "JarvisWakeListener"])
            .status()
            .await;
        if !state.wake_supervisor_running.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(350)).await;
    raise_jarvis_window(&app);
    let mut wake = json!({"ok": true, "cold": true});
    if let Some((avatar, name)) = take_last_wake() {
        wake["avatar"] = json!(avatar);
        wake["name"] = json!(name);
    }
    let _ = app.emit("jarvis-wake", wake);
    Ok(true)
}

#[tauri::command]
fn default_workspace() -> Result<String, String> {
    if let Ok(configured) = std::env::var("JARVIS_WORKSPACE") {
        let path = PathBuf::from(configured);
        if path.is_dir() {
            return path
                .canonicalize()
                .map(|value| value.to_string_lossy().into_owned())
                .map_err(|error| format!("无法读取 JARVIS_WORKSPACE：{error}"));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let path = PathBuf::from(home);
        if path.is_dir() {
            return Ok(path.to_string_lossy().into_owned());
        }
    }
    std::env::current_dir()
        .map(|value| value.to_string_lossy().into_owned())
        .map_err(|error| format!("无法确定默认工作目录：{error}"))
}

/// DeepSeek and other non-realtime providers cannot open Codex Voice, so the
/// user can opt into a text-only wake: `{"voice":"off"}` in
/// `~/.jarvis-codex/config.json` skips the WebRTC handshake entirely.
/// `~/.jarvis-codex` holds the state the shell scripts share with the app:
/// config, logs and the markers that tell the keeper why Jarvis is gone.
fn jarvis_state_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let directory = PathBuf::from(home).join(".jarvis-codex");
    let _ = fs::create_dir_all(&directory);
    Some(directory)
}

/// Written whenever Jarvis is closed on purpose (voice command, menu quit or a
/// termination signal). The keeper relaunches a crashed Jarvis, never a closed
/// one, so this marker is what makes "关闭" stick.
fn closed_by_user_marker() -> Option<PathBuf> {
    Some(jarvis_state_dir()?.join("closed-by-user"))
}

fn mark_closed_by_user(reason: &str) {
    let Some(path) = closed_by_user_marker() else {
        return;
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    let _ = fs::write(path, format!("{stamp} {reason}\n"));
}

/// A real launch clears the marker: from now on a crash must be restarted.
fn clear_closed_by_user() {
    if let Some(path) = closed_by_user_marker() {
        let _ = fs::remove_file(path);
    }
}

/// Appends a line to a state file so a failure that only happens on a user's
/// machine can be read afterwards. Never panics: diagnostics must not be the
/// reason Jarvis dies.
pub(crate) fn append_state_log(file: &str, message: &str) {
    let Some(directory) = jarvis_state_dir() else {
        return;
    };
    let path = directory.join(file);
    let stamp = local_stamp();
    use std::io::Write;
    if let Ok(mut handle) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(handle, "[{stamp}] {message}");
    }
}

/// `[2026-09-13T11:20:05]` without pulling in a date crate.
#[cfg(target_os = "macos")]
fn local_stamp() -> String {
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut parts: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&now, &mut parts).is_null() {
            return format!("epoch {now}");
        }
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
            parts.tm_year + 1900,
            parts.tm_mon + 1,
            parts.tm_mday,
            parts.tm_hour,
            parts.tm_min,
            parts.tm_sec
        )
    }
}

#[cfg(not(target_os = "macos"))]
fn local_stamp() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    format!("epoch {seconds}")
}

/// Rust cannot unwind through AppKit's `applicationWillTerminate`, so an
/// unexpected panic on the main thread aborts the process (the user sees
/// "Jarvis Codex quit unexpectedly"). Catch it, write it down, carry on.
fn install_panic_log() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|value| format!("{}:{}", value.file(), value.line()))
            .unwrap_or_else(|| "unknown location".to_owned());
        append_state_log("panic.log", &format!("panic at {location}: {info}"));
        previous(info);
    }));
}

/// SIGTERM/SIGINT cannot run Rust handlers safely, so the marker is written
/// with the raw POSIX calls and the path is prepared before the handler is
/// installed.
#[cfg(unix)]
static CLOSED_MARKER_PATH: std::sync::OnceLock<std::ffi::CString> = std::sync::OnceLock::new();

#[cfg(unix)]
extern "C" fn on_termination_signal(_signal: libc::c_int) {
    if let Some(c_path) = CLOSED_MARKER_PATH.get() {
        unsafe {
            let fd = libc::open(
                c_path.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
                0o644,
            );
            if fd >= 0 {
                let line = b"closed\n";
                libc::write(fd, line.as_ptr().cast(), line.len());
                libc::close(fd);
            }
        }
    }
    unsafe { libc::_exit(0) };
}

#[cfg(unix)]
fn install_termination_marker() {
    use std::ffi::CString;
    let Some(path) = closed_by_user_marker() else {
        return;
    };
    let Ok(c_path) = CString::new(path.to_string_lossy().as_bytes().to_vec()) else {
        return;
    };
    if CLOSED_MARKER_PATH.set(c_path).is_err() {
        return;
    }
    unsafe {
        libc::signal(
            libc::SIGTERM,
            on_termination_signal as *const () as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGINT,
            on_termination_signal as *const () as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGHUP,
            on_termination_signal as *const () as libc::sighandler_t,
        );
    }
}

/// Jarvis must not survive the app that owns it: a leftover wake listener
/// would keep the microphone busy and would reopen Jarvis on the next
/// "嗨 Jarvis", which looks exactly like the app refusing to stay closed.
async fn stop_wake_helpers() {
    let _ = Command::new("/usr/bin/pkill")
        .args(["-x", "JarvisWakeListener"])
        .status()
        .await;
}

/// Same cleanup for the exit handler, which runs on the main thread while the
/// runtime is already shutting down.
fn stop_wake_helpers_blocking() {
    let _ = std::process::Command::new("/usr/bin/pkill")
        .args(["-x", "JarvisWakeListener"])
        .status();
}

/// Jarvis must stay wake-able after it is closed: instead of leaving nothing
/// on the microphone, a lone listener is started that only knows the wake
/// phrase and opens the app again ("嗨 Jarvis" brings Jarvis back). It carries
/// no conversation, no event file and no control file, so a closed Jarvis is
/// never opened by anything but the user's voice.
fn spawn_cold_wake_listener(app: &AppHandle) {
    let Ok(helper) = wake_helper_path(app) else {
        return;
    };
    // Explicitly the std process API: this also runs from the exit handler on
    // the main thread, where tokio's `Command::spawn` panics with "there is no
    // reactor running" — and a panic there turns "quit" into a crash report.
    let mut command = std::process::Command::new("/usr/bin/open");
    command.arg("-n").arg(&helper).arg("--args");
    if let Some(host_app) = host_app_bundle_path(app) {
        command.arg("--host-app").arg(host_app);
    }
    if let Ok(store) = avatars::store_path() {
        command.arg("--names-file").arg(store);
    }
    let _ = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

/// "关闭 Jarvis" has to mean it: the spoken farewell plays out, then the
/// closed marker keeps the keeper from bringing Jarvis back.
#[tauri::command]
async fn close_jarvis(
    app: AppHandle,
    state: State<'_, AppState>,
    farewell: Option<String>,
) -> Result<(), String> {
    if let Some(text) = farewell.filter(|value| !value.trim().is_empty()) {
        let pack = active_voice_pack();
        let _ = speak_with(&app, pack, &text).await;
    }
    // Sentences of one answer are serialised on SPEAK_PLAY, so wait for the
    // queue instead of cutting the farewell off.
    for _ in 0..40 {
        if SPEAK_PENDING.load(Ordering::SeqCst) == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    mark_closed_by_user("voice");
    write_wake_control(&app, "end").await;
    stop_wake_helpers().await;
    // Keep one listener on the microphone so the wake word still works while
    // Jarvis is closed; the keeper only ever starts a crashed Jarvis.
    spawn_cold_wake_listener(&app);
    let _ = terminate_runtime(&state).await;
    app.exit(0);
    Ok(())
}

pub(crate) fn jarvis_config() -> Value {
    let Ok(home) = std::env::var("HOME") else {
        return Value::Null;
    };
    let Ok(raw) = fs::read_to_string(PathBuf::from(home).join(".jarvis-codex/config.json")) else {
        return Value::Null;
    };
    serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null)
}

#[tauri::command]
fn voice_text_only() -> bool {
    jarvis_config()
        .get("voice")
        .and_then(Value::as_str)
        .is_some_and(|voice| voice.eq_ignore_ascii_case("off"))
}

/// Continuous conversation: after the first "嗨 Jarvis" the listener keeps
/// taking commands until the user ends the session or it idles out.
fn conversation_enabled() -> bool {
    jarvis_config()
        .get("conversation")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

async fn write_wake_control(app: &AppHandle, line: &str) {
    let state = app.state::<AppState>();
    let path = state.wake_control.read().await.clone();
    let Some(path) = path else {
        return;
    };
    use std::io::Write;
    if let Ok(mut file) = fs::OpenOptions::new().append(true).open(path) {
        let _ = file.write_all(format!("{line}\n").as_bytes());
    }
}

/// Spoken replies turn a text-mode wake into a spoken assistant. Defaults to
/// matching the wake mode: on whenever Voice is unavailable.
#[tauri::command]
fn speak_replies() -> bool {
    jarvis_config()
        .get("speakReplies")
        .and_then(Value::as_bool)
        .unwrap_or_else(voice_text_only)
}

fn system_voice() -> String {
    let preferred = jarvis_config()
        .get("voiceName")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(name) = preferred {
        return name;
    }
    let Ok(listing) = std::process::Command::new("/usr/bin/say")
        .arg("-v")
        .arg("?")
        .output()
    else {
        return "Tingting".to_owned();
    };
    let voices = String::from_utf8_lossy(&listing.stdout);
    for candidate in ["Tingting", "Meijia", "Sinji", "Li-mu", "Yu-shu"] {
        if voices.contains(candidate) {
            return candidate.to_owned();
        }
    }
    String::new()
}

fn speak_log(line: &str) {
    use std::io::Write;
    let Ok(home) = std::env::var("HOME") else {
        return;
    };
    let path = PathBuf::from(home).join(".jarvis-codex/speak.log");
    let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    let _ = writeln!(file, "{stamp} {line}");
}

/// Sentences are handed to one resident CoreAudio stream instead of a fresh
/// `afplay` process per sentence. Spawning a player costs half a second of
/// silence before the first sample leaves the speakers and another stretch
/// after the last one, so a five sentence answer used to pause audibly at every
/// seam — that is the choppiness the reader complained about. Talking through
/// one open stream makes consecutive sentences run into each other the way a
/// person speaks them.
enum AudioRequest {
    Play {
        file: PathBuf,
        done: oneshot::Sender<()>,
    },
    Stop,
    /// Trails the answer with silence. How long the sound card buffers is not
    /// ours to decide, and a reconfiguration at the end of an answer (the
    /// microphone coming back) makes the card re-emit whatever is still in
    /// that buffer — which came out as the last syllable of the answer being
    /// repeated three or four times. Ending on silence makes any re-emission
    /// inaudible.
    Pad {
        millis: u64,
    },
}

static AUDIO_QUEUE: std::sync::OnceLock<std::sync::mpsc::Sender<AudioRequest>> =
    std::sync::OnceLock::new();

fn audio_queue() -> &'static std::sync::mpsc::Sender<AudioRequest> {
    AUDIO_QUEUE.get_or_init(|| {
        let (sender, receiver) = std::sync::mpsc::channel();
        let _ = std::thread::Builder::new()
            .name("jarvis-audio".to_owned())
            .spawn(move || audio_loop(receiver));
        sender
    })
}

/// Owns the output stream for as long as words are queued. The device is
/// released a few seconds after the answer ends: an output stream that stayed
/// open forever would keep CoreAudio from handing the microphone its echo
/// cancelling configuration.
fn audio_loop(receiver: std::sync::mpsc::Receiver<AudioRequest>) {
    let mut device: Option<rodio::MixerDeviceSink> = None;
    let mut player: Option<rodio::Player> = None;
    let mut playing: Option<oneshot::Sender<()>> = None;
    let mut idle_since = std::time::Instant::now();
    loop {
        match receiver.recv_timeout(std::time::Duration::from_millis(40)) {
            Ok(AudioRequest::Play { file, done }) => {
                if device.is_none() {
                    match rodio::DeviceSinkBuilder::open_default_sink() {
                        Ok(handle) => {
                            player = Some(rodio::Player::connect_new(handle.mixer()));
                            device = Some(handle);
                        }
                        Err(error) => speak_log(&format!("audio device unavailable: {error}")),
                    }
                }
                let started = match (player.as_ref(), fs::File::open(&file)) {
                    (Some(player), Ok(handle)) => {
                        match rodio::Decoder::new_wav(std::io::BufReader::new(handle)) {
                            Ok(source) => {
                                player.append(source);
                                true
                            }
                            Err(error) => {
                                speak_log(&format!("decode failed: {error}"));
                                false
                            }
                        }
                    }
                    (Some(_), Err(error)) => {
                        speak_log(&format!("open failed: {error}"));
                        false
                    }
                    (None, _) => false,
                };
                if started {
                    playing = Some(done);
                    idle_since = std::time::Instant::now();
                } else {
                    let _ = done.send(());
                }
            }
            Ok(AudioRequest::Pad { millis }) => {
                if let (Some(handle), Some(player)) = (device.as_ref(), player.as_ref()) {
                    let channels = handle.config().channel_count();
                    let sample_rate = handle.config().sample_rate();
                    let samples = (sample_rate.get() as u64 * millis / 1_000) as usize;
                    player.append(rodio::source::Zero::new_samples(
                        channels,
                        sample_rate,
                        samples,
                    ));
                    idle_since = std::time::Instant::now();
                }
            }
            Ok(AudioRequest::Stop) => {
                if let Some(player) = player.as_ref() {
                    player.stop();
                }
                if let Some(done) = playing.take() {
                    let _ = done.send(());
                }
                idle_since = std::time::Instant::now();
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if let Some(active) = player.as_ref() {
            if active.empty() {
                if let Some(done) = playing.take() {
                    let _ = done.send(());
                }
                if idle_since.elapsed() > std::time::Duration::from_secs(6) {
                    player = None;
                    device = None;
                    idle_since = std::time::Instant::now();
                }
            }
        }
    }
}

static SPEAK_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SPEAK_PLAY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SPEAK_VOICE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
static SPEAK_INDEX: AtomicU64 = AtomicU64::new(1);
static SPEAK_ACTIVE: AtomicBool = AtomicBool::new(false);
/// Sentences of one answer play in order: every new utterance takes this
/// counter, and a stop (barge-in, interrupt, new command) advances it so all
/// queued speech of the cancelled answer is dropped instead of talking on.
static SPEAK_GENERATION: AtomicU64 = AtomicU64::new(0);
/// Utterances currently rendered or playing, used to keep the microphone
/// muted until the very last sentence of an answer has left the speakers.
static SPEAK_PENDING: AtomicU64 = AtomicU64::new(0);
/// Sentences that are still being rendered or played. Rendering counts: a
/// sentence that is still going through `say` has not reached the audio queue
/// yet, and the microphone must not come back in the middle of it.
static SPEAK_INFLIGHT: AtomicU64 = AtomicU64::new(0);
/// A turn is answering: the microphone goes back when that turn ends, not when
/// a single sentence does. Handing the microphone back between two sentences of
/// one answer is what let Jarvis hear its own voice mid-reply.
static SPEAK_TURN_OPEN: AtomicBool = AtomicBool::new(false);
/// One drain watcher at a time.
static SPEAK_RESUMING: AtomicBool = AtomicBool::new(false);
static TURN_SEQ: AtomicU64 = AtomicU64::new(0);
static TURN_SPOKEN: AtomicBool = AtomicBool::new(false);

struct VoicePack {
    id: &'static str,
    label: &'static str,
    engine: &'static str,
    voice: &'static str,
    robot: bool,
}

/// Voice packs either use the local macOS speech synthesiser (offline) or the
/// free Microsoft Edge neural voices, which is what makes male and "cute"
/// Chinese voices possible at all: macOS only ships female Chinese voices.
const VOICE_PACKS: &[VoicePack] = &[
    VoicePack {
        id: "jarvis",
        label: "JARVIS 机器人男声（云扬 + 金属音）",
        engine: "edge",
        voice: "zh-CN-YunyangNeural",
        robot: true,
    },
    VoicePack {
        id: "male",
        label: "男声（云希）",
        engine: "edge",
        voice: "zh-CN-YunxiNeural",
        robot: false,
    },
    VoicePack {
        id: "girl",
        label: "可爱女声（晓伊）",
        engine: "edge",
        voice: "zh-CN-XiaoyiNeural",
        robot: false,
    },
    VoicePack {
        id: "female",
        label: "温柔女声（晓晓）",
        engine: "edge",
        voice: "zh-CN-XiaoxiaoNeural",
        robot: false,
    },
    VoicePack {
        id: "local",
        label: "本机婷婷（完全离线）",
        engine: "say",
        voice: "",
        robot: false,
    },
];

pub(crate) fn voice_pack_by_id(id: &str) -> &'static VoicePack {
    let wanted = id.to_ascii_lowercase();
    VOICE_PACKS
        .iter()
        .find(|pack| pack.id == wanted)
        .unwrap_or(&VOICE_PACKS[0])
}

fn active_voice_pack() -> &'static VoicePack {
    // The voice belongs to the running character, so switching character also
    // switches the voice without a separate settings trip.
    let id = avatars::active_voice_pack_id();
    voice_pack_by_id(&id)
}

/// Records a voice pack for the running character and for the global
/// preference, so the settings dialog and spoken switches agree.
pub(crate) fn write_voice_pack(id: &str) -> Result<(), String> {
    let id = voice_pack_by_id(id).id;
    let mut store = avatars::load_store();
    let active_id = store.active_id.clone();
    if let Some(index) = store
        .avatars
        .iter()
        .position(|avatar| avatar.id == active_id)
    {
        store.avatars[index].voice_pack = id.to_owned();
        avatars::save_store(&store)?;
    }
    let directory = avatars::jarvis_dir()?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join("config.json");
    let mut config = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    config["voicePack"] = json!(id);
    let body = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(&path, format!("{body}\n")).map_err(|error| error.to_string())
}

fn edge_tts_bin() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let candidate = PathBuf::from(home).join(".jarvis-codex/venv/bin/edge-tts");
    candidate.is_file().then_some(candidate)
}

/// Payload of a 16 bit PCM WAV as (offset, bytes, sample rate).
fn wav_pcm16_data(bytes: &[u8]) -> Result<(usize, usize, u32), String> {
    let mut sample_rate = 22_050u32;
    let mut bits = 16u16;
    let mut offset = 12usize;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        let payload = offset + 8;
        if id == b"fmt " && size >= 16 && payload + 16 <= bytes.len() {
            sample_rate = u32::from_le_bytes([
                bytes[payload + 4],
                bytes[payload + 5],
                bytes[payload + 6],
                bytes[payload + 7],
            ]);
            bits = u16::from_le_bytes([bytes[payload + 14], bytes[payload + 15]]);
        } else if id == b"data" {
            if bits != 16 {
                return Err(format!("仅支持 16bit PCM，当前 {bits}bit"));
            }
            return Ok((
                payload,
                size.min(bytes.len().saturating_sub(payload)),
                sample_rate,
            ));
        }
        offset = payload + size + (size & 1);
    }
    Err("音频文件缺少 data 段".to_owned())
}

/// How loud a reply should end up, as a fraction of full scale. Speech sits
/// comfortably around -14 dBFS RMS, which is where the local voice always was;
/// the online packs used to arrive 5 to 10 dB below that and were heard as
/// "Jarvis got quiet". `volume` in config.json scales it (1.0 is the default,
/// 1.2 is 1.6 dB louder), so the level can be tuned without a new build.
fn loudness_target() -> f64 {
    let scale = jarvis_config()
        .get("volume")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(1.0)
        .clamp(0.2, 3.0);
    (0.20 * scale).clamp(0.05, 0.6)
}

/// Speech arrives from the engines with very different dynamics: the online
/// voices carry peaks up to 20 dB above their own average, which is what made
/// "just turn it up" clip instead of getting louder. A gentle compressor
/// (6 ms attack, 140 ms release) shrinks that range first, so the level can
/// afterwards be lifted for the whole sentence instead of the limiter
/// flattening every stressed syllable.
fn compress_wav_dynamics(
    path: &std::path::Path,
    threshold_db: f64,
    ratio: f64,
) -> Result<(), String> {
    let mut bytes = fs::read(path).map_err(|error| error.to_string())?;
    let (start, size, sample_rate) = wav_pcm16_data(&bytes)?;
    let frames = size / 2;
    if frames == 0 {
        return Ok(());
    }
    let rate = f64::from(sample_rate.max(1));
    let threshold = 32_768.0 * 10f64.powf(threshold_db / 20.0);
    let slope = 1.0 - 1.0 / ratio.max(1.0);
    let attack = (-1.0 / (0.006 * rate)).exp();
    let release = (-1.0 / (0.140 * rate)).exp();
    let mut envelope = 0.0f64;
    let mut gain = 1.0f64;
    for frame in 0..frames {
        let at = start + frame * 2;
        let sample = f64::from(i16::from_le_bytes([bytes[at], bytes[at + 1]]));
        let level = sample.abs();
        // The envelope climbs fast and falls slowly, the shape a compressor
        // needs to react to a syllable without riding every cycle.
        envelope = if level > envelope {
            level + (envelope - level) * attack
        } else {
            level + (envelope - level) * release
        };
        let wanted = if envelope > threshold {
            (threshold / envelope).powf(slope)
        } else {
            1.0
        };
        // Gain drops the moment a peak needs it and returns smoothly, so no
        // zipper noise is written into the file.
        gain = if wanted < gain {
            wanted
        } else {
            wanted + (gain - wanted) * 0.98
        };
        let scaled = (sample * gain).round().clamp(-32_768.0, 32_767.0) as i16;
        bytes[at..at + 2].copy_from_slice(&scaled.to_le_bytes());
    }
    fs::write(path, bytes).map_err(|error| error.to_string())
}

/// One loudness for every voice. The engines do not agree: measured on this
/// Mac the online Edge voices arrive 4 to 9 dB below the local one, and the
/// JARVIS pack lost another ~7 dB to its ring modulation, so changing the voice
/// pack was heard as "Jarvis got quieter". Scaling each rendered utterance to
/// the same RMS (never past the peak cap) keeps the volume the same whichever
/// pack is chosen. Returns the gain that was applied.
fn normalize_wav_level(
    path: &std::path::Path,
    target_rms: f64,
    peak_cap: f64,
) -> Result<f64, String> {
    let mut bytes = fs::read(path).map_err(|error| error.to_string())?;
    let (start, size, sample_rate) = wav_pcm16_data(&bytes)?;
    let frames = size / 2;
    if frames == 0 {
        return Ok(1.0);
    }
    let mut squares = 0.0f64;
    let mut peak = 0.0f64;
    for frame in 0..frames {
        let at = start + frame * 2;
        let sample = f64::from(i16::from_le_bytes([bytes[at], bytes[at + 1]]));
        squares += sample * sample;
        peak = peak.max(sample.abs());
    }
    let rms = (squares / frames as f64).sqrt();
    if rms < 1.0 || peak < 1.0 {
        return Ok(1.0);
    }
    let full = 32_768.0;
    let gain = (target_rms * full) / rms;
    let threshold = peak_cap * full;
    let limiter = peak * gain > threshold;
    if !gain.is_finite() || (!limiter && (gain - 1.0).abs() < 0.03) {
        return Ok(1.0);
    }
    // Instant attack, 150 ms release. Below the threshold the gain stays
    // exactly 1.0, so a voice whose peaks already fit is left untouched, while
    // the online voices (much higher crest factor than the local one) reach the
    // same loudness without clipping their peaks into distortion.
    let release = (-1.0 / (0.150 * f64::from(sample_rate.max(1)))).exp();
    let mut envelope = 0.0f64;
    for frame in 0..frames {
        let at = start + frame * 2;
        let scaled = f64::from(i16::from_le_bytes([bytes[at], bytes[at + 1]])) * gain;
        let level = scaled.abs();
        envelope = if level > envelope {
            level
        } else {
            envelope * release
        };
        let duck = if envelope > threshold {
            threshold / envelope
        } else {
            1.0
        };
        let clamped = (scaled * duck).round().clamp(-32_768.0, 32_767.0) as i16;
        bytes[at..at + 2].copy_from_slice(&clamped.to_le_bytes());
    }
    fs::write(path, bytes).map_err(|error| error.to_string())?;
    Ok(gain)
}

/// Ring modulation is what gives the JARVIS pack its metallic robot timbre.
fn ring_modulate_wav(path: &std::path::Path, freq: f64, wet: f64) -> Result<(), String> {
    let mut bytes = fs::read(path).map_err(|error| error.to_string())?;
    let (start, size, sample_rate) = wav_pcm16_data(&bytes)?;
    let step = std::f64::consts::TAU * freq / f64::from(sample_rate.max(1));
    // The carrier to sideband ratio is what the robot sounds like. The carrier
    // is scaled so its loudest moment is exactly unity gain: the effect can no
    // longer push the voice over full scale, which is what the pack used to pay
    // for with a limiter flattening the voice *before* the effect, and the
    // loudness that the effect costs is handed back by the levelling step.
    let depth = (wet / (1.0 - wet).max(0.05)).clamp(0.0, 3.0);
    let scale = 1.0 / (1.0 + depth);
    let frames = size / 2;
    for frame in 0..frames {
        let at = start + frame * 2;
        let sample = i16::from_le_bytes([bytes[at], bytes[at + 1]]);
        let carrier = (step * frame as f64).cos();
        let gain = (scale * (1.0 + depth * carrier)) as f32;
        let scaled = (f32::from(sample) * gain).round();
        let clamped = scaled.clamp(-32768.0, 32767.0) as i16;
        bytes[at..at + 2].copy_from_slice(&clamped.to_le_bytes());
    }
    fs::write(path, bytes).map_err(|error| error.to_string())
}

async fn speak_stop_players() {
    SPEAK_GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Some(queue) = AUDIO_QUEUE.get() {
        let _ = queue.send(AudioRequest::Stop);
    }
    // A build that was still reading through `afplay`, and the online packs
    // that render with `say`, can leave a player of their own behind.
    for name in ["afplay", "say"] {
        let _ = Command::new("/usr/bin/pkill")
            .args(["-x", name])
            .status()
            .await;
    }
    for _ in 0..20 {
        let mut alive = false;
        for name in ["afplay", "say"] {
            alive |= Command::new("/usr/bin/pgrep")
                .args(["-x", name])
                .output()
                .await
                .map(|out| !out.stdout.is_empty())
                .unwrap_or(false);
        }
        if !alive {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn render_local(text: &str, wav: &std::path::Path) -> Result<(), String> {
    let voice = SPEAK_VOICE.get_or_init(system_voice).clone();
    let mut render = Command::new("/usr/bin/say");
    render.arg("--data-format=LEI16@22050").arg("-o").arg(wav);
    if !voice.is_empty() {
        render.arg("-v").arg(&voice);
    }
    let status = render
        .arg(text)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|error| format!("无法调用系统语音：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("系统语音退出码 {status}"))
    }
}

/// Renders `text` to `wav` with the requested voice pack. Online packs fall
/// back to the offline system voice when the Edge service is unreachable, so a
/// lost network never silences Jarvis.
async fn render_voice(pack: &VoicePack, text: &str, wav: &std::path::Path) -> Result<(), String> {
    if pack.engine == "edge" {
        if let Some(bin) = edge_tts_bin() {
            let mp3 = wav.with_extension("mp3");
            let spoken = timeout(
                Duration::from_secs(45),
                Command::new(&bin)
                    .arg("--voice")
                    .arg(pack.voice)
                    .arg("--text")
                    .arg(text)
                    .arg("--write-media")
                    .arg(&mp3)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status(),
            )
            .await;
            let ok = matches!(spoken, Ok(Ok(status)) if status.success());
            if ok {
                let converted = Command::new("/usr/bin/afconvert")
                    .args(["-f", "WAVE", "-d", "LEI16@22050", "-c", "1"])
                    .arg(&mp3)
                    .arg(wav)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .await;
                let _ = fs::remove_file(&mp3);
                if matches!(converted, Ok(status) if status.success()) {
                    return Ok(());
                }
                speak_log("afconvert failed, falling back to local voice");
            } else {
                speak_log(&format!(
                    "edge-tts failed ({spoken:?}), falling back to local voice"
                ));
            }
        } else {
            speak_log("edge-tts missing, falling back to local voice");
        }
    }
    render_local(text, wav).await
}

/// Reads replies through the selected voice pack, so no audio leaves the Mac
/// unless an online pack is chosen.
///
/// The utterance is always rendered to a file first and then handed to the
/// resident stream: playing `say` straight to the audio device repeats the
/// final syllable on this build of macOS, while a rendered file plays cleanly
/// and can be queued behind the sentence before it without a seam.
async fn speak_once(app: &AppHandle, pack: &VoicePack, text: &str) -> Result<(), String> {
    let trimmed = text.trim().to_owned();
    if trimmed.is_empty() {
        return Ok(());
    }
    let file = std::env::temp_dir().join(format!(
        "jarvis-speak-{}-{}.wav",
        std::process::id(),
        SPEAK_INDEX.fetch_add(1, Ordering::SeqCst)
    ));
    // Which answer this sentence belongs to is decided *before* it is rendered.
    // Reading the counter after the render handed every sentence that was
    // already on its way a fresh one, so a cancelled answer kept reading its
    // remaining sentences over the reply that replaced it.
    let generation = SPEAK_GENERATION.load(Ordering::SeqCst);
    // Rendering already counts as "an answer is on its way": a fill sound must
    // never be queued behind a sentence that is about to play.
    TURN_SPOKEN.store(true, Ordering::SeqCst);
    {
        let _guard = SPEAK_LOCK.lock().await;
        if generation != SPEAK_GENERATION.load(Ordering::SeqCst) {
            speak_log(&format!(
                "dropped queued sentence: answer was cancelled ({trimmed})"
            ));
            let _ = fs::remove_file(&file);
            return Ok(());
        }
        speak_log(&format!(
            "enter pack={} chars={} text={trimmed}",
            pack.id,
            trimmed.chars().count()
        ));
        if let Err(error) = render_voice(pack, &trimmed, &file).await {
            speak_log(&format!("render failed: {error}"));
            let _ = fs::remove_file(&file);
            return Err(format!("无法朗读回复：{error}"));
        }
        if let Err(error) = compress_wav_dynamics(&file, -20.0, 3.0) {
            speak_log(&format!("level compression skipped: {error}"));
        }
        if pack.robot {
            if let Err(error) = ring_modulate_wav(&file, 52.0, 0.55) {
                speak_log(&format!("robot effect skipped: {error}"));
            }
            // The carrier adds peaks of its own, so the range is squeezed once
            // more after it.
            let _ = compress_wav_dynamics(&file, -18.0, 3.0);
        }
        // One loudness for every pack. Changing the voice used to change the
        // volume: the online voices arrive 4-9 dB below the local one, and the
        // JARVIS effect alone ate another 7 dB.
        let peak_cap = if pack.robot { 0.98 } else { 0.95 };
        match normalize_wav_level(&file, loudness_target(), peak_cap) {
            Ok(gain) => {
                let decibels = 20.0 * gain.log10();
                if decibels.abs() > 0.4 {
                    speak_log(&format!("level {decibels:+.1} dB"));
                }
            }
            Err(error) => speak_log(&format!("level normalisation skipped: {error}")),
        }
    }
    play_wav(app, pack, &trimmed, &file, generation, true).await
}

/// Renders and plays one utterance, and keeps the microphone away until the
/// answer it belongs to is over. Sentences of a streaming answer queue up in
/// the resident stream, so speech stays continuous without a seam.
async fn speak_with(app: &AppHandle, pack: &VoicePack, text: &str) -> Result<(), String> {
    // Rendering counts as in flight: the microphone must not come back while a
    // sentence is still on its way to the speakers.
    SPEAK_INFLIGHT.fetch_add(1, Ordering::SeqCst);
    let outcome = speak_once(app, pack, text).await;
    SPEAK_INFLIGHT.fetch_sub(1, Ordering::SeqCst);
    if !SPEAK_TURN_OPEN.load(Ordering::SeqCst) {
        resume_listening_when_idle(app);
    }
    outcome
}

/// Plays an already rendered utterance.
///
/// `hold_microphone` is what keeps Jarvis from recognising its own voice as the
/// next command. The wake greeting is the one sentence that plays with the
/// microphone open: the master usually starts talking the moment the wake word
/// is out, and swallowing that sentence into a muted microphone would make the
/// greeting the reason Jarvis did not hear the order.
async fn play_wav(
    app: &AppHandle,
    pack: &VoicePack,
    text: &str,
    file: &std::path::Path,
    generation: u64,
    hold_microphone: bool,
) -> Result<(), String> {
    SPEAK_PENDING.fetch_add(1, Ordering::SeqCst);
    TURN_SPOKEN.store(true, Ordering::SeqCst);
    if hold_microphone {
        write_wake_control(app, "mute").await;
    }
    let outcome = {
        let _slot = SPEAK_PLAY.lock().await;
        if generation != SPEAK_GENERATION.load(Ordering::SeqCst) {
            speak_log(&format!(
                "dropped queued sentence: answer was cancelled ({text})"
            ));
            Ok(())
        } else {
            // The listener needs the exact sentence to tell its own voice apart
            // from the user talking over it, which is what makes interruptions
            // possible.
            write_wake_control(
                app,
                &format!(
                    "speaking {}",
                    text.replace('\n', " ")
                        .chars()
                        .take(400)
                        .collect::<String>()
                ),
            )
            .await;
            let (done, finished) = oneshot::channel();
            let queued = audio_queue()
                .send(AudioRequest::Play {
                    file: file.to_path_buf(),
                    done,
                })
                .is_ok();
            if !queued {
                speak_log("play failed: audio queue is gone");
                return Err("无法朗读回复：音频引擎不可用".to_owned());
            }
            SPEAK_ACTIVE.store(true, Ordering::SeqCst);
            speak_log(&format!("play pack={} text={text}", pack.id));
            let started = std::time::Instant::now();
            let _ = finished.await;
            // The elapsed time is the seam check: a sentence that takes much
            // longer than its own audio means the stream stalled.
            speak_log(&format!(
                "played {:.2}s chars={}",
                started.elapsed().as_secs_f64(),
                text.chars().count()
            ));
            SPEAK_ACTIVE.store(false, Ordering::SeqCst);
            Ok(())
        }
    };
    SPEAK_PENDING.fetch_sub(1, Ordering::SeqCst);
    let _ = fs::remove_file(file);
    if hold_microphone && !SPEAK_TURN_OPEN.load(Ordering::SeqCst) {
        // Speech that belongs to no turn (a voice change notice, a farewell, a
        // backchannel that outlived its answer) has no `turn/completed` coming,
        // so the drain watcher hands the microphone back instead of writing
        // "mute" forever.
        resume_listening_when_idle(app);
    }
    outcome
}

/// Waits for everything that is being rendered or played to leave the
/// speakers, then hands the microphone back exactly once — after a trailing
/// moment of silence, so a reconfiguring sound card cannot repeat the last
/// syllable of the answer, and long after the last word, so the listener never
/// transcribes Jarvis's own voice.
fn resume_listening_when_idle(app: &AppHandle) {
    if SPEAK_RESUMING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let idle = || {
            SPEAK_INFLIGHT.load(Ordering::SeqCst) == 0
                && SPEAK_PENDING.load(Ordering::SeqCst) == 0
                && !SPEAK_TURN_OPEN.load(Ordering::SeqCst)
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
        loop {
            if std::time::Instant::now() >= deadline {
                break;
            }
            if !idle() {
                tokio::time::sleep(std::time::Duration::from_millis(60)).await;
                continue;
            }
            // A sentence can arrive a moment after the last one left the
            // speakers, so the quiet has to hold before the microphone comes
            // back — and a new turn always takes priority over this one.
            tokio::time::sleep(std::time::Duration::from_millis(700)).await;
            if !idle() {
                continue;
            }
            if let Some(queue) = AUDIO_QUEUE.get() {
                let _ = queue.send(AudioRequest::Pad { millis: 700 });
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if idle() {
                speak_log("microphone back: answer drained");
                write_wake_control(&app, "unmute").await;
                break;
            }
        }
        SPEAK_RESUMING.store(false, Ordering::SeqCst);
    });
}

/// The one sentence Jarvis says without being asked: the master summoned it, so
/// the summon has to be heard and not only shown. It is cached per voice pack
/// like the backchannel sound, which is what makes it start instantly instead of
/// waiting for the text to speech round trip after the wake word.
pub(crate) const WAKE_GREETING: &str = "主人！我来了！请主人吩咐！";

fn greeting_file(pack: &VoicePack) -> PathBuf {
    // The cached clip is keyed by the character's own line, so switching
    // character never replays the previous character's voice.
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    avatars::greeting_text().hash(&mut hasher);
    std::env::temp_dir().join(format!(
        "jarvis-greeting-{}-{:x}-{}.wav",
        pack.id,
        hasher.finish(),
        speech_cache_stamp()
    ))
}

async fn prewarm_greeting(pack: &VoicePack) {
    if !speak_replies() {
        return;
    }
    let path = greeting_file(pack);
    if path.exists() {
        return;
    }
    let _guard = SPEAK_LOCK.lock().await;
    if path.exists() {
        return;
    }
    if let Err(error) = render_voice(pack, &avatars::greeting_text(), &path).await {
        speak_log(&format!("greeting render failed: {error}"));
        return;
    }
    if let Err(error) = compress_wav_dynamics(&path, -20.0, 3.0) {
        speak_log(&format!("greeting compression skipped: {error}"));
    }
    if pack.robot {
        if let Err(error) = ring_modulate_wav(&path, 52.0, 0.55) {
            speak_log(&format!("greeting effect skipped: {error}"));
        }
        let _ = compress_wav_dynamics(&path, -18.0, 3.0);
    }
    if let Err(error) = normalize_wav_level(
        &path,
        loudness_target(),
        if pack.robot { 0.98 } else { 0.95 },
    ) {
        speak_log(&format!("greeting level skipped: {error}"));
    }
    speak_log(&format!("greeting ready pack={}", pack.id));
}

/// Says hello after the wake word. The answer of the sentence that follows the
/// wake phrase takes priority: it stops this greeting through the same
/// barge-in path as any other reply.
async fn greet_on_wake(app: &AppHandle) {
    if !speak_replies() {
        return;
    }
    let pack = active_voice_pack();
    let path = greeting_file(pack);
    if !path.exists() {
        prewarm_greeting(pack).await;
    }
    if !path.exists() {
        return;
    }
    speak_log(&format!(
        "wake greeting avatar={} pack={}",
        avatars::active_avatar().id,
        pack.id
    ));
    let _ = play_wav(
        app,
        pack,
        &avatars::greeting_text(),
        &path,
        SPEAK_GENERATION.load(Ordering::SeqCst),
        false,
    )
    .await;
}

/// One cached "I am listening" sound per voice pack, so the first reply of a
/// turn starts instantly instead of waiting for the text to speech round trip.
fn backchannel_phrase() -> &'static str {
    const PHRASES: &[&str] = &["嗯。", "好，我看看。", "嗯，稍等。"];
    let index = SPEAK_INDEX.load(Ordering::SeqCst) as usize % PHRASES.len();
    PHRASES[index]
}

fn backchannel_enabled() -> bool {
    jarvis_config()
        .get("backchannel")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// Cached sentences carry the loudness they were rendered at in their name: a
/// file rendered by an older build, or before `volume` was changed, would
/// otherwise keep playing at the old level — which is exactly how a loudness
/// fix stays inaudible.
fn speech_cache_stamp() -> i64 {
    (loudness_target() * 1000.0).round() as i64
}

fn backchannel_file(pack: &VoicePack) -> PathBuf {
    std::env::temp_dir().join(format!(
        "jarvis-ack-{}-{}.wav",
        pack.id,
        speech_cache_stamp()
    ))
}

async fn prewarm_backchannel(pack: &VoicePack) {
    if !backchannel_enabled() {
        return;
    }
    let path = backchannel_file(pack);
    if path.exists() {
        return;
    }
    let _guard = SPEAK_LOCK.lock().await;
    if path.exists() {
        return;
    }
    if let Err(error) = render_voice(pack, backchannel_phrase(), &path).await {
        speak_log(&format!("backchannel render failed: {error}"));
        return;
    }
    if let Err(error) = compress_wav_dynamics(&path, -20.0, 3.0) {
        speak_log(&format!("backchannel compression skipped: {error}"));
    }
    if pack.robot {
        if let Err(error) = ring_modulate_wav(&path, 52.0, 0.55) {
            speak_log(&format!("backchannel effect skipped: {error}"));
        }
        let _ = compress_wav_dynamics(&path, -18.0, 3.0);
    }
    if let Err(error) = normalize_wav_level(
        &path,
        loudness_target(),
        if pack.robot { 0.98 } else { 0.95 },
    ) {
        speak_log(&format!("backchannel level skipped: {error}"));
    }
    speak_log(&format!("backchannel ready pack={}", pack.id));
}

/// Starts the answer of a spoken command with an immediate short sound while
/// the model is still thinking, which is what makes a turn feel like a phone
/// call instead of a request. Skipped as soon as real speech beats it.
fn schedule_backchannel(app: &AppHandle, command: &str) {
    if command.trim().is_empty() || !backchannel_enabled() || !speak_replies() {
        return;
    }
    let turn = TURN_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    TURN_SPOKEN.store(false, Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(650)).await;
        if TURN_SEQ.load(Ordering::SeqCst) != turn || TURN_SPOKEN.swap(true, Ordering::SeqCst) {
            return;
        }
        let pack = active_voice_pack();
        let phrase = backchannel_phrase();
        if !backchannel_file(pack).exists() {
            prewarm_backchannel(pack).await;
        }
        if !backchannel_file(pack).exists() {
            return;
        }
        speak_log(&format!("backchannel pack={} text={phrase}", pack.id));
        let file = backchannel_file(pack);
        let _ = play_wav(
            &app,
            pack,
            phrase,
            &file,
            SPEAK_GENERATION.load(Ordering::SeqCst),
            true,
        )
        .await;
    });
}

#[tauri::command]
async fn speak(app: AppHandle, text: String) -> Result<(), String> {
    speak_with(&app, active_voice_pack(), &text).await
}

/// The cold wake says the same hello as the warm one: the master summoned
/// Jarvis and should hear it, not only see the window appear.
#[tauri::command]
async fn wake_greeting(app: AppHandle) -> Result<(), String> {
    greet_on_wake(&app).await;
    Ok(())
}

#[tauri::command]
async fn preview_voice(app: AppHandle, id: String) -> Result<(), String> {
    let pack = voice_pack_by_id(&id);
    speak_with(&app, pack, "你好，我是 Jarvis。这是当前语音包的试听效果。").await
}

#[derive(Serialize)]
struct VoicePackInfo {
    id: &'static str,
    label: &'static str,
    online: bool,
    active: bool,
}

#[tauri::command]
fn voice_packs() -> Vec<VoicePackInfo> {
    let active = active_voice_pack().id;
    let online = edge_tts_bin().is_some();
    VOICE_PACKS
        .iter()
        .map(|pack| VoicePackInfo {
            id: pack.id,
            label: pack.label,
            online: pack.engine == "edge" && online,
            active: pack.id == active,
        })
        .collect()
}

#[tauri::command]
fn set_voice_pack(id: String) -> Result<(), String> {
    write_voice_pack(&id)
}

fn validated_workspace(cwd: &str) -> Result<String, String> {
    let path = PathBuf::from(cwd);
    if !path.is_dir() {
        return Err(format!("工作目录不存在或不是文件夹：{cwd}"));
    }
    path.canonicalize()
        .map(|value| value.to_string_lossy().into_owned())
        .map_err(|error| format!("无法读取工作目录：{error}"))
}

async fn terminate_runtime(state: &AppState) -> Result<(), String> {
    if let Some(runtime) = state.runtime.lock().await.take() {
        runtime
            .child
            .lock()
            .await
            .kill()
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn ensure_runtime(
    app: AppHandle,
    state: &State<'_, AppState>,
    cwd: &str,
    resume_thread_id: Option<&str>,
    permission_mode: PermissionMode,
) -> Result<Arc<CodexRuntime>, String> {
    let cwd = validated_workspace(cwd)?;
    let existing = { state.runtime.lock().await.clone() };
    if let Some(existing) = existing {
        if existing.permission_mode == permission_mode
            && existing.workspace == cwd
            && existing.avatar_id == avatars::active_avatar().id
        {
            return Ok(existing);
        }
        terminate_runtime(state).await?;
    }
    let profile = permission_mode.profile();
    let avatar_id = avatars::active_avatar().id;
    let runtime = CodexRuntime::spawn(app, permission_mode, cwd.clone(), avatar_id).await?;
    runtime.request("initialize", json!({
        "clientInfo": {"name": "jarvis-codex", "title": "Jarvis Codex", "version": env!("CARGO_PKG_VERSION")},
        "capabilities": {"experimentalApi": true}
    })).await?;
    runtime.notify("initialized", json!({})).await?;
    let thread_options = json!({
        "cwd": cwd,
        "approvalPolicy": profile.approval_policy,
        "sandbox": profile.sandbox,
        "baseInstructions": format!(
            "You are Codex speaking through the local Jarvis interface. Keep voice replies concise and natural, execute real tasks with Codex tools when asked, report progress while work continues, and accept spoken corrections in the same thread. \
    说话用中文，回答要短，像真人对话一样，不要念 Markdown 符号。{} 摄像头会看到主人，方括号里的内容是表情提示，用自然的语气回应它，但不要照念方括号里的文字。{}",
            avatars::persona_for_prompt(),
            profile.instructions
        )
    });
    let started = if let Some(thread_id) = resume_thread_id.filter(|value| !value.trim().is_empty())
    {
        let mut resume_options = thread_options.clone();
        resume_options["threadId"] = Value::String(thread_id.to_owned());
        match runtime.request("thread/resume", resume_options).await {
            Ok(resumed) => resumed,
            Err(_) => {
                let mut start_options = thread_options;
                start_options["ephemeral"] = Value::Bool(false);
                runtime.request("thread/start", start_options).await?
            }
        }
    } else {
        let mut start_options = thread_options;
        start_options["ephemeral"] = Value::Bool(false);
        runtime.request("thread/start", start_options).await?
    };
    let thread_id = started
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .ok_or("Codex 未返回 threadId")?
        .to_owned();
    *runtime.thread_id.write().await = Some(thread_id.clone());
    *state.runtime.lock().await = Some(runtime.clone());
    Ok(runtime)
}

#[tauri::command]
async fn start_jarvis(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    thread_id: Option<String>,
    permission_mode: PermissionMode,
) -> Result<SessionInfo, String> {
    let runtime = ensure_runtime(app, &state, &cwd, thread_id.as_deref(), permission_mode).await?;
    let thread_id = runtime.thread().await?;
    Ok(SessionInfo { thread_id, cwd })
}

#[tauri::command]
async fn start_codex_voice(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    thread_id: Option<String>,
    permission_mode: PermissionMode,
    sdp: String,
    voice: Option<String>,
) -> Result<DirectVoiceInfo, String> {
    if !sdp.starts_with("v=0") {
        return Err("WebRTC SDP offer 无效".to_owned());
    }
    let runtime = ensure_runtime(app, &state, &cwd, thread_id.as_deref(), permission_mode).await?;
    let thread_id = runtime.thread().await?;
    if runtime.voice_active.load(Ordering::SeqCst) {
        let _ = runtime
            .request("thread/realtime/stop", json!({"threadId": thread_id}))
            .await;
    }
    *runtime.voice_phase.write().await = "starting".to_owned();
    runtime.voice_active.store(false, Ordering::SeqCst);
    *runtime.realtime_session_id.write().await = None;

    let mut params = json!({
        "threadId": thread_id,
        "outputModality": "audio",
        "version": "v3",
        "includeStartupContext": true,
        "clientManagedHandoffs": false,
        // STOP must be final. Flushing the tail can create a new Codex turn
        // after the user has already stopped the session.
        "flushTranscriptTailOnSessionEnd": false,
        "codexResponsesAsItems": false,
        "codexResponseHandoffMode": "commentary",
        "transport": {"type": "webrtc", "sdp": sdp}
    });
    if let Some(voice) = voice {
        const SUPPORTED: &[&str] = &[
            "alloy", "arbor", "ash", "ballad", "breeze", "cedar", "coral", "cove", "echo", "ember",
            "juniper", "maple", "marin", "sage", "shimmer", "sol", "spruce", "vale", "verse",
        ];
        if SUPPORTED.contains(&voice.as_str()) {
            params["voice"] = Value::String(voice);
        }
    }
    if let Err(error) = runtime.request("thread/realtime/start", params).await {
        *runtime.voice_phase.write().await = "error".to_owned();
        return Err(format!("Codex Voice V3 启动失败：{error}"));
    }
    Ok(direct_voice_info(&state).await)
}

#[tauri::command]
async fn stop_codex_voice(state: State<'_, AppState>) -> Result<DirectVoiceInfo, String> {
    let Ok(runtime) = runtime(&state).await else {
        return Ok(direct_voice_info(&state).await);
    };
    let thread_id = runtime.thread().await?;
    *runtime.voice_phase.write().await = "stopping".to_owned();
    let result = runtime
        .request("thread/realtime/stop", json!({"threadId": thread_id}))
        .await;
    runtime.voice_active.store(false, Ordering::SeqCst);
    *runtime.voice_phase.write().await = "closed".to_owned();
    *runtime.realtime_session_id.write().await = None;
    result?;
    Ok(direct_voice_info(&state).await)
}

#[tauri::command]
async fn append_codex_voice_text(state: State<'_, AppState>, text: String) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Voice 文本不能为空".to_owned());
    }
    let runtime = runtime(&state).await?;
    if !runtime.voice_active.load(Ordering::SeqCst) {
        return Err("Codex Voice 尚未连接".to_owned());
    }
    let thread_id = runtime.thread().await?;
    runtime
        .request(
            "thread/realtime/appendText",
            json!({"threadId": thread_id, "role": "user", "text": text}),
        )
        .await?;
    Ok(())
}

#[tauri::command]
async fn send_text(state: State<'_, AppState>, text: String) -> Result<(), String> {
    // A new command always wins over a reply that is still being read out:
    // stop the answer that is playing instead of queueing the new one behind
    // it, which is what made Jarvis finish the old answer no matter what the
    // user said over it.
    SPEAK_TURN_OPEN.store(true, Ordering::SeqCst);
    speak_stop_players().await;
    let runtime = runtime(&state).await?;
    let thread_id = runtime.thread().await?;
    // Expression context rides with the turn: a stage direction the model can
    // answer naturally, and that the transcript in the HUD never shows.
    let text = match vision::mood_hint() {
        Some(hint) => format!("[{hint}]\n{text}"),
        None => text,
    };
    runtime
        .request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{"type": "text", "text": text, "text_elements": []}]
            }),
        )
        .await?;
    Ok(())
}

async fn interrupt_active_turn(state: &State<'_, AppState>) {
    let Ok(runtime) = runtime(state).await else {
        return;
    };
    let Ok(thread_id) = runtime.thread().await else {
        return;
    };
    // Only the turn that was running when the user interrupted is cancelled,
    // asked for a few times in case the server has not registered it yet.
    // Re-reading the active turn would also kill the command the user is
    // interrupting with, which starts a new turn moments later.
    let Some(turn_id) = runtime.active_turn.read().await.clone() else {
        return;
    };
    for _ in 0..4 {
        let _ = runtime
            .request(
                "turn/interrupt",
                json!({"threadId": thread_id, "turnId": turn_id}),
            )
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
}

#[tauri::command]
/// Drops the answer in flight without ending the spoken conversation, so the
/// user can talk over Jarvis and be heard straight away.
async fn interrupt_turn(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // The interrupted turn owns the microphone no longer: the listener takes
    // it back right away so the user can say what they wanted to say.
    SPEAK_TURN_OPEN.store(false, Ordering::SeqCst);
    speak_stop_players().await;
    interrupt_active_turn(&state).await;
    write_wake_control(&app, "listen").await;
    Ok(())
}

#[tauri::command]
/// The answer is complete: it may still be playing, so the microphone comes
/// back when the last sentence has left the speakers rather than at the turn
/// boundary — nothing may be spoken into a live microphone.
async fn speak_turn_end(app: AppHandle) -> Result<(), String> {
    SPEAK_TURN_OPEN.store(false, Ordering::SeqCst);
    speak_log("turn ended: draining the answer before the microphone returns");
    resume_listening_when_idle(&app);
    Ok(())
}

#[tauri::command]
async fn stop_all(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    write_wake_control(&app, "end").await;
    speak_stop_players().await;
    interrupt_active_turn(&state).await;
    let Ok(runtime) = runtime(&state).await else {
        return Ok(());
    };
    let thread_id = runtime.thread().await?;
    if let Ok(background) = runtime
        .request(
            "thread/backgroundTerminals/list",
            json!({"threadId": thread_id, "limit": 100}),
        )
        .await
    {
        if let Some(terminals) = background.get("data").and_then(Value::as_array) {
            for terminal in terminals {
                if let Some(process_id) = terminal.get("processId").and_then(Value::as_str) {
                    let _ = runtime
                        .request(
                            "thread/backgroundTerminals/terminate",
                            json!({"threadId": thread_id, "processId": process_id}),
                        )
                        .await;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn resolve_server_request(
    state: State<'_, AppState>,
    request_id: Value,
    approved: bool,
) -> Result<(), String> {
    let runtime = runtime(&state).await?;
    runtime.write(&json!({"id": request_id, "result": {"decision": if approved {"accept"} else {"decline"}}})).await
}

#[tauri::command]
async fn shutdown(state: State<'_, AppState>) -> Result<(), String> {
    terminate_runtime(&state).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Jarvis must be the only copy on the machine: two instances start two wake
/// listeners, and two listeners fighting over the microphone hear nothing at
/// all (which looks exactly like "it cannot hear me").
fn another_instance_owns_the_microphone() -> bool {
    let Ok(home) = std::env::var("HOME") else {
        return false;
    };
    let directory = PathBuf::from(home).join(".jarvis-codex");
    let _ = fs::create_dir_all(&directory);
    let lock = directory.join("app.lock");
    let me = std::process::id();
    for _ in 0..2 {
        if let Ok(mut file) = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
        {
            use std::io::Write;
            let _ = file.write_all(me.to_string().as_bytes());
            return false;
        }
        let owner = fs::read_to_string(&lock)
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok());
        let alive = owner.is_some_and(|pid| {
            std::process::Command::new("/bin/ps")
                .args(["-p", &pid.to_string()])
                .output()
                .map(|out| out.status.success())
                .unwrap_or(false)
        });
        if alive {
            return true;
        }
        let _ = fs::remove_file(&lock);
    }
    false
}

pub fn run() {
    if another_instance_owns_the_microphone() {
        // Another Jarvis is already listening: bring it forward and leave the
        // microphone to it.
        eprintln!("jarvis-codex: another instance is already running, exiting");
        return;
    }
    // A real launch is the end of "closed": from here on a crash must be
    // restarted by the keeper again.
    clear_closed_by_user();
    install_termination_marker();
    install_panic_log();
    let arguments: Vec<String> = std::env::args().collect();
    let cold_wake_pending = arguments.iter().any(|argument| argument == "--jarvis-wake");
    let background_start = arguments.iter().any(|argument| argument == "--background");
    tauri::Builder::default()
        .manage(AppState {
            runtime: Mutex::new(None),
            cold_wake_pending: AtomicBool::new(cold_wake_pending),
            background_start,
            wake_enabled: AtomicBool::new(false),
            wake_ready: AtomicBool::new(false),
            wake_supervisor_running: AtomicBool::new(false),
            wake_pid: AtomicU32::new(0),
            wake_authorization: RwLock::new("notDetermined".to_owned()),
            wake_control: RwLock::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            direct_voice_status,
            arm_wake_listener,
            disarm_wake_listener,
            wake_listener_status,
            consume_cold_wake,
            default_workspace,
            voice_text_only,
            speak_replies,
            speak,
            wake_greeting,
            preview_voice,
            voice_packs,
            set_voice_pack,
            startup_is_background,
            request_microphone_permission,
            start_jarvis,
            start_codex_voice,
            stop_codex_voice,
            append_codex_voice_text,
            send_text,
            stop_all,
            interrupt_turn,
            speak_turn_end,
            resume_wake_conversation,
            resolve_server_request,
            shutdown,
            close_jarvis,
            web_log,
            avatars::avatars,
            avatars::avatar_image,
            avatars::avatar_face,
            avatars::avatar_body,
            avatars::create_avatar,
            avatars::set_active_avatar,
            avatars::delete_avatar,
            avatars::set_vidu_key,
            avatars::vidu_status_command,
            avatars::create_avatar_from_image,
            avatars::set_avatar_live_voice,
            live::videolive_start,
            live::videolive_prepare,
            live::videolive_billing,
            live::videolive_voices,
            live::videolive_credits,
            vision::camera_frame,
            vision::vision_status,
            vision::set_vision_enabled,
            vision::open_camera_settings,
            vision::camera_active,
            vision::request_camera_permission
        ])
        .setup(move |app| {
            use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
            app.handle().plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                Some(vec!["--background"]),
            ))?;
            let _ = app.autolaunch().enable();
            if let Some(window) = app.get_webview_window("main") {
                if background_start {
                    let _ = window.hide();
                } else {
                    raise_jarvis_window(app.handle());
                }
            }
            // The camera stays closed at launch and opens only on a spoken
            // order, so nobody is watched just because Jarvis started.
            vision::reset_at_launch();
            if background_start {
                start_wake_supervisor(app.handle().clone());
            }
            tauri::async_runtime::spawn(async move {
                let pack = active_voice_pack();
                prewarm_greeting(pack).await;
                prewarm_backchannel(pack).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Jarvis Codex")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                // Any clean exit — menu quit, window close, voice command —
                // means Jarvis is meant to be gone, so the keeper stays out of
                // the way. The cold listener keeps the wake word alive without
                // ever opening Jarvis on its own.
                //
                // This runs inside AppKit's `applicationWillTerminate`, where a
                // panic cannot unwind and turns "quit" into "quit unexpectedly"
                // (SIGABRT + a crash report). Nothing here may take the app
                // down with it, so the hand-off is contained and logged.
                append_state_log("exit.log", "exit: menu, window or voice close");
                let handoff = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    mark_closed_by_user("exit");
                    stop_wake_helpers_blocking();
                    spawn_cold_wake_listener(app);
                }));
                if handoff.is_err() {
                    append_state_log("exit.log", "hand-off failed, see panic.log");
                }
            }
        });
}
