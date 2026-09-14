//! Minimal client for the Vidu open platform (<https://platform.vidu.cn>).
//!
//! Every supported macOS release already ships `/usr/bin/curl`, so the client
//! shells out instead of pulling a second HTTP/TLS stack into the app bundle.
//! Calls are blocking and must run inside `spawn_blocking`.

use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

pub const API_BASE: &str = "https://api.vidu.cn";
/// The reference-to-image model used for avatar portraits.
pub const IMAGE_MODEL: &str = "viduq2";
/// Avatar art is billed per task; a portrait render costs roughly 6 credits.
const POLL_INTERVAL: Duration = Duration::from_secs(3);

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

pub struct ViduClient {
    key: String,
}

struct HttpResponse {
    status: u16,
    body: String,
}

fn error_message(body: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return body.trim().chars().take(200).collect();
    };
    for pointer in ["/message", "/detail", "/error", "/msg", "/error/message"] {
        if let Some(text) = value.pointer(pointer).and_then(Value::as_str) {
            if !text.trim().is_empty() {
                return text.trim().to_owned();
            }
        }
    }
    body.trim().chars().take(200).collect()
}

impl ViduClient {
    pub fn new(key: impl Into<String>) -> Self {
        Self { key: key.into() }
    }

    fn curl(&self, url: &str, body: Option<&Value>) -> Result<HttpResponse, String> {
        let mut command = Command::new("/usr/bin/curl");
        command.args(["-sS", "--max-time", "120", "-X"]);
        command.arg(if body.is_some() { "POST" } else { "GET" });
        command.args(["-H", &format!("Authorization: Token {}", self.key)]);
        command.args(["-H", "Content-Type: application/json"]);
        command
            .arg("--write-out")
            .arg("\n__JARVIS_HTTP__%{http_code}");

        let payload = body
            .map(|value| {
                let path = std::env::temp_dir().join(format!(
                    "jarvis-vidu-{}-{}.json",
                    std::process::id(),
                    TEMP_SEQ.fetch_add(1, Ordering::SeqCst)
                ));
                fs::write(
                    &path,
                    serde_json::to_vec(value).map_err(|error| error.to_string())?,
                )
                .map_err(|error| format!("无法写入 Vidu 请求体：{error}"))?;
                Ok::<_, String>(path)
            })
            .transpose()?;
        if let Some(path) = &payload {
            command
                .arg("--data-binary")
                .arg(format!("@{}", path.display()));
        }
        command.arg(url);

        let output = command
            .output()
            .map_err(|error| format!("无法调用 curl：{error}"))?;
        if let Some(path) = payload {
            let _ = fs::remove_file(path);
        }
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("请求 Vidu 失败：{}", stderr.trim()));
        }
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let (body, status) = stdout
            .rsplit_once("__JARVIS_HTTP__")
            .ok_or_else(|| "Vidu 响应缺少状态码".to_owned())?;
        Ok(HttpResponse {
            status: status.trim().parse().unwrap_or(0),
            body: body.trim().to_owned(),
        })
    }

    fn json(&self, url: &str, body: Option<&Value>) -> Result<Value, String> {
        let response = self.curl(url, body)?;
        if response.status == 401 || response.status == 403 {
            return Err("Vidu 鉴权失败：API Key 不正确或已失效。".to_owned());
        }
        if !(200..300).contains(&response.status) {
            return Err(format!(
                "Vidu 返回 {}：{}",
                response.status,
                error_message(&response.body)
            ));
        }
        serde_json::from_str::<Value>(&response.body)
            .map_err(|error| format!("无法解析 Vidu 响应：{error}"))
    }

    /// Remaining credits, concurrency ceiling and current usage.
    pub fn credits(&self) -> Result<Value, String> {
        let value = self.json(&format!("{API_BASE}/ent/v2/credits"), None)?;
        let remains = value
            .pointer("/remains/0")
            .or_else(|| value.pointer("/general_remains/0"));
        Ok(json!({
            "creditRemain": remains.and_then(|item| item.get("credit_remain")).and_then(Value::as_i64),
            "concurrencyLimit": remains.and_then(|item| item.get("concurrency_limit")).and_then(Value::as_i64),
            "currentConcurrency": remains.and_then(|item| item.get("current_concurrency")).and_then(Value::as_i64),
        }))
    }

    /// Submits a reference-to-image task and returns its task id.
    pub fn reference_to_image(&self, prompt: &str, images: &[String]) -> Result<String, String> {
        let mut payload = json!({
            "model": IMAGE_MODEL,
            "prompt": prompt,
            "aspect_ratio": "3:4",
            "resolution": "1080p",
        });
        if !images.is_empty() {
            payload["images"] = json!(images);
        }
        let value = self.json(
            &format!("{API_BASE}/ent/v2/reference2image"),
            Some(&payload),
        )?;
        value
            .get("task_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("Vidu 未返回 task_id：{value}"))
    }

    fn task_state(&self, task_id: &str) -> Result<(String, Vec<String>), String> {
        let value = self.json(
            &format!("{API_BASE}/ent/v2/tasks/{task_id}/creations"),
            None,
        )?;
        let state = value
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        let urls = value
            .get("creations")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("url").and_then(Value::as_str))
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok((state, urls))
    }

    /// Waits for a task and returns the finished creation URLs.
    pub fn wait_for_task(&self, task_id: &str, timeout: Duration) -> Result<Vec<String>, String> {
        let deadline = Instant::now() + timeout;
        let mut last_state;
        loop {
            let (state, urls) = self.task_state(task_id)?;
            last_state = state.clone();
            match state.as_str() {
                "success" if !urls.is_empty() => return Ok(urls),
                "success" => return Err("Vidu 任务成功但没有返回图片。".to_owned()),
                "failed" => {
                    return Err(format!(
                        "Vidu 生成失败：{}",
                        self.task_error(task_id)
                            .unwrap_or_else(|| "未提供原因".to_owned())
                    ))
                }
                _ => {}
            }
            if Instant::now() >= deadline {
                return Err(format!("Vidu 生成超时（最后状态 {last_state}）。"));
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn task_error(&self, task_id: &str) -> Option<String> {
        let value = self
            .json(
                &format!("{API_BASE}/ent/v2/tasks/{task_id}/creations"),
                None,
            )
            .ok()?;
        value
            .get("err_code")
            .and_then(Value::as_str)
            .filter(|code| !code.is_empty())
            .map(str::to_owned)
    }

    /// Uploads a portrait as a reusable digital-human asset.
    ///
    /// The live endpoint accepts an inline image too, but it re-ingests the
    /// picture on every call; an asset id makes later sessions start at once.
    pub fn create_avatar_asset(&self, image_uri: &str, name: &str) -> Result<String, String> {
        let value = self.json(
            &format!("{API_BASE}/live/v1/avatars"),
            Some(&json!({"image_uri": image_uri, "name": name})),
        )?;
        value
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("Vidu 未返回形象资产 ID：{value}"))
    }

    /// A freshly uploaded asset describes itself asynchronously (`created` →
    /// `processing` → `success`); a live session cannot use it before that.
    pub fn wait_for_avatar_asset(
        &self,
        id: &str,
        timeout: Duration,
        interval: Duration,
    ) -> Result<String, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let value = self.json(&format!("{API_BASE}/live/v1/avatars/{id}"), None)?;
            let last = value
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned();
            match last.as_str() {
                "success" => return Ok(id.to_owned()),
                "failed" => {
                    return Err("Vidu 无法识别这张形象图片，换一张更清晰的正面试试。".to_owned())
                }
                _ => {}
            }
            if Instant::now() >= deadline {
                return Err(format!("形象资产处理超时（最后状态 {last}）。"));
            }
            std::thread::sleep(interval);
        }
    }

    /// Opens a realtime digital-human session.
    pub fn create_live(&self, body: &Value) -> Result<Value, String> {
        self.json(&format!("{API_BASE}/live/v1/lives"), Some(body))
    }

    /// Session state and what it has cost so far.
    pub fn live_status(&self, live_id: &str) -> Result<Value, String> {
        let value = self.json(&format!("{API_BASE}/live/v1/lives/{live_id}"), None)?;
        let live = value.get("live").cloned().unwrap_or(Value::Null);
        Ok(json!({
            "status": live.get("status").cloned().unwrap_or(Value::Null),
            "billedSeconds": live.get("billed_seconds").cloned().unwrap_or(Value::Null),
            "creditsCost": live.get("credits_cost").cloned().unwrap_or(Value::Null),
            "closeReason": live.get("close_reason").cloned().unwrap_or(Value::Null),
            "duration": live.get("live_duration").cloned().unwrap_or(Value::Null),
        }))
    }

    /// Streams a creation URL to `destination`.
    pub fn download(&self, url: &str, destination: &Path) -> Result<(), String> {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建形象目录：{error}"))?;
        }
        let staging = destination.with_extension("part");
        let output = Command::new("/usr/bin/curl")
            .args(["-sS", "--max-time", "180", "-L", "-o"])
            .arg(&staging)
            .arg(url)
            .output()
            .map_err(|error| format!("无法下载形象图片：{error}"))?;
        if !output.status.success() {
            let _ = fs::remove_file(&staging);
            return Err(format!(
                "下载形象图片失败：{}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let size = fs::metadata(&staging).map(|meta| meta.len()).unwrap_or(0);
        if size < 1024 {
            let _ = fs::remove_file(&staging);
            return Err("下载到的形象图片不完整。".to_owned());
        }
        let _ = fs::remove_file(destination);
        fs::rename(&staging, destination).map_err(|error| format!("无法保存形象图片：{error}"))
    }
}

/// Decodes the data URL a `<input type="file">` produces. Anything that is not
/// base64 is rejected, because the result is written straight to disk.
pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let body = match input.split_once(',') {
        Some((head, tail)) if head.contains("base64") => tail,
        _ => input,
    };
    let mut out = Vec::with_capacity(body.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for byte in body.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return Err(format!("数据里有非法字符 {}", byte as char)),
        } as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

/// Standard base64, used to hand local images to the webview without widening
/// the asset-protocol scope.
pub fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 63] as char);
        out.push(TABLE[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(triple >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[triple as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64_encode;

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0xff, 0xef, 0x01]), "/+8B");
    }

    #[test]
    fn base64_decode_reads_data_urls() {
        assert_eq!(super::base64_decode("Zm9vYmFy").unwrap(), b"foobar");
        assert_eq!(
            super::base64_decode("data:image/png;base64,Zm9vYmFy").unwrap(),
            b"foobar"
        );
        assert!(super::base64_decode("data:image/png;base64,Zm9v*").is_err());
        for sample in [
            b"a".to_vec(),
            b"ab".to_vec(),
            b"abc".to_vec(),
            (0..=255u8).collect(),
        ] {
            let encoded = super::base64_encode(&sample);
            assert_eq!(super::base64_decode(&encoded).unwrap(), sample);
        }
    }

    #[test]
    fn error_messages_prefer_the_platform_field() {
        assert_eq!(
            super::error_message(r#"{"code":"x","message":"余额不足"}"#),
            "余额不足"
        );
        assert_eq!(super::error_message("plain text"), "plain text");
    }
}
