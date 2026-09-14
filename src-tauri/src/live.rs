//! Vidu S1 realtime digital human ("实时交互数字人 · 标准版").
//!
//! A live conversation has two parallel links: an HTTP create call that returns
//! the AliRTC credentials plus a per-session `client_secret`, and a control
//! WebSocket. The webview owns both media and control (AliRTC SDK + the secret),
//! which keeps the account API key inside this process while still allowing the
//! page to drive text, barge-in and hang-up directly.
//!
//! Reference: https://platform.vidu.cn/docs/vidu-s1

use crate::avatars::{self, Avatar};
use crate::vidu::ViduClient;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Vidu bills 3 credits per two seconds of conversation.
pub const CREDITS_PER_SECOND: f64 = 1.5;
/// A session with no input for this long hangs itself up, so a forgotten call
/// cannot drain the account.
const IDLE_TIMEOUT_SECONDS: u64 = 300;
/// The avatar asset needs its description generated before a live can use it.
const ASSET_WAIT: Duration = Duration::from_secs(120);
const ASSET_POLL: Duration = Duration::from_secs(3);

/// Voices offered in the character editor, verified against the live endpoint.
pub fn voice_options() -> Value {
    let voices = [
        ("Tina", "Tina · 温柔女声（默认）"),
        ("Cindy", "Cindy · 可爱少女"),
        ("Momo", "Momo · 元气萌音"),
        ("Kiki", "Kiki · 粤语女声"),
        ("Sunny", "Sunny · 四川话"),
        ("Dylan", "Dylan · 北京话"),
        ("Raymond", "Raymond · 沉稳男声"),
        ("Ethan", "Ethan · 清朗男声"),
        ("Harvey", "Harvey · 磁性男声"),
    ];
    json!(voices
        .into_iter()
        .map(|(id, label)| json!({"id": id, "label": label}))
        .collect::<Vec<_>>())
}

/// Characters inherit the digital-human voice from their fixed voice pack, so a
/// character always sounds the same in both local and live speech.
pub fn default_voice(pack: &str) -> &'static str {
    match pack {
        "girl" => "Cindy",
        "female" => "Tina",
        "jarvis" | "male" => "Raymond",
        _ => "Tina",
    }
}

pub fn live_voice(avatar: &Avatar) -> String {
    if avatar.live_voice.trim().is_empty() {
        default_voice(&avatar.voice_pack).to_owned()
    } else {
        avatar.live_voice.trim().to_owned()
    }
}

/// Persona handed to the digital human. The spoken-word rules matter: this
/// model answers out loud, so markdown or stage directions would be read out,
/// and any answer of its own would collide with the line the agent hands back.
pub fn live_persona(avatar: &Avatar) -> String {
    format!(
        "{}\n\n【实时通话规则】\n\
- 你是主人的数字人化身，只负责「出镜」和「传话」，不做任何思考，绝不抢答。\n\
- 用户说出的每一句话都是发给智能体的指令，不是对你说话：无论用户问什么、\
说什么，一律不许回答、不许附和、不许解释、不许追问，保持安静等待转述。\n\
- 只有收到以「朗读：」开头的文本时，才把冒号后面的内容一字不差地念出来，\
不要添加、删减、改写，也不要回应它的内容。\n\
- 不要使用 Markdown、列表、表情符号、括号里的动作说明或旁白。",
        avatar.persona.trim()
    )
}

pub fn greeting_instruction(avatar: &Avatar) -> String {
    let greeting = if avatar.greeting.trim().is_empty() {
        format!("{}在此，主人请吩咐！", avatar.name)
    } else {
        avatar.greeting.trim().to_owned()
    };
    let prefix = "请直接用中文说这句开场白，不要添加任何别的内容：";
    let mut text = format!("{prefix}“{greeting}”");
    if text.chars().count() > 200 {
        text = format!(
            "{prefix}“{}”",
            greeting.chars().take(160).collect::<String>()
        );
    }
    text
}

/// The chroma-key twin of a portrait, when the matting tool produced one.
pub fn green_portrait(avatar: &Avatar) -> Option<PathBuf> {
    if avatar.image_file.is_empty() {
        return None;
    }
    let directory = avatars::portraits_dir().ok()?;
    let stem = Path::new(&avatar.image_file)
        .file_stem()
        .and_then(|value| value.to_str())?;
    let candidate = directory.join(format!("{stem}-green.png"));
    candidate.exists().then_some(candidate)
}

fn portrait_path(avatar: &Avatar) -> Option<PathBuf> {
    if avatar.image_file.is_empty() {
        return None;
    }
    let path = avatars::portraits_dir().ok()?.join(&avatar.image_file);
    path.exists().then_some(path)
}

/// A pre-rendered scene animation, once Vidu has produced and downloaded it.
/// `None` until the one-off generation has finished, so the UI falls back to
/// the still portrait in the meantime.
pub fn scene_video_path(avatar: &Avatar, scene: &str) -> Option<PathBuf> {
    let file = match scene {
        "greet" => &avatar.greet_video_file,
        "wait" => &avatar.wait_video_file,
        _ => return None,
    };
    if file.is_empty() {
        return None;
    }
    let path = avatars::portraits_dir().ok()?.join(file);
    path.is_file().then_some(path)
}

/// Image the digital human is rendered from: the green-screen twin keeps the
/// background removable on the client, which is what makes the character stand
/// on top of the HUD instead of inside a video rectangle.
pub fn live_image(avatar: &Avatar) -> Option<PathBuf> {
    green_portrait(avatar).or_else(|| portrait_path(avatar))
}

fn data_uri(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("无法读取形象图片：{error}"))?;
    let mime = match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    };
    Ok(format!(
        "data:{mime};base64,{}",
        crate::vidu::base64_encode(&bytes)
    ))
}

fn resolve_avatar(avatar_id: Option<String>) -> Result<Avatar, String> {
    match avatar_id {
        Some(id) if !id.trim().is_empty() => avatars::load_store()
            .avatars
            .into_iter()
            .find(|avatar| avatar.id == id)
            .ok_or_else(|| format!("没有找到形象 {id}。")),
        _ => Ok(avatars::active_avatar()),
    }
}

fn create_body(avatar: &Avatar, asset_id: &str, image_uri: Option<String>) -> Value {
    let mut avatar_payload = json!({
        "persona": live_persona(avatar),
        "voice": live_voice(avatar),
        "greeting_instruction": greeting_instruction(avatar),
        "idle_action": true,
    });
    if !asset_id.is_empty() {
        avatar_payload["id"] = json!(asset_id);
    } else if let Some(uri) = image_uri {
        avatar_payload["image_uri"] = json!(uri);
    }
    json!({
        "call_mode": "video",
        "avatar": avatar_payload,
        "audio": {"enable_transcription": true},
        "vad": {
            // semantic means "the user opens their mouth and the current line
            // is interrupted", and the digital human's own voice bleeds into
            // the published microphone: she used to interrupt herself every
            // sentence. server filters echoes and background noise instead.
            "type": "server",
            "threshold": 0.7,
            "silence_duration_ms": 800,
            "idle_timeout_ms": 0
        },
        "llm": {
            "temperature": 0.4,
            "top_p": 0.8,
            "max_tokens": 220,
            "frequency_penalty": 1
        },
        "idle_timeout_seconds": IDLE_TIMEOUT_SECONDS
    })
}

/// Starts a conversation and hands the webview everything it needs: the RTC
/// credentials, the control secret and the persona that is actually live.
#[tauri::command]
pub async fn videolive_start(avatar_id: Option<String>) -> Result<Value, String> {
    let key = avatars::vidu_key()
        .ok_or_else(|| "还没有配置 Vidu API Key，请先在设置里填写。".to_owned())?;
    let avatar = resolve_avatar(avatar_id)?;
    let asset = match ensure_asset_key(&key, &avatar).await {
        Ok(asset) => asset,
        Err(error) => {
            // Falling back to the inline image keeps a first call possible even
            // when the asset service is unhappy; the session just starts slower.
            eprintln!("jarvis-codex: live asset unavailable ({error}), sending the image inline");
            String::new()
        }
    };
    let inline = if asset.is_empty() {
        live_image(&avatar)
            .map(|path| data_uri(&path))
            .transpose()?
    } else {
        None
    };
    let body = create_body(&avatar, &asset, inline);
    let created = tauri::async_runtime::spawn_blocking(move || {
        let client = ViduClient::new(key);
        client.create_live(&body)
    })
    .await
    .map_err(|error| format!("创建实时会话异常：{error}"))??;

    let live_id = created
        .pointer("/live/id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if live_id.is_empty() {
        return Err(format!("Vidu 未返回会话 ID：{created}"));
    }
    if let Some(asset) = created.pointer("/live/avatar/id").and_then(Value::as_str) {
        if !asset.is_empty() {
            let _ = avatars::set_live_asset_id(&avatar.id, asset);
        }
    }
    Ok(json!({
        "liveId": live_id,
        "rtc": created.get("rtc").cloned().unwrap_or(Value::Null),
        "clientSecret": created.get("client_secret").cloned().unwrap_or(Value::Null),
        "avatarId": avatar.id,
        "avatarName": avatar.name,
        "voice": live_voice(&avatar),
        "greenScreen": green_portrait(&avatar).is_some(),
        "idleTimeoutSeconds": IDLE_TIMEOUT_SECONDS,
        "creditsPerSecond": CREDITS_PER_SECOND,
        "model": "Vidu S1 实时数字人"
    }))
}

async fn ensure_asset_key(key: &str, avatar: &Avatar) -> Result<String, String> {
    if !avatar.live_asset_id.trim().is_empty() {
        return Ok(avatar.live_asset_id.trim().to_owned());
    }
    let name = avatar.name.clone();
    let avatar_id = avatar.id.clone();
    let image = live_image(avatar)
        .ok_or_else(|| format!("形象「{name}」还没有图片，请先生成或导入一张。"))?;
    let uri = data_uri(&image)?;
    let key = key.to_owned();
    let asset = tauri::async_runtime::spawn_blocking(move || {
        let client = ViduClient::new(key);
        let id = client.create_avatar_asset(&uri, &name)?;
        client.wait_for_avatar_asset(&id, ASSET_WAIT, ASSET_POLL)
    })
    .await
    .map_err(|error| format!("形象资产任务异常：{error}"))??;
    avatars::set_live_asset_id(&avatar_id, &asset)?;
    Ok(asset)
}

/// Billing for a finished or running conversation.
#[tauri::command]
pub async fn videolive_billing(live_id: String) -> Result<Value, String> {
    let key = avatars::vidu_key().ok_or_else(|| "还没有配置 Vidu API Key。".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let client = ViduClient::new(key);
        client.live_status(&live_id)
    })
    .await
    .map_err(|error| format!("查询通话账单异常：{error}"))?
}

/// Pre-uploads a portrait so the next conversation starts without the wait.
#[tauri::command]
pub async fn videolive_prepare(avatar_id: Option<String>) -> Result<Value, String> {
    let avatar = resolve_avatar(avatar_id)?;
    let asset = ensure_asset_key(
        &avatars::vidu_key().ok_or_else(|| "还没有配置 Vidu API Key。".to_owned())?,
        &avatar,
    )
    .await?;
    Ok(json!({"avatarId": avatar.id, "assetId": asset, "voice": live_voice(&avatar)}))
}

#[tauri::command]
pub fn videolive_voices() -> Value {
    voice_options()
}

/// Remaining credits plus how much conversation they still pay for.
#[tauri::command]
pub fn videolive_credits() -> Value {
    let mut status = avatars::vidu_status();
    if let Some(remaining) = status.get("creditRemain").and_then(Value::as_i64) {
        status["affordableSeconds"] = json!(affordable_seconds(remaining));
        status["creditsPerSecond"] = json!(CREDITS_PER_SECOND);
    }
    status
}

/// Seconds of conversation the remaining credits can pay for.
pub fn affordable_seconds(credits: i64) -> i64 {
    ((credits as f64) / CREDITS_PER_SECOND).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_voices_follow_the_voice_pack() {
        assert_eq!(default_voice("girl"), "Cindy");
        assert_eq!(default_voice("jarvis"), "Raymond");
        assert_eq!(default_voice("unknown-pack"), "Tina");
    }

    #[test]
    fn live_persona_keeps_the_character_and_adds_spoken_rules() {
        let persona = live_persona(&avatars::builtin_avatar());
        assert!(persona.contains("钢铁侠式智能管家"));
        assert!(persona.contains("朗读："));
    }

    #[test]
    fn greeting_instruction_stays_inside_the_200_character_limit() {
        let mut avatar = avatars::builtin_avatar();
        assert!(greeting_instruction(&avatar).chars().count() <= 200);
        avatar.greeting = "好".repeat(500);
        assert!(greeting_instruction(&avatar).chars().count() <= 200);
    }

    #[test]
    fn credits_map_to_minutes_of_talk() {
        assert_eq!(affordable_seconds(1959), 1306);
    }
}
