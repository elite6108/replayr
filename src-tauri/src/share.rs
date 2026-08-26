use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::library;
#[cfg(windows)]
use crate::overlay::OverlayLayout;

/// How the file was handed off: native share UI, clipboard file drop, or Explorer.
pub fn share_clip(app: &AppHandle, local_id: Option<&str>, file_path: Option<&str>) -> AppResult<String> {
    let path = outgoing_media(app, local_id, file_path, None)?;
    share_file(app, &path.to_string_lossy())
}

pub fn export_clip(
    app: &AppHandle,
    local_id: Option<&str>,
    source: Option<&str>,
    dest: &str,
) -> AppResult<()> {
    if dest.trim().is_empty() {
        return Err(AppError::Message("Choose a download location.".into()));
    }
    outgoing_media(app, local_id, source, Some(Path::new(dest)))?;
    Ok(())
}

fn outgoing_media(
    app: &AppHandle,
    local_id: Option<&str>,
    file_path: Option<&str>,
    dest: Option<&Path>,
) -> AppResult<PathBuf> {
    let clip = if let Some(id) = local_id {
        let db = app.state::<crate::database::AppState>();
        let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        Some(library::get(&conn, id)?)
    } else {
        None
    };
    let gameplay = clip
        .as_ref()
        .map(|item| PathBuf::from(&item.file_path))
        .or_else(|| file_path.map(PathBuf::from))
        .ok_or_else(|| AppError::Message("Choose a clip to share.".into()))?;
    if !gameplay.exists() {
        return Err(AppError::Message("That file is no longer on disk.".into()));
    }

    #[cfg(windows)]
    {
        let fps = clip
            .as_ref()
            .and_then(|item| item.fps)
            .unwrap_or(60)
            .clamp(24, 60) as u32;
        let watermark = crate::export::should_watermark_exports(app) && is_mp4(&gameplay);
        if let Some(webcam) = clip.as_ref().and_then(library::valid_webcam_source) {
            let layout = OverlayLayout::from_json(webcam.layout_json.as_deref());
            let output = dest
                .map(|path| path.to_path_buf())
                .unwrap_or_else(|| composed_temp_path(&gameplay, &layout, watermark));
            let duration_hns = clip
                .as_ref()
                .and_then(|item| item.duration_ms)
                .unwrap_or(0)
                .saturating_mul(10_000);
            match crate::export::compose_webcam_mp4(
                &gameplay,
                Path::new(&webcam.file_path),
                &output,
                &layout,
                0,
                duration_hns,
                fps,
                watermark,
            ) {
                Ok(_) => return Ok(output),
                Err(err) => {
                    tracing::warn!(%err, "composed export failed; using gameplay file");
                    if dest.is_some() {
                        let _ = std::fs::remove_file(&output);
                    }
                }
            }
        }
        if let Some(dest) = dest {
            if watermark {
                crate::export::write_watermarked_mp4(&gameplay, dest, fps).map_err(AppError::Message)?;
            } else {
                library::export_copy(&gameplay.display().to_string(), &dest.display().to_string())?;
            }
            return Ok(dest.to_path_buf());
        }
        if watermark {
            return crate::export::watermarked_temp(&gameplay, fps).map_err(AppError::Message);
        }
        return Ok(gameplay);
    }

    #[cfg(not(windows))]
    {
        let _ = clip;
        if let Some(dest) = dest {
            library::export_copy(&gameplay.display().to_string(), &dest.display().to_string())?;
            return Ok(dest.to_path_buf());
        }
        Ok(gameplay)
    }
}

#[cfg(windows)]
fn is_mp4(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .eq_ignore_ascii_case("mp4")
}

#[cfg(windows)]
fn composed_temp_path(source: &Path, layout: &OverlayLayout, watermark: bool) -> PathBuf {
    let stem = source
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("clip");
    let width = (layout.width * 100.0).round() as u32;
    let kind = if watermark { "composed.watermark" } else { "composed" };
    source.with_file_name(format!(
        "{stem}.{}.{}.{}.{kind}.mp4",
        layout.placement, layout.shape, width
    ))
}

pub fn share_file(app: &AppHandle, file_path: &str) -> AppResult<String> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err(AppError::Message("That file is no longer on disk.".into()));
    }
    #[cfg(windows)]
    {
        if show_share_ui(app, path).is_ok() {
            return Ok("share".into());
        }
        if copy_file_drop(path).is_ok() {
            return Ok("clipboard".into());
        }
        library::reveal(file_path)?;
        Ok("folder".into())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        library::reveal(file_path)?;
        Ok("folder".into())
    }
}

#[cfg(windows)]
fn show_share_ui(app: &AppHandle, path: &Path) -> Result<(), String> {
    use windows::core::{Interface, HSTRING};
    use windows::ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager};
    use windows::Foundation::TypedEventHandler;
    use windows::Storage::{IStorageItem, StorageFile};
    use windows::Win32::System::WinRT::RoGetActivationFactory;
    use windows::Win32::UI::Shell::IDataTransferManagerInterop;
    use windows_collections::IIterable;

    let hwnd = app
        .get_webview_window("main")
        .ok_or_else(|| "No window to share from.".to_string())?
        .hwnd()
        .map_err(|err| err.to_string())?;

    let file_path = HSTRING::from(path.to_string_lossy().as_ref());
    let file = StorageFile::GetFileFromPathAsync(&file_path)
        .map_err(|err| err.to_string())?
        .get()
        .map_err(|err| err.to_string())?;
    let item: IStorageItem = file.cast().map_err(|err| err.to_string())?;
    let item = windows::core::AgileReference::new(&item).map_err(|err| err.to_string())?;
    let title = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Replayr clip")
        .to_string();

    let class = HSTRING::from("Windows.ApplicationModel.DataTransfer.DataTransferManager");
    let interop: IDataTransferManagerInterop =
        unsafe { RoGetActivationFactory(&class) }.map_err(|err| err.to_string())?;
    let manager: DataTransferManager = unsafe { interop.GetForWindow(hwnd) }.map_err(|err| err.to_string())?;

    let handler = TypedEventHandler::<DataTransferManager, DataRequestedEventArgs>::new(move |_, args| {
        let Some(args) = args.as_ref() else {
            return Ok(());
        };
        let item = item.resolve()?;
        let request = args.Request()?;
        let data = request.Data()?;
        data.Properties()?.SetTitle(&HSTRING::from(title.as_str()))?;
        let storage_items: IIterable<IStorageItem> = vec![Some(item)].into();
        data.SetStorageItemsReadOnly(&storage_items)?;
        Ok(())
    });
    let _token = manager.DataRequested(&handler).map_err(|err| err.to_string())?;
    unsafe {
        interop.ShowShareUIForWindow(hwnd).map_err(|err| err.to_string())?;
    }
    // DataRequested fires after this returns; keep the manager alive for the flyout.
    std::mem::forget(manager);
    Ok(())
}

#[cfg(windows)]
fn copy_file_drop(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT};

    const CF_HDROP: u32 = 15;

    #[repr(C)]
    struct Dropfiles {
        p_files: u32,
        x: i32,
        y: i32,
        nc: i32,
        wide: i32,
    }

    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    wide.push(0);
    let header = std::mem::size_of::<Dropfiles>();
    let bytes = header + wide.len() * 2;
    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes).map_err(|err| err.to_string())?;
        if handle.is_invalid() {
            return Err("Could not copy that clip.".into());
        }
        let locked = GlobalLock(handle);
        if locked.is_null() {
            return Err("Could not copy that clip.".into());
        }
        let header_ptr = locked.cast::<Dropfiles>();
        header_ptr.write(Dropfiles {
            p_files: header as u32,
            x: 0,
            y: 0,
            nc: 0,
            wide: 1,
        });
        std::ptr::copy_nonoverlapping(
            wide.as_ptr(),
            locked.cast::<u8>().add(header).cast::<u16>(),
            wide.len(),
        );
        let _ = GlobalUnlock(handle);
        OpenClipboard(None).map_err(|err| err.to_string())?;
        let _ = EmptyClipboard();
        let copied = SetClipboardData(CF_HDROP, Some(HANDLE(handle.0)));
        let _ = CloseClipboard();
        copied.map_err(|err| err.to_string())?;
    }
    Ok(())
}
