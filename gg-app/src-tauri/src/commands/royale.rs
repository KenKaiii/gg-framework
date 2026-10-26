//! GG Royale: the public hook for the private, web-hosted game mode. Link state
//! lives in the sidecar (`/royale*`, daemon-level so no session header); this
//! module proxies it and hands the app a validated page URL, which the app
//! shows full-window inside the current window (a sandboxed iframe, see
//! `RoyaleScreen.tsx`). The remote page never gets IPC: no capability lists a
//! remote URL, and the app CSP's `frame-src` allows only the GG Royale origins.

use crate::commands::agent::sidecar_json;
use crate::*;

/// Label of the hosted game window.
///
/// SECURITY: this window loads a REMOTE page, so it must get NO IPC. The only
/// capability (`capabilities/default.json`) covers `["main","project-*",
/// "whatsnew"]`; "gg-royale" must never match any capability glob. Do not add
/// it (or a wildcard that matches it) to any capability.
pub(crate) const ROYALE_LABEL: &str = "gg-royale";

/// Only https, or plain http to localhost/127.0.0.1 for local dev servers.
pub(crate) fn validate_royale_url(raw: &str) -> Result<tauri::Url, String> {
    let url =
        tauri::Url::parse(raw).map_err(|_| "GG Royale sent an invalid page URL".to_string())?;
    let ok = match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")),
        _ => false,
    };
    if ok {
        Ok(url)
    } else {
        Err("GG Royale page URL must be https".into())
    }
}

/// Proxy: `{ linked, serverUrl }`.
#[tauri::command]
pub(crate) async fn agent_royale_status(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .get(format!("{}/royale", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: `{ claimable, streak, playing }` badge counts, or `null` when
/// unlinked/unreachable.
#[tauri::command]
pub(crate) async fn agent_royale_summary(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .get(format!("{}/royale/summary", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: forget the device link (deletes ~/.gg/royale.json).
#[tauri::command]
pub(crate) async fn agent_royale_unlink(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .post(format!("{}/royale/unlink", sidecar_base(port)))
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Link (if needed) and mint a one-time login code; returns the game page URL
/// for the app to embed. `async` for the WebView2 build deadlock (see
/// `setup_windows`).
#[tauri::command]
pub(crate) async fn agent_royale_open(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<String, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .post(format!("{}/royale/open", sidecar_base(port)))
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body = sidecar_json(res).await?;
    let raw = body
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("GG Royale sent no page URL")?;
    Ok(validate_royale_url(raw)?.to_string())
}

/// Proxy: GG World online save, read (`GET /world/save`). Returns the World
/// server's `{ status, body }` as-is (status 0 = unreachable/unavailable).
#[tauri::command]
pub(crate) async fn agent_world_get(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .get(format!("{}/world/save", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: GG World online save, write `{ ver, patch }` (`PUT /world/save`).
#[tauri::command]
pub(crate) async fn agent_world_put(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    ver: i64,
    patch: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .put(format!("{}/world/save", sidecar_base(port)))
        .json(&serde_json::json!({ "ver": ver, "patch": patch }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: delete the GG World online save (`DELETE /world/save`).
#[tauri::command]
pub(crate) async fn agent_world_delete(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .delete(format!("{}/world/save", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn royale_url_allows_https_and_local_http_only() {
        assert!(validate_royale_url("https://royale.example.com/#code=a").is_ok());
        assert!(validate_royale_url("http://localhost:5173/#code=a").is_ok());
        assert!(validate_royale_url("http://127.0.0.1:8080/").is_ok());
        assert!(validate_royale_url("http://example.com/").is_err());
        assert!(validate_royale_url("http://localhost.evil.com/").is_err());
        assert!(validate_royale_url("file:///etc/passwd").is_err());
        assert!(validate_royale_url("javascript:alert(1)").is_err());
        assert!(validate_royale_url("tauri://localhost/").is_err());
        assert!(validate_royale_url("not a url").is_err());
    }

    #[test]
    fn royale_window_matches_no_capability() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        let windows = caps["windows"].as_array().unwrap();
        for w in windows {
            let pat = w.as_str().unwrap();
            let matches = match pat.strip_suffix('*') {
                Some(prefix) => ROYALE_LABEL.starts_with(prefix),
                None => pat == ROYALE_LABEL,
            };
            assert!(
                !matches,
                "capability window pattern {pat} grants IPC to gg-royale"
            );
        }
    }
}
