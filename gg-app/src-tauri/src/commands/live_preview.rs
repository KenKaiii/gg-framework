//! Live preview: the window's running web app in the user's browser, with the
//! chat overlay. The sidecar runs the proxy and the preview's own session; these
//! commands start, stop and report it for the calling window's session.

use super::agent::sidecar_json;
use crate::*;

/// Proxy: start (or reuse) this window's live preview. `url` is a dev server
/// address the user typed; without it the sidecar finds one in the window's
/// background process logs. Returns `{ running, url, target, needsUrl?, error? }`.
#[tauri::command]
pub(crate) async fn live_preview_start(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    url: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/live-preview/start", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "url": url }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: stop this window's live preview and close its session.
#[tauri::command]
pub(crate) async fn live_preview_stop(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/live-preview/stop", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: whether this window's live preview runs, and its link.
#[tauri::command]
pub(crate) async fn live_preview_status(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/live-preview/status", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}
