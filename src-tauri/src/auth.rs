use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use keyring::Entry;
use tauri::{AppHandle, Manager};

use crate::branding::KEYRING_SERVICE;
use crate::error::{AppError, AppResult};

const KEYRING_READ_TIMEOUT: Duration = Duration::from_millis(1500);

/// Windows Credential Manager rejects blobs over 2560 bytes and can hang or
/// error on leftover oversized entries. The session lives in a DPAPI-protected
/// file; keyring is migration-only and must never fail a sign-in.
pub fn get_item(app: &AppHandle, key: &str) -> AppResult<Option<String>> {
    let path = store_path(app, key)?;
    if path.exists() {
        match std::fs::read(&path)
            .map_err(AppError::from)
            .and_then(|bytes| unprotect_string(&bytes))
        {
            Ok(value) => return Ok(Some(value)),
            Err(err) => {
                tracing::warn!("auth session file was unreadable and will be reset: {err}");
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    if let Some(value) = keyring_get_timed(key) {
        if let Err(err) = set_item(app, key, &value) {
            tracing::warn!("could not migrate auth item off the keyring: {err}");
            return Ok(Some(value));
        }
        return Ok(Some(value));
    }
    Ok(None)
}

pub fn set_item(app: &AppHandle, key: &str, value: &str) -> AppResult<()> {
    let path = store_path(app, key)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let protected = protect_string(value)?;
    std::fs::write(&path, protected)?;
    keyring_remove_bg(key);
    Ok(())
}

pub fn remove_item(app: &AppHandle, key: &str) -> AppResult<()> {
    let path = store_path(app, key)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    keyring_remove_bg(key);
    Ok(())
}

fn store_path(app: &AppHandle, key: &str) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| AppError::Message(err.to_string()))?
        .join("auth");
    Ok(dir.join(format!("{}.bin", safe_key(key)?)))
}

fn safe_key(key: &str) -> AppResult<String> {
    if key.is_empty()
        || key.len() > 128
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(AppError::Message("Invalid auth storage key.".into()));
    }
    Ok(key.to_string())
}

fn keyring_get(key: &str) -> AppResult<Option<String>> {
    let entry = Entry::new(KEYRING_SERVICE, key)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn keyring_get_timed(key: &str) -> Option<String> {
    let key = key.to_string();
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("auth-keyring-read".into())
        .spawn(move || {
            let _ = tx.send(keyring_get(&key));
        });
    if let Err(err) = spawned {
        tracing::warn!("could not start legacy keyring read: {err}");
        return None;
    }
    match rx.recv_timeout(KEYRING_READ_TIMEOUT) {
        Ok(Ok(value)) => value,
        Ok(Err(err)) => {
            tracing::warn!("legacy keyring auth item could not be read: {err}");
            None
        }
        Err(_) => {
            tracing::warn!("legacy keyring auth item timed out; using the DPAPI store");
            None
        }
    }
}

fn keyring_remove(key: &str) -> AppResult<()> {
    let entry = Entry::new(KEYRING_SERVICE, key)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.into()),
    }
}

fn keyring_remove_bg(key: &str) {
    let key = key.to_string();
    let _ = std::thread::Builder::new()
        .name("auth-keyring-cleanup".into())
        .spawn(move || {
            if let Err(err) = keyring_remove(&key) {
                tracing::warn!("could not remove legacy keyring auth item: {err}");
            }
        });
}

fn protect_string(value: &str) -> AppResult<Vec<u8>> {
    protect(value.as_bytes())
}

fn unprotect_string(bytes: &[u8]) -> AppResult<String> {
    let plain = unprotect(bytes)?;
    String::from_utf8(plain).map_err(|err| AppError::Message(err.to_string()))
}

#[cfg(windows)]
fn protect(bytes: &[u8]) -> AppResult<Vec<u8>> {
    dpapi_protect(bytes)
}

#[cfg(windows)]
fn unprotect(bytes: &[u8]) -> AppResult<Vec<u8>> {
    dpapi_unprotect(bytes)
}

#[cfg(not(windows))]
fn protect(bytes: &[u8]) -> AppResult<Vec<u8>> {
    Ok(bytes.to_vec())
}

#[cfg(not(windows))]
fn unprotect(bytes: &[u8]) -> AppResult<Vec<u8>> {
    Ok(bytes.to_vec())
}

#[cfg(windows)]
fn dpapi_protect(bytes: &[u8]) -> AppResult<Vec<u8>> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(|err| AppError::Message(err.to_string()))?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let descr: Vec<u16> = KEYRING_SERVICE.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR(descr.as_ptr()),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|err| AppError::Message(format!("Could not protect the auth session: {err}")))?;
        let copied = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        if !output.pbData.is_null() {
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        }
        Ok(copied)
    }
}

#[cfg(windows)]
fn dpapi_unprotect(bytes: &[u8]) -> AppResult<Vec<u8>> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(|err| AppError::Message(err.to_string()))?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|err| AppError::Message(format!("Could not read the auth session: {err}")))?;
        let copied = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        if !output.pbData.is_null() {
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        }
        Ok(copied)
    }
}

#[cfg(test)]
mod tests {
    use super::safe_key;

    #[test]
    fn accepts_supabase_storage_keys() {
        assert_eq!(
            safe_key("tv.elite.replay.auth").unwrap(),
            "tv.elite.replay.auth"
        );
        assert_eq!(
            safe_key("tv.elite.replay.auth-code-verifier").unwrap(),
            "tv.elite.replay.auth-code-verifier"
        );
        assert_eq!(
            safe_key("tv.elite.replay.auth-flows-code-verifier").unwrap(),
            "tv.elite.replay.auth-flows-code-verifier"
        );
        let flow = format!(
            "tv.elite.replay.auth-flow-{}-code-verifier",
            "a".repeat(32)
        );
        assert_eq!(safe_key(&flow).unwrap(), flow);
    }

    #[test]
    fn rejects_path_characters() {
        assert!(safe_key("../secrets").is_err());
        assert!(safe_key("a/b").is_err());
        assert!(safe_key("").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip() {
        let secret = "x".repeat(8000);
        let protected = super::protect_string(&secret).unwrap();
        assert_ne!(protected, secret.as_bytes());
        assert_eq!(super::unprotect_string(&protected).unwrap(), secret);
    }
}
