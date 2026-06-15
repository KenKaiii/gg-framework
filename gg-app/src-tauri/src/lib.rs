use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use futures_util::StreamExt;
use tauri::{Emitter, EventTarget, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// One Node agent sidecar, owned by a single window. Each window runs its own
/// agent against its own project cwd, so windows never share state.
#[derive(Default)]
struct SidecarInstance {
    child: Option<Child>,
    port: Option<u16>,
}

/// Per-window sidecar registry, keyed by window label.
#[derive(Default)]
struct Sidecars {
    map: Mutex<HashMap<String, SidecarInstance>>,
}

fn sidecar_base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Gracefully terminate a sidecar child so its SIGINT/SIGTERM handler can run
/// `session.dispose()` (process/LSP/MCP shutdown) before exit. On Unix we send
/// SIGTERM synchronously (non-blocking), then poll `try_wait()` for up to ~3s off
/// the calling thread, SIGKILL as a fallback, and `wait()` to reap the zombie
/// (std `Child` never auto-reaps). On Windows there is no SIGTERM, so the
/// fallback `kill()` is the only step.
fn terminate_child(mut child: Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    std::thread::spawn(move || {
        #[cfg(unix)]
        {
            for _ in 0..30 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        let _ = child.kill(); // SIGKILL fallback (and the only step on Windows)
        let _ = child.wait(); // reap
    });
}

/// Resolve the sidecar port for the window that issued a command.
fn port_for(webview: &WebviewWindow) -> Option<u16> {
    let state: State<Sidecars> = webview.state();
    let map = state.map.lock().unwrap();
    map.get(webview.label()).and_then(|i| i.port)
}

/// Frontend polls this until it returns a port (mirrors the `sidecar-ready` event).
#[tauri::command]
fn sidecar_port(webview: WebviewWindow) -> Option<u16> {
    port_for(&webview)
}

/// Proxy: current agent/session state.
#[tauri::command]
async fn agent_state(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .get(format!("{}/state", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: submit a prompt (optionally with attachments). The reply streams back
/// via the `agent-event` event. `attachments` is passed through opaquely.
#[tauri::command]
async fn agent_prompt(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    text: String,
    attachments: Option<serde_json::Value>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    client
        .post(format!("{}/prompt", sidecar_base(port)))
        .json(&serde_json::json!({
            "text": text,
            "attachments": attachments.unwrap_or(serde_json::Value::Array(vec![])),
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Proxy: resumed conversation history (user + assistant text) for hydration.
#[tauri::command]
async fn agent_history(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .get(format!("{}/history", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: start a fresh session (clears history) for this window's project.
#[tauri::command]
async fn agent_new_session(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    client
        .post(format!("{}/new-session", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Proxy: provider auth status (which providers are connected).
#[tauri::command]
async fn agent_auth_status(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .get(format!("{}/auth/status", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: store an API key for a provider.
#[tauri::command]
async fn agent_auth_apikey(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    provider: String,
    key: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .post(format!("{}/auth/apikey", sidecar_base(port)))
        .json(&serde_json::json!({ "provider": provider, "key": key }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: begin an OAuth login. Progress streams back via `agent-event`
/// (`auth_url`, `auth_status`, `auth_need_code`, `auth_done`, `auth_error`).
#[tauri::command]
async fn agent_auth_oauth_start(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    provider: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .post(format!("{}/auth/oauth/start", sidecar_base(port)))
        .json(&serde_json::json!({ "provider": provider }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: submit a pasted OAuth code to an in-flight login.
#[tauri::command]
async fn agent_auth_oauth_code(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    code: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .post(format!("{}/auth/oauth/code", sidecar_base(port)))
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: disconnect a provider (clear its stored credentials).
#[tauri::command]
async fn agent_auth_logout(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    provider: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .post(format!("{}/auth/logout", sidecar_base(port)))
        .json(&serde_json::json!({ "provider": provider }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: stop a background task by id. Returns `{ message }`.
#[tauri::command]
async fn agent_kill_task(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .post(format!("{}/kill", sidecar_base(port)))
        .json(&serde_json::json!({ "id": id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: radio state for THIS window's sidecar — `{ stations, current }`.
/// Playback lives in the per-window sidecar process, so each window's radio is
/// independent (opening more windows never duplicates audio).
#[tauri::command]
async fn agent_radio_state(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .get(format!("{}/radio", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: play a station by id, or stop with `station = "off"`. Returns
/// `{ current }` on success, an error message (e.g. no player installed) on 4xx.
#[tauri::command]
async fn agent_radio_set(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    station: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .post(format!("{}/radio", sidecar_base(port)))
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

/// Proxy: list this project's task list (the ~/.gg-tasks store for its cwd).
#[tauri::command]
async fn agent_tasks(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .get(format!("{}/tasks", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: run one task (`id`) or run-all (`all = true`, starting from the next
/// pending task). Progress streams back via `agent-event` (session_reset,
/// task_start, run_start/run_end, tasks_list, tasks_run_done).
#[tauri::command]
async fn agent_run_tasks(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: Option<String>,
    all: bool,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .post(format!("{}/tasks/run", sidecar_base(port)))
        .json(&serde_json::json!({ "id": id, "all": all }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: delete a task by id. Returns the remaining `{ tasks }`.
#[tauri::command]
async fn agent_delete_task(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .post(format!("{}/tasks/delete", sidecar_base(port)))
        .json(&serde_json::json!({ "id": id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: cancel the in-flight run.
#[tauri::command]
async fn agent_cancel(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    client
        .post(format!("{}/cancel", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Proxy: list workflow (prompt-template) slash commands.
#[tauri::command]
async fn agent_commands(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .get(format!("{}/commands", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: list models available to the logged-in providers.
#[tauri::command]
async fn agent_models(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .get(format!("{}/models", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: switch the active model. Returns the new provider/model + thinking state.
#[tauri::command]
async fn agent_switch_model(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    model: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .post(format!("{}/model", sidecar_base(port)))
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: cycle the reasoning/thinking level to the next supported value.
/// Returns the new `{ thinkingLevel, supportedThinkingLevels }`.
#[tauri::command]
async fn agent_cycle_thinking(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .post(format!("{}/thinking", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: read gg-app settings (e.g. the projects root folder).
#[tauri::command]
async fn agent_settings(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .get(format!("{}/settings", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: save gg-app settings.
#[tauri::command]
async fn agent_save_settings(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    projects_root: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .post(format!("{}/settings", sidecar_base(port)))
        .json(&serde_json::json!({ "projectsRoot": projects_root }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: create a new project folder under the configured projects root.
/// Returns `{ path }` on success, or an error message on validation/conflict.
#[tauri::command]
async fn agent_create_project(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    name: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .post(format!("{}/create-project", sidecar_base(port)))
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

/// Proxy: discover known projects across ggcoder/Claude Code/Codex stores.
#[tauri::command]
async fn agent_projects(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let res = client
        .get(format!("{}/projects", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: list recent sessions for a project cwd.
#[tauri::command]
async fn agent_sessions(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    cwd: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("sidecar not ready")?;
    let encoded = urlencoding(&cwd);
    let res = client
        .get(format!("{}/sessions?cwd={}", sidecar_base(port), encoded))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Minimal percent-encoding for a filesystem path in a query string.
fn urlencoding(s: &str) -> String {
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

/// App background (#111317) painted on the native window + webview BEFORE the
/// first frame, so opening a new window never flashes white.
const APP_BG: tauri::window::Color = tauri::window::Color(15, 17, 21, 255);

/// Per-OS window chrome decision. macOS uses the Overlay title bar (webview
/// draws under the traffic lights); every other OS keeps native decorations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowChrome {
    MacOverlay,
    Native,
}

/// Compile-time chrome selection: Overlay only on macOS, native elsewhere.
fn window_chrome() -> WindowChrome {
    if cfg!(target_os = "macos") {
        WindowChrome::MacOverlay
    } else {
        WindowChrome::Native
    }
}

/// Apply the macOS Overlay title bar + hidden title to a window builder. Kept
/// behind `#[cfg(target_os = "macos")]` because `TitleBarStyle::Overlay` and
/// `hidden_title` are macOS-only builder methods.
#[cfg(target_os = "macos")]
fn apply_mac_overlay<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
}

/// No-op on non-macOS: native chrome is the default, nothing to apply.
#[cfg(not(target_os = "macos"))]
fn apply_mac_overlay<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
}

/// Build an app window with the standard chrome. On macOS this includes the
/// Overlay title bar + `hidden_title(true)` so the native title text never
/// shows — the in-app `chat-head-title` is the ONLY title. Building via the
/// builder (rather than the config + a runtime patch) is the only way to hide
/// the native title, since there's no runtime `set_hidden_title` setter.
fn build_app_window(app: &tauri::AppHandle, label: &str) -> Result<WebviewWindow, String> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("GG Coder")
        .inner_size(1024.0, 720.0)
        .min_inner_size(480.0, 360.0)
        .background_color(APP_BG)
        // Let the webview's HTML drop handler receive files (Tauri's native
        // drag-drop would otherwise intercept them).
        .disable_drag_drop_handler();
    if matches!(window_chrome(), WindowChrome::MacOverlay) {
        builder = apply_mac_overlay(builder);
    }
    builder.build().map_err(|e| e.to_string())
}

/// Open enough new project windows to reach `count` total (each with its own
/// agent sidecar at the default cwd), then tile the first `count` windows across
/// the work area like macOS fill&arrange. Project selection per window happens
/// in-app via the picker; windows open immediately.
#[tauri::command]
fn setup_windows(app: tauri::AppHandle, count: usize) -> Result<(), String> {
    let existing = app.webview_windows().len();
    let to_create = count.saturating_sub(existing);
    for _ in 0..to_create {
        let label = next_window_label(&app);
        // macOS-only chrome: the Overlay title bar + hidden title lets the
        // webview draw under the traffic lights. Windows/Linux keep native
        // chrome (Overlay is a no-op / unsupported there) and the webview CSS
        // drops the mac traffic-light insets via the `.platform-*` class.
        let win = build_app_window(&app, &label)?;
        spawn_sidecar(app.clone(), label, default_cwd());
        let _ = win.set_focus();
    }
    arrange_windows(&app, count);
    Ok(())
}

/// Re-point THIS window's agent at a chosen project: kill its sidecar and spawn
/// a fresh one at `cwd`, optionally resuming the session file `session_path`.
/// The webview re-runs its ready flow against the new sidecar.
#[tauri::command]
fn select_project(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    cwd: String,
    session_path: Option<String>,
) -> Result<(), String> {
    let label = webview.label().to_string();
    {
        let state: State<Sidecars> = app.state();
        let mut map = state.map.lock().unwrap();
        if let Some(inst) = map.get_mut(&label) {
            inst.port = None;
            if let Some(child) = inst.child.take() {
                terminate_child(child);
            }
        }
    }
    spawn_sidecar_with_session(app, label, PathBuf::from(cwd), session_path);
    Ok(())
}

/// Allocate a unique `project-N` window label.
fn next_window_label(app: &tauri::AppHandle) -> String {
    let mut n = 1;
    loop {
        let label = format!("project-{n}");
        if app.get_webview_window(&label).is_none() {
            return label;
        }
        n += 1;
    }
}

/// Tile the first `count` windows into a grid filling the primary work area:
/// 2 → side-by-side halves, 4 → 2×2 quadrants, 6 → 3×2. "main" is placed first.
fn arrange_windows(app: &tauri::AppHandle, count: usize) {
    let mut windows: Vec<WebviewWindow> = app.webview_windows().into_values().collect();
    // Deterministic order: main first, then project-N ascending.
    windows.sort_by(|a, b| label_rank(a.label()).cmp(&label_rank(b.label())));
    let tiles: Vec<WebviewWindow> = windows.into_iter().take(count).collect();
    if tiles.is_empty() {
        return;
    }

    let Some(monitor) = tiles[0].primary_monitor().ok().flatten() else {
        return;
    };
    let area = monitor.work_area();
    let (ox, oy) = (area.position.x, area.position.y);
    let (w, h) = (area.size.width as i32, area.size.height as i32);

    // Column count: 2-up → 2×1, 4-up → 2×2, 6-up → 3×2 (wide displays read
    // better with 3 columns than 2). Falls back to 2 columns otherwise.
    let cols: i32 = if count <= 2 {
        count.max(1) as i32
    } else if count >= 6 {
        3
    } else {
        2
    };
    let rows: i32 = ((count as i32) + cols - 1) / cols;
    let cell_w = w / cols;
    let cell_h = h / rows;

    for (i, win) in tiles.iter().enumerate() {
        let col = (i as i32) % cols;
        let row = (i as i32) / cols;
        let x = ox + col * cell_w;
        let y = oy + row * cell_h;
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        let _ = win.set_size(tauri::PhysicalSize::new(cell_w as u32, cell_h as u32));
    }
}

fn label_rank(label: &str) -> (u8, u32) {
    if label == "main" {
        (0, 0)
    } else if let Some(n) = label.strip_prefix("project-").and_then(|s| s.parse().ok()) {
        (1, n)
    } else {
        (2, 0)
    }
}

/// Connect to a window's sidecar SSE stream and re-emit each frame ONLY to that
/// window (`emit_to` the window label) as `agent-event`, so windows never see
/// each other's agent activity. Rust has no mixed-content restriction, so the
/// webview never touches plain HTTP directly. Reconnects on stream end.
fn start_event_bridge(app: tauri::AppHandle, label: String, port: u16) {
    // Reuse the app's shared HTTP client (cheap Arc clone) so the SSE connect
    // shares the connection pool with the proxy commands.
    let client = app.state::<reqwest::Client>().inner().clone();
    tauri::async_runtime::spawn(async move {
        loop {
            // Stop once this window's active sidecar port has moved on (project
            // switch respawned the sidecar) or the window is gone — otherwise the
            // old bridge would reconnect to a dead port forever.
            {
                let state: State<Sidecars> = app.state();
                let map = state.map.lock().unwrap();
                if map.get(&label).and_then(|i| i.port) != Some(port) {
                    log::debug!("event bridge for {label}:{port} retired");
                    return;
                }
            }
            let url = format!("{}/events", sidecar_base(port));
            match client.get(&url).send().await {
                Ok(res) => {
                    let mut stream = res.bytes_stream();
                    let mut buf = String::new();
                    while let Some(chunk) = stream.next().await {
                        let Ok(bytes) = chunk else { break };
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        // SSE frames are separated by a blank line.
                        while let Some(idx) = buf.find("\n\n") {
                            let frame = buf[..idx].to_string();
                            buf.drain(..idx + 2);
                            for line in frame.lines() {
                                if let Some(payload) = line.strip_prefix("data: ") {
                                    if let Ok(value) =
                                        serde_json::from_str::<serde_json::Value>(payload)
                                    {
                                        let _ = app.emit_to(
                                            EventTarget::webview_window(label.clone()),
                                            "agent-event",
                                            value,
                                        );
                                    }
                                }
                            }
                        }
                    }
                    log::warn!("agent event stream ended, reconnecting");
                }
                Err(e) => {
                    log::error!("failed to connect to event stream: {e}");
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        }
    });
}

/// Resolve the Node runtime used to run the sidecar.
///
/// Dev (debug build, or `GG_NODE_BIN` set): use `GG_NODE_BIN`, else bare
/// `"node"` from PATH — matches the workspace developer flow.
///
/// Bundled (release): use the per-platform Node staged as a Tauri `externalBin`,
/// which Tauri places next to the app executable named `ggnode` (`.exe` on
/// Windows). This removes any dependency on a Node install on the user's PATH
/// (a Finder/Dock-launched `.app` gets a minimal PATH without nvm/homebrew).
fn resolve_node(_app: &tauri::AppHandle) -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.to_path_buf()));
    pick_node(
        std::env::var("GG_NODE_BIN").ok(),
        cfg!(debug_assertions),
        exe_dir.as_deref(),
    )
}

/// Pure node-path decision (testable without an AppHandle).
/// - `env_override` (GG_NODE_BIN) always wins.
/// - dev build → bare `"node"` from PATH.
/// - bundled → `ggnode(.exe)` next to the executable if present, else `"node"`.
fn pick_node(env_override: Option<String>, is_dev: bool, exe_dir: Option<&Path>) -> PathBuf {
    if let Some(p) = env_override {
        return PathBuf::from(p);
    }
    if is_dev {
        return PathBuf::from("node");
    }
    let name = if cfg!(target_os = "windows") {
        "ggnode.exe"
    } else {
        "ggnode"
    };
    match exe_dir.map(|d| d.join(name)) {
        Some(p) if p.exists() => p,
        _ => PathBuf::from("node"),
    }
}

/// Resolve the built sidecar JS.
///
/// Dev (debug build, or `GG_SIDECAR_PATH` set): use `GG_SIDECAR_PATH`, else the
/// workspace `dist/app-sidecar.js` relative to this crate.
///
/// Bundled (release): resolve the single-file ESM sidecar shipped under
/// `bundle.resources` via the Tauri resource directory.
fn resolve_sidecar(app: &tauri::AppHandle) -> PathBuf {
    let resource = app
        .path()
        .resolve("sidecar/app-sidecar.mjs", tauri::path::BaseDirectory::Resource)
        .ok();
    pick_sidecar(
        std::env::var("GG_SIDECAR_PATH").ok(),
        cfg!(debug_assertions),
        resource.as_deref(),
    )
}

/// Path to the workspace dev sidecar, relative to this crate.
fn workspace_sidecar() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/ggcoder/dist/app-sidecar.js")
}

/// Pure sidecar-path decision (testable without an AppHandle).
/// - `env_override` (GG_SIDECAR_PATH) always wins.
/// - dev build → workspace `dist/app-sidecar.js`.
/// - bundled → the resolved bundle resource, falling back to the workspace path.
fn pick_sidecar(env_override: Option<String>, is_dev: bool, resource: Option<&Path>) -> PathBuf {
    if let Some(p) = env_override {
        return PathBuf::from(p);
    }
    if is_dev {
        return workspace_sidecar();
    }
    match resource {
        Some(p) => p.to_path_buf(),
        None => workspace_sidecar(),
    }
}

/// Default working directory for the main window. Override with GG_APP_CWD;
/// otherwise the workspace root in dev, or the user's home dir in release.
/// Canonicalized so traversal segments (`../..`) don't leak into the session
/// store path and surface as a stray ".." project in the picker.
fn default_cwd() -> PathBuf {
    let raw = pick_cwd(
        std::env::var("GG_APP_CWD").ok(),
        cfg!(debug_assertions),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
        home_dir(),
    );
    std::fs::canonicalize(&raw).unwrap_or(raw)
}

/// The current user's home directory, from HOME (Unix) / USERPROFILE (Windows).
/// Falls back to "/" only if neither is set (effectively never on a real OS).
fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Pure cwd decision (testable without touching env/filesystem).
/// - `env_override` (GG_APP_CWD) always wins.
/// - dev build → the workspace root (`CARGO_MANIFEST_DIR/../..`).
/// - bundled (release) → `home`. `CARGO_MANIFEST_DIR` is baked in at COMPILE
///   time, so in a shipped binary it's the CI build machine's path (e.g.
///   `/Users/runner/work/...`) which doesn't exist on the user's machine — the
///   sidecar would crash with EACCES trying to use it. Home always exists and
///   is writable; the project picker re-points the window immediately anyway.
fn pick_cwd(env_override: Option<String>, is_dev: bool, dev_root: PathBuf, home: PathBuf) -> PathBuf {
    if let Some(p) = env_override {
        return PathBuf::from(p);
    }
    if is_dev {
        return dev_root;
    }
    home
}

/// Spawn a Node agent sidecar bound to one window (`label`) + project `cwd`.
/// Port/ready/error/event traffic is routed only to that window.
fn spawn_sidecar(app: tauri::AppHandle, label: String, cwd: PathBuf) {
    spawn_sidecar_with_session(app, label, cwd, None);
}

/// Like `spawn_sidecar`, but optionally resumes an existing session file.
fn spawn_sidecar_with_session(
    app: tauri::AppHandle,
    label: String,
    cwd: PathBuf,
    session_path: Option<String>,
) {
    let script = resolve_sidecar(&app);
    let node = resolve_node(&app);
    log::info!(
        "spawning sidecar for {label}: {} {} (cwd={})",
        node.display(),
        script.display(),
        cwd.display()
    );

    let mut cmd = Command::new(node);
    cmd.arg(&script)
        // Port 0 → the OS assigns a free port, reported back via the
        // GG_APP_LISTENING handshake. Avoids EADDRINUSE across windows.
        .env("GG_APP_PORT", "0")
        .env("GG_APP_CWD", &cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(sp) = session_path {
        cmd.env("GG_APP_SESSION_ID", sp);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log::error!("failed to spawn sidecar: {e}");
            let _ = app.emit_to(
                EventTarget::webview_window(label.clone()),
                "sidecar-error",
                format!("failed to spawn sidecar: {e}"),
            );
            return;
        }
    };

    if let Some(stdout) = child.stdout.take() {
        let app2 = app.clone();
        let label2 = label.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("GG_APP_LISTENING ") {
                    if let Ok(port) = rest.trim().parse::<u16>() {
                        log::info!("sidecar for {label2} listening on port {port}");
                        {
                            let state: State<Sidecars> = app2.state();
                            let mut map = state.map.lock().unwrap();
                            map.entry(label2.clone()).or_default().port = Some(port);
                        }
                        start_event_bridge(app2.clone(), label2.clone(), port);
                        let _ = app2.emit_to(
                            EventTarget::webview_window(label2.clone()),
                            "sidecar-ready",
                            port,
                        );
                    }
                } else {
                    log::debug!("[sidecar:{label2}] {line}");
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app3 = app.clone();
        let label3 = label.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                log::error!("[sidecar:{label3}:stderr] {line}");
                if line.starts_with("GG_APP_FATAL") {
                    let _ = app3.emit_to(
                        EventTarget::webview_window(label3.clone()),
                        "sidecar-error",
                        line,
                    );
                }
            }
        });
    }

    let state: State<Sidecars> = app.state();
    let mut map = state.map.lock().unwrap();
    map.entry(label).or_default().child = Some(child);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("gg-app".into()),
                    },
                ))
                .build(),
        )
        .manage(Sidecars::default())
        .manage(reqwest::Client::new())
        .invoke_handler(tauri::generate_handler![
            sidecar_port,
            agent_state,
            agent_prompt,
            agent_cancel,
            agent_new_session,
            agent_history,
            agent_auth_status,
            agent_auth_apikey,
            agent_auth_oauth_start,
            agent_auth_oauth_code,
            agent_auth_logout,
            agent_kill_task,
            agent_radio_state,
            agent_radio_set,
            agent_tasks,
            agent_run_tasks,
            agent_delete_task,
            agent_cycle_thinking,
            agent_models,
            agent_switch_model,
            agent_commands,
            setup_windows,
            select_project,
            agent_projects,
            agent_sessions,
            agent_settings,
            agent_save_settings,
            agent_create_project
        ])
        .setup(|app| {
            // Build the main window in code (not from config) so macOS gets
            // `hidden_title(true)` via the builder — there's no runtime setter,
            // and without it the native "GG Coder" title would linger alongside
            // the in-app title. `build_app_window` applies the same chrome as
            // secondary windows.
            build_app_window(&app.handle().clone(), "main")?;
            // The main window gets its sidecar at the default cwd.
            spawn_sidecar(app.handle().clone(), "main".into(), default_cwd());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Kill only THIS window's sidecar so other projects keep running.
                let state: State<Sidecars> = window.state();
                let child = state
                    .map
                    .lock()
                    .unwrap()
                    .remove(window.label())
                    .and_then(|mut i| i.child.take());
                if let Some(child) = child {
                    terminate_child(child);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_node_env_override_wins() {
        let got = pick_node(Some("/opt/node".into()), true, None);
        assert_eq!(got, PathBuf::from("/opt/node"));
        // ...even in bundled mode with a present exe dir.
        let got = pick_node(Some("/opt/node".into()), false, Some(Path::new("/app")));
        assert_eq!(got, PathBuf::from("/opt/node"));
    }

    #[test]
    fn pick_node_dev_uses_path() {
        let got = pick_node(None, true, Some(Path::new("/app")));
        assert_eq!(got, PathBuf::from("node"));
    }

    #[test]
    fn pick_node_bundled_uses_exe_dir_when_present() {
        let tmp = std::env::temp_dir().join(format!("ggnode-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let name = if cfg!(target_os = "windows") {
            "ggnode.exe"
        } else {
            "ggnode"
        };
        let staged = tmp.join(name);
        std::fs::write(&staged, b"").unwrap();
        let got = pick_node(None, false, Some(&tmp));
        assert_eq!(got, staged);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn pick_node_bundled_falls_back_when_missing() {
        let got = pick_node(None, false, Some(Path::new("/nonexistent-dir-xyz")));
        assert_eq!(got, PathBuf::from("node"));
    }

    #[test]
    fn pick_sidecar_env_override_wins() {
        let got = pick_sidecar(Some("/x/side.mjs".into()), true, None);
        assert_eq!(got, PathBuf::from("/x/side.mjs"));
        let got = pick_sidecar(
            Some("/x/side.mjs".into()),
            false,
            Some(Path::new("/res/sidecar/app-sidecar.mjs")),
        );
        assert_eq!(got, PathBuf::from("/x/side.mjs"));
    }

    #[test]
    fn pick_sidecar_dev_uses_workspace() {
        let got = pick_sidecar(None, true, Some(Path::new("/res/app-sidecar.mjs")));
        assert_eq!(got, workspace_sidecar());
    }

    #[test]
    fn pick_sidecar_bundled_uses_resource() {
        let res = Path::new("/res/sidecar/app-sidecar.mjs");
        let got = pick_sidecar(None, false, Some(res));
        assert_eq!(got, res.to_path_buf());
    }

    #[test]
    fn pick_sidecar_bundled_falls_back_without_resource() {
        let got = pick_sidecar(None, false, None);
        assert_eq!(got, workspace_sidecar());
    }

    #[test]
    fn pick_cwd_env_override_wins() {
        let got = pick_cwd(
            Some("/work/proj".into()),
            true,
            PathBuf::from("/repo"),
            PathBuf::from("/home/user"),
        );
        assert_eq!(got, PathBuf::from("/work/proj"));
        // ...even in release mode.
        let got = pick_cwd(
            Some("/work/proj".into()),
            false,
            PathBuf::from("/repo"),
            PathBuf::from("/home/user"),
        );
        assert_eq!(got, PathBuf::from("/work/proj"));
    }

    #[test]
    fn pick_cwd_dev_uses_workspace_root() {
        let got = pick_cwd(None, true, PathBuf::from("/repo"), PathBuf::from("/home/user"));
        assert_eq!(got, PathBuf::from("/repo"));
    }

    #[test]
    fn pick_cwd_release_uses_home_not_build_path() {
        // The crux of the release bug: in a shipped binary the dev_root is the CI
        // build machine's path; release must ignore it and use the home dir.
        let got = pick_cwd(
            None,
            false,
            PathBuf::from("/Users/runner/work/gg-framework/gg-framework"),
            PathBuf::from("/home/user"),
        );
        assert_eq!(got, PathBuf::from("/home/user"));
    }

    #[test]
    fn window_chrome_matches_target_os() {
        let got = window_chrome();
        if cfg!(target_os = "macos") {
            assert_eq!(got, WindowChrome::MacOverlay);
        } else {
            assert_eq!(got, WindowChrome::Native);
        }
    }
}
