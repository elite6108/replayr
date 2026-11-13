//! Rules for a browser source. The address is untrusted. Only a normal https
//! page, or http on this computer, is allowed. The page never gets Tauri,
//! files, or a second window.

const MAX_URL_CHARS: usize = 2048;

pub fn sanitize_page_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_URL_CHARS {
        return Err("Enter a page address to record.".into());
    }
    if trimmed.chars().any(|ch| ch.is_control() || ch == ' ' || ch == '\\') {
        return Err("That page address is not allowed.".into());
    }
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return Err("That page address is not allowed.".into());
    };
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return Err("Browser sources can open https pages only.".into());
    }
    if rest.starts_with('/') || rest.contains('@') {
        return Err("That page address is not allowed.".into());
    }
    let (authority, path) = split_authority(rest);
    let host = host_only(authority)?;
    if host.is_empty() || host.contains('*') {
        return Err("That page address is not allowed.".into());
    }
    let local = is_loopback(&host);
    if scheme == "http" && !local {
        return Err("Browser sources can open http only on this computer.".into());
    }
    if path.starts_with("//") {
        return Err("That page address is not allowed.".into());
    }
    let path = if path.is_empty() { "/" } else { path };
    Ok(format!("{scheme}://{host}{path}"))
}

/// A navigation stays on the page that was opened. A new host, a file, or a
/// script address is cancelled.
pub fn navigation_allowed(start: &str, next: &str) -> bool {
    let Ok(start) = sanitize_page_url(start) else {
        return false;
    };
    let Ok(next) = sanitize_page_url(next) else {
        return false;
    };
    host_of(&start) == host_of(&next) && scheme_of(&start) == scheme_of(&next)
}

fn split_authority(rest: &str) -> (&str, &str) {
    match rest.find(['/', '?', '#']) {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    }
}

fn host_only(authority: &str) -> Result<String, String> {
    if authority.is_empty() || authority.contains('@') {
        return Err("That page address is not allowed.".into());
    }
    if let Some(inside) = authority.strip_prefix('[') {
        let end = inside
            .find(']')
            .ok_or_else(|| "That page address is not allowed.".to_string())?;
        let rest = &inside[end + 1..];
        if !rest.is_empty() && !port_suffix(rest) {
            return Err("That page address is not allowed.".into());
        }
        return Ok(format!("[{}]{rest}", &inside[..end]).to_ascii_lowercase());
    }
    let mut parts = authority.split(':');
    let host = parts.next().unwrap_or("");
    let port = parts.next();
    if host.is_empty() || parts.next().is_some() {
        return Err("That page address is not allowed.".into());
    }
    if let Some(port) = port {
        if !port.chars().all(|ch| ch.is_ascii_digit()) || port.is_empty() {
            return Err("That page address is not allowed.".into());
        }
        return Ok(format!("{}:{port}", host.to_ascii_lowercase()));
    }
    Ok(host.to_ascii_lowercase())
}

fn port_suffix(rest: &str) -> bool {
    rest.starts_with(':') && rest.len() > 1 && rest[1..].chars().all(|ch| ch.is_ascii_digit())
}

fn is_loopback(authority: &str) -> bool {
    if authority.starts_with("[::1]") {
        return true;
    }
    let host = authority.split(':').next().unwrap_or(authority);
    host == "localhost" || host == "127.0.0.1"
}

fn scheme_of(url: &str) -> &str {
    url.split("://").next().unwrap_or("")
}

fn host_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .map(|rest| split_authority(rest).0.to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_pages_are_kept_and_the_host_is_lowercased() {
        assert_eq!(
            sanitize_page_url("  HTTPS://Example.COM/watch?v=1  ").unwrap(),
            "https://example.com/watch?v=1"
        );
    }

    #[test]
    fn http_is_only_allowed_on_this_computer() {
        assert!(sanitize_page_url("http://example.com").is_err());
        assert_eq!(
            sanitize_page_url("http://localhost:3000/overlay").unwrap(),
            "http://localhost:3000/overlay"
        );
        assert!(sanitize_page_url("http://127.0.0.1/health").is_ok());
        assert!(sanitize_page_url("http://[::1]/health").is_ok());
    }

    #[test]
    fn scripts_files_and_passwords_are_rejected() {
        for raw in [
            "javascript:alert(1)",
            "file:///C:/secret.png",
            "data:text/html,hi",
            "https://user:pass@example.com",
            "https://example.com\\evil",
            "",
        ] {
            assert!(sanitize_page_url(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn navigation_cannot_leave_the_opened_site() {
        assert!(navigation_allowed("https://example.com/a", "https://example.com/b?x=1"));
        assert!(!navigation_allowed("https://example.com/a", "https://other.example/b"));
        assert!(!navigation_allowed("https://example.com/a", "javascript:alert(1)"));
        assert!(!navigation_allowed("http://localhost/a", "http://example.com/a"));
    }
}
