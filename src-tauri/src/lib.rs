#[cfg(windows)]
mod audio;
#[cfg(windows)]
mod audio_capture;
mod audio_resolve;
#[cfg(windows)]
mod audio_timeline;
#[cfg(windows)]
mod encode;
#[cfg(windows)]
mod encode_pump;
#[cfg(windows)]
mod export;
#[cfg(windows)]
mod thumb;
mod auth;
mod branding;
mod buffer;
mod capture;
mod commands;
mod database;
mod detection;
mod disk;
mod editor;
mod error;
mod games;
mod hotkeys;
mod library;
mod overlay_notification;
mod process;
#[cfg(windows)]
mod process_loopback;
mod settings;
mod shortcut;
mod share;
mod still;
mod system;
mod upload;

use database::AppState;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tracing_subscriber::EnvFilter;

fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    tracing::info!("{} ({}) starting", branding::APP_NAME, branding::APP_IDENTIFIER);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let urls: Vec<String> = args
                .into_iter()
                .filter(|arg| arg.starts_with("replayr://"))
                .collect();
            if !urls.is_empty() {
                let _ = app.emit("oauth-callback-url", urls);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    crate::hotkeys::handle(app, shortcut, event);
                })
                .build(),
        )
        .setup(|app| {
            let conn = database::open_for_app(app.handle()).map_err(|err| err.to_string())?;
            app.manage(AppState { db: Mutex::new(conn) });
            app.manage(detection::DetectionState::default());
            app.manage(capture::RecordingState::default());
            app.manage(hotkeys::HotkeyMap::default());
            #[cfg(windows)]
            {
                app.manage(crate::audio::AudioRuntime::new());
                let runtime = app.state::<crate::audio::AudioRuntime>();
                runtime.bind(app.handle().clone());
                let handle = app.handle().clone();
                std::thread::Builder::new()
                    .name("audio-apply".into())
                    .spawn(move || {
                        let loaded = {
                            let db = handle.state::<AppState>();
                            db.db
                                .lock()
                                .ok()
                                .and_then(|conn| crate::settings::load(&conn).ok())
                        };
                        if let Some(settings) = loaded {
                            handle.state::<crate::audio::AudioRuntime>().apply(&settings);
                        }
                    })
                    .ok();
            }
            {
                let state = app.state::<AppState>();
                let reset = state
                    .db
                    .lock()
                    .ok()
                    .and_then(|conn| crate::library::reset_stale_uploads(&conn).ok());
                if let Some(ids) = reset {
                    if !ids.is_empty() {
                        tracing::info!("reset {} interrupted cloud upload(s)", ids.len());
                    }
                }
            }
            system::setup_tray(app.handle()).map_err(|err| err.to_string())?;
            crate::overlay_notification::prepare(app.handle());
            detection::start(app.handle().clone());
            hotkeys::sync(app.handle()).map_err(|err| err.to_string())?;
            {
                let handle = app.handle().clone();
                let _ = std::thread::Builder::new()
                    .name("sync-replay".into())
                    .spawn(move || {
                        let rec = handle.state::<capture::RecordingState>();
                        if let Err(err) = capture::sync_replay(&handle, &rec, None, None, None) {
                            tracing::warn!("instant replay did not start: {err}");
                        }
                    });
            }
            if let Err(err) = app.deep_link().register("replayr") {
                tracing::warn!("could not register replayr:// handler: {err}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }
                let close_to_tray = {
                    let state = window.state::<AppState>();
                    let close = match state.db.lock() {
                        Ok(conn) => crate::settings::load(&conn)
                            .map(|settings| settings.close_to_tray)
                            .unwrap_or(true),
                        Err(_) => true,
                    };
                    close
                };
                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_all_settings,
            commands::set_setting,
            commands::set_settings,
            commands::list_audio_devices,
            commands::list_audio_sessions,
            commands::get_audio_status,
            commands::add_extra_audio_app,
            commands::get_mic_level,
            commands::stop_mic_monitor,
            commands::resolve_mic_disconnect,
            commands::list_local_clips,
            commands::reset_stale_uploads,
            commands::save_trimmed_clip,
            commands::save_short_clip,
            commands::list_clip_filmstrip,
            commands::set_clip_editor_crop,
            commands::rename_local_clip,
            commands::set_local_clip_favorite,
            commands::delete_local_clip,
            commands::reveal_local_clip,
            commands::share_local_clip,
            commands::export_local_clip,
            commands::download_url_to_file,
            commands::get_default_save_location,
            commands::auth_get_item,
            commands::auth_set_item,
            commands::auth_remove_item,
            commands::list_games,
            commands::sync_games,
            commands::get_detected_game,
            commands::start_recording,
            commands::stop_recording,
            commands::get_recording_status,
            commands::get_replay_status,
            commands::save_clip,
            commands::save_screenshot,
            commands::upload_local_clip,
            commands::delete_cloud_clip,
            commands::create_desktop_shortcut,
            commands::remove_desktop_shortcut,
            commands::desktop_shortcut_exists
        ])
        .run(tauri::generate_context!())
        .expect("error while running Project Replay");
}
