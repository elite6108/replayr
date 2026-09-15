//! Writing screenshots and share links to the Windows clipboard from Rust.
//!
//! This runs in Rust rather than through `navigator.clipboard` because a screenshot is usually
//! taken while a game has focus and Replayr is hidden in the tray, and WebView2 only grants
//! clipboard writes to a focused document.

use crate::still::StillFrame;

const BITMAPINFOHEADER_SIZE: usize = 40;

/// Build a `CF_DIB` payload: a BITMAPINFOHEADER followed by 32-bit BGRA rows, bottom-up.
///
/// Bottom-up with a positive height is the layout every paste target understands; top-down
/// DIBs are legal but several apps render them upside down. Alpha is forced opaque so nothing
/// pastes as transparent.
pub fn build_dib(frame: &StillFrame) -> Result<Vec<u8>, String> {
    let (width, height) = (frame.width as usize, frame.height as usize);
    let row_bytes = width
        .checked_mul(4)
        .ok_or_else(|| "The screenshot is too large to copy.".to_string())?;
    let pixel_bytes = row_bytes
        .checked_mul(height)
        .ok_or_else(|| "The screenshot is too large to copy.".to_string())?;
    let pitch = (frame.pitch as usize).max(row_bytes);
    if width == 0 || height == 0 || frame.bgra.len() < pitch * (height - 1) + row_bytes {
        return Err("The screenshot frame was incomplete.".into());
    }
    let image_size =
        u32::try_from(pixel_bytes).map_err(|_| "The screenshot is too large to copy.".to_string())?;

    let mut out = Vec::with_capacity(BITMAPINFOHEADER_SIZE + pixel_bytes);
    out.extend_from_slice(&(BITMAPINFOHEADER_SIZE as u32).to_le_bytes()); // biSize
    out.extend_from_slice(&(frame.width as i32).to_le_bytes()); // biWidth
    out.extend_from_slice(&(frame.height as i32).to_le_bytes()); // biHeight (positive: bottom-up)
    out.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    out.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    out.extend_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
    out.extend_from_slice(&image_size.to_le_bytes()); // biSizeImage
    out.extend_from_slice(&0i32.to_le_bytes()); // biXPelsPerMeter
    out.extend_from_slice(&0i32.to_le_bytes()); // biYPelsPerMeter
    out.extend_from_slice(&0u32.to_le_bytes()); // biClrUsed
    out.extend_from_slice(&0u32.to_le_bytes()); // biClrImportant

    for row in (0..height).rev() {
        let start = row * pitch;
        for pixel in frame.bgra[start..start + row_bytes].chunks_exact(4) {
            out.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 0xFF]);
        }
    }
    Ok(out)
}

/// A UTF-16, NUL-terminated `CF_UNICODETEXT` payload.
pub fn utf16_payload(text: &str) -> Vec<u8> {
    text.encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(|unit| unit.to_le_bytes())
        .collect()
}

#[cfg(windows)]
pub use windows_impl::{set_image, set_text};

#[cfg(windows)]
mod windows_impl {
    use std::time::Duration;

    use windows::core::w;
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    use crate::still::StillFrame;

    const CF_DIB: u32 = 8;
    const CF_UNICODETEXT: u32 = 13;
    /// Another app may hold the clipboard for a moment (clipboard managers, remote desktop).
    const OPEN_ATTEMPTS: u32 = 10;
    const OPEN_RETRY: Duration = Duration::from_millis(25);

    /// Replace the clipboard with a text string.
    pub fn set_text(text: &str) -> Result<(), String> {
        write(&[(CF_UNICODETEXT, super::utf16_payload(text))])
    }

    /// Replace the clipboard with an image, offered both as a DIB and as PNG bytes.
    ///
    /// Offering PNG as well keeps full fidelity in apps that read it (Discord, Chrome, Slack);
    /// the DIB covers everything else (Paint, Word, older apps).
    pub fn set_image(frame: &StillFrame, png: &[u8]) -> Result<(), String> {
        let dib = super::build_dib(frame)?;
        let png_format = unsafe { RegisterClipboardFormatW(w!("PNG")) };
        let mut entries = vec![(CF_DIB, dib)];
        if png_format != 0 {
            entries.push((png_format, png.to_vec()));
        }
        write(&entries)
    }

    fn write(entries: &[(u32, Vec<u8>)]) -> Result<(), String> {
        open_with_retry()?;
        let _guard = CloseOnDrop;
        unsafe { EmptyClipboard() }.map_err(|err| format!("Could not clear the clipboard: {err}"))?;
        for (format, bytes) in entries {
            let handle = alloc_filled(bytes)?;
            if let Err(err) = unsafe { SetClipboardData(*format, Some(HANDLE(handle.0))) } {
                // Ownership only passes to the system on success; free it ourselves otherwise.
                let _ = unsafe { GlobalFree(Some(handle)) };
                return Err(format!("Could not copy to the clipboard: {err}"));
            }
        }
        Ok(())
    }

    fn open_with_retry() -> Result<(), String> {
        let mut last = String::new();
        for attempt in 0..OPEN_ATTEMPTS {
            match unsafe { OpenClipboard(None) } {
                Ok(()) => return Ok(()),
                Err(err) => last = err.to_string(),
            }
            if attempt + 1 < OPEN_ATTEMPTS {
                std::thread::sleep(OPEN_RETRY);
            }
        }
        Err(format!("The clipboard is busy: {last}"))
    }

    fn alloc_filled(bytes: &[u8]) -> Result<HGLOBAL, String> {
        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)) }
            .map_err(|err| format!("Could not allocate clipboard memory: {err}"))?;
        let locked = unsafe { GlobalLock(handle) };
        if locked.is_null() {
            let _ = unsafe { GlobalFree(Some(handle)) };
            return Err("Could not lock clipboard memory.".into());
        }
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), locked.cast::<u8>(), bytes.len());
            let _ = GlobalUnlock(handle);
        }
        Ok(handle)
    }

    struct CloseOnDrop;

    impl Drop for CloseOnDrop {
        fn drop(&mut self) {
            let _ = unsafe { CloseClipboard() };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dib_header_describes_a_bottom_up_32bpp_bitmap() {
        let frame = StillFrame { bgra: vec![0; 3 * 2 * 4], width: 3, height: 2, pitch: 12 };
        let dib = build_dib(&frame).unwrap();
        let u32_at = |at: usize| u32::from_le_bytes(dib[at..at + 4].try_into().unwrap());
        let i32_at = |at: usize| i32::from_le_bytes(dib[at..at + 4].try_into().unwrap());
        let u16_at = |at: usize| u16::from_le_bytes(dib[at..at + 2].try_into().unwrap());
        assert_eq!(u32_at(0), 40, "biSize");
        assert_eq!(i32_at(4), 3, "biWidth");
        assert_eq!(i32_at(8), 2, "positive height means bottom-up");
        assert_eq!(u16_at(12), 1, "biPlanes");
        assert_eq!(u16_at(14), 32, "biBitCount");
        assert_eq!(u32_at(16), 0, "BI_RGB");
        assert_eq!(u32_at(20), 24, "biSizeImage");
        assert_eq!(dib.len(), 40 + 24);
    }

    #[test]
    fn dib_rows_are_flipped_and_alpha_is_opaque() {
        // Top row blue-ish with zero alpha, bottom row red-ish.
        let mut bgra = Vec::new();
        bgra.extend_from_slice(&[1, 2, 3, 0]);
        bgra.extend_from_slice(&[9, 8, 7, 0]);
        let frame = StillFrame { bgra, width: 1, height: 2, pitch: 4 };
        let dib = build_dib(&frame).unwrap();
        // First stored row is the image's bottom row.
        assert_eq!(&dib[40..44], &[9, 8, 7, 0xFF]);
        assert_eq!(&dib[44..48], &[1, 2, 3, 0xFF]);
    }

    #[test]
    fn dib_honours_row_padding() {
        let frame = StillFrame {
            bgra: vec![1, 1, 1, 1, 0xEE, 0xEE, 2, 2, 2, 2, 0xEE, 0xEE],
            width: 1,
            height: 2,
            pitch: 6,
        };
        let dib = build_dib(&frame).unwrap();
        assert_eq!(&dib[40..44], &[2, 2, 2, 0xFF]);
        assert_eq!(&dib[44..48], &[1, 1, 1, 0xFF]);
    }

    #[test]
    fn dib_rejects_an_incomplete_frame() {
        let frame = StillFrame { bgra: vec![0; 4], width: 2, height: 2, pitch: 8 };
        assert!(build_dib(&frame).is_err());
    }

    #[test]
    fn text_payload_is_nul_terminated_utf16() {
        assert_eq!(utf16_payload("hi"), vec![b'h', 0, b'i', 0, 0, 0]);
    }
}
