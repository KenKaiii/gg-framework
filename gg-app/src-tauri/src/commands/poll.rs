//! Home's weekly poll. The sidecar talks to the poll server and keeps the
//! random voter id (`/poll`, daemon-level so no session header); this module
//! proxies it. The webview never contacts the poll server, so the CSP is unchanged.

use crate::commands::agent::sidecar_json;
use crate::*;

/// Proxy: the open poll with its counts and this install's pick (`GET /poll`).
/// Returns `{ status, poll, counts, total, myChoice }` (status 0 = unreachable).
#[tauri::command]
pub(crate) async fn agent_poll_get(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .get(format!("{}/poll", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: vote, or move this install's vote (`POST /poll/vote`).
#[tauri::command]
pub(crate) async fn agent_poll_vote(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    poll_id: String,
    choice: u8,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .post(format!("{}/poll/vote", sidecar_base(port)))
        .json(&serde_json::json!({ "pollId": poll_id, "choice": choice }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}
