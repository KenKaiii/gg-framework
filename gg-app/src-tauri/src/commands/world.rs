//! GG World online save + live tickets. The device link lives in the sidecar
//! (`/world/*`, daemon-level so no session header); this module proxies it.
//! The app CSP's `frame-src` allows only the app itself and the GG World TV
//! page (gg-world worker `/tv`, which embeds the YouTube player).
//! `connect-src` allows one remote origin, `wss://gg-world.buzzbeamaustralia.workers.dev`:
//! the GG World live socket, opened by the main frame with a one-time ticket
//! from `agent_world_live` (never by the sealed game frame).
//! Tauri sends this same CSP with World's own page (`world/index.html`), so it
//! also needs `frame-ancestors 'self'` (to be framed by the app), `connect-src
//! blob:` (glTF textures) and `'wasm-unsafe-eval'` (the meshopt decoder).
//! `script-src` names the app's origins (`tauri://localhost` on macOS,
//! `http://tauri.localhost` on Windows) as well as `'self'`: in the sealed
//! frame's opaque origin WebKit matches `'self'` to nothing, so World's own
//! scripts never ran and the screen stayed black.

use crate::commands::agent::sidecar_json;
use crate::*;

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

/// Proxy: a one-time GG World live ticket (`POST /world/live`). The device
/// token stays in the sidecar; the app only gets `{ status, body }` where body
/// is `{ world, ticket, url }` on success.
#[tauri::command]
pub(crate) async fn agent_world_live(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .post(format!("{}/world/live", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: delete the whole GG World account (`DELETE /world/account`). The
/// sidecar removes ~/.gg/royale.json once the server confirms.
#[tauri::command]
pub(crate) async fn agent_world_account_delete(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .delete(format!("{}/world/account", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}
