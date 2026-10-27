//! Daemon-global proxy commands: telegram, local models, serve, MCP, projects.

use super::agent::sidecar_json;
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
    sidecar_json(res).await
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
    sidecar_json(res).await
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
    sidecar_json(res).await
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
    sidecar_json(res).await
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
    sidecar_json(res).await
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
    sidecar_json(res).await
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
    sidecar_json(res).await
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
    sidecar_json(res).await
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
    sidecar_json(res).await
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
    sidecar_json(res).await
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
    sidecar_json(res).await
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
    sidecar_json(res).await
}

/// Proxy: begin an interactive OAuth login for a remote (HTTP) MCP server.
/// Returns 202 immediately; progress + outcome stream back via `agent-event`
/// (`mcp_auth_url`, `mcp_auth_done`, `mcp_auth_error`). The
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
    sidecar_json(res).await
}

/// Turn a sidecar reply into the body or its `error` message.
async fn json_or_error(
    res: reqwest::Response,
    fallback: &str,
) -> Result<serde_json::Value, String> {
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or(fallback);
        return Err(msg.to_string());
    }
    Ok(body)
}

/// Proxy: list Goals (the `~/.gg/goals` folders), newest activity first.
#[tauri::command]
pub(crate) async fn agent_goals(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/goals", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to list goals").await
}

/// Proxy: create a Goal folder. The sidecar validates every field and resolves
/// context paths on disk; this only forwards them.
#[tauri::command]
pub(crate) async fn agent_create_goal(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    name: String,
    goal: String,
    context: Vec<String>,
    instructions: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/goals", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({
            "name": name,
            "goal": goal,
            "context": context,
            "instructions": instructions,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to create goal").await
}

/// Proxy: delete a Goal (its folder and coordinator sessions). The sidecar
/// validates the id and refuses while the goal is open elsewhere.
#[tauri::command]
pub(crate) async fn agent_delete_goal(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/goals/delete", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "id": id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to delete goal").await
}

/// Proxy: pin the model a Goal's workers run on, or clear it (`None`) so they
/// follow GG Goals. The sidecar validates the model and the provider login.
#[tauri::command]
pub(crate) async fn agent_set_critter_model(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    model: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/goal/critter-model", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to change the critters' model").await
}

/// Proxy: start a Goal's automatic first reply. Idempotent on the sidecar.
#[tauri::command]
pub(crate) async fn agent_goal_kickoff(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/goal/kickoff", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to start the goal").await
}

/// Proxy: change this window's Goal's attached context and/or standing
/// instructions. The sidecar validates both and resolves paths on disk.
#[tauri::command]
pub(crate) async fn agent_update_goal(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    context: Option<Vec<String>>,
    instructions: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let mut body = serde_json::Map::new();
    if let Some(context) = context {
        body.insert("context".into(), serde_json::json!(context));
    }
    if let Some(instructions) = instructions {
        body.insert("instructions".into(), serde_json::json!(instructions));
    }
    let res = client
        .post(format!("{}/goal/update", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to update the goal").await
}

/// Proxy: pause this window's Goal (the app also stops the current run).
#[tauri::command]
pub(crate) async fn agent_goal_pause(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/goal/pause", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to pause the goal").await
}

/// Proxy: carry this window's Goal on after a pause or an interrupted run.
/// Idempotent on the sidecar.
#[tauri::command]
pub(crate) async fn agent_goal_resume(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/goal/resume", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to resume the goal").await
}

/// Proxy: a project's git worktrees with their status, for Home.
#[tauri::command]
pub(crate) async fn agent_git_worktrees(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    cwd: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!(
            "{}/git/worktrees?cwd={}",
            sidecar_base(port),
            urlencoding(&cwd)
        ))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: remove a GG-made worktree's folder (its branch stays).
#[tauri::command]
pub(crate) async fn agent_git_remove_worktree(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    cwd: String,
    path: String,
    force: bool,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/git/worktrees/remove", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "cwd": cwd, "path": path, "force": force }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
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
    sidecar_json(res).await
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
    sidecar_json(res).await
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
