//! Validated recording-composition IPC payload. Frontend scene is untrusted.

use serde::Deserialize;

use super::transforms::{FitMode, NormRect};

const MAX_ID: usize = 64;
const MAX_NAME: usize = 80;
const MAX_DEVICE: usize = 512;
const MAX_PATH: usize = 1024;
const MAX_TEXT: usize = 280;
const MAX_SOURCES: usize = 16;
const MIN_CANVAS: u32 = 320;
const MAX_CANVAS_W: u32 = 3840;
const MAX_CANVAS_H: u32 = 2160;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureKind {
    Game,
    Display,
    Window,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComposedFilterId {
    None,
    Bodycam,
    Dashcam,
    Vhs,
    Cinematic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextAlign {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompositionCanvas {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompositionTransform {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    #[serde(default = "default_opacity")]
    pub opacity: f32,
}

fn default_opacity() -> f32 {
    1.0
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCompositionSource {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub capture: CaptureKind,
    pub enabled: bool,
    pub order: i32,
    pub transform: CompositionTransform,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebcamCompositionSource {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub enabled: bool,
    pub order: i32,
    pub transform: CompositionTransform,
    pub device_id: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub mirror: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCompositionSource {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub enabled: bool,
    pub order: i32,
    pub transform: CompositionTransform,
    pub path: String,
    #[serde(default)]
    pub fit: FitMode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextCompositionSource {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub enabled: bool,
    pub order: i32,
    pub transform: CompositionTransform,
    pub text: String,
    pub color: String,
    pub size: u32,
    pub align: TextAlign,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayCompositionSource {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub enabled: bool,
    pub order: i32,
    pub filter: ComposedFilterId,
    #[serde(default)]
    pub rec_indicator: bool,
    #[serde(default)]
    pub timestamp: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CompositionSource {
    Capture(CaptureCompositionSource),
    Webcam(WebcamCompositionSource),
    Image(ImageCompositionSource),
    Text(TextCompositionSource),
    ReplayrOverlay(OverlayCompositionSource),
}

#[derive(Debug, Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComposedAudioSourceRoute {
    #[serde(default)]
    pub present: bool,
    #[serde(default)]
    pub muted: bool,
}

impl ComposedAudioSourceRoute {
    pub fn routed(self) -> bool {
        self.present && !self.muted
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComposedAudioRouting {
    #[serde(default)]
    pub microphone: ComposedAudioSourceRoute,
    #[serde(default)]
    pub game_audio: ComposedAudioSourceRoute,
    #[serde(default)]
    pub desktop_audio: ComposedAudioSourceRoute,
}

impl ComposedAudioRouting {
    pub fn include(self) -> bool {
        self.microphone.routed() || self.game_audio.routed() || self.desktop_audio.routed()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingComposition {
    pub canvas: CompositionCanvas,
    #[serde(default)]
    pub audio: ComposedAudioRouting,
    pub sources: Vec<CompositionSource>,
}

#[derive(Debug, Clone)]
pub struct ValidatedComposition {
    pub canvas_w: u32,
    pub canvas_h: u32,
    pub native_canvas: bool,
    pub fps: u32,
    pub capture: ValidatedCapture,
    pub webcam: Option<ValidatedWebcam>,
    pub layers: Vec<ValidatedLayer>,
    pub filter: ComposedFilterId,
    pub hud: Option<ValidatedHud>,
    pub audio: ComposedAudioRouting,
}

#[derive(Debug, Clone)]
pub struct ValidatedCapture {
    pub id: String,
    pub name: String,
    pub kind: CaptureKind,
    pub order: i32,
    pub transform: NormRect,
    pub opacity: f32,
}

#[derive(Debug, Clone)]
pub struct ValidatedWebcam {
    pub id: String,
    pub name: String,
    pub order: i32,
    pub transform: NormRect,
    pub opacity: f32,
    pub device_id: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub mirror: bool,
}

#[derive(Debug, Clone)]
pub struct ValidatedImage {
    pub id: String,
    pub name: String,
    pub order: i32,
    pub transform: NormRect,
    pub opacity: f32,
    pub path: String,
    pub fit: FitMode,
}

#[derive(Debug, Clone)]
pub struct ValidatedText {
    pub id: String,
    pub name: String,
    pub order: i32,
    pub transform: NormRect,
    pub opacity: f32,
    pub text: String,
    pub color: [u8; 4],
    pub size: u32,
    pub align: TextAlign,
}

#[derive(Debug, Clone)]
pub struct ValidatedHud {
    pub rec: bool,
    pub timestamp: bool,
    pub filter: ComposedFilterId,
    pub label: Option<String>,
}

#[derive(Debug, Clone)]
pub enum ValidatedLayer {
    Capture,
    Webcam,
    Image(ValidatedImage),
    Text(ValidatedText),
    OverlayChrome { filter: ComposedFilterId, order: i32 },
}

impl ValidatedLayer {
    pub fn order(&self, spec: &ValidatedComposition) -> i32 {
        match self {
            Self::Capture => spec.capture.order,
            Self::Webcam => spec.webcam.as_ref().map(|cam| cam.order).unwrap_or(0),
            Self::Image(image) => image.order,
            Self::Text(text) => text.order,
            Self::OverlayChrome { order, .. } => *order,
        }
    }
}

impl RecordingComposition {
    pub fn validate(self) -> Result<ValidatedComposition, String> {
        if self.sources.len() > MAX_SOURCES {
            return Err("Too many composed sources.".into());
        }
        let native_canvas = self.canvas.width == 0 && self.canvas.height == 0;
        let (canvas_w, canvas_h) = if native_canvas {
            (0, 0)
        } else {
            (
                validate_dim(self.canvas.width, MIN_CANVAS, MAX_CANVAS_W, "canvas width")?,
                validate_dim(self.canvas.height, MIN_CANVAS, MAX_CANVAS_H, "canvas height")?,
            )
        };
        let fps = self.canvas.fps.clamp(24, 60);
        let audio = self.audio;
        let mut capture = None;
        let mut webcam = None;
        let mut images = Vec::new();
        let mut texts = Vec::new();
        let mut overlay = None;
        let mut ids = Vec::new();
        let mut layers = Vec::new();

        for source in self.sources {
            match source {
                CompositionSource::Capture(src) => {
                    if !src.enabled {
                        continue;
                    }
                    if capture.is_some() {
                        return Err("Composed recording supports one capture source.".into());
                    }
                    let id = sanitize_id(&src.id)?;
                    reject_duplicate(&mut ids, &id)?;
                    let validated = ValidatedCapture {
                        id,
                        name: sanitize_name(&src.name, "Game Capture"),
                        kind: src.capture,
                        order: src.order,
                        transform: validate_transform(&src.transform)?,
                        opacity: src.transform.opacity.clamp(0.0, 1.0),
                    };
                    layers.push(ValidatedLayer::Capture);
                    capture = Some(validated);
                }
                CompositionSource::Webcam(src) => {
                    if !src.enabled {
                        continue;
                    }
                    if webcam.is_some() {
                        return Err("Composed recording supports one webcam.".into());
                    }
                    let device_id = sanitize_device(&src.device_id)?;
                    if device_id.is_empty() {
                        return Err("Choose a camera before recording with a webcam overlay.".into());
                    }
                    let id = sanitize_id(&src.id)?;
                    reject_duplicate(&mut ids, &id)?;
                    let validated = ValidatedWebcam {
                        id,
                        name: sanitize_name(&src.name, "Webcam"),
                        order: src.order,
                        transform: validate_transform(&src.transform)?,
                        opacity: src.transform.opacity.clamp(0.0, 1.0),
                        device_id,
                        width: src.width.clamp(160, 1920),
                        height: src.height.clamp(120, 1080),
                        fps: src.fps.clamp(15, 60),
                        mirror: src.mirror,
                    };
                    layers.push(ValidatedLayer::Webcam);
                    webcam = Some(validated);
                }
                CompositionSource::Image(src) => {
                    if !src.enabled {
                        continue;
                    }
                    let name = sanitize_name(&src.name, "Image");
                    let id = sanitize_id(&src.id)?;
                    reject_duplicate(&mut ids, &id)?;
                    let path = sanitize_path_input(&src.path, &name)?;
                    layers.push(ValidatedLayer::Image(ValidatedImage {
                        id,
                        name,
                        order: src.order,
                        transform: validate_transform(&src.transform)?,
                        opacity: src.transform.opacity.clamp(0.0, 1.0),
                        path,
                        fit: src.fit,
                    }));
                    images.push(());
                }
                CompositionSource::Text(src) => {
                    if !src.enabled {
                        continue;
                    }
                    let name = sanitize_name(&src.name, "Text");
                    let id = sanitize_id(&src.id)?;
                    reject_duplicate(&mut ids, &id)?;
                    let text = sanitize_text(&src.text, &name)?;
                    layers.push(ValidatedLayer::Text(ValidatedText {
                        id,
                        name,
                        order: src.order,
                        transform: validate_transform(&src.transform)?,
                        opacity: src.transform.opacity.clamp(0.0, 1.0),
                        text,
                        color: parse_color(&src.color),
                        size: src.size.clamp(10, 96),
                        align: src.align,
                    }));
                    texts.push(());
                    let _ = texts;
                }
                CompositionSource::ReplayrOverlay(src) => {
                    if !src.enabled {
                        continue;
                    }
                    if overlay.is_some() {
                        return Err("Composed recording supports one Replayr overlay.".into());
                    }
                    let id = sanitize_id(&src.id)?;
                    reject_duplicate(&mut ids, &id)?;
                    overlay = Some(src);
                }
            }
        }
        let _ = images;
        let capture = capture.ok_or_else(|| {
            "Composed recording needs a Game or Desktop capture source.".to_string()
        })?;
        if matches!(capture.kind, CaptureKind::Window) {
            return Err("Window capture is not available in composed recording yet. Use Game or Desktop.".into());
        }
        let filter = overlay
            .as_ref()
            .map(|src| src.filter)
            .unwrap_or(ComposedFilterId::None);
        let hud = overlay.as_ref().and_then(|src| {
            let label = match src.filter {
                ComposedFilterId::Bodycam => Some("BODYCAM".into()),
                ComposedFilterId::Dashcam => Some("DASHCAM".into()),
                _ => None,
            };
            if src.rec_indicator || src.timestamp || label.is_some() {
                Some(ValidatedHud {
                    rec: src.rec_indicator,
                    timestamp: src.timestamp,
                    filter: src.filter,
                    label,
                })
            } else {
                None
            }
        });
        if let Some(src) = overlay {
            if filter != ComposedFilterId::None {
                layers.push(ValidatedLayer::OverlayChrome {
                    filter,
                    order: src.order,
                });
            }
        }
        layers.sort_by_key(|layer| match layer {
            ValidatedLayer::Capture => capture.order,
            ValidatedLayer::Webcam => webcam.as_ref().map(|cam| cam.order).unwrap_or(0),
            ValidatedLayer::Image(image) => image.order,
            ValidatedLayer::Text(text) => text.order,
            ValidatedLayer::OverlayChrome { order, .. } => *order,
        });
        Ok(ValidatedComposition {
            canvas_w,
            canvas_h,
            native_canvas,
            fps,
            capture,
            webcam,
            layers,
            filter,
            hud,
            audio,
        })
    }
}

fn reject_duplicate(ids: &mut Vec<String>, id: &str) -> Result<(), String> {
    if ids.iter().any(|existing| existing == id) {
        return Err("A composed source id was duplicated.".into());
    }
    ids.push(id.to_string());
    Ok(())
}

fn validate_transform(value: &CompositionTransform) -> Result<NormRect, String> {
    if ![value.x, value.y, value.w, value.h, value.opacity]
        .iter()
        .all(|n| n.is_finite())
    {
        return Err("A source transform was invalid.".into());
    }
    let w = value.w.clamp(0.02, 1.0);
    let h = value.h.clamp(0.02, 1.0);
    Ok(NormRect {
        x: value.x.clamp(0.0, 1.0 - w),
        y: value.y.clamp(0.0, 1.0 - h),
        w,
        h,
    })
}

fn validate_dim(value: u32, min: u32, max: u32, label: &str) -> Result<u32, String> {
    if value < min || value > max {
        return Err(format!("{label} must be between {min} and {max}."));
    }
    Ok(value)
}

fn sanitize_id(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_ID {
        return Err("A source id was invalid.".into());
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("A source id was invalid.".into());
    }
    Ok(trimmed.to_string())
}

fn sanitize_name(value: &str, fallback: &str) -> String {
    let trimmed: String = value
        .chars()
        .filter(|ch| !ch.is_control())
        .take(MAX_NAME)
        .collect();
    let trimmed = trimmed.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn sanitize_device(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.len() > MAX_DEVICE {
        return Err("That camera id is not valid.".into());
    }
    if trimmed.contains('\0') || trimmed.contains("..") {
        return Err("That camera id is not valid.".into());
    }
    Ok(trimmed.to_string())
}

fn sanitize_path_input(value: &str, name: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("Could not load image source '{name}'."));
    }
    if trimmed.len() > MAX_PATH || trimmed.contains('\0') {
        return Err(format!("Could not load image source '{name}'."));
    }
    Ok(trimmed.to_string())
}

fn sanitize_text(value: &str, name: &str) -> Result<String, String> {
    if value.chars().count() > MAX_TEXT {
        return Err(format!("Text source '{name}' is too long."));
    }
    if value.contains('\0') {
        return Err(format!("Text source '{name}' is not valid."));
    }
    let plain: String = value.chars().filter(|ch| !ch.is_control() || *ch == '\n').collect();
    Ok(if plain.trim().is_empty() {
        "Text".into()
    } else {
        plain
    })
}

/// Parse `#RRGGBB` into straight BGRA. Invalid input becomes white.
fn parse_color(value: &str) -> [u8; 4] {
    let hex = value.trim().trim_start_matches('#');
    if hex.len() == 6 {
        if let (Ok(r), Ok(g), Ok(b)) = (
            u8::from_str_radix(&hex[0..2], 16),
            u8::from_str_radix(&hex[2..4], 16),
            u8::from_str_radix(&hex[4..6], 16),
        ) {
            return [b, g, r, 255];
        }
    }
    [255, 255, 255, 255]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Result<ValidatedComposition, String> {
        let payload: RecordingComposition =
            serde_json::from_str(json).map_err(|err| err.to_string())?;
        payload.validate()
    }

    fn capture_source(id: &str, order: i32) -> String {
        format!(
            r##"{{"kind":"capture","id":"{id}","name":"Game","capture":"game","enabled":true,"order":{order},"transform":{{"x":0,"y":0,"w":1,"h":1,"opacity":1}}}}"##
        )
    }

    #[test]
    fn rejects_duplicate_ids() {
        let json = format!(
            r#"{{"canvas":{{"width":1920,"height":1080,"fps":60}},"sources":[{},{}]}}"#,
            capture_source("game-1", 0),
            r##"{"kind":"text","id":"game-1","name":"Dup","enabled":true,"order":1,"transform":{"x":0.1,"y":0.1,"w":0.2,"h":0.1,"opacity":1},"text":"Hi","color":"#ffffff","size":18,"align":"left"}"##
        );
        assert!(parse(&json).unwrap_err().contains("duplicated"));
    }

    #[test]
    fn rejects_unknown_filter_id() {
        let json = format!(
            r#"{{"canvas":{{"width":1920,"height":1080,"fps":60}},"sources":[{},{}]}}"#,
            capture_source("game-1", 0),
            r#"{"kind":"replayrOverlay","id":"ov-1","name":"Overlay","enabled":true,"order":9,"filter":"cctv","recIndicator":false,"timestamp":false}"#
        );
        assert!(parse(&json).is_err());
    }

    #[test]
    fn rejects_nan_and_infinite_transforms() {
        let json = format!(
            r#"{{"canvas":{{"width":1920,"height":1080,"fps":60}},"sources":[{}]}}"#,
            capture_source("game-1", 0)
        );
        let mut payload: RecordingComposition = serde_json::from_str(&json).unwrap();
        if let CompositionSource::Capture(src) = &mut payload.sources[0] {
            src.transform.x = f32::NAN;
        }
        assert!(RecordingComposition {
            canvas: payload.canvas.clone(),
            audio: payload.audio,
            sources: payload.sources.clone(),
        }
        .validate()
        .is_err());

        if let CompositionSource::Capture(src) = &mut payload.sources[0] {
            src.transform.x = 0.0;
            src.transform.opacity = f32::INFINITY;
        }
        assert!(payload.validate().is_err());
    }

    #[test]
    fn rejects_window_capture() {
        let json = r#"{"canvas":{"width":1920,"height":1080,"fps":60},"sources":[{"kind":"capture","id":"win-1","name":"Window","capture":"window","enabled":true,"order":0,"transform":{"x":0,"y":0,"w":1,"h":1,"opacity":1}}]}"#;
        assert!(parse(json).unwrap_err().contains("Window capture"));
    }

    #[test]
    fn scene_order_is_lowest_first() {
        let json = format!(
            r#"{{"canvas":{{"width":1920,"height":1080,"fps":60}},"sources":[{},{},{}]}}"#,
            capture_source("game-1", 1),
            r##"{"kind":"text","id":"text-1","name":"Title","enabled":true,"order":5,"transform":{"x":0.1,"y":0.1,"w":0.3,"h":0.1,"opacity":1},"text":"Hello","color":"#000000","size":22,"align":"center"}"##,
            r#"{"kind":"webcam","id":"cam-1","name":"Cam","enabled":true,"order":3,"transform":{"x":0.7,"y":0.7,"w":0.2,"h":0.2,"opacity":1},"deviceId":"cam","width":1280,"height":720,"fps":30,"mirror":false}"#
        );
        let spec = parse(&json).unwrap();
        let orders: Vec<i32> = spec.layers.iter().map(|layer| layer.order(&spec)).collect();
        assert_eq!(orders, vec![1, 3, 5]);
        assert!(matches!(spec.layers[0], ValidatedLayer::Capture));
        assert!(matches!(spec.layers[1], ValidatedLayer::Webcam));
        assert!(matches!(spec.layers[2], ValidatedLayer::Text(_)));
    }

    #[test]
    fn black_text_color_is_opaque_bgra_black() {
        let json = format!(
            r#"{{"canvas":{{"width":1920,"height":1080,"fps":60}},"sources":[{},{}]}}"#,
            capture_source("game-1", 0),
            r##"{"kind":"text","id":"text-1","name":"Title","enabled":true,"order":1,"transform":{"x":0.1,"y":0.1,"w":0.3,"h":0.1,"opacity":1},"text":"Hello","color":"#000000","size":22,"align":"left"}"##
        );
        let spec = parse(&json).unwrap();
        let ValidatedLayer::Text(text) = &spec.layers[1] else {
            panic!("expected text layer");
        };
        assert_eq!(text.color, [0, 0, 0, 255]);
        assert_eq!(text.text, "Hello");
    }

    #[test]
    fn rejects_oversized_text_and_keeps_unicode() {
        let long = "x".repeat(281);
        let json = format!(
            r#"{{"canvas":{{"width":1920,"height":1080,"fps":60}},"sources":[{},{}]}}"#,
            capture_source("game-1", 0),
            format!(
                r##"{{"kind":"text","id":"text-1","name":"Long","enabled":true,"order":1,"transform":{{"x":0.1,"y":0.1,"w":0.3,"h":0.1,"opacity":1}},"text":"{long}","color":"#ffffff","size":18,"align":"left"}}"##
            )
        );
        assert!(parse(&json).unwrap_err().contains("too long"));

        let json = format!(
            r#"{{"canvas":{{"width":1920,"height":1080,"fps":60}},"sources":[{},{}]}}"#,
            capture_source("game-1", 0),
            r##"{"kind":"text","id":"text-1","name":"Uni","enabled":true,"order":1,"transform":{"x":0.1,"y":0.1,"w":0.3,"h":0.1,"opacity":1},"text":"こんにちは","color":"#00ffff","size":18,"align":"center"}"##
        );
        let spec = parse(&json).unwrap();
        let ValidatedLayer::Text(text) = &spec.layers[1] else {
            panic!("expected text");
        };
        assert_eq!(text.text, "こんにちは");
        assert_eq!(text.color, [255, 255, 0, 255]);
    }

    #[test]
    fn hidden_sources_are_omitted() {
        let json = format!(
            r#"{{"canvas":{{"width":1920,"height":1080,"fps":60}},"sources":[{},{}]}}"#,
            capture_source("game-1", 0),
            r#"{"kind":"image","id":"img-1","name":"Logo","enabled":false,"order":2,"transform":{"x":0.1,"y":0.1,"w":0.2,"h":0.2,"opacity":1},"path":"C:\\logo.png"}"#
        );
        let spec = parse(&json).unwrap();
        assert_eq!(spec.layers.len(), 1);
    }

    #[test]
    fn missing_audio_defaults_to_video_only() {
        let json = format!(
            r#"{{"canvas":{{"width":1920,"height":1080,"fps":60}},"sources":[{}]}}"#,
            capture_source("game-1", 0)
        );
        let spec = parse(&json).unwrap();
        assert!(!spec.audio.include());
        assert!(!spec.audio.microphone.routed());
        assert!(!spec.audio.game_audio.routed());
        assert!(!spec.audio.desktop_audio.routed());
    }

    #[test]
    fn muted_or_absent_audio_is_not_routed() {
        let json = format!(
            r#"{{"canvas":{{"width":1920,"height":1080,"fps":60}},"audio":{{"microphone":{{"present":true,"muted":true}},"gameAudio":{{"present":false,"muted":false}},"desktopAudio":{{"present":true,"muted":true}}}},"sources":[{}]}}"#,
            capture_source("game-1", 0)
        );
        let spec = parse(&json).unwrap();
        assert!(spec.audio.microphone.present && spec.audio.microphone.muted);
        assert!(!spec.audio.microphone.routed());
        assert!(!spec.audio.game_audio.present);
        assert!(!spec.audio.game_audio.routed());
        assert!(spec.audio.desktop_audio.present && spec.audio.desktop_audio.muted);
        assert!(!spec.audio.desktop_audio.routed());
        assert!(!spec.audio.include());
    }

    #[test]
    fn present_unmuted_audio_is_routed() {
        let json = format!(
            r#"{{"canvas":{{"width":1920,"height":1080,"fps":60}},"audio":{{"microphone":{{"present":true,"muted":false}},"gameAudio":{{"present":true,"muted":false}},"desktopAudio":{{"present":true,"muted":false}}}},"sources":[{}]}}"#,
            capture_source("game-1", 0)
        );
        let spec = parse(&json).unwrap();
        assert!(spec.audio.microphone.routed());
        assert!(spec.audio.game_audio.routed());
        assert!(spec.audio.desktop_audio.routed());
        assert!(spec.audio.include());
    }
}
