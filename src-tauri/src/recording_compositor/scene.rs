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

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompositionCrop {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Default for CompositionCrop {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        }
    }
}

/// Per-source picture adjustments. Brightness, contrast and saturation run
/// -100..100, hue -180..180 degrees, sharpness 0..100. Zero is untouched.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CompositionPicture {
    pub brightness: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub hue: f32,
    pub sharpness: f32,
}

impl CompositionPicture {
    pub fn clamped(self) -> Self {
        let clamp = |value: f32, min: f32, max: f32| {
            if value.is_finite() {
                value.round().clamp(min, max)
            } else {
                0.0
            }
        };
        Self {
            brightness: clamp(self.brightness, -100.0, 100.0),
            contrast: clamp(self.contrast, -100.0, 100.0),
            saturation: clamp(self.saturation, -100.0, 100.0),
            hue: clamp(self.hue, -180.0, 180.0),
            sharpness: clamp(self.sharpness, 0.0, 100.0),
        }
    }

    /// Colour constants for the still shader, matching the preview's CSS
    /// filter: brightness, contrast and saturation factors, hue in radians.
    pub fn shader_params(&self) -> [f32; 4] {
        [
            1.0 + self.brightness / 200.0,
            1.0 + self.contrast / 100.0,
            1.0 + self.saturation / 100.0,
            self.hue.to_radians(),
        ]
    }
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
    #[serde(default)]
    pub crop: CompositionCrop,
    #[serde(default)]
    pub monitor_id: Option<String>,
    #[serde(default)]
    pub picture: CompositionPicture,
    /// Set when `capture` is `window`. Ignored for game and display.
    #[serde(default)]
    pub window: WindowTargetPayload,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowTargetPayload {
    pub title: String,
    pub class_name: String,
    pub exe: String,
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
    #[serde(default)]
    pub crop: CompositionCrop,
    pub device_id: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub mirror: bool,
    #[serde(default)]
    pub shape: WebcamShape,
    #[serde(default)]
    pub picture: CompositionPicture,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum WebcamShape {
    #[default]
    Rectangle,
    Rounded,
    Circle,
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
    #[serde(default)]
    pub crop: CompositionCrop,
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
#[serde(rename_all = "camelCase")]
pub struct MediaCompositionSource {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub enabled: bool,
    pub order: i32,
    pub transform: CompositionTransform,
    #[serde(default)]
    pub crop: CompositionCrop,
    pub path: String,
    #[serde(default, rename = "loop")]
    pub looping: bool,
    #[serde(default = "default_true")]
    pub restart: bool,
    #[serde(default = "default_extra_gain")]
    pub gain: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCompositionSource {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub enabled: bool,
    pub order: i32,
    pub transform: CompositionTransform,
    #[serde(default)]
    pub crop: CompositionCrop,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CompositionSource {
    Capture(CaptureCompositionSource),
    Webcam(WebcamCompositionSource),
    Image(ImageCompositionSource),
    Text(TextCompositionSource),
    ReplayrOverlay(OverlayCompositionSource),
    VideoFile(MediaCompositionSource),
    AudioFile(MediaCompositionSource),
    Browser(BrowserCompositionSource),
    /// A capture card. It records on the camera path and never replaces the primary webcam.
    CaptureCard(WebcamCompositionSource),
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

fn default_extra_gain() -> f32 {
    1.0
}

fn default_extra_device() -> String {
    "default".into()
}

/// A microphone after the first. The first stays on the engine's existing capture.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraMicrophoneRoute {
    pub id: String,
    #[serde(default = "default_extra_device")]
    pub device_id: String,
    #[serde(default = "default_extra_gain")]
    pub gain: f32,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingComposition {
    pub canvas: CompositionCanvas,
    #[serde(default)]
    pub audio: ComposedAudioRouting,
    /// Microphones after the first. Missing on older clients, which record one microphone.
    #[serde(default)]
    pub extra_microphones: Vec<ExtraMicrophoneRoute>,
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
    /// Displays and windows drawn over the base capture. Empty for a one-capture scene.
    pub extra_captures: Vec<ValidatedCapture>,
    /// Webcams after the first, plus capture cards. The first webcam stays on the existing camera path.
    pub extra_webcams: Vec<ValidatedWebcam>,
    pub videos: Vec<ValidatedMedia>,
    pub audio_files: Vec<ValidatedMedia>,
    pub browsers: Vec<ValidatedBrowser>,
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
    pub crop: NormRect,
    pub opacity: f32,
    pub monitor_id: Option<String>,
    pub picture: CompositionPicture,
    pub window: crate::capture_windows::WindowTarget,
}

impl ValidatedCapture {
    pub fn window_target(&self) -> Option<&crate::capture_windows::WindowTarget> {
        matches!(self.kind, CaptureKind::Window).then_some(&self.window)
    }
}

#[derive(Debug, Clone)]
pub struct ValidatedWebcam {
    pub id: String,
    pub name: String,
    pub order: i32,
    pub transform: NormRect,
    pub crop: NormRect,
    pub opacity: f32,
    pub device_id: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub mirror: bool,
    pub shape: WebcamShape,
    pub picture: CompositionPicture,
}

#[derive(Debug, Clone)]
pub struct ValidatedMedia {
    pub id: String,
    pub name: String,
    pub order: i32,
    pub transform: NormRect,
    pub crop: NormRect,
    pub opacity: f32,
    pub path: String,
    pub looping: bool,
    pub gain: f32,
}

#[derive(Debug, Clone)]
pub struct ValidatedBrowser {
    pub id: String,
    pub name: String,
    pub order: i32,
    pub transform: NormRect,
    pub crop: NormRect,
    pub opacity: f32,
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct ValidatedImage {
    pub id: String,
    pub name: String,
    pub order: i32,
    pub transform: NormRect,
    pub crop: NormRect,
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
    ExtraCapture(usize),
    ExtraWebcam(usize),
    Video(usize),
    Browser(usize),
    Image(ValidatedImage),
    Text(ValidatedText),
    OverlayChrome { filter: ComposedFilterId, order: i32 },
}

impl ValidatedLayer {
    pub fn order(&self, spec: &ValidatedComposition) -> i32 {
        match self {
            Self::Capture => spec.capture.order,
            Self::Webcam => spec.webcam.as_ref().map(|cam| cam.order).unwrap_or(0),
            Self::ExtraCapture(index) => spec.extra_captures.get(*index).map(|item| item.order).unwrap_or(0),
            Self::ExtraWebcam(index) => spec.extra_webcams.get(*index).map(|item| item.order).unwrap_or(0),
            Self::Video(index) => spec.videos.get(*index).map(|item| item.order).unwrap_or(0),
            Self::Browser(index) => spec.browsers.get(*index).map(|item| item.order).unwrap_or(0),
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
        let mut captures = Vec::new();
        let mut webcams = Vec::new();
        let mut cards = Vec::new();
        let mut videos = Vec::new();
        let mut audio_files = Vec::new();
        let mut browsers = Vec::new();
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
                    if captures.len() >= 9 {
                        return Err("A scene can record one game, four displays, and four windows.".into());
                    }
                    let id = sanitize_id(&src.id)?;
                    reject_duplicate(&mut ids, &id)?;
                    let window = crate::capture_windows::sanitize_target(&src.window.title, &src.window.class_name, &src.window.exe);
                    if matches!(src.capture, CaptureKind::Window) && window.is_empty() {
                        return Err("Choose a window to record.".into());
                    }
                    if matches!(src.capture, CaptureKind::Game) && !captures.is_empty() {
                        return Err("A scene records one game capture.".into());
                    }
                    captures.push(ValidatedCapture {
                        id,
                        name: sanitize_name(&src.name, "Game Capture"),
                        kind: src.capture,
                        order: src.order,
                        transform: validate_transform(&src.transform)?,
                        crop: validate_crop(&src.crop)?,
                        opacity: src.transform.opacity.clamp(0.0, 1.0),
                        monitor_id: crate::displays::sanitize_monitor_id(src.monitor_id.as_deref()),
                        picture: src.picture.clamped(),
                        window,
                    });
                }
                CompositionSource::Webcam(src) => {
                    if let Some(camera) = validated_camera(src, true, &mut ids)? {
                        if webcams.iter().any(|item: &ValidatedWebcam| item.device_id.eq_ignore_ascii_case(&camera.device_id)) {
                            continue;
                        }
                        if webcams.len() >= 4 {
                            return Err("A scene can record up to four webcams.".into());
                        }
                        webcams.push(camera);
                    }
                }
                CompositionSource::CaptureCard(src) => {
                    if let Some(camera) = validated_camera(src, false, &mut ids)? {
                        let used = webcams
                            .iter()
                            .chain(cards.iter())
                            .any(|item| item.device_id.eq_ignore_ascii_case(&camera.device_id));
                        if used || cards.len() >= 4 {
                            continue;
                        }
                        cards.push(camera);
                    }
                }
                CompositionSource::VideoFile(src) => {
                    push_media(src, true, &mut videos, &mut ids)?;
                }
                CompositionSource::AudioFile(src) => {
                    push_media(src, false, &mut audio_files, &mut ids)?;
                }
                CompositionSource::Browser(src) => {
                    if !src.enabled {
                        continue;
                    }
                    if browsers.len() >= 2 {
                        return Err("A scene can record up to two browser sources.".into());
                    }
                    let name = sanitize_name(&src.name, "Browser");
                    let url = crate::browser_policy::sanitize_page_url(&src.url)?;
                    let id = sanitize_id(&src.id)?;
                    reject_duplicate(&mut ids, &id)?;
                    browsers.push(ValidatedBrowser {
                        id,
                        name,
                        order: src.order,
                        transform: validate_transform(&src.transform)?,
                        crop: validate_crop(&src.crop)?,
                        opacity: src.transform.opacity.clamp(0.0, 1.0),
                        url,
                    });
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
                        crop: validate_crop(&src.crop)?,
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
        if captures.is_empty() {
            return Err("Add a Game, Desktop, or Window capture to record.".into());
        }
        let mut capture_iter = captures.into_iter();
        let capture = capture_iter.next().expect("capture");
        let extra_captures: Vec<ValidatedCapture> = capture_iter.collect();
        let mut webcam_iter = webcams.into_iter();
        let webcam = webcam_iter.next();
        let mut extra_webcams: Vec<ValidatedWebcam> = webcam_iter.collect();
        for card in cards {
            let used = webcam
                .as_ref()
                .is_some_and(|camera| camera.device_id.eq_ignore_ascii_case(&card.device_id))
                || extra_webcams
                    .iter()
                    .any(|camera| camera.device_id.eq_ignore_ascii_case(&card.device_id));
            if used || extra_webcams.len() >= 4 {
                continue;
            }
            extra_webcams.push(card);
        }
        layers.push(ValidatedLayer::Capture);
        if webcam.is_some() {
            layers.push(ValidatedLayer::Webcam);
        }
        for index in 0..extra_captures.len() {
            layers.push(ValidatedLayer::ExtraCapture(index));
        }
        for index in 0..extra_webcams.len() {
            layers.push(ValidatedLayer::ExtraWebcam(index));
        }
        for index in 0..videos.len() {
            layers.push(ValidatedLayer::Video(index));
        }
        for index in 0..browsers.len() {
            layers.push(ValidatedLayer::Browser(index));
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
        layers.sort_by_key(|layer| layer.order(&ValidatedComposition {
            canvas_w,
            canvas_h,
            native_canvas,
            fps,
            capture: capture.clone(),
            webcam: webcam.clone(),
            extra_captures: extra_captures.clone(),
            extra_webcams: extra_webcams.clone(),
            videos: videos.clone(),
            audio_files: audio_files.clone(),
            browsers: browsers.clone(),
            layers: Vec::new(),
            filter,
            hud: hud.clone(),
            audio: audio.clone(),
        }));
        Ok(ValidatedComposition {
            canvas_w,
            canvas_h,
            native_canvas,
            fps,
            capture,
            webcam,
            extra_captures,
            extra_webcams,
            videos,
            audio_files,
            browsers,
            layers,
            filter,
            hud,
            audio,
        })
    }
}

fn validated_camera(
    src: WebcamCompositionSource,
    required: bool,
    ids: &mut Vec<String>,
) -> Result<Option<ValidatedWebcam>, String> {
    if !src.enabled {
        return Ok(None);
    }
    let device_id = sanitize_device(&src.device_id)?;
    if device_id.is_empty() {
        if required {
            return Err("Choose a camera before recording with a webcam overlay.".into());
        }
        return Ok(None);
    }
    let id = sanitize_id(&src.id)?;
    reject_duplicate(ids, &id)?;
    Ok(Some(ValidatedWebcam {
        id,
        name: sanitize_name(&src.name, if required { "Webcam" } else { "Capture card" }),
        order: src.order,
        transform: validate_transform(&src.transform)?,
        crop: validate_crop(&src.crop)?,
        opacity: src.transform.opacity.clamp(0.0, 1.0),
        device_id,
        width: src.width.clamp(160, 1920),
        height: src.height.clamp(120, 1080),
        fps: src.fps.clamp(15, 60),
        mirror: src.mirror,
        shape: src.shape,
        picture: src.picture.clamped(),
    }))
}

fn push_media(
    src: MediaCompositionSource,
    video: bool,
    into: &mut Vec<ValidatedMedia>,
    ids: &mut Vec<String>,
) -> Result<(), String> {
    if !src.enabled {
        return Ok(());
    }
    if into.len() >= 4 {
        return Err(if video {
            "A scene can record up to four video files.".into()
        } else {
            "A scene can record up to four audio files.".into()
        });
    }
    let _ = src.restart;
    let name = sanitize_name(&src.name, if video { "Video" } else { "Audio" });
    let kind = crate::media_policy::media_path_shape(&src.path)?;
    let expected = if video {
        crate::media_policy::MediaKind::Video
    } else {
        crate::media_policy::MediaKind::Audio
    };
    if kind != expected {
        return Err(if video {
            "Use an MP4 or MOV video.".into()
        } else {
            "Use an MP3, M4A, or WAV file.".into()
        });
    }
    let id = sanitize_id(&src.id)?;
    reject_duplicate(ids, &id)?;
    into.push(ValidatedMedia {
        id,
        name,
        order: src.order,
        transform: validate_transform(&src.transform)?,
        crop: validate_crop(&src.crop)?,
        opacity: src.transform.opacity.clamp(0.0, 1.0),
        path: src.path.trim().to_string(),
        looping: src.looping,
        gain: src.gain.clamp(0.0, 2.0),
    });
    Ok(())
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

fn validate_crop(value: &CompositionCrop) -> Result<NormRect, String> {
    if ![value.x, value.y, value.w, value.h]
        .iter()
        .all(|n| n.is_finite())
    {
        return Err("A source crop was invalid.".into());
    }
    let w = value.w.clamp(0.05, 1.0);
    let h = value.h.clamp(0.05, 1.0);
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
            extra_microphones: Vec::new(),
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
    fn rejects_a_window_capture_with_no_target() {
        let json = r#"{"canvas":{"width":1920,"height":1080,"fps":60},"sources":[{"kind":"capture","id":"win-1","name":"Window","capture":"window","enabled":true,"order":0,"transform":{"x":0,"y":0,"w":1,"h":1,"opacity":1}}]}"#;
        assert!(parse(json).unwrap_err().contains("Choose a window"));
    }

    #[test]
    fn records_a_named_window_and_keeps_extra_displays_as_layers() {
        let json = r#"{"canvas":{"width":1920,"height":1080,"fps":60},"sources":[
            {"kind":"capture","id":"game-1","name":"Game","capture":"game","enabled":true,"order":0,"transform":{"x":0,"y":0,"w":1,"h":1,"opacity":1}},
            {"kind":"capture","id":"disp-2","name":"Side","capture":"display","enabled":true,"order":2,"transform":{"x":0.6,"y":0.1,"w":0.3,"h":0.3,"opacity":1},"monitorId":"\\\\.\\DISPLAY2"},
            {"kind":"capture","id":"win-1","name":"Notes","capture":"window","enabled":true,"order":4,"transform":{"x":0.1,"y":0.1,"w":0.3,"h":0.3,"opacity":1},"window":{"title":"Notes","className":"Notepad","exe":"notepad.exe"}},
            {"kind":"webcam","id":"cam-1","name":"Cam","enabled":true,"order":3,"transform":{"x":0.7,"y":0.7,"w":0.2,"h":0.2,"opacity":1},"deviceId":"cam-a","width":1280,"height":720,"fps":30,"mirror":false},
            {"kind":"webcam","id":"cam-2","name":"Cam 2","enabled":true,"order":5,"transform":{"x":0.1,"y":0.7,"w":0.2,"h":0.2,"opacity":1},"deviceId":"cam-b","width":640,"height":480,"fps":30,"mirror":true}
        ]}"#;
        let spec = parse(json).unwrap();
        assert_eq!(spec.capture.kind, CaptureKind::Game);
        assert_eq!(spec.extra_captures.len(), 2);
        assert_eq!(spec.extra_captures[1].window.title, "Notes");
        assert_eq!(spec.extra_webcams.len(), 1);
        assert_eq!(spec.extra_webcams[0].device_id, "cam-b");
    }

    #[test]
    fn skips_a_second_webcam_on_the_same_device() {
        let json = r#"{"canvas":{"width":1920,"height":1080,"fps":60},"sources":[
            {"kind":"capture","id":"game-1","name":"Game","capture":"game","enabled":true,"order":0,"transform":{"x":0,"y":0,"w":1,"h":1,"opacity":1}},
            {"kind":"webcam","id":"cam-1","name":"Cam","enabled":true,"order":1,"transform":{"x":0.7,"y":0.7,"w":0.2,"h":0.2,"opacity":1},"deviceId":"Cam-A","width":1280,"height":720,"fps":30,"mirror":false},
            {"kind":"webcam","id":"cam-2","name":"Cam 2","enabled":true,"order":2,"transform":{"x":0.1,"y":0.7,"w":0.2,"h":0.2,"opacity":1},"deviceId":"cam-a","width":640,"height":480,"fps":30,"mirror":false}
        ]}"#;
        let spec = parse(json).unwrap();
        assert!(spec.webcam.is_some());
        assert!(spec.extra_webcams.is_empty());
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
    fn a_capture_card_stays_off_the_primary_webcam() {
        let json = r#"{"canvas":{"width":1920,"height":1080,"fps":60},"sources":[
            {"kind":"capture","id":"game-1","name":"Game","capture":"game","enabled":true,"order":0,"transform":{"x":0,"y":0,"w":1,"h":1,"opacity":1}},
            {"kind":"webcam","id":"cam-1","name":"Cam","enabled":true,"order":1,"transform":{"x":0.7,"y":0.7,"w":0.2,"h":0.2,"opacity":1},"deviceId":"cam-a","width":1280,"height":720,"fps":30,"mirror":false},
            {"kind":"captureCard","id":"card-1","name":"Card","enabled":true,"order":2,"transform":{"x":0.1,"y":0.1,"w":0.3,"h":0.3,"opacity":1},"deviceId":"card-a","width":1920,"height":1080,"fps":60,"mirror":false},
            {"kind":"captureCard","id":"card-2","name":"Same","enabled":true,"order":3,"transform":{"x":0.1,"y":0.1,"w":0.3,"h":0.3,"opacity":1},"deviceId":"cam-a","width":1280,"height":720,"fps":30,"mirror":false}
        ]}"#;
        let spec = parse(json).unwrap();
        assert_eq!(spec.webcam.as_ref().unwrap().device_id, "cam-a");
        assert_eq!(spec.extra_webcams.len(), 1);
        assert_eq!(spec.extra_webcams[0].device_id, "card-a");
    }

    #[test]
    fn a_missing_capture_card_does_not_block_the_scene() {
        let json = r#"{"canvas":{"width":1920,"height":1080,"fps":60},"sources":[
            {"kind":"capture","id":"game-1","name":"Game","capture":"game","enabled":true,"order":0,"transform":{"x":0,"y":0,"w":1,"h":1,"opacity":1}},
            {"kind":"captureCard","id":"card-1","name":"Card","enabled":true,"order":2,"transform":{"x":0.1,"y":0.1,"w":0.3,"h":0.3,"opacity":1},"deviceId":"","width":1920,"height":1080,"fps":60,"mirror":false}
        ]}"#;
        let spec = parse(json).unwrap();
        assert!(spec.webcam.is_none());
        assert!(spec.extra_webcams.is_empty());
    }

    #[test]
    fn media_and_browser_sources_are_checked_before_they_open() {
        let ok = r#"{"canvas":{"width":1920,"height":1080,"fps":60},"sources":[
            {"kind":"capture","id":"game-1","name":"Game","capture":"game","enabled":true,"order":0,"transform":{"x":0,"y":0,"w":1,"h":1,"opacity":1}},
            {"kind":"videoFile","id":"vid-1","name":"Intro","enabled":true,"order":2,"transform":{"x":0.1,"y":0.1,"w":0.4,"h":0.4,"opacity":1},"path":"C:\\clips\\intro.mp4","loop":true,"restart":true,"gain":1},
            {"kind":"audioFile","id":"aud-1","name":"Bed","enabled":true,"order":3,"transform":{"x":0,"y":0,"w":1,"h":1,"opacity":1},"path":"D:\\music\\bed.mp3","loop":false,"gain":0.5},
            {"kind":"browser","id":"web-1","name":"Page","enabled":true,"order":4,"transform":{"x":0.6,"y":0.1,"w":0.3,"h":0.3,"opacity":1},"url":"HTTPS://Example.com/watch"}
        ]}"#;
        let spec = parse(ok).unwrap();
        assert_eq!(spec.videos.len(), 1);
        assert!(spec.videos[0].looping);
        assert_eq!(spec.audio_files.len(), 1);
        assert_eq!(spec.browsers[0].url, "https://example.com/watch");

        let bad_path = r#"{"canvas":{"width":1920,"height":1080,"fps":60},"sources":[
            {"kind":"capture","id":"game-1","name":"Game","capture":"game","enabled":true,"order":0,"transform":{"x":0,"y":0,"w":1,"h":1,"opacity":1}},
            {"kind":"videoFile","id":"vid-1","name":"Run","enabled":true,"order":2,"transform":{"x":0.1,"y":0.1,"w":0.4,"h":0.4,"opacity":1},"path":"C:\\clips\\run.exe"}
        ]}"#;
        assert!(parse(bad_path).is_err());

        let script = r#"{"canvas":{"width":1920,"height":1080,"fps":60},"sources":[
            {"kind":"capture","id":"game-1","name":"Game","capture":"game","enabled":true,"order":0,"transform":{"x":0,"y":0,"w":1,"h":1,"opacity":1}},
            {"kind":"browser","id":"web-1","name":"Page","enabled":true,"order":2,"transform":{"x":0.1,"y":0.1,"w":0.4,"h":0.4,"opacity":1},"url":"javascript:alert(1)"}
        ]}"#;
        assert!(parse(script).is_err());
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

    #[test]
    fn webcam_shape_defaults_to_rectangle_and_parses_circle() {
        let omitted = format!(
            r#"{{"canvas":{{"width":1920,"height":1080,"fps":60}},"sources":[{},{}]}}"#,
            capture_source("game-1", 0),
            r#"{"kind":"webcam","id":"cam-1","name":"Cam","enabled":true,"order":1,"transform":{"x":0.7,"y":0.7,"w":0.2,"h":0.2,"opacity":1},"deviceId":"cam","width":1280,"height":720,"fps":30,"mirror":false}"#
        );
        let spec = parse(&omitted).unwrap();
        assert_eq!(spec.webcam.as_ref().unwrap().shape, WebcamShape::Rectangle);
        let circle = format!(
            r#"{{"canvas":{{"width":1920,"height":1080,"fps":60}},"sources":[{},{}]}}"#,
            capture_source("game-1", 0),
            r#"{"kind":"webcam","id":"cam-1","name":"Cam","enabled":true,"order":1,"transform":{"x":0.7,"y":0.7,"w":0.2,"h":0.2,"opacity":1},"deviceId":"cam","width":1280,"height":720,"fps":30,"mirror":true,"shape":"circle"}"#
        );
        let spec = parse(&circle).unwrap();
        assert_eq!(spec.webcam.as_ref().unwrap().shape, WebcamShape::Circle);
    }

    #[test]
    fn picture_defaults_to_neutral_and_is_clamped() {
        let json = format!(
            r#"{{"canvas":{{"width":1920,"height":1080,"fps":60}},"sources":[{}]}}"#,
            capture_source("game-1", 0)
        );
        assert_eq!(parse(&json).unwrap().capture.picture, CompositionPicture::default());

        let json = r#"{"canvas":{"width":1920,"height":1080,"fps":60},"sources":[{"kind":"capture","id":"game-1","capture":"game","enabled":true,"order":0,"transform":{"x":0,"y":0,"w":1,"h":1,"opacity":1},"picture":{"brightness":250,"contrast":-20.4,"hue":-400,"sharpness":-5}}]}"#;
        let picture = parse(json).unwrap().capture.picture;
        assert_eq!(picture.brightness, 100.0);
        assert_eq!(picture.contrast, -20.0);
        assert_eq!(picture.saturation, 0.0);
        assert_eq!(picture.hue, -180.0);
        assert_eq!(picture.sharpness, 0.0);
    }
}
