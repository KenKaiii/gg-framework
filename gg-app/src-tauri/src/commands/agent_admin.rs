//! Daemon-global proxy commands: telegram, local models, serve, MCP, projects,
//! routines and saved chats.

use crate::*;

/// Proxy: read Telegram config status (configured + masked preview).
#[tauri::command]
pub(crate) async fn agent_telegram_get(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/telegram", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: local model endpoints + their last-scan status (no probing).
#[tauri::command]
pub(crate) async fn agent_local(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/local", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: re-probe every local endpoint (the "Scan" button). Slower than
/// `agent_local` — it actually talks to each server.
#[tauri::command]
pub(crate) async fn agent_local_scan(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/local/scan", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: add a custom local endpoint (URL + optional API key).
#[tauri::command]
pub(crate) async fn agent_local_endpoint_add(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    base_url: String,
    label: Option<String>,
    api_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/local/endpoints", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "baseUrl": base_url, "label": label, "apiKey": api_key }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: remove a custom local endpoint (and its stored credential).
#[tauri::command]
pub(crate) async fn agent_local_endpoint_remove(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .delete(format!(
            "{}/local/endpoints/{}",
            sidecar_base(port),
            urlencoding(&id)
        ))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: search Hugging Face for GGUF repos (the "Add from Hugging Face" modal).
#[tauri::command]
pub(crate) async fn agent_hf_search(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    query: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/hf/search", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "query": query }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if status.is_client_error() || status.is_server_error() {
        return Err(body["error"]
            .as_str()
            .unwrap_or("Hugging Face search failed")
            .to_string());
    }
    Ok(body)
}

/// Proxy: start an `ollama pull` of a Hugging Face repo (progress arrives as
/// `hf_pull` sidecar events). Returns the pull state immediately.
#[tauri::command]
pub(crate) async fn agent_hf_pull(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    repo: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/hf/pull", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "repo": repo }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if status.is_client_error() || status.is_server_error() {
        return Err(body["error"]
            .as_str()
            .unwrap_or("Could not start the download")
            .to_string());
    }
    Ok(body)
}

/// Proxy: current Hugging Face pull state (null when none ever started).
#[tauri::command]
pub(crate) async fn agent_hf_pull_status(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/hf/pull", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: cancel the running Hugging Face pull (if any).
#[tauri::command]
pub(crate) async fn agent_hf_pull_cancel(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/hf/pull/cancel", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: save Telegram config (bot token + user id). Verifies the token via
/// getMe sidecar-side; returns an error message on rejection.
#[tauri::command]
pub(crate) async fn agent_telegram_save(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    bot_token: String,
    user_id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/telegram", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "botToken": bot_token, "userId": user_id }))
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
            .unwrap_or("failed to save Telegram config");
        return Err(msg.to_string());
    }
    Ok(body)
}

/// Proxy: Telegram serve status (`{ running, configured }`).
#[tauri::command]
pub(crate) async fn agent_serve_status(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/serve", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: start the Telegram serve loop. Returns `{ running }` or an error.
#[tauri::command]
pub(crate) async fn agent_serve_start(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/serve/start", sidecar_base(port)))
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
        let msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("failed to start serve");
        return Err(msg.to_string());
    }
    Ok(body)
}

/// Proxy: stop the Telegram serve loop. Returns `{ running: false }`.
#[tauri::command]
pub(crate) async fn agent_serve_stop(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/serve/stop", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: Agent Steroids status (`{ installed, connected, version?, repos?, … }`).
#[tauri::command]
pub(crate) async fn agent_steroids_status(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/steroids", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: download + verify + install the `steroids` binary. Returns the
/// post-install status or the sidecar's error text.
#[tauri::command]
pub(crate) async fn agent_steroids_install(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/steroids/install", sidecar_base(port)))
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
        let msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("failed to install Steroids");
        return Err(msg.to_string());
    }
    Ok(body)
}

/// Proxy: list MCP servers with live connection status (`{ servers: […] }`).
/// `cwd` (project scope) scopes the project servers to a specific project path.
#[tauri::command]
pub(crate) async fn agent_mcp_list(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let mut req = client
        .get(format!("{}/mcp", sidecar_base(port)))
        .header("x-gg-session", &gg_sid);
    if let Some(c) = cwd.as_deref().filter(|c| !c.trim().is_empty()) {
        req = req.query(&[("cwd", c)]);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: add an MCP server from a pasted `claude mcp add …` line. Returns
/// `{ ok, name, connected, toolCount, error? }`, or an error message on parse/save
/// failure (the sidecar probes before saving but never blocks the save).
/// `cwd` is required for project scope (the target project path).
#[tauri::command]
pub(crate) async fn agent_mcp_add(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    line: String,
    scope: String,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/mcp/add", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "line": line, "scope": scope, "cwd": cwd }))
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
            .unwrap_or("failed to add MCP server");
        return Err(msg.to_string());
    }
    Ok(body)
}

/// Proxy: remove an MCP server by name. Returns `{ removed: boolean }`.
/// `cwd` is required for project scope (the target project path).
#[tauri::command]
pub(crate) async fn agent_mcp_remove(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    name: String,
    scope: String,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/mcp/remove", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "name": name, "scope": scope, "cwd": cwd }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: begin an interactive OAuth login for a remote (HTTP) MCP server.
/// Returns 202 immediately; progress + outcome stream back via `agent-event`
/// (`mcp_auth_url`, `mcp_auth_status`, `mcp_auth_done`, `mcp_auth_error`). The
/// webview opens the browser when it receives `mcp_auth_url`.
/// `cwd` is required for project scope (the target project path).
#[tauri::command]
pub(crate) async fn agent_mcp_login(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    name: String,
    scope: String,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/mcp/login", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "name": name, "scope": scope, "cwd": cwd }))
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
            .unwrap_or("failed to start MCP login");
        return Err(msg.to_string());
    }
    Ok(body)
}

/// Proxy: create a new project folder under the configured projects root.
/// Returns `{ path }` on success, or an error message on validation/conflict.
#[tauri::command]
pub(crate) async fn agent_create_project(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    name: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/create-project", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "name": name }))
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
            .unwrap_or("failed to create project");
        return Err(msg.to_string());
    }
    Ok(body)
}

/// Proxy: hide (or with `hidden: false`, restore) a project in the picker.
#[tauri::command]
pub(crate) async fn agent_set_project_hidden(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    path: String,
    hidden: bool,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/projects/hidden", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "path": path, "hidden": hidden }))
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
            .unwrap_or("failed to update hidden projects");
        return Err(msg.to_string());
    }
    Ok(body)
}

/// Proxy: discover known projects across ggcoder/Claude Code/Codex stores.
#[tauri::command]
pub(crate) async fn agent_projects(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/projects", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// "Open existing" while paired with a Kleio host: the folders in the HOST's
/// projects folders (hidden ones marked), since this Mac can't browse its disk.
#[tauri::command]
pub(crate) async fn agent_project_folders(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or(STILL_CONNECTING)?;
    let gg_sid = session_for(&webview).ok_or(STILL_CONNECTING)?;
    let res = client
        .get(format!("{}/projects/folders", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach your host: {e}"))?;
    let status = res.status().as_u16();
    let body = res
        .text()
        .await
        .map_err(|e| format!("Couldn't reach your host: {e}"))?;
    project_folders(status, &body)
}

/// The host's `{ folders }`, or a reason to show. An older host has no such
/// route (404), so say what it needs rather than a bare status.
pub(crate) fn project_folders(status: u16, body: &str) -> Result<serde_json::Value, String> {
    if status == 404 {
        return Err(
            "Your host needs a Kleio update before it can list its folders here.".to_string(),
        );
    }
    if !(200..300).contains(&status) {
        return Err(kleio::files::host_error(status, body));
    }
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .filter(|v| v.get("folders").is_some_and(serde_json::Value::is_array))
        .ok_or_else(|| "Your host sent a folder list this app can't read.".to_string())
}

/// Routines (`/schedule`) are daemon-level: they outlive any window, and on a
/// Kleio host they run with no window at all. Session-less proxies.
#[tauri::command]
pub(crate) async fn routines_list(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .get(format!("{}/routines", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn routines_add(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    routine: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .post(format!("{}/routines", sidecar_base(port)))
        .json(&routine)
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
            .and_then(|e| e.as_str())
            .unwrap_or("routine refused")
            .to_string());
    }
    Ok(body)
}

#[tauri::command]
pub(crate) async fn routines_remove(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: String,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .delete(format!(
            "{}/routines/{}",
            sidecar_base(port),
            urlencoding(&id)
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("routine remove failed: HTTP {}", res.status()));
    }
    Ok(())
}

/// Proxy: list recent sessions for a project cwd.
#[tauri::command]
pub(crate) async fn agent_sessions(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    cwd: String,
    chat_agent: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let encoded = urlencoding(&cwd);
    let mut url = format!("{}/sessions?cwd={}", sidecar_base(port), encoded);
    if let Some(agent) = chat_agent {
        url.push_str("&chatAgent=");
        url.push_str(&urlencoding(&agent));
    }
    let res = client
        .get(url)
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Pull the sidecar's `{ "error": ".." }` message out of a failed response
/// body, falling back to "<action> failed: HTTP <status>".
pub(crate) fn sidecar_error_message(action: &str, status: u16, body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| format!("{action} failed: HTTP {status}"))
}

/// Proxy: permanently delete a saved chat (all generations) by its path.
#[tauri::command]
pub(crate) async fn agent_delete_chat(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    path: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/sessions/delete", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "path": path }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(sidecar_error_message("delete", status.as_u16(), &body));
    }
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: search project files for the chat input's `@` picker. Empty `query`
/// returns the most-recently-modified files; a query returns fuzzy matches.
#[tauri::command]
pub(crate) async fn agent_files(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    query: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let encoded = urlencoding(&query);
    let res = client
        .get(format!("{}/files?q={}", sidecar_base(port), encoded))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Minimal percent-encoding for a filesystem path in a query string.
pub(crate) fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_error_message_prefers_the_sidecar_error() {
        assert_eq!(
            sidecar_error_message(
                "delete",
                409,
                r#"{"error":"This chat is open in a window."}"#
            ),
            "This chat is open in a window."
        );
        assert_eq!(
            sidecar_error_message("delete", 502, "<html>"),
            "delete failed: HTTP 502"
        );
        // A prompt over the sidecar's body cap is refused, not sent.
        assert_eq!(
            sidecar_error_message("send", 413, r#"{"error":"request body too large"}"#),
            "request body too large"
        );
        assert_eq!(
            sidecar_error_message("send", 413, ""),
            "send failed: HTTP 413"
        );
    }

    #[test]
    fn project_folders_passes_the_hosts_list_through() {
        let body = r#"{"folders":[{"name":"test","path":"/u/kleio-projects/test","hidden":true}]}"#;
        assert_eq!(
            project_folders(200, body),
            Ok(serde_json::json!({
                "folders": [{ "name": "test", "path": "/u/kleio-projects/test", "hidden": true }]
            }))
        );
    }

    #[test]
    fn project_folders_explains_an_old_host_and_other_failures() {
        assert_eq!(
            project_folders(404, r#"{"error":"not found"}"#),
            Err("Your host needs a Kleio update before it can list its folders here.".into())
        );
        assert_eq!(
            project_folders(500, r#"{"error":"Couldn't list the project folders."}"#),
            Err("Couldn't list the project folders.".into())
        );
        for body in ["not json", "{}", r#"{"folders":7}"#] {
            assert!(project_folders(200, body).is_err(), "{body}");
        }
    }
}
