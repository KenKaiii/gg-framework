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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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

// kleio: the Brain window's add and edit. A new entry is a POST to the list and
// an edit is a PATCH to the entry. The id is one path segment, so `/` is encoded
// too (`urlencoding` keeps it for paths).
pub(crate) fn brain_save_route(kind: &str, id: Option<&str>) -> (reqwest::Method, String) {
    match id {
        None => (reqwest::Method::POST, format!("/{kind}")),
        Some(id) => (
            reqwest::Method::PATCH,
            format!("/{kind}/{}", urlencoding(id).replace('/', "%2F")),
        ),
    }
}

// kleio: sends one Brain entry under this window's session. The sidecar checks
// it (text, category, importance) with the tools' limits; this only carries it.
pub(crate) async fn brain_save(
    webview: &WebviewWindow,
    client: &reqwest::Client,
    kind: &str,
    id: Option<&str>,
    entry: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let port = port_for(webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(webview).ok_or("session not ready")?;
    let (method, path) = brain_save_route(kind, id);
    let res = client
        .request(method, format!("{}{}", sidecar_base(port), path))
        .header("x-gg-session", &gg_sid)
        .json(&entry)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(sidecar_error_message("save", status.as_u16(), &body));
    }
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: add a shared memory (no `id`) or edit one, from the Brain window.
#[tauri::command]
pub(crate) async fn agent_save_memory(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: Option<String>,
    text: String,
    category: String,
    importance: u8,
) -> Result<serde_json::Value, String> {
    let entry = serde_json::json!({ "text": text, "category": category, "importance": importance });
    brain_save(&webview, &client, "memories", id.as_deref(), entry).await
}

/// Proxy: add a shared Jiwa instruction (no `id`) or edit one, from the Brain window.
#[tauri::command]
pub(crate) async fn agent_save_jiwa(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: Option<String>,
    text: String,
    category: String,
    importance: u8,
) -> Result<serde_json::Value, String> {
    let entry = serde_json::json!({ "text": text, "category": category, "importance": importance });
    brain_save(&webview, &client, "jiwa", id.as_deref(), entry).await
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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    let res = client
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
    // A refusal (413 too large, 409 mid-cancel) means the agent never got the
    // message: report it rather than pass it off as sent.
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(sidecar_error_message("send", status.as_u16(), &body));
    }
    // kleio (iPhone): show what the agent is doing on the lock screen.
    if kleio::remote().is_some() {
        let (chat, cwd) = {
            let windows: State<Windows> = webview.state();
            let map = windows.map.lock().unwrap();
            let w = map.get(webview.label());
            (
                w.is_some_and(|w| w.mode == WorkspaceMode::Chat),
                w.and_then(|w| w.cwd.as_ref().map(|c| c.to_string_lossy().into_owned())),
            )
        };
        let title = kleio::live::prompt_title(chat, cwd.as_deref(), &text);
        kleio::live::start(
            if chat { "chat" } else { "code" },
            &title,
            Some(&gg_sid),
            None,
        );
    }
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
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if status.is_success() {
        return Ok(body);
    }
    Err(body
        .get("message")
        .or_else(|| body.get("error"))
        .and_then(|value| value.as_str())
        .unwrap_or_else(|| {
            status
                .canonical_reason()
                .unwrap_or("sidecar request failed")
        })
        .to_string())
}

/// Proxy: resumed conversation history (user + assistant text) for hydration.
/// `images_by_ref`: its tool images as refs, to load as they're scrolled to
/// (`agent_history_images`), from a sidecar whose state says it can
/// (`historyImageRefs`).
#[tauri::command]
pub(crate) async fn agent_history(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    images_by_ref: Option<bool>,
) -> Result<serde_json::Value, String> {
    let path = if images_by_ref == Some(true) {
        "/history?images=refs"
    } else {
        "/history"
    };
    sidecar_get_json(&webview, &client, path).await
}

/// The most image refs one `agent_history_images` asks for.
pub(crate) const HISTORY_IMAGES_MAX: usize = 8;

/// The sidecar's path for some of a chat's history images: 1 to
/// [`HISTORY_IMAGES_MAX`] refs, each 64 lowercase hex characters, so nothing
/// else reaches the path.
pub(crate) fn history_images_path(refs: &[String]) -> Result<String, String> {
    if refs.is_empty() || refs.len() > HISTORY_IMAGES_MAX {
        return Err(format!(
            "Ask for 1 to {HISTORY_IMAGES_MAX} images at a time."
        ));
    }
    let is_ref =
        |r: &String| r.len() == 64 && r.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !refs.iter().all(is_ref) {
        return Err("That isn't an image in this chat.".into());
    }
    Ok(format!("/history-images?refs={}", refs.join(",")))
}

/// Proxy: some of a resumed chat's tool images, as preview data URLs by ref,
/// as the transcript scrolls to them.
#[tauri::command]
pub(crate) async fn agent_history_images(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    refs: Vec<String>,
) -> Result<serde_json::Value, String> {
    sidecar_get_json(&webview, &client, &history_images_path(&refs)?).await
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
    client
        .post(format!("{}/new-session", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Proxy: store an API key for a provider.
#[tauri::command]
pub(crate) async fn agent_auth_apikey(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    provider: String,
    key: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/auth/apikey", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "provider": provider, "key": key }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: disconnect a provider (clear its stored credentials).
#[tauri::command]
pub(crate) async fn agent_auth_logout(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    provider: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/auth/logout", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "provider": provider }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    // kleio: remote mode plays on THIS Mac; the host only lists the stations.
    // Local playback is reported even when the host is unreachable, so the UI
    // still shows it playing and can stop it (`off` needs no host).
    if kleio::remote().is_some() {
        let stations = kleio::radio::host_radio(&client, &sidecar_base(port), &gg_sid)
            .await
            .ok()
            .and_then(|host| host.get("stations").cloned())
            .unwrap_or_else(|| serde_json::json!([]));
        let (current, volume) = webview.state::<kleio::radio::LocalRadio>().state();
        return Ok(serde_json::json!({
            "stations": stations,
            "current": current,
            "volume": volume,
        }));
    }
    let res = client
        .get(format!("{}/radio", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    // kleio: remote mode plays on THIS Mac; the host only supplies the URL.
    if kleio::remote().is_some() {
        let radio = webview.state::<kleio::radio::LocalRadio>();
        if station.is_empty() || station == "off" {
            radio.stop();
            return Ok(serde_json::json!({ "current": null }));
        }
        let host = kleio::radio::host_radio(&client, &sidecar_base(port), &gg_sid).await?;
        let url = kleio::radio::station_url(&host, &station)?;
        radio.play(&station, &url)?;
        return Ok(serde_json::json!({ "current": station }));
    }
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
    // kleio: remote mode adjusts the local player (see agent_radio_set).
    if kleio::remote().is_some() {
        let radio = webview.state::<kleio::radio::LocalRadio>();
        radio.set_volume(volume)?;
        let (current, volume) = radio.state();
        return Ok(serde_json::json!({ "current": current, "volume": volume }));
    }
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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    client
        .post(format!("{}/plan/accept", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "planPath": plan_path }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: switch the active model. Returns the new provider/model + thinking state.
#[tauri::command]
pub(crate) async fn agent_switch_model(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    model: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/model", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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

/// Proxy: transcribe a dictated clip (base64 16 kHz mono 16-bit PCM) with the
/// sidecar's local Whisper. Returns `{ text }`, empty when nothing was said.
#[tauri::command]
pub(crate) async fn agent_transcribe(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    audio: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/transcribe", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "audio": audio }))
        // The first clip also downloads the speech model (~140 MB) where the
        // sidecar runs: the host once paired.
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Transcribing took too long. Try again.".to_owned()
            } else {
                "Couldn't reach your host to transcribe.".to_owned()
            }
        })?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Couldn't transcribe that recording. Try again.")
            .to_owned());
    }
    Ok(body)
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
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: read gg-app settings (e.g. the projects root folder).
#[tauri::command]
pub(crate) async fn agent_settings(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/settings", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: save gg-app settings.
#[tauri::command]
pub(crate) async fn agent_save_settings(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    projects_root: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/settings", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "projectsRoot": projects_root }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    fn history_images_path_takes_1_to_8_image_refs_and_nothing_else() {
        let r = |c: char| c.to_string().repeat(64);
        assert_eq!(
            super::history_images_path(&[r('a'), r('0')]),
            Ok(format!("/history-images?refs={},{}", r('a'), r('0')))
        );
        assert!(super::history_images_path(&vec![r('f'); 8]).is_ok());
        for refs in [
            vec![],
            vec![r('a'); 9],
            vec![r('A')],
            vec!["a".repeat(63)],
            vec![format!("{}&x=1", "a".repeat(60))],
            vec![format!("{}../", "a".repeat(61))],
        ] {
            assert!(super::history_images_path(&refs).is_err(), "{refs:?}");
        }
    }

    #[test]
    fn brain_save_route_posts_a_new_entry_and_patches_an_edit() {
        use reqwest::Method;
        assert_eq!(
            brain_save_route("memories", None),
            (Method::POST, "/memories".to_string())
        );
        assert_eq!(
            brain_save_route("jiwa", None),
            (Method::POST, "/jiwa".to_string())
        );
        assert_eq!(
            brain_save_route("memories", Some("cfadf2e0-60bd-4049-9711-21e464f6df46")),
            (
                Method::PATCH,
                "/memories/cfadf2e0-60bd-4049-9711-21e464f6df46".to_string()
            )
        );
        // Whatever the id holds, it stays one path segment.
        assert_eq!(
            brain_save_route("jiwa", Some("a/b c%?#é")),
            (Method::PATCH, "/jiwa/a%2Fb%20c%25%3F%23%C3%A9".to_string())
        );
    }

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
}
