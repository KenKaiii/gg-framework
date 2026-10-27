//! Per-session agent proxy commands forwarded to the sidecar daemon.

use crate::*;

/// Proxy: current agent/session state.
#[tauri::command]
pub(crate) async fn agent_state(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/state", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: shared durable chat memories.
#[tauri::command]
pub(crate) async fn agent_memories(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/memories", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("failed to load memories")
            .to_string());
    }
    Ok(body)
}

/// Proxy: delete exactly one shared durable chat memory.
#[tauri::command]
pub(crate) async fn agent_delete_memory(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .delete(format!(
            "{}/memories/{}",
            sidecar_base(port),
            urlencoding(&id)
        ))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("failed to delete memory")
            .to_string());
    }
    Ok(body)
}

/// Proxy: shared chat behavior instructions (Jiwa).
#[tauri::command]
pub(crate) async fn agent_jiwa(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/jiwa", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("failed to load Jiwa")
            .to_string());
    }
    Ok(body)
}

/// Proxy: delete exactly one shared Jiwa instruction.
#[tauri::command]
pub(crate) async fn agent_delete_jiwa(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .delete(format!("{}/jiwa/{}", sidecar_base(port), urlencoding(&id)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("failed to delete Jiwa entry")
            .to_string());
    }
    Ok(body)
}

/// Proxy: current XP/rank progress snapshot (Ranks system).
#[tauri::command]
pub(crate) async fn agent_progress(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .get(format!("{}/progress", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: every trophy, earned or not. Daemon-level like progress (trophies
/// are app-wide), so no session header.
#[tauri::command]
pub(crate) async fn agent_trophies(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .get(format!("{}/trophies", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: the app-wide "keep computer awake while the agent works" setting.
/// Daemon-level (one OS assertion for every window), so no session header.
#[tauri::command]
pub(crate) async fn agent_keep_awake_get(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .get(format!("{}/keep-awake", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: turn keep-awake on/off; applies live to in-flight runs.
#[tauri::command]
pub(crate) async fn agent_keep_awake_set(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .post(format!("{}/keep-awake", sidecar_base(port)))
        .json(&serde_json::json!({ "enabled": enabled }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: the active provider's subscription quota snapshot. Account-wide, so
/// no per-window session header is needed.
#[tauri::command]
pub(crate) async fn agent_usage(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    provider: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    if provider != "anthropic" && provider != "openai" && provider != "moonshot" {
        return Err("unsupported usage provider".into());
    }
    let res = client
        .get(format!(
            "{}/usage?provider={}",
            sidecar_base(port),
            provider
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("usage request failed")
            .to_string());
    }
    Ok(body)
}

/// Proxy: submit a prompt (optionally with attachments). The reply streams back
/// via the `agent-event` event. `attachments` is passed through opaquely.
#[tauri::command]
pub(crate) async fn agent_prompt(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    text: String,
    attachments: Option<serde_json::Value>,
    meta: Option<serde_json::Value>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    client
        .post(format!("{}/prompt", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({
            "text": text,
            "attachments": attachments.unwrap_or(serde_json::Value::Array(vec![])),
            "meta": meta.unwrap_or(serde_json::Value::Null),
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) async fn sidecar_get_json(
    webview: &WebviewWindow,
    client: &reqwest::Client,
    path: &str,
) -> Result<serde_json::Value, String> {
    let port = port_for(webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}{}", sidecar_base(port), path))
        .header("x-gg-session", &gg_sid)
        // Local reads (history, export): bounded so a wedged daemon surfaces
        // an error instead of an endless spinner.
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Decode a sidecar response: the JSON body on 2xx, otherwise an error taken
/// from the body's `message`, then `error`, then the HTTP status reason. A
/// non-JSON error body falls back to the status reason.
pub(crate) async fn sidecar_json(res: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = res.status();
    if status.is_success() {
        return res
            .json::<serde_json::Value>()
            .await
            .map_err(|e| e.to_string());
    }
    let body = res.json::<serde_json::Value>().await.ok();
    Err(sidecar_error_message(status, body.as_ref()))
}

/// Pick the user-facing error for a non-2xx sidecar response.
pub(crate) fn sidecar_error_message(
    status: reqwest::StatusCode,
    body: Option<&serde_json::Value>,
) -> String {
    body.and_then(|b| b.get("message").or_else(|| b.get("error")))
        .and_then(|value| value.as_str())
        .unwrap_or_else(|| {
            status
                .canonical_reason()
                .unwrap_or("sidecar request failed")
        })
        .to_string()
}

/// Proxy: resumed conversation history (user + assistant text) for hydration.
#[tauri::command]
pub(crate) async fn agent_history(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    sidecar_get_json(&webview, &client, "/history").await
}

/// Proxy: export this window's session as Markdown.
///
/// Called twice per export, deliberately. With `path: None` it returns only the
/// suggested filename, so the webview can open the native save dialog without
/// ever carrying the transcript. With `path: Some(_)` it fetches the markdown
/// and writes it to disk here — a large transcript never crosses the IPC bridge.
#[tauri::command]
pub(crate) async fn agent_export_transcript(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    let Some(path) = path else {
        return sidecar_get_json(&webview, &client, "/export?name=1").await;
    };
    let body = sidecar_get_json(&webview, &client, "/export").await?;
    let markdown = body
        .get("markdown")
        .and_then(|v| v.as_str())
        .ok_or("sidecar returned no transcript")?;
    std::fs::write(&path, markdown).map_err(|e| format!("could not save transcript: {e}"))?;
    Ok(serde_json::json!({ "path": path, "bytes": markdown.len() }))
}

/// Proxy: start a fresh session (clears history) for this window's project.
#[tauri::command]
pub(crate) async fn agent_new_session(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/new-session", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    // Remember the new conversation, so a daemon respawn reopens it rather
    // than the one this window started with.
    let body = sidecar_json(res).await?;
    if let Some(path) = json_session_path(&body) {
        let windows: State<Windows> = webview.state();
        let mut map = windows.map.lock_or_recover();
        if let Some(entry) = map.get_mut(webview.label()) {
            if entry.session_id.as_deref() == Some(gg_sid.as_str()) {
                entry.session_path = Some(path);
            }
        }
    }
    Ok(())
}

/// Proxy: begin an OAuth login. Progress streams back via `agent-event`
/// (`auth_url`, `auth_status`, `auth_need_code`, `auth_done`, `auth_error`).
#[tauri::command]
pub(crate) async fn agent_auth_oauth_start(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    provider: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/auth/oauth/start", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "provider": provider }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: submit a pasted OAuth code to an in-flight login.
#[tauri::command]
pub(crate) async fn agent_auth_oauth_code(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    code: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/auth/oauth/code", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: answer an MCP server's mid-tool-call request for user input.
///
/// `action` is `accept` | `decline` | `cancel`; `content` carries the filled
/// form and is only meaningful for `accept`.
#[tauri::command]
pub(crate) async fn agent_mcp_elicit(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: String,
    action: String,
    content: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!(
            "{}/mcp/elicit/{}",
            sidecar_base(port),
            urlencoding(&id)
        ))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "action": action, "content": content }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: answer an `ask_user` question band.
///
/// `action` is `answer` | `cancel`; `answers` maps each question id to the
/// picked value (or values, for a multi-select). The turn is blocked on this,
/// so the webview must call it on every dismissal path too.
#[tauri::command]
pub(crate) async fn agent_ask_user(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: String,
    action: String,
    answers: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/ask/{}", sidecar_base(port), urlencoding(&id)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "action": action, "answers": answers }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: cancel one pending queued message by id. Returns
/// `{ cancelled, queued }`. `cancelled: false` means it already drained into
/// the run between render and click, which is a normal race, not an error.
#[tauri::command]
pub(crate) async fn agent_cancel_queued(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/queued/cancel", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "id": id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: stop a background task by id. Returns `{ message }`.
#[tauri::command]
pub(crate) async fn agent_kill_task(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/kill", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "id": id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: import a Claude Code / Codex / Cursor transcript into a resumable
/// GG Coder session. Returns the importer's typed result (`{ ok, ... }`),
/// including the failure case, so the webview can show the reason verbatim.
#[tauri::command]
pub(crate) async fn agent_import_transcript(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    path: String,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/import-transcript", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "path": path, "cwd": cwd }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: app-wide radio state — `{ stations, current, volume }`.
/// All windows share the daemon's single player, preventing duplicate audio.
#[tauri::command]
pub(crate) async fn agent_radio_state(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/radio", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: play a station by id, or stop with `station = "off"`. Returns
/// `{ current }` on success, an error message (e.g. no player installed) on 4xx.
#[tauri::command]
pub(crate) async fn agent_radio_set(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    station: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/radio", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "station": station }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("radio request failed")
            .to_string();
        return Err(msg);
    }
    Ok(body)
}

/// Proxy: set app-wide radio volume from 0 to 100.
#[tauri::command]
pub(crate) async fn agent_radio_volume(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    volume: f64,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/radio/volume", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "volume": volume }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("radio volume request failed")
            .to_string());
    }
    Ok(body)
}

/// Proxy: list this project's task list (the ~/.gg-tasks store for its cwd).
#[tauri::command]
pub(crate) async fn agent_tasks(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/tasks", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: the Git panel's data. Open issues and PRs on the project's GitHub
/// repo (null when `gh` can't answer), and the changed files with line counts.
#[tauri::command]
pub(crate) async fn agent_git_overview(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/git/overview", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: the Git panel's branch picker list (local branches, the current one,
/// and whether other windows share this checkout).
#[tauri::command]
pub(crate) async fn agent_git_branches(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/git/branches", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: put this window on a branch. Switches in place, or (when other
/// windows share the checkout) answers with the worktree this window should
/// re-open in; the webview then re-points itself there.
#[tauri::command]
pub(crate) async fn agent_git_switch_branch(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    branch: String,
    create: bool,
    placement: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/git/branch", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "branch": branch, "create": create, "placement": placement }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: the project health checklist (`.gg-checklist.json` joined with the
/// built-in items and their current status). A corrupt record surfaces as Err.
#[tauri::command]
pub(crate) async fn agent_checklist(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/checklist", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("checklist request failed")
            .to_string());
    }
    Ok(body)
}

/// Proxy: run one task (`id`) or run-all (`all = true`, starting from the next
/// pending task). Progress streams back via `agent-event` (session_reset,
/// task_start, run_start/run_end, tasks_list, tasks_run_done).
#[tauri::command]
pub(crate) async fn agent_run_tasks(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: Option<String>,
    all: bool,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/tasks/run", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "id": id, "all": all }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: delete a task by id. Returns the remaining `{ tasks }`.
#[tauri::command]
pub(crate) async fn agent_delete_task(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/tasks/delete", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "id": id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: accept the pending plan — bakes its `## Steps` into the system prompt
/// so the agent emits `[DONE:n]` progress markers while implementing. Call
/// before sending the "implement it now" prompt.
#[tauri::command]
pub(crate) async fn agent_accept_plan(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    plan_path: Option<String>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/plan/accept", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "planPath": plan_path }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    // A refused accept (409 while a run is still finishing, 500 when the plan
    // can't be activated) must reach the webview; swallowing it made the app
    // send "implement it now" into the planning session as if it had worked.
    let status = res.status();
    if status.is_success() {
        return Ok(());
    }
    let body = res.text().await.unwrap_or_default();
    Err(accept_plan_error(status, &body))
}

/// Human-readable failure for a refused `/plan/accept`: the sidecar's
/// `{ "error": "..." }` message when present, else the HTTP status.
pub(crate) fn accept_plan_error(status: reqwest::StatusCode, body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|e| e.as_str())
                .map(str::to_owned)
        })
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| format!("plan accept failed (HTTP {})", status.as_u16()))
}

pub(crate) fn parse_cancel_response(
    status: reqwest::StatusCode,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if status.is_success() {
        return Ok(body);
    }
    // Preserve the typed sidecar payload (cancel_failed, reason, runState) so
    // the webview can recover honestly instead of seeing only an HTTP code.
    Err(body.to_string())
}

/// Proxy: cancel the in-flight run and reject non-2xx acknowledgements.
#[tauri::command]
pub(crate) async fn agent_cancel(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/cancel", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    parse_cancel_response(status, body)
}

/// Proxy: ask Ken Kai (the read-only mentor agent). Reply streams back via the
/// `agent-event` event with `ken_`-prefixed types. Lazily boots Ken's session.
#[tauri::command]
pub(crate) async fn agent_ken_prompt(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    text: String,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    client
        .post(format!("{}/ken/prompt", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "text": text }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Proxy: cancel Ken's in-flight run (leaves GG Coder's run untouched).
#[tauri::command]
pub(crate) async fn agent_ken_cancel(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    client
        .post(format!("{}/ken/cancel", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Proxy: toggle autopilot (auto-review) for THIS window's project. Persisted
/// server-side in ~/.gg/gg-app.json keyed by cwd; returns `{ autopilot }`.
#[tauri::command]
pub(crate) async fn agent_autopilot_set(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/autopilot", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "enabled": enabled }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: list workflow (prompt-template) slash commands.
#[tauri::command]
pub(crate) async fn agent_commands(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/commands", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: list models available to the logged-in providers.
#[tauri::command]
pub(crate) async fn agent_models(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/models", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: switch the active model. Returns the new provider/model + thinking state.
/// `confirm_paid` carries the user's explicit "yes, spend real money" for a
/// model that bills usage credits; the sidecar refuses such a switch without it.
#[tauri::command]
pub(crate) async fn agent_switch_model(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    model: String,
    confirm_paid: Option<bool>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/model", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({
            "model": model,
            "confirmPaid": confirm_paid.unwrap_or(false),
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: pin Ken (mentor + autopilot) to a model, or clear the pin so he
/// follows GG Coder's model again. `model: None` clears. Returns
/// `{ kenProvider, kenModel, kenModelOverride }`.
#[tauri::command]
pub(crate) async fn agent_switch_ken_model(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    model: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/ken/model", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: rewrite a draft prompt into a tighter, terminology-correct version
/// using the active model. Returns `{ enhanced, segments }`.
#[tauri::command]
pub(crate) async fn agent_enhance_prompt(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    text: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/enhance", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "text": text }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Couldn't enhance the prompt. Your original draft has been kept.")
            .to_owned());
    }
    Ok(body)
}

/// Proxy: best-effort Anthropic prompt-cache prewarm (fire-and-forget; 202).
#[tauri::command]
pub(crate) async fn agent_prewarm(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    client
        .post(format!("{}/prewarm", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Proxy: cycle the reasoning/thinking level to the next supported value.
/// Returns the new `{ thinkingLevel, supportedThinkingLevels }`.
#[tauri::command]
pub(crate) async fn agent_cycle_thinking(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/thinking", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: set the reasoning level directly. `level: None` turns thinking off.
/// The sidecar refuses a level the current model doesn't support (400).
#[tauri::command]
pub(crate) async fn agent_set_thinking(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    level: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/thinking", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "level": level }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

#[tauri::command]
pub(crate) async fn agent_plugins(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/plugins", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.error_for_status()
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn agent_install_plugin(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    bundle_path: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/plugins/install", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "bundlePath": bundle_path }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.error_for_status()
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn agent_remove_plugin(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    plugin_id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let mut endpoint = reqwest::Url::parse(&format!("{}/plugins/", sidecar_base(port)))
        .map_err(|e| e.to_string())?;
    endpoint
        .path_segments_mut()
        .map_err(|_| "invalid sidecar URL".to_string())?
        .push(&plugin_id);
    let res = client
        .delete(endpoint)
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.error_for_status()
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_response_accepts_acknowledged_success() {
        let body = serde_json::json!({ "cancelled": true, "runState": "idle" });
        assert_eq!(
            parse_cancel_response(reqwest::StatusCode::OK, body.clone()).unwrap(),
            body
        );
    }

    #[test]
    fn cancel_response_rejects_typed_non_success_body() {
        let body = serde_json::json!({
            "error": "cancel_failed",
            "reason": "timeout",
            "runState": "running"
        });
        let error = parse_cancel_response(reqwest::StatusCode::GATEWAY_TIMEOUT, body).unwrap_err();
        assert!(error.contains("cancel_failed"));
        assert!(error.contains("runState"));
        assert!(error.contains("running"));
    }

    #[test]
    fn accept_plan_error_surfaces_sidecar_message_or_status() {
        let body = r#"{"error":"cannot accept a plan while the agent is running"}"#;
        assert_eq!(
            accept_plan_error(reqwest::StatusCode::CONFLICT, body),
            "cannot accept a plan while the agent is running"
        );
        assert_eq!(
            accept_plan_error(reqwest::StatusCode::INTERNAL_SERVER_ERROR, "<html>"),
            "plan accept failed (HTTP 500)"
        );
    }

    #[test]
    fn sidecar_error_prefers_message_then_error_then_status() {
        let both = serde_json::json!({ "message": "m", "error": "e" });
        assert_eq!(
            sidecar_error_message(reqwest::StatusCode::CONFLICT, Some(&both)),
            "m"
        );
        let err = serde_json::json!({ "error": "a login is already in progress" });
        assert_eq!(
            sidecar_error_message(reqwest::StatusCode::CONFLICT, Some(&err)),
            "a login is already in progress"
        );
        let other = serde_json::json!({ "ok": false });
        assert_eq!(
            sidecar_error_message(reqwest::StatusCode::BAD_REQUEST, Some(&other)),
            "Bad Request"
        );
        assert_eq!(
            sidecar_error_message(reqwest::StatusCode::INTERNAL_SERVER_ERROR, None),
            "Internal Server Error"
        );
    }
}
