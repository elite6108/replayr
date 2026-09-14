//! Reading the Clip studio scene at Save Clip time.
//!
//! The Clips tab on the Record page describes how a *saved clip* is framed and decorated. It
//! never changes what Instant Replay captures: IR stays a raw rolling buffer, and Save Clip
//! stays a bitstream-copy remux unless the scene actually asks for something to be burned in.
//!
//! The scene lives on the settings document rather than in localStorage because Save Clip is
//! reachable from the F10 hotkey and the tray with no frontend payload (`hotkeys.rs`,
//! `system.rs`) — those paths can only read what is already in SQLite.
//!
//! This module is deliberately not `#[cfg(windows)]`: it is pure data, so it unit-tests on any
//! host, the same way `recording_compositor::scene` does.

use crate::overlay::OverlayLayout;
use crate::recording_compositor::scene::{
    CaptureKind, ComposedAudioRouting, ComposedFilterId, CompositionCanvas, CompositionCrop,
    CompositionSource, CompositionTransform, ImageCompositionSource, OverlayCompositionSource,
    RecordingComposition, TextAlign, TextCompositionSource, ValidatedComposition,
};
use crate::settings::{AppSettings, ClipRect, ClipScene, ClipSceneSource};

/// Source `type` strings this module cares about. Mirrors `RecordingSourceType`
/// (src/recording/scene.ts:17).
const KIND_WEBCAM: &str = "webcam";
const KIND_GAME: &str = "game";
const KIND_DISPLAY: &str = "display";
const KIND_IMAGE: &str = "image";
const KIND_TEXT: &str = "text";
const KIND_OVERLAY: &str = "replayrOverlay";

/// The clip scene the next Save Clip will use, or `None` when the user has never opened the
/// Clips tab. `None` means "behave exactly as before this feature existed".
pub fn active_scene(settings: &AppSettings) -> Option<&ClipScene> {
    let studio = &settings.clip_studio;
    studio
        .scenes
        .iter()
        .find(|scene| scene.id == studio.active_id)
        .or_else(|| studio.scenes.first())
}

fn source_of<'a>(scene: &'a ClipScene, kind: &str) -> Option<&'a ClipSceneSource> {
    scene.sources.iter().find(|source| source.kind == kind)
}

/// Whether this save should write a webcam sidecar.
///
/// Turning the webcam off on a clip scene means "no sidecar for clips saved with this scene".
/// It must never be confused with `settings.webcam.enabled`, which powers the camera engine
/// globally — the clip studio is not allowed to write that.
///
/// With no clip scene at all we fall back to the global webcam setting, which is what the
/// sidecar has always keyed off in practice.
pub fn webcam_enabled(settings: &AppSettings) -> bool {
    match active_scene(settings).and_then(|scene| source_of(scene, KIND_WEBCAM)) {
        Some(webcam) => webcam.enabled,
        None => settings.webcam.enabled,
    }
}

/// The webcam overlay layout to store on the saved clip's webcam source row.
///
/// Returns `None` when there is no clip scene or its webcam is off/untransformed, which leaves
/// `library::resolve_webcam_meta` to fall back to `webcam_layout_from_settings` exactly as it
/// does today. This is the back-compat guarantee for users who never open the Clips tab.
///
/// The Rust counterpart of `sessionWebcamLayoutFromScene` (src/recording/composition.ts:143).
pub fn webcam_layout(settings: &AppSettings) -> Option<OverlayLayout> {
    let webcam = active_scene(settings).and_then(|scene| source_of(scene, KIND_WEBCAM))?;
    if !webcam.enabled {
        return None;
    }
    let transform = webcam.transform?;
    if !transform.x.is_finite()
        || !transform.y.is_finite()
        || !transform.w.is_finite()
        || !transform.h.is_finite()
    {
        return None;
    }
    let shape = webcam
        .settings
        .get("shape")
        .and_then(|value| value.as_str())
        .unwrap_or(crate::overlay::DEFAULT_SHAPE);

    let mut layout = OverlayLayout::new(
        nearest_corner(transform.x, transform.y, transform.w, transform.h),
        shape,
        transform.w,
    );
    // Free placement wins over the corner when both axes are present; `sanitize` drops one
    // without the other.
    layout.x = Some(transform.x);
    layout.y = Some(transform.y);
    layout.sanitize();
    Some(layout)
}

/// Mirrors `nearestWebcamPlacement` (src/utils/clips.ts:94) exactly, so the corner the Clip tab
/// previews is the corner the editor snaps to.
pub fn nearest_corner(x: f32, y: f32, box_w: f32, box_h: f32) -> &'static str {
    let cx = x + box_w / 2.0;
    let cy = y + box_h / 2.0;
    let left = cx < 0.5;
    let top = cy < 0.5;
    match (top, left) {
        (true, true) => "top-left",
        (true, false) => "top-right",
        (false, true) => "bottom-left",
        (false, false) => "bottom-right",
    }
}

/// Where the HUD timestamp starts counting from.
///
/// Derived from the clip's own capture window, never from `SystemTime::now()` per frame — a
/// multi-minute burn would otherwise stamp the save time creeping forward instead of when the
/// footage was actually captured.
#[derive(Debug, Clone, Copy)]
pub struct ClipHudClock {
    /// Unix seconds at the clip's first frame.
    pub started_unix_secs: u64,
    /// Local-time offset captured by the Clips tab. 0 means UTC, matching `wall_clock_stamp`.
    pub tz_offset_minutes: i32,
}

/// What a Save Clip needs in order to burn overlays into the remuxed file.
pub struct ClipBurnPlan {
    pub composition: ValidatedComposition,
    pub hud_clock: ClipHudClock,
}

fn setting_str<'a>(source: &'a ClipSceneSource, key: &str) -> Option<&'a str> {
    source.settings.get(key).and_then(|value| value.as_str())
}

fn setting_bool(source: &ClipSceneSource, key: &str) -> bool {
    source
        .settings
        .get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn setting_f32(source: &ClipSceneSource, key: &str, fallback: f32) -> f32 {
    source
        .settings
        .get(key)
        .and_then(|value| value.as_f64())
        .map(|value| value as f32)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

/// Mirrors `NormRect::is_full` (recording_compositor/transforms.rs) and `isFullCrop`
/// (src/recording/scene.ts), so "unchanged" means the same thing on both sides of the boundary.
fn rect_is_full(rect: Option<ClipRect>) -> bool {
    match rect {
        None => true,
        Some(rect) => {
            rect.x <= 1e-4 && rect.y <= 1e-4 && rect.w >= 1.0 - 1e-4 && rect.h >= 1.0 - 1e-4
        }
    }
}

fn primary_capture(scene: &ClipScene) -> Option<&ClipSceneSource> {
    scene
        .sources
        .iter()
        .find(|source| source.enabled && (source.kind == KIND_GAME || source.kind == KIND_DISPLAY))
}

fn parse_filter(raw: Option<&str>) -> ComposedFilterId {
    match raw {
        Some("bodycam") => ComposedFilterId::Bodycam,
        Some("dashcam") => ComposedFilterId::Dashcam,
        Some("vhs") => ComposedFilterId::Vhs,
        Some("cinematic") => ComposedFilterId::Cinematic,
        _ => ComposedFilterId::None,
    }
}

/// The identity skip.
///
/// When this is false, Save Clip stays a pure bitstream-copy remux — byte-identical to what it
/// produced before the clip studio existed. Webcam never counts: it stays a sidecar so the editor
/// can keep moving it, so its presence alone must not trigger a re-encode.
pub fn needs_burn(scene: &ClipScene) -> bool {
    let has_burn_layer = scene.sources.iter().any(|source| {
        if !source.enabled {
            return false;
        }
        match source.kind.as_str() {
            KIND_IMAGE | KIND_TEXT => true,
            KIND_OVERLAY => {
                parse_filter(setting_str(source, "filter")) != ComposedFilterId::None
                    || setting_bool(source, "recIndicator")
                    || setting_bool(source, "timestamp")
            }
            _ => false,
        }
    });
    if has_burn_layer {
        return true;
    }
    match primary_capture(scene) {
        Some(capture) => !rect_is_full(capture.transform) || !rect_is_full(capture.crop),
        None => false,
    }
}

fn to_transform(rect: Option<ClipRect>, opacity: f32) -> CompositionTransform {
    let rect = rect.unwrap_or(ClipRect::FULL);
    CompositionTransform {
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        opacity,
    }
}

fn to_crop(rect: Option<ClipRect>) -> CompositionCrop {
    let rect = rect.unwrap_or(ClipRect::FULL);
    CompositionCrop {
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
    }
}

/// Build the burn plan for the active clip scene, or `None` when there is nothing to burn.
///
/// The composition is validated through the same `RecordingComposition::validate` the live
/// compositor uses, which gives source caps, id sanity, and path/text length limits for free.
/// Canvas is left at 0×0 so `native_canvas` is true: the clip keeps Instant Replay's real
/// resolution and frame rate instead of being clamped to validate()'s 24–60 fps / 4K ceiling.
pub fn burn_plan(settings: &AppSettings, started_unix_secs: u64) -> Option<ClipBurnPlan> {
    let scene = active_scene(settings)?;
    if !needs_burn(scene) {
        return None;
    }
    let capture = primary_capture(scene)?;

    let mut sources: Vec<CompositionSource> = Vec::with_capacity(scene.sources.len());
    sources.push(CompositionSource::Capture(
        crate::recording_compositor::scene::CaptureCompositionSource {
            id: capture.id.clone(),
            name: capture.name.clone(),
            capture: if capture.kind == KIND_DISPLAY {
                CaptureKind::Display
            } else {
                CaptureKind::Game
            },
            enabled: true,
            order: capture.order,
            transform: to_transform(capture.transform, 1.0),
            crop: to_crop(capture.crop),
            monitor_id: setting_str(capture, "monitorId").map(|value| value.to_string()),
        },
    ));

    let mut tz_offset_minutes = 0i32;
    for source in &scene.sources {
        if !source.enabled {
            continue;
        }
        match source.kind.as_str() {
            KIND_IMAGE => sources.push(CompositionSource::Image(ImageCompositionSource {
                id: source.id.clone(),
                name: source.name.clone(),
                enabled: true,
                order: source.order,
                transform: to_transform(source.transform, setting_f32(source, "opacity", 1.0)),
                crop: to_crop(source.crop),
                path: setting_str(source, "path").unwrap_or_default().to_string(),
                fit: Default::default(),
            })),
            KIND_TEXT => sources.push(CompositionSource::Text(TextCompositionSource {
                id: source.id.clone(),
                name: source.name.clone(),
                enabled: true,
                order: source.order,
                transform: to_transform(source.transform, 1.0),
                text: setting_str(source, "text").unwrap_or_default().to_string(),
                color: setting_str(source, "color").unwrap_or("#ffffff").to_string(),
                size: setting_f32(source, "size", 32.0).max(1.0) as u32,
                align: match setting_str(source, "align") {
                    Some("center") => TextAlign::Center,
                    Some("right") => TextAlign::Right,
                    _ => TextAlign::Left,
                },
            })),
            KIND_OVERLAY => {
                tz_offset_minutes = setting_f32(source, "tzOffsetMinutes", 0.0) as i32;
                sources.push(CompositionSource::ReplayrOverlay(OverlayCompositionSource {
                    id: source.id.clone(),
                    name: source.name.clone(),
                    enabled: true,
                    order: source.order,
                    filter: parse_filter(setting_str(source, "filter")),
                    rec_indicator: setting_bool(source, "recIndicator"),
                    timestamp: setting_bool(source, "timestamp"),
                }));
            }
            // Webcam is deliberately dropped: it stays a sidecar so the editor can still move it,
            // and share/upload compose it on top of whatever this burn produces.
            _ => {}
        }
    }

    let composition = RecordingComposition {
        canvas: CompositionCanvas {
            width: 0,
            height: 0,
            fps: 60,
        },
        audio: ComposedAudioRouting::default(),
        sources,
    };
    match composition.validate() {
        Ok(validated) => Some(ClipBurnPlan {
            composition: validated,
            hud_clock: ClipHudClock {
                started_unix_secs,
                tz_offset_minutes,
            },
        }),
        Err(error) => {
            tracing::warn!(%error, "clip scene failed validation; saving without overlays");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::ClipStudioSettings;

    fn source(id: &str, kind: &str) -> ClipSceneSource {
        ClipSceneSource {
            id: id.into(),
            kind: kind.into(),
            name: kind.into(),
            enabled: true,
            locked: false,
            order: 1,
            transform: None,
            crop: None,
            settings: serde_json::Map::new(),
        }
    }

    fn settings_with(sources: Vec<ClipSceneSource>) -> AppSettings {
        let mut settings = AppSettings::default();
        settings.clip_studio = ClipStudioSettings {
            version: 1,
            active_id: "scene-abc123".into(),
            scenes: vec![ClipScene {
                id: "scene-abc123".into(),
                name: "Clip".into(),
                sources,
            }],
        };
        settings
    }

    #[test]
    fn nearest_corner_matches_frontend() {
        // Same cases the editor's snap uses: the box centre picks the corner.
        assert_eq!(nearest_corner(0.03, 0.03, 0.22, 0.124), "top-left");
        assert_eq!(nearest_corner(0.75, 0.03, 0.22, 0.124), "top-right");
        assert_eq!(nearest_corner(0.03, 0.85, 0.22, 0.124), "bottom-left");
        assert_eq!(nearest_corner(0.75, 0.85, 0.22, 0.124), "bottom-right");
        // Dead centre falls to bottom-right, matching the frontend's final `return`.
        assert_eq!(nearest_corner(0.4, 0.4, 0.2, 0.2), "bottom-right");
    }

    #[test]
    fn no_clip_scene_falls_back_to_settings() {
        let settings = AppSettings::default();
        assert!(
            webcam_layout(&settings).is_none(),
            "no clip scene must leave the Settings-based layout fallback in charge"
        );
        assert!(!webcam_enabled(&settings));
    }

    #[test]
    fn webcam_disabled_yields_no_layout() {
        let mut webcam = source("webcam-1", "webcam");
        webcam.enabled = false;
        webcam.transform = Some(ClipRect {
            x: 0.03,
            y: 0.03,
            w: 0.22,
            h: 0.124,
        });
        let settings = settings_with(vec![source("game-1", "game"), webcam]);
        assert!(webcam_layout(&settings).is_none());
        assert!(!webcam_enabled(&settings), "no sidecar for this save");
    }

    #[test]
    fn webcam_layout_carries_corner_shape_and_free_position() {
        let mut webcam = source("webcam-1", "webcam");
        webcam.transform = Some(ClipRect {
            x: 0.71,
            y: 0.03,
            w: 0.26,
            h: 0.146,
        });
        webcam
            .settings
            .insert("shape".into(), serde_json::Value::String("circle".into()));
        let settings = settings_with(vec![source("game-1", "game"), webcam]);

        let layout = webcam_layout(&settings).expect("an enabled webcam yields a layout");
        assert_eq!(layout.placement, "top-right");
        assert_eq!(layout.shape, "circle");
        assert_eq!(layout.width, 0.26);
        assert_eq!(layout.x, Some(0.71));
        assert_eq!(layout.y, Some(0.03));
        assert!(webcam_enabled(&settings));
    }

    fn scene_of(sources: Vec<ClipSceneSource>) -> ClipScene {
        ClipScene {
            id: "scene-abc123".into(),
            name: "Clip".into(),
            sources,
        }
    }

    #[test]
    fn identity_scene_skips_burn() {
        // Full-frame game only: Save Clip must stay a pure remux.
        let mut game = source("game-1", "game");
        game.transform = Some(ClipRect::FULL);
        game.crop = Some(ClipRect::FULL);
        assert!(!needs_burn(&scene_of(vec![game.clone()])));

        // A missing transform/crop means "unchanged", not "needs work".
        let bare = source("game-2", "game");
        assert!(!needs_burn(&scene_of(vec![bare])));

        // Webcam never triggers a burn: it stays a sidecar the editor can move.
        let mut webcam = source("webcam-1", "webcam");
        webcam.transform = Some(ClipRect { x: 0.7, y: 0.7, w: 0.22, h: 0.124 });
        assert!(!needs_burn(&scene_of(vec![game, webcam])));
    }

    #[test]
    fn cropped_or_moved_capture_needs_burn() {
        let mut cropped = source("game-1", "game");
        cropped.crop = Some(ClipRect { x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
        assert!(needs_burn(&scene_of(vec![cropped])));

        let mut moved = source("game-1", "game");
        moved.transform = Some(ClipRect { x: 0.1, y: 0.0, w: 0.8, h: 1.0 });
        assert!(needs_burn(&scene_of(vec![moved])));
    }

    #[test]
    fn image_and_text_sources_need_burn() {
        let game = source("game-1", "game");
        assert!(needs_burn(&scene_of(vec![game.clone(), source("image-1", "image")])));
        assert!(needs_burn(&scene_of(vec![game.clone(), source("text-1", "text")])));

        // A disabled layer is not a reason to re-encode.
        let mut off = source("image-1", "image");
        off.enabled = false;
        assert!(!needs_burn(&scene_of(vec![game, off])));
    }

    #[test]
    fn overlay_needs_burn_only_when_it_draws_something() {
        let game = source("game-1", "game");
        let bare = source("overlay-1", "replayrOverlay");
        assert!(
            !needs_burn(&scene_of(vec![game.clone(), bare])),
            "an overlay with no filter, REC or timestamp draws nothing"
        );

        for (key, value) in [
            ("filter", serde_json::Value::String("vhs".into())),
            ("recIndicator", serde_json::Value::Bool(true)),
            ("timestamp", serde_json::Value::Bool(true)),
        ] {
            let mut overlay = source("overlay-1", "replayrOverlay");
            overlay.settings.insert(key.into(), value);
            assert!(
                needs_burn(&scene_of(vec![game.clone(), overlay])),
                "{key} should require a burn"
            );
        }
    }

    #[test]
    fn burn_plan_strips_webcam_and_keeps_native_canvas() {
        let mut webcam = source("webcam-1", "webcam");
        webcam.transform = Some(ClipRect { x: 0.7, y: 0.7, w: 0.22, h: 0.124 });
        let mut image = source("image-1", "image");
        image.settings.insert("path".into(), serde_json::Value::String("C:/x.png".into()));
        let settings = settings_with(vec![source("game-1", "game"), webcam, image]);

        let plan = burn_plan(&settings, 1_700_000_000).expect("an image layer requires a burn");
        assert!(
            plan.composition.webcam.is_none(),
            "webcam must never be baked: it stays a sidecar for the editor"
        );
        assert!(
            plan.composition.native_canvas,
            "the burn keeps Instant Replay's real resolution rather than validate()'s ceiling"
        );
        assert_eq!(plan.hud_clock.started_unix_secs, 1_700_000_000);
    }

    #[test]
    fn burn_plan_is_none_for_an_identity_scene() {
        let settings = settings_with(vec![source("game-1", "game")]);
        assert!(burn_plan(&settings, 0).is_none(), "Save Clip must stay a pure remux");
    }

    #[test]
    fn webcam_layout_clamps_width_like_the_editor() {
        let mut webcam = source("webcam-1", "webcam");
        // Wider than OverlayLayout's 0.40 ceiling.
        webcam.transform = Some(ClipRect {
            x: 0.0,
            y: 0.0,
            w: 0.9,
            h: 0.5,
        });
        let settings = settings_with(vec![webcam]);
        let layout = webcam_layout(&settings).unwrap();
        assert_eq!(layout.width, 0.40);
        assert_eq!(
            layout.shape, "rounded",
            "a source with no shape takes the overlay default"
        );
    }
}
