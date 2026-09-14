//! Subject extraction for character portraits.
//!
//! Illustrations arrive with a painted background — a checkerboard, a studio
//! wall, a gradient — while the HUD wants the character alone. A small Swift
//! tool (built next to the wake helper) runs Apple's foreground-instance
//! matting and writes both a transparent cut-out and a chroma-key green twin
//! for the Vidu digital human.

use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

pub struct MatteOutput {
    pub portrait: PathBuf,
    pub green: PathBuf,
    pub width: u32,
    pub height: u32,
    /// Face/mouth/eye boxes, normalised to the artwork. `null` when the tool
    /// found no face, in which case the still character cannot talk.
    pub face: serde_json::Value,
    /// Hands and feet for the idle pose pass; `null` until the portrait has
    /// been looked at with `--body`.
    pub body: serde_json::Value,
}

fn tool_path(app: &AppHandle) -> Result<PathBuf, String> {
    let relative = PathBuf::from("wake-helper/JarvisMatte");
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
    Err("没有找到主体提取工具 JarvisMatte。".to_owned())
}

fn parse_face(stdout: &str) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(stdout.trim())
        .ok()
        .and_then(|value| value.get("face").cloned())
        .filter(|face| !face.is_null())
        .unwrap_or(serde_json::Value::Null)
}

fn parse_body(stdout: &str) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(stdout.trim())
        .ok()
        .and_then(|value| {
            let hands = value.get("hands").cloned();
            let feet = value.get("feet").cloned();
            if hands.is_none() && feet.is_none() {
                None
            } else {
                Some(serde_json::json!({
                    "hands": hands.unwrap_or_else(|| serde_json::json!([])),
                    "feet": feet.unwrap_or_else(|| serde_json::json!([])),
                }))
            }
        })
        .unwrap_or(serde_json::Value::Null)
}

/// Face geometry of an existing portrait, used for characters that were saved
/// before their artwork could be worked out.
pub fn face_geometry(app: &AppHandle, input: &Path) -> Result<serde_json::Value, String> {
    let tool = tool_path(app)?;
    let output = Command::new(&tool)
        .arg("--face")
        .arg(input)
        .output()
        .map_err(|error| format!("无法运行人脸识别：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let face = parse_face(&stdout);
    if face.is_null() {
        return Err("这张图里没有找到人脸。".to_owned());
    }
    Ok(face)
}

/// Hands and feet of a portrait, for the idle pose pass. Detection never
/// fails: artwork without visible hands or feet simply returns empty arrays,
/// and the HUD falls back to face-only animation.
pub fn body_geometry(app: &AppHandle, input: &Path) -> Result<serde_json::Value, String> {
    let tool = tool_path(app)?;
    let output = Command::new(&tool)
        .arg("--body")
        .arg(input)
        .output()
        .map_err(|error| format!("无法运行姿态识别：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_body(&stdout))
}

fn parse_dimensions(stdout: &str) -> (u32, u32) {
    let value: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap_or_default();
    let width = value
        .get("width")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as u32;
    let height = value
        .get("height")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as u32;
    (width, height)
}

/// Runs the matting tool. `input` may be any raster the system can read; the
/// outputs land in `output_dir` as `portrait.png` and `green.png`.
pub fn extract_subject(
    app: &AppHandle,
    input: &Path,
    output_dir: &Path,
) -> Result<MatteOutput, String> {
    let tool = tool_path(app)?;
    std::fs::create_dir_all(output_dir).map_err(|error| format!("无法创建形象目录：{error}"))?;
    let output = Command::new(&tool)
        .arg(input)
        .arg(output_dir)
        .output()
        .map_err(|error| format!("无法运行主体提取工具：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("主体提取失败：{}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let (width, height) = parse_dimensions(&stdout);
    Ok(MatteOutput {
        portrait: output_dir.join("portrait.png"),
        green: output_dir.join("green.png"),
        width,
        height,
        face: parse_face(&stdout),
        body: serde_json::Value::Null,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn dimensions_default_to_zero_when_the_tool_is_quiet() {
        assert_eq!(super::parse_dimensions("not json"), (0, 0));
        assert_eq!(
            super::parse_dimensions(r#"{"width": 1600, "height": 2848, "matted": true}"#),
            (1600, 2848)
        );
    }
}
