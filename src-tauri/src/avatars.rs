//! Character system: the built-in Jarvis plus up to nine user-created
//! companions. Each character owns a portrait, a persona and a fixed voice
//! pack, so switching character also switches voice without touching settings.

use crate::vidu::{base64_encode, ViduClient};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

/// The built-in character is always slot zero, so ten characters in total.
pub const MAX_AVATARS: usize = 10;
pub const DEFAULT_AVATAR_ID: &str = "jarvis";
pub const DEFAULT_VOICE_PACK: &str = "jarvis";

pub const JARVIS_PERSONA: &str =
    "你是 Jarvis，主人专属的钢铁侠式智能管家：冷静、可靠、略带英式幽默，\
说话简短利落，称呼用户为“主人”。遇到复杂任务先给结论再给必要的细节。";

#[derive(Clone, Serialize, Deserialize)]
pub struct Avatar {
    pub id: String,
    pub name: String,
    #[serde(rename = "voicePack", default = "default_voice_pack")]
    pub voice_pack: String,
    #[serde(default)]
    pub persona: String,
    /// Empty for the built-in Jarvis, who uses the bundled artwork.
    #[serde(rename = "imageFile", default)]
    pub image_file: String,
    /// Vidu voice used by the realtime digital human; empty means "derive it
    /// from the voice pack" so characters always sound like themselves.
    #[serde(rename = "liveVoice", default)]
    pub live_voice: String,
    /// Cached Vidu avatar asset, which makes live sessions start immediately.
    #[serde(rename = "liveAssetId", default)]
    pub live_asset_id: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub greeting: String,
    /// Face/mouth/eye boxes of the artwork, normalised to the image. They let
    /// the still character move her lips and eyes while she talks without a
    /// live call. `null` until the artwork has been looked at.
    #[serde(default)]
    pub face: Value,
    /// Hand and feet boxes for the idle pose pass (sway, breathing, small
    /// gestures). `null` until the portrait has been looked at.
    #[serde(default)]
    pub body: Value,
    #[serde(rename = "createdAt", default)]
    pub created_at: u64,
}

fn default_voice_pack() -> String {
    DEFAULT_VOICE_PACK.to_owned()
}

#[derive(Serialize, Deserialize)]
pub struct AvatarStore {
    #[serde(rename = "activeId", default = "default_avatar_id")]
    pub active_id: String,
    #[serde(default)]
    pub avatars: Vec<Avatar>,
}

fn default_avatar_id() -> String {
    DEFAULT_AVATAR_ID.to_owned()
}

/// The built-in character: bundled artwork, robot voice, butler persona.
pub fn builtin_avatar() -> Avatar {
    Avatar {
        id: default_avatar_id(),
        name: "Jarvis".to_owned(),
        voice_pack: default_voice_pack(),
        persona: JARVIS_PERSONA.to_owned(),
        image_file: String::new(),
        live_voice: String::new(),
        live_asset_id: String::new(),
        prompt: "内置形象".to_owned(),
        greeting: crate::WAKE_GREETING.to_owned(),
        face: Value::Null,
        body: Value::Null,
        created_at: 0,
    }
}

impl Default for AvatarStore {
    fn default() -> Self {
        Self {
            active_id: default_avatar_id(),
            avatars: vec![builtin_avatar()],
        }
    }
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "HOME 未设置".to_owned())
}

pub fn jarvis_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".jarvis-codex"))
}

pub fn store_path() -> Result<PathBuf, String> {
    Ok(jarvis_dir()?.join("avatars.json"))
}

pub fn portraits_dir() -> Result<PathBuf, String> {
    Ok(jarvis_dir()?.join("avatars"))
}

pub fn load_store() -> AvatarStore {
    let Ok(path) = store_path() else {
        return AvatarStore::default();
    };
    let store = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<AvatarStore>(&raw).ok())
        .unwrap_or_default();
    if store.avatars.is_empty() {
        return AvatarStore::default();
    }
    store
}

pub fn save_store(store: &AvatarStore) -> Result<(), String> {
    let directory = jarvis_dir()?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let body = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    fs::write(store_path()?, format!("{body}\n")).map_err(|error| error.to_string())
}

pub fn active_avatar() -> Avatar {
    let store = load_store();
    store
        .avatars
        .iter()
        .find(|avatar| avatar.id == store.active_id)
        .or_else(|| store.avatars.first())
        .cloned()
        .unwrap_or_else(builtin_avatar)
}

/// Voice pack of the running character. Falls back to the global preference
/// when the character store has not been created yet.
pub fn active_voice_pack_id() -> String {
    let store = load_store();
    store
        .avatars
        .iter()
        .find(|avatar| avatar.id == store.active_id)
        .map(|avatar| avatar.voice_pack.clone())
        .filter(|pack| !pack.trim().is_empty())
        .unwrap_or_else(|| {
            crate::jarvis_config()
                .get("voicePack")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_VOICE_PACK)
                .to_owned()
        })
}

pub fn persona_for_prompt() -> String {
    let avatar = active_avatar();
    let persona = if avatar.persona.trim().is_empty() {
        JARVIS_PERSONA.to_owned()
    } else {
        avatar.persona.clone()
    };
    format!("你现在的身份是「{}」。{persona}", avatar.name)
}

pub fn greeting_text() -> String {
    let avatar = active_avatar();
    if avatar.greeting.trim().is_empty() {
        if avatar.id == DEFAULT_AVATAR_ID {
            crate::WAKE_GREETING.to_owned()
        } else {
            format!("{}在此，主人请吩咐！", avatar.name)
        }
    } else {
        avatar.greeting.clone()
    }
}

#[derive(Serialize)]
pub struct AvatarView {
    pub id: String,
    pub name: String,
    #[serde(rename = "voicePack")]
    pub voice_pack: String,
    #[serde(rename = "voiceLabel")]
    pub voice_label: String,
    pub persona: String,
    #[serde(rename = "hasPortrait")]
    pub has_portrait: bool,
    #[serde(rename = "hasImage")]
    pub has_image: bool,
    #[serde(rename = "isBuiltin")]
    pub is_builtin: bool,
    pub greeting: String,
    #[serde(rename = "liveVoice")]
    pub live_voice: String,
    #[serde(rename = "liveVoiceLabel")]
    pub live_voice_label: String,
    #[serde(rename = "hasGreenPortrait")]
    pub has_green_portrait: bool,
    /// Where her face is, so the still artwork can talk between calls.
    pub face: Value,
    /// Hands and feet of the artwork, for the idle pose pass.
    pub body: Value,
}

fn voice_label(pack_id: &str) -> String {
    crate::voice_pack_by_id(pack_id).label.to_owned()
}

fn view(avatar: &Avatar) -> AvatarView {
    AvatarView {
        id: avatar.id.clone(),
        name: avatar.name.clone(),
        voice_pack: avatar.voice_pack.clone(),
        voice_label: voice_label(&avatar.voice_pack),
        persona: avatar.persona.clone(),
        has_portrait: avatar.id == DEFAULT_AVATAR_ID || !avatar.image_file.is_empty(),
        has_image: !avatar.image_file.is_empty(),
        is_builtin: avatar.id == DEFAULT_AVATAR_ID,
        greeting: greeting_text_for(avatar),
        live_voice: crate::live::live_voice(avatar),
        live_voice_label: live_voice_label(&crate::live::live_voice(avatar)),
        face: avatar.face.clone(),
        body: avatar.body.clone(),
        has_green_portrait: crate::live::green_portrait(avatar).is_some(),
    }
}

fn live_voice_label(id: &str) -> String {
    crate::live::voice_options()
        .as_array()
        .and_then(|items| {
            items.iter().find_map(|item| {
                (item.get("id").and_then(Value::as_str) == Some(id)).then(|| {
                    item.get("label")
                        .and_then(Value::as_str)
                        .unwrap_or(id)
                        .to_owned()
                })
            })
        })
        .unwrap_or_else(|| id.to_owned())
}

fn greeting_text_for(avatar: &Avatar) -> String {
    if avatar.greeting.trim().is_empty() {
        if avatar.id == DEFAULT_AVATAR_ID {
            crate::WAKE_GREETING.to_owned()
        } else {
            format!("{}在此，主人请吩咐！", avatar.name)
        }
    } else {
        avatar.greeting.clone()
    }
}

#[derive(Serialize)]
pub struct AvatarSnapshot {
    #[serde(rename = "activeId")]
    pub active_id: String,
    pub limit: usize,
    pub avatars: Vec<AvatarView>,
    pub vidu: Value,
}

/// Vidu credentials live in the local config file, never in the repository.
pub fn vidu_key() -> Option<String> {
    if let Ok(key) = std::env::var("VIDU_API_KEY") {
        if !key.trim().is_empty() {
            return Some(key.trim().to_owned());
        }
    }
    crate::jarvis_config()
        .get("viduKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
}

pub fn vidu_status() -> Value {
    let Some(key) = vidu_key() else {
        return json!({"configured": false, "creditRemain": Value::Null});
    };
    match ViduClient::new(key).credits() {
        Ok(mut credits) => {
            credits["configured"] = json!(true);
            credits
        }
        Err(error) => json!({"configured": true, "creditRemain": Value::Null, "error": error}),
    }
}

fn snapshot() -> AvatarSnapshot {
    let store = load_store();
    AvatarSnapshot {
        active_id: store.active_id.clone(),
        limit: MAX_AVATARS,
        avatars: store.avatars.iter().map(view).collect(),
        vidu: vidu_status(),
    }
}

#[tauri::command]
pub fn avatars() -> AvatarSnapshot {
    snapshot()
}

/// Portraits are local files; the webview receives them as data URLs so the
/// asset protocol scope stays narrow.
#[tauri::command]
pub fn avatar_image(id: String) -> Result<Option<String>, String> {
    let store = load_store();
    let Some(avatar) = store.avatars.iter().find(|avatar| avatar.id == id) else {
        return Ok(None);
    };
    if avatar.image_file.is_empty() {
        return Ok(None);
    }
    let path = portraits_dir()?.join(&avatar.image_file);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    let mime = if avatar.image_file.ends_with(".jpg") || avatar.image_file.ends_with(".jpeg") {
        "image/jpeg"
    } else {
        "image/png"
    };
    Ok(Some(format!(
        "data:{mime};base64,{}",
        base64_encode(&bytes)
    )))
}

#[tauri::command]
pub fn set_vidu_key(key: String) -> Value {
    let trimmed = key.trim();
    let mut config = crate::jarvis_config();
    if !config.is_object() {
        config = json!({});
    }
    if trimmed.is_empty() {
        config["viduKey"] = Value::Null;
    } else {
        config["viduKey"] = json!(trimmed);
    }
    if let Ok(directory) = jarvis_dir() {
        let _ = fs::create_dir_all(&directory);
        if let Ok(body) = serde_json::to_string_pretty(&config) {
            let _ = fs::write(directory.join("config.json"), format!("{body}\n"));
        }
    }
    vidu_status()
}

fn validate_new_avatar(store: &AvatarStore, name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("请先给新形象起个名字。".to_owned());
    }
    if name.chars().count() > 12 {
        return Err("名字最多 12 个字。".to_owned());
    }
    if store.avatars.len() >= MAX_AVATARS {
        return Err(format!("最多只能创建 {MAX_AVATARS} 个形象，请先删除一个。"));
    }
    if store
        .avatars
        .iter()
        .any(|avatar| avatar.name.eq_ignore_ascii_case(name))
    {
        return Err(format!("已经有一个叫“{name}”的形象了。"));
    }
    Ok(())
}

fn persona_or_default(name: &str, persona: &str) -> String {
    if persona.trim().is_empty() {
        format!("你是{name}，主人的贴身智能伙伴，说话自然亲切，用中文简短回答。")
    } else {
        persona.trim().to_owned()
    }
}

/// Moves the matting result into place under the character id, returning the
/// portrait file name used by the store.
fn adopt_portrait(id: &str, matte: &crate::matte::MatteOutput) -> Result<String, String> {
    let directory = portraits_dir()?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建形象目录：{error}"))?;
    let portrait = format!("{id}.png");
    fs::copy(&matte.portrait, directory.join(&portrait))
        .map_err(|error| format!("无法保存形象图片：{error}"))?;
    if matte.green.exists() {
        fs::copy(&matte.green, directory.join(format!("{id}-green.png")))
            .map_err(|error| format!("无法保存绿幕形象：{error}"))?;
    }
    Ok(portrait)
}

/// Adds a character from an image the user already has. The background is
/// lifted with Apple's matting so the HUD only ever shows the character.
#[tauri::command]
pub async fn create_avatar_from_image(
    app: AppHandle,
    name: String,
    persona: String,
    voice_pack: String,
    file_name: String,
    data: String,
) -> Result<AvatarView, String> {
    let name = name.trim().to_owned();
    let store = load_store();
    validate_new_avatar(&store, &name)?;
    let voice_pack = crate::voice_pack_by_id(&voice_pack).id.to_owned();
    let persona = persona_or_default(&name, &persona);
    let bytes =
        crate::vidu::base64_decode(&data).map_err(|error| format!("无法读取这张图片：{error}"))?;
    if bytes.len() < 512 {
        return Err("这张图片看起来是空的，换一张再试。".to_owned());
    }

    let id = format!("av{}", unix_millis());
    let work_dir = jarvis_dir()?.join("matte").join(&id);
    let extension = PathBuf::from(&file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|value| matches!(value.as_str(), "png" | "jpg" | "jpeg" | "webp"))
        .unwrap_or_else(|| "png".to_owned());
    let source = work_dir.join(format!("source.{extension}"));
    fs::create_dir_all(&work_dir).map_err(|error| format!("无法创建形象目录：{error}"))?;
    fs::write(&source, &bytes).map_err(|error| format!("无法保存原始图片：{error}"))?;

    let matte_app = app.clone();
    let matte_dir = work_dir.clone();
    let matte = tauri::async_runtime::spawn_blocking(move || {
        crate::matte::extract_subject(&matte_app, &source, &matte_dir)
    })
    .await
    .map_err(|error| format!("主体提取任务异常：{error}"))?;

    let (portrait, face) = match matte {
        Ok(matte) => {
            let _ = app.emit(
                "avatar-progress",
                json!({
                    "stage": "matting",
                    "message": format!("已抠出人物主体（{}×{}）", matte.width, matte.height)
                }),
            );
            let body = matte.body.clone();
            let face = matte.face.clone();
            let _ = body;
            (adopt_portrait(&id, &matte)?, face)
        }
        Err(error) => {
            // Without a cut-out the character still works, it just keeps the
            // background of the original picture.
            eprintln!("jarvis-codex: subject extraction skipped ({error})");
            let directory = portraits_dir()?;
            fs::create_dir_all(&directory)
                .map_err(|error2| format!("无法创建形象目录：{error2}"))?;
            let portrait = format!("{id}.{extension}");
            fs::write(directory.join(&portrait), &bytes)
                .map_err(|error2| format!("无法保存形象图片：{error2}"))?;
            (portrait, Value::Null)
        }
    };
    let _ = fs::remove_dir_all(&work_dir);

    let store = load_store();
    let avatar = Avatar {
        id: id.clone(),
        name: name.clone(),
        voice_pack,
        persona,
        image_file: portrait,
        live_voice: String::new(),
        live_asset_id: String::new(),
        prompt: "本地图片导入".to_owned(),
        greeting: format!("{name}在此，主人请吩咐！"),
        face,
        body: Value::Null,
        created_at: unix_millis(),
    };
    let mut avatars = store.avatars;
    avatars.push(avatar.clone());
    save_store(&AvatarStore {
        active_id: store.active_id,
        avatars,
    })?;
    let _ = app.emit(
        "avatar-progress",
        json!({"stage": "done", "message": "形象已导入"}),
    );
    Ok(view(&avatar))
}

/// Where the face of a character's artwork is. Detected once and remembered,
/// because the HUD needs it on every frame of the talking still.
#[tauri::command]
pub async fn avatar_face(app: AppHandle, id: String) -> Result<Value, String> {
    let store = load_store();
    let Some(avatar) = store.avatars.iter().find(|avatar| avatar.id == id) else {
        return Err(format!("没有找到形象 {id}。"));
    };
    if !avatar.face.is_null() {
        return Ok(avatar.face.clone());
    }
    let Some(portrait) = crate::live::portrait_path_for(avatar) else {
        return Ok(Value::Null);
    };
    let probe = app.clone();
    let face = tauri::async_runtime::spawn_blocking(move || {
        crate::matte::face_geometry(&probe, &portrait)
    })
    .await
    .map_err(|error| format!("人脸识别任务异常：{error}"))?
    .unwrap_or(Value::Null);
    if face.is_null() {
        return Ok(Value::Null);
    }
    let mut store = load_store();
    if let Some(target) = store.avatars.iter_mut().find(|avatar| avatar.id == id) {
        target.face = face.clone();
        let _ = save_store(&store);
    }
    Ok(face)
}

/// Hands and feet of a character's artwork, for the idle pose pass. Detected
/// lazily on first request and remembered, exactly like the face geometry.
#[tauri::command]
pub async fn avatar_body(app: AppHandle, id: String) -> Result<Value, String> {
    let store = load_store();
    let Some(avatar) = store.avatars.iter().find(|avatar| avatar.id == id) else {
        return Err(format!("没有找到形象 {id}。"));
    };
    if !avatar.body.is_null() {
        return Ok(avatar.body.clone());
    }
    let Some(portrait) = crate::live::portrait_path_for(avatar) else {
        return Ok(Value::Null);
    };
    let probe = app.clone();
    let body = tauri::async_runtime::spawn_blocking(move || {
        crate::matte::body_geometry(&probe, &portrait)
    })
    .await
    .map_err(|error| format!("姿态识别任务异常：{error}"))?
    .unwrap_or_else(|_| serde_json::json!({ "hands": [], "feet": [] }));
    let mut store = load_store();
    if let Some(target) = store.avatars.iter_mut().find(|avatar| avatar.id == id) {
        target.body = body.clone();
        let _ = save_store(&store);
    }
    Ok(body)
}

#[tauri::command]
pub fn set_avatar_live_voice(id: String, voice: String) -> Result<AvatarView, String> {
    let mut store = load_store();
    let Some(index) = store.avatars.iter().position(|avatar| avatar.id == id) else {
        return Err(format!("没有找到形象 {id}。"));
    };
    let known = crate::live::voice_options()
        .as_array()
        .map(|items| {
            items
                .iter()
                .any(|item| item.get("id").and_then(Value::as_str) == Some(voice.as_str()))
        })
        .unwrap_or(false);
    if !known {
        return Err(format!("Vidu 没有名为 {voice} 的音色。"));
    }
    store.avatars[index].live_voice = voice;
    let avatar = store.avatars[index].clone();
    save_store(&store)?;
    Ok(view(&avatar))
}

/// Remembers the Vidu asset so the next conversation skips the upload.
pub fn set_live_asset_id(id: &str, asset_id: &str) -> Result<(), String> {
    let mut store = load_store();
    let Some(index) = store.avatars.iter().position(|avatar| avatar.id == id) else {
        return Ok(());
    };
    if store.avatars[index].live_asset_id == asset_id {
        return Ok(());
    }
    store.avatars[index].live_asset_id = asset_id.to_owned();
    save_store(&store)
}

#[tauri::command]
pub async fn create_avatar(
    app: AppHandle,
    name: String,
    persona: String,
    voice_pack: String,
    prompt: String,
) -> Result<AvatarView, String> {
    let name = name.trim().to_owned();
    let prompt = prompt.trim().to_owned();
    if prompt.chars().count() < 4 {
        return Err("请用一句话描述这个形象（至少 4 个字）。".to_owned());
    }
    let store = load_store();
    validate_new_avatar(&store, &name)?;
    let key = vidu_key().ok_or_else(|| "还没有配置 Vidu API Key，请先在设置里填写。".to_owned())?;
    let voice_pack = crate::voice_pack_by_id(&voice_pack).id.to_owned();
    let persona = persona_or_default(&name, &persona);

    let progress = |stage: &str, message: &str| {
        let _ = app.emit(
            "avatar-progress",
            json!({"stage": stage, "message": message}),
        );
    };
    progress("submitting", "正在把形象描述提交给 Vidu…");

    let id = format!("av{}", unix_millis());
    let portrait_id = id.clone();
    let full_prompt = format!(
        "{prompt}。角色半身立绘，正面看向镜头，居中构图，画面中只有这一个人物，\
纯绿色幕布背景（chroma key green），柔和轮廓光，高质量插画，细节清晰，无文字无水印"
    );
    let task_app = app.clone();
    let (_urls, portrait) = tauri::async_runtime::spawn_blocking(move || {
        let client = ViduClient::new(key);
        let task_id = client.reference_to_image(&full_prompt, &[])?;
        let _ = task_app.emit(
            "avatar-progress",
            json!({"stage": "rendering", "message": "Vidu 正在绘制形象，大约需要 30–90 秒…", "taskId": task_id}),
        );
        let urls = client.wait_for_task(&task_id, Duration::from_secs(300))?;
        let portrait = portrait_file_name(&portrait_id, &urls[0]);
        let target = portraits_dir()?.join(&portrait);
        client.download(&urls[0], &target)?;
        Ok::<_, String>((urls, portrait))
    })
    .await
    .map_err(|error| format!("形象生成任务异常：{error}"))??;

    progress("saving", "形象已生成，正在保存…");
    let store = load_store();
    let mut avatars = store.avatars;
    let avatar = Avatar {
        id: id.clone(),
        name: name.clone(),
        voice_pack,
        persona,
        image_file: portrait,
        live_voice: String::new(),
        live_asset_id: String::new(),
        prompt,
        greeting: format!("{name}在此，主人请吩咐！"),
        face: Value::Null,
        body: Value::Null,
        created_at: unix_millis(),
    };
    avatars.push(avatar.clone());
    save_store(&AvatarStore {
        active_id: store.active_id,
        avatars,
    })?;
    progress("done", "形象创建完成");
    Ok(view(&avatar))
}

fn portrait_file_name(id: &str, url: &str) -> String {
    let extension = url
        .split('?')
        .next()
        .and_then(|path| path.rsplit('.').next())
        .filter(|value| matches!(*value, "png" | "jpg" | "jpeg" | "webp"))
        .unwrap_or("png");
    format!("{id}.{extension}")
}

/// Switches character. The voice pack is bound to the character, so this also
/// re-points speech synthesis and drops the cached wake greeting.
#[tauri::command]
pub fn set_active_avatar(id: String) -> Result<AvatarView, String> {
    let mut store = load_store();
    let Some(index) = store.avatars.iter().position(|avatar| avatar.id == id) else {
        return Err(format!("没有找到形象 {id}。"));
    };
    store.active_id = id;
    let avatar = store.avatars[index].clone();
    save_store(&store)?;
    crate::write_voice_pack(&avatar.voice_pack)?;
    Ok(view(&avatar))
}

#[tauri::command]
pub fn delete_avatar(id: String) -> Result<AvatarSnapshot, String> {
    if id == DEFAULT_AVATAR_ID {
        return Err("内置的 Jarvis 不能删除。".to_owned());
    }
    let mut store = load_store();
    let Some(index) = store.avatars.iter().position(|avatar| avatar.id == id) else {
        return Err("这个形象已经不存在了。".to_owned());
    };
    let removed = store.avatars.remove(index);
    if !removed.image_file.is_empty() {
        if let Ok(directory) = portraits_dir() {
            let _ = fs::remove_file(directory.join(&removed.image_file));
        }
    }
    if let (Some(stem), Ok(directory)) = (
        PathBuf::from(&removed.image_file)
            .file_stem()
            .and_then(|value| value.to_str())
            .map(str::to_owned),
        portraits_dir(),
    ) {
        let _ = fs::remove_file(directory.join(format!("{stem}-green.png")));
    }
    if store.active_id == removed.id {
        store.active_id = DEFAULT_AVATAR_ID.to_owned();
        crate::write_voice_pack(DEFAULT_VOICE_PACK)?;
    }
    save_store(&store)?;
    Ok(snapshot())
}

#[tauri::command]
pub fn vidu_status_command() -> Value {
    vidu_status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_builtin_character_is_always_first() {
        let store = AvatarStore::default();
        assert_eq!(store.active_id, DEFAULT_AVATAR_ID);
        assert_eq!(store.avatars.len(), 1);
        assert_eq!(store.avatars[0].voice_pack, DEFAULT_VOICE_PACK);
        assert_eq!(greeting_text_for(&store.avatars[0]), crate::WAKE_GREETING);
    }

    #[test]
    fn a_created_character_greets_in_its_own_name() {
        let avatar = Avatar {
            id: "av1".to_owned(),
            name: "小美".to_owned(),
            voice_pack: "girl".to_owned(),
            persona: String::new(),
            face: serde_json::Value::Null,
            body: serde_json::Value::Null,
            image_file: "av1.png".to_owned(),
            live_voice: String::new(),
            live_asset_id: String::new(),
            prompt: String::new(),
            greeting: String::new(),
            created_at: 1,
        };
        assert_eq!(greeting_text_for(&avatar), "小美在此，主人请吩咐！");
        let view = view(&avatar);
        assert!(view.has_image && view.has_portrait && !view.is_builtin);
        assert_eq!(view.voice_label, crate::voice_pack_by_id("girl").label);
        // An explicit greeting always wins over the generated one.
        let custom = Avatar {
            greeting: "我回来啦！".to_owned(),
            ..avatar
        };
        assert_eq!(greeting_text_for(&custom), "我回来啦！");
    }

    #[test]
    fn portrait_names_keep_the_served_extension() {
        assert_eq!(
            portrait_file_name("av1", "https://x/y/image.png?sig=1"),
            "av1.png"
        );
        assert_eq!(
            portrait_file_name("av2", "https://x/y/photo.JPEG"),
            "av2.png"
        );
        assert_eq!(
            portrait_file_name("av3", "https://x/y/photo.jpg"),
            "av3.jpg"
        );
        assert_eq!(portrait_file_name("av4", "https://x/y/download"), "av4.png");
    }

    #[test]
    fn the_persona_carries_the_character_name() {
        let persona = format!("你现在的身份是「小美」。{JARVIS_PERSONA}");
        assert!(persona.starts_with("你现在的身份是「小美」。"));
    }
}
