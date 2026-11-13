//! Camera hardware controls (exposure, focus, white balance, backlight, gain,
//! power line frequency) through the driver's IAMCameraControl and
//! IAMVideoProcAmp interfaces.
//!
//! Saved values live in a process-wide store. Every running camera session
//! holds a [`ControlFollower`] that re-applies them on its own media source
//! whenever the store changes, because some drivers reset properties when a
//! stream starts.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use serde::Serialize;

use crate::settings::CameraControlSetting;

type DeviceControls = BTreeMap<String, CameraControlSetting>;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CameraControlInfo {
    pub name: String,
    pub label: String,
    pub min: i32,
    pub max: i32,
    pub step: i32,
    pub default_value: i32,
    pub value: i32,
    pub auto: bool,
    pub auto_supported: bool,
}

#[derive(Default)]
struct Store {
    generation: AtomicU64,
    controls: Mutex<BTreeMap<String, DeviceControls>>,
    followers: Mutex<HashMap<String, usize>>,
}

static STORE: LazyLock<Store> = LazyLock::new(Store::default);

/// Replace the saved controls with the settings file's copy.
pub fn store_settings(controls: &BTreeMap<String, DeviceControls>) {
    let Ok(mut current) = STORE.controls.lock() else {
        return;
    };
    if *current == *controls {
        return;
    }
    *current = controls.clone();
    STORE.generation.fetch_add(1, Ordering::SeqCst);
}

/// Save one control for one device and wake every session following it.
pub fn store_one(device_id: &str, name: &str, setting: CameraControlSetting) {
    let Ok(mut current) = STORE.controls.lock() else {
        return;
    };
    current
        .entry(device_id.to_string())
        .or_default()
        .insert(name.to_string(), setting);
    STORE.generation.fetch_add(1, Ordering::SeqCst);
}

fn stored_for(device_id: &str) -> DeviceControls {
    STORE
        .controls
        .lock()
        .ok()
        .and_then(|current| current.get(device_id).cloned())
        .unwrap_or_default()
}

/// True while a running session is streaming from this camera.
pub fn has_follower(device_id: &str) -> bool {
    STORE
        .followers
        .lock()
        .map(|followers| followers.get(device_id).copied().unwrap_or(0) > 0)
        .unwrap_or(false)
}

/// Snap a requested value onto the driver's range and step.
pub fn snap_to_range(value: i32, min: i32, max: i32, step: i32) -> i32 {
    let (low, high) = if min <= max { (min, max) } else { (max, min) };
    let clamped = value.clamp(low, high);
    if step <= 1 {
        return clamped;
    }
    let offset = i64::from(clamped) - i64::from(low);
    let step = i64::from(step);
    let snapped = i64::from(low) + ((offset + step / 2) / step) * step;
    snapped.clamp(i64::from(low), i64::from(high)) as i32
}

/// Keeps one session's media source in line with the saved controls.
pub struct ControlFollower {
    device_id: String,
    seen: Option<u64>,
}

impl ControlFollower {
    pub fn new(device_id: &str) -> Self {
        if let Ok(mut followers) = STORE.followers.lock() {
            *followers.entry(device_id.to_string()).or_default() += 1;
        }
        Self {
            device_id: device_id.to_string(),
            seen: None,
        }
    }

    fn changed(&mut self) -> bool {
        let generation = STORE.generation.load(Ordering::SeqCst);
        if self.seen == Some(generation) {
            return false;
        }
        self.seen = Some(generation);
        true
    }
}

impl Drop for ControlFollower {
    fn drop(&mut self) {
        if let Ok(mut followers) = STORE.followers.lock() {
            if let Some(count) = followers.get_mut(&self.device_id) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    followers.remove(&self.device_id);
                }
            }
        }
    }
}

#[cfg(windows)]
pub use platform::{get_controls, set_control};

#[cfg(windows)]
mod platform {
    use std::time::Duration;

    use windows::core::Interface;
    use windows::Win32::Media::DirectShow::{
        IAMCameraControl, IAMVideoProcAmp, CameraControl_Exposure, CameraControl_Flags_Auto,
        CameraControl_Flags_Manual, CameraControl_Focus, VideoProcAmp_BacklightCompensation,
        VideoProcAmp_Flags_Auto, VideoProcAmp_Flags_Manual, VideoProcAmp_Gain, VideoProcAmp_WhiteBalance,
    };
    use windows::Win32::Media::MediaFoundation::IMFMediaSource;

    use super::super::device::{activate_source, ensure_com, ensure_mf, run_off_ui};
    use super::super::types::{is_camera_control_name, sanitize_device_id};
    use super::*;

    const CONTROL_TIMEOUT: Duration = Duration::from_secs(4);
    /// KSPROPERTY_VIDEOPROCAMP_POWERLINE_FREQUENCY: 0 off, 1 50 Hz, 2 60 Hz, 3 auto.
    const VIDEO_PROC_AMP_POWER_LINE: i32 = 13;

    #[derive(Clone, Copy)]
    enum Target {
        Camera(i32),
        ProcAmp(i32),
    }

    struct Spec {
        name: &'static str,
        label: &'static str,
        target: Target,
    }

    const SPECS: [Spec; 6] = [
        Spec { name: "exposure", label: "Exposure", target: Target::Camera(CameraControl_Exposure.0) },
        Spec { name: "focus", label: "Focus", target: Target::Camera(CameraControl_Focus.0) },
        Spec { name: "whiteBalance", label: "White balance", target: Target::ProcAmp(VideoProcAmp_WhiteBalance.0) },
        Spec {
            name: "backlight",
            label: "Backlight compensation",
            target: Target::ProcAmp(VideoProcAmp_BacklightCompensation.0),
        },
        Spec { name: "gain", label: "Gain", target: Target::ProcAmp(VideoProcAmp_Gain.0) },
        Spec {
            name: "powerLine",
            label: "Anti-flicker",
            target: Target::ProcAmp(VIDEO_PROC_AMP_POWER_LINE),
        },
    ];

    struct Handles {
        camera: Option<IAMCameraControl>,
        proc_amp: Option<IAMVideoProcAmp>,
    }

    impl Handles {
        fn from(source: &IMFMediaSource) -> Self {
            Self {
                camera: source.cast::<IAMCameraControl>().ok(),
                proc_amp: source.cast::<IAMVideoProcAmp>().ok(),
            }
        }
    }

    struct Range {
        min: i32,
        max: i32,
        step: i32,
        default: i32,
        auto_supported: bool,
    }

    fn range(handles: &Handles, target: Target) -> Option<Range> {
        let (mut min, mut max, mut step, mut default, mut caps) = (0, 0, 0, 0, 0);
        let ok = unsafe {
            match target {
                Target::Camera(prop) => handles
                    .camera
                    .as_ref()?
                    .GetRange(prop, &mut min, &mut max, &mut step, &mut default, &mut caps)
                    .is_ok(),
                Target::ProcAmp(prop) => handles
                    .proc_amp
                    .as_ref()?
                    .GetRange(prop, &mut min, &mut max, &mut step, &mut default, &mut caps)
                    .is_ok(),
            }
        };
        if !ok || min >= max {
            return None;
        }
        let auto_flag = match target {
            Target::Camera(_) => CameraControl_Flags_Auto.0,
            Target::ProcAmp(_) => VideoProcAmp_Flags_Auto.0,
        };
        Some(Range {
            min,
            max,
            step: step.max(1),
            default,
            auto_supported: caps & auto_flag != 0,
        })
    }

    fn current(handles: &Handles, target: Target) -> Option<(i32, i32)> {
        let (mut value, mut flags) = (0, 0);
        let ok = unsafe {
            match target {
                Target::Camera(prop) => handles.camera.as_ref()?.Get(prop, &mut value, &mut flags).is_ok(),
                Target::ProcAmp(prop) => handles.proc_amp.as_ref()?.Get(prop, &mut value, &mut flags).is_ok(),
            }
        };
        ok.then_some((value, flags))
    }

    fn write(handles: &Handles, spec: &Spec, setting: CameraControlSetting) -> Result<(), String> {
        let range = range(handles, spec.target).ok_or_else(|| format!("This camera has no {} control.", spec.label))?;
        let value = snap_to_range(setting.value, range.min, range.max, range.step);
        let auto = setting.auto && range.auto_supported;
        let result = unsafe {
            match spec.target {
                Target::Camera(prop) => {
                    let flags = if auto { CameraControl_Flags_Auto.0 } else { CameraControl_Flags_Manual.0 };
                    handles.camera.as_ref().map(|camera| camera.Set(prop, value, flags))
                }
                Target::ProcAmp(prop) => {
                    let flags = if auto { VideoProcAmp_Flags_Auto.0 } else { VideoProcAmp_Flags_Manual.0 };
                    handles.proc_amp.as_ref().map(|amp| amp.Set(prop, value, flags))
                }
            }
        };
        match result {
            Some(Ok(())) => Ok(()),
            Some(Err(err)) => Err(format!("The camera rejected that {} value. {}", spec.label, err.message())),
            None => Err(format!("This camera has no {} control.", spec.label)),
        }
    }

    fn read_all(source: &IMFMediaSource) -> Vec<CameraControlInfo> {
        let handles = Handles::from(source);
        SPECS
            .iter()
            .filter_map(|spec| {
                let range = range(&handles, spec.target)?;
                let (value, flags) = current(&handles, spec.target).unwrap_or((range.default, 0));
                let power_line = spec.name == "powerLine";
                let auto_flag = match spec.target {
                    Target::Camera(_) => CameraControl_Flags_Auto.0,
                    Target::ProcAmp(_) => VideoProcAmp_Flags_Auto.0,
                };
                Some(CameraControlInfo {
                    name: spec.name.into(),
                    label: spec.label.into(),
                    min: range.min,
                    max: range.max,
                    step: range.step,
                    default_value: range.default,
                    value,
                    auto: !power_line && range.auto_supported && flags & auto_flag != 0,
                    auto_supported: !power_line && range.auto_supported,
                })
            })
            .collect()
    }

    fn apply_all(source: &IMFMediaSource, controls: &DeviceControls) {
        if controls.is_empty() {
            return;
        }
        let handles = Handles::from(source);
        for spec in &SPECS {
            let Some(setting) = controls.get(spec.name) else {
                continue;
            };
            if let Err(err) = write(&handles, spec, *setting) {
                tracing::debug!(control = spec.name, %err, "camera control not applied");
            }
        }
    }

    impl ControlFollower {
        /// Apply the saved controls when they changed since the last call.
        /// Cheap when nothing changed, so sessions call it once per frame.
        pub fn sync(&mut self, source: &IMFMediaSource) {
            if self.changed() {
                apply_all(source, &stored_for(&self.device_id));
            }
        }
    }

    fn with_source<T>(device_id: &str, work: impl FnOnce(&IMFMediaSource) -> Result<T, String>) -> Result<T, String> {
        ensure_com()?;
        ensure_mf()?;
        let source = unsafe { activate_source(device_id)? };
        let result = work(&source);
        let _ = unsafe { source.Shutdown() };
        result
    }

    pub fn get_controls(device_id: &str) -> Result<Vec<CameraControlInfo>, String> {
        let id = sanitize_device_id(device_id)?;
        if id.is_empty() {
            return Ok(Vec::new());
        }
        run_off_ui("camera-controls", CONTROL_TIMEOUT, move || {
            with_source(&id, |source| Ok(read_all(source)))
        })
    }

    pub fn set_control(device_id: &str, name: &str, value: i32, auto: bool) -> Result<(), String> {
        let id = sanitize_device_id(device_id)?;
        if id.is_empty() {
            return Err("Choose a camera first.".into());
        }
        if !is_camera_control_name(name) {
            return Err("That camera control is not supported.".into());
        }
        let setting = CameraControlSetting { value, auto };
        store_one(&id, name, setting);
        let spec_name = name.to_string();
        let direct = {
            let id = id.clone();
            run_off_ui("camera-control-set", CONTROL_TIMEOUT, move || {
                with_source(&id, |source| {
                    let handles = Handles::from(source);
                    let spec = SPECS
                        .iter()
                        .find(|spec| spec.name == spec_name)
                        .ok_or_else(|| "That camera control is not supported.".to_string())?;
                    write(&handles, spec, setting)
                })
            })
        };
        match direct {
            Ok(()) => Ok(()),
            // A running session re-applies the stored value on its own source.
            Err(err) if has_follower(&id) => {
                tracing::debug!(%err, "camera control will be applied by the running session");
                Ok(())
            }
            Err(err) => Err(err),
        }
    }
}

#[cfg(not(windows))]
pub fn get_controls(_device_id: &str) -> Result<Vec<CameraControlInfo>, String> {
    Ok(Vec::new())
}

#[cfg(not(windows))]
pub fn set_control(_device_id: &str, _name: &str, _value: i32, _auto: bool) -> Result<(), String> {
    Err("Camera controls are available on Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snap_clamps_and_rounds_to_step() {
        assert_eq!(snap_to_range(50, 0, 255, 1), 50);
        assert_eq!(snap_to_range(-10, 0, 255, 1), 0);
        assert_eq!(snap_to_range(999, 0, 255, 1), 255);
        assert_eq!(snap_to_range(2804, 2800, 6500, 10), 2800);
        assert_eq!(snap_to_range(2806, 2800, 6500, 10), 2810);
        assert_eq!(snap_to_range(-6, -11, -2, 1), -6);
        assert_eq!(snap_to_range(-5, -11, -2, 3), -5);
        assert_eq!(snap_to_range(7, 10, 0, 1), 7);
    }

    #[test]
    fn follower_sees_each_store_change_once() {
        let device = "test-follower-device";
        let mut follower = ControlFollower::new(device);
        assert!(has_follower(device));
        assert!(follower.changed());
        assert!(!follower.changed());
        store_one(device, "gain", CameraControlSetting { value: 4, auto: false });
        assert!(follower.changed());
        assert!(!follower.changed());
        assert_eq!(stored_for(device).get("gain").map(|s| s.value), Some(4));
        drop(follower);
        assert!(!has_follower(device));
    }
}
