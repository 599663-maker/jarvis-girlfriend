//! Camera presence: a small helper app owns the webcam, publishes a low
//! latency JPEG for the HUD self-view, and reports face/expression estimates so
//! Jarvis can react to how the master looks, not only to what is said.

use crate::vidu::base64_encode;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::Command;

/// Frames older than this mean the helper is gone and the self-view must blank
/// instead of freezing on the last picture.
const FRAME_FRESHNESS: Duration = Duration::from_secs(2);
const MAX_RESTARTS: u32 = 3;

static VISION_ENABLED: AtomicBool = AtomicBool::new(false);
static VISION_RUNNING: AtomicBool = AtomicBool::new(false);
static VISION_PID: AtomicU32 = AtomicU32::new(0);
static VISION_ERROR: Mutex<Option<String>> = Mutex::new(None);
static LAST_SIGNAL: OnceLock<Mutex<Value>> = OnceLock::new();

fn signal_store() -> &'static Mutex<Value> {
    LAST_SIGNAL.get_or_init(|| Mutex::new(json!({"faces": 0, "emotion": "unknown"})))
}

fn set_error(message: Option<String>) {
    if let Ok(mut guard) = VISION_ERROR.lock() {
        *guard = message;
    }
}

fn vision_helper_path(app: &AppHandle) -> Result<PathBuf, String> {
    let relative = PathBuf::from("wake-helper/JarvisVision.app");
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
    Err("Jarvis 视觉组件未找到".to_owned())
}

pub fn event_file() -> PathBuf {
    std::env::temp_dir().join(format!("jarvis-vision-{}.jsonl", std::process::id()))
}

pub fn frame_file() -> PathBuf {
    std::env::temp_dir().join(format!("jarvis-vision-{}.jpg", std::process::id()))
}

/// `camera` in the local config turns the webcam on. It is **off** by default:
/// the green camera light must never be on just because Jarvis is running, so
/// the master asks for it by voice ("启动视频组件" / "你能看到我吗").
pub fn configured_enabled() -> bool {
    crate::jarvis_config()
        .get("camera")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// A launch always begins with the eyes closed: the webcam only comes on after
/// a spoken order ("启动视频组件" / "你能看到我吗"), never because the last
/// session happened to leave it on.
pub fn reset_at_launch() {
    VISION_ENABLED.store(false, Ordering::SeqCst);
    let _ = set_configured_enabled(false);
}

/// Whether the camera is switched on in *this* session.
pub fn session_enabled() -> bool {
    VISION_ENABLED.load(Ordering::SeqCst)
}

fn set_configured_enabled(enabled: bool) -> Result<(), String> {
    let mut config = crate::jarvis_config();
    if !config.is_object() {
        config = json!({});
    }
    config["camera"] = json!(enabled);
    let directory = crate::avatars::jarvis_dir()?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let body = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(directory.join("config.json"), format!("{body}\n")).map_err(|error| error.to_string())
}

pub fn status() -> Value {
    let running = VISION_RUNNING.load(Ordering::SeqCst);
    let last = signal_store()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or(Value::Null);
    json!({
        "enabled": VISION_ENABLED.load(Ordering::SeqCst),
        "running": running,
        "preferred": configured_enabled(),
        "error": VISION_ERROR.lock().ok().and_then(|guard| guard.clone()),
        "signal": last,
    })
}

/// Latest known expression, phrased for the model prompt.
pub fn mood_hint() -> Option<String> {
    let guard = signal_store().lock().ok()?;
    let faces = guard.get("faces").and_then(Value::as_i64).unwrap_or(0);
    if faces <= 0 {
        return None;
    }
    let emotion = guard
        .get("emotion")
        .and_then(Value::as_str)
        .unwrap_or("neutral");
    let zh = match emotion {
        "happy" => "主人正带着微笑，心情不错",
        "surprised" => "主人看起来有点惊讶",
        "sad" => "主人看起来情绪低落",
        "angry" => "主人皱着眉，似乎有点不满",
        "tired" => "主人看起来有些疲惫",
        _ => "主人表情平静",
    };
    Some(format!("摄像头看到{zh}。"))
}

#[tauri::command]
pub fn camera_frame() -> Option<String> {
    let path = frame_file();
    let modified = fs::metadata(&path).ok()?.modified().ok()?;
    if SystemTime::now().duration_since(modified).ok()? > FRAME_FRESHNESS {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    if bytes.len() < 512 {
        return None;
    }
    Some(format!("data:image/jpeg;base64,{}", base64_encode(&bytes)))
}

/// The camera prompt belongs to the app that owns the window, exactly like the
/// microphone one: macOS attributes a nested helper's request to its host, so
/// asking here is what makes the prompt appear at all.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn request_camera_permission() -> Result<String, String> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeVideo};
    use std::sync::{Arc as StdArc, Mutex as StdMutex};
    use tokio::sync::oneshot;

    let media_type =
        unsafe { AVMediaTypeVideo }.ok_or_else(|| "macOS 未提供摄像头授权类型".to_owned())?;
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
    crate::append_state_log("camera.log", &format!("app request, status={status:?}"));
    match status {
        AVAuthorizationStatus::Authorized => return Ok("authorized".to_owned()),
        AVAuthorizationStatus::Denied => return Ok("denied".to_owned()),
        AVAuthorizationStatus::Restricted => return Ok("restricted".to_owned()),
        _ => {}
    }

    let (sender, receiver) = oneshot::channel::<bool>();
    let sender = StdArc::new(StdMutex::new(Some(sender)));
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
        .map_err(|_| "macOS 摄像头授权回调中断".to_owned())?;
    crate::append_state_log(
        "camera.log",
        &format!("app request finished, granted={granted}"),
    );
    Ok(if granted { "authorized" } else { "denied" }.to_owned())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn request_camera_permission() -> Result<String, String> {
    Ok("authorized".to_owned())
}

#[tauri::command]
pub fn vision_status() -> Value {
    status()
}

#[tauri::command]
pub fn set_vision_enabled(app: AppHandle, enabled: bool) -> Result<Value, String> {
    set_configured_enabled(enabled)?;
    if enabled {
        start(app);
    } else {
        stop();
    }
    Ok(status())
}

pub fn start(app: AppHandle) {
    if !configured_enabled() {
        VISION_ENABLED.store(false, Ordering::SeqCst);
        return;
    }
    if VISION_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    VISION_ENABLED.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let helper = match vision_helper_path(&app) {
            Ok(path) => path,
            Err(error) => {
                set_error(Some(error));
                VISION_RUNNING.store(false, Ordering::SeqCst);
                return;
            }
        };
        let event_file = event_file();
        let frame_file = frame_file();

        let _ = fs::remove_file(&event_file);
        let _ = fs::remove_file(&frame_file);
        if fs::write(&event_file, "").is_err() {
            set_error(Some("无法创建视觉事件通道".to_owned()));
            VISION_RUNNING.store(false, Ordering::SeqCst);
            return;
        }
        set_error(None);
        let mut restarts = 0u32;
        while VISION_ENABLED.load(Ordering::SeqCst) {
            let mut command = Command::new("/usr/bin/open");
            command
                .arg("-n")
                .arg("-W")
                .arg(&helper)
                .args(["--args", "--event-file"])
                .arg(&event_file)
                .arg("--frame-file")
                .arg(&frame_file)
                .args(["--fps", "10"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    set_error(Some(format!("无法启动视觉组件：{error}")));
                    break;
                }
            };
            VISION_PID.store(child.id().unwrap_or(0), Ordering::SeqCst);
            let mut processed = 0usize;
            loop {
                if !VISION_ENABLED.load(Ordering::SeqCst) {
                    let _ = child.start_kill();
                    break;
                }
                if let Ok(Some(_)) = child.try_wait() {
                    break;
                }
                if let Ok(content) = fs::read_to_string(&event_file) {
                    let lines: Vec<String> = content.lines().map(str::to_owned).collect();
                    for line in lines.iter().skip(processed) {
                        if let Ok(value) = serde_json::from_str::<Value>(line) {
                            if let Ok(mut guard) = signal_store().lock() {
                                for key in [
                                    "faces",
                                    "emotion",
                                    "confidence",
                                    "smile",
                                    "eyes",
                                    "mouth",
                                    "distance",
                                    "ts",
                                ] {
                                    if let Some(field) = value.get(key) {
                                        guard[key] = field.clone();
                                    }
                                }
                            }
                            if value.get("type").and_then(Value::as_str) == Some("error") {
                                set_error(
                                    value
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .map(str::to_owned),
                                );
                            }
                            let _ = app.emit("jarvis-vision", value);
                        }
                    }
                    processed = lines.len();
                }
                tokio::time::sleep(Duration::from_millis(220)).await;
            }
            if !VISION_ENABLED.load(Ordering::SeqCst) {
                break;
            }
            restarts += 1;
            if restarts > MAX_RESTARTS {
                set_error(Some(
                    "视觉组件反复退出，请检查系统设置里的摄像头权限。".to_owned(),
                ));
                break;
            }
            tokio::time::sleep(Duration::from_millis(900)).await;
        }
        VISION_RUNNING.store(false, Ordering::SeqCst);
        VISION_PID.store(0, Ordering::SeqCst);
        let _ = fs::remove_file(&frame_file);
    });
}

pub fn stop() {
    VISION_ENABLED.store(false, Ordering::SeqCst);
    let _ = std::process::Command::new("/usr/bin/pkill")
        .args(["-x", "JarvisVision"])
        .status();
}

/// Called by the HUD when the window hides: the camera must not keep running
/// behind a window nobody can see.
#[tauri::command]
pub fn camera_active(app: AppHandle, active: bool) {
    if active && configured_enabled() {
        start(app);
    } else if !active {
        VISION_ENABLED.store(false, Ordering::SeqCst);
        let _ = std::process::Command::new("/usr/bin/pkill")
            .args(["-x", "JarvisVision"])
            .status();
    }
}

#[tauri::command]
pub fn open_camera_settings() {
    let _ = std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")
        .status();
}
