//! Native app settings (~/.kleio/gg-app.json) and the workspace snapshot.

use crate::*;

// ── Native app settings (~/.gg/gg-app.json) ───────────────────────────────
// The project folder is a plain home-dir file with NOTHING to do with the
// agent, so Rust reads/writes it directly. This makes the home-screen Settings
// + New project flow independent of the Node sidecar's boot — a slow or crashed
// sidecar used to make "Save project folder" silently fail or time out even on
// up-to-date builds. (The sidecar keeps its own /settings endpoint for its
// internal use; this is the authoritative path for the webview.)

/// Absolute path to ~/.gg/gg-app.json.
pub(crate) fn app_settings_path() -> PathBuf {
    app_state_dir().join("gg-app.json")
}

/// Default projects root: ~/gg-projects.
pub(crate) fn default_projects_root() -> PathBuf {
    home_dir().join("gg-projects")
}

/// Validate a project folder name: lowercase letters, digits, single dashes
/// between segments (mirrors the sidecar's isValidProjectName).
pub(crate) fn is_valid_project_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    // ^[a-z0-9]+(?:-[a-z0-9]+)*$ — no leading/trailing/double dashes.
    let bytes = name.as_bytes();
    if bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' {
        return false;
    }
    let mut prev_dash = false;
    for &b in bytes {
        match b {
            b'a'..=b'z' | b'0'..=b'9' => prev_dash = false,
            b'-' => {
                if prev_dash {
                    return false;
                }
                prev_dash = true;
            }
            _ => return false,
        }
    }
    true
}

/// Native: read gg-app settings directly from ~/.gg/gg-app.json. `configured`
/// is true only when the file exists with a non-empty projectsRoot (so the home
/// screen's "Your Projects" gate matches the sidecar's semantics). Never needs
/// the sidecar.
#[tauri::command]
pub(crate) async fn app_settings_get(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    // kleio: a paired host owns the projects root — the paths are the HOST's,
    // so read them through the sidecar (session-scoped) instead of ~/.gg here.
    if kleio::remote().is_some() {
        let port = port_for(&webview).ok_or("daemon not ready")?;
        let gg_sid = session_for(&webview).ok_or("session not ready")?;
        return kleio::host_settings(&client, &sidecar_base(port), &gg_sid).await;
    }
    Ok(local_settings_get())
}

pub(crate) fn local_settings_get() -> serde_json::Value {
    let raw = std::fs::read_to_string(app_settings_path()).ok();
    let parsed = raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
    let configured = parsed
        .as_ref()
        .and_then(|v| v.get("projectsRoot"))
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let projects_root = parsed
        .as_ref()
        .and_then(|v| v.get("projectsRoot"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| default_projects_root().to_string_lossy().to_string());
    serde_json::json!({ "projectsRoot": projects_root, "configured": configured })
}

/// Native: write gg-app settings directly to ~/.gg/gg-app.json. Creates the
/// ~/.gg directory if needed. Never needs the sidecar.
#[tauri::command]
pub(crate) async fn app_settings_save(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    projects_root: String,
) -> Result<serde_json::Value, String> {
    let trimmed = projects_root.trim();
    if trimmed.is_empty() {
        return Err("projectsRoot is required".to_string());
    }
    // kleio: save on the host, not here.
    if kleio::remote().is_some() {
        let port = port_for(&webview).ok_or("daemon not ready")?;
        let gg_sid = session_for(&webview).ok_or("session not ready")?;
        return kleio::host_settings_save(&client, &sidecar_base(port), &gg_sid, trimmed).await;
    }
    let path = app_settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Change ONLY projectsRoot. gg-app.json also holds the sidecar's per-project
    // model/autopilot/Ken prefs, extra project folders, hidden projects and
    // local endpoints — overwriting the file wiped all of them.
    with_settings_lock(&path, || {
        let existing = std::fs::read_to_string(&path).ok();
        let body = merge_projects_root(existing.as_deref(), trimmed);
        let pretty = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
        write_atomic(&path, &pretty)
    })?;
    Ok(serde_json::json!({ "projectsRoot": trimmed }))
}

/// The settings object with `projectsRoot` set and every other key kept. A
/// missing, unreadable or non-object file starts from an empty object.
pub(crate) fn merge_projects_root(
    existing: Option<&str>,
    projects_root: &str,
) -> serde_json::Value {
    let mut body = existing
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    body["projectsRoot"] = serde_json::Value::String(projects_root.to_string());
    body
}

/// Temp file + rename, so the sidecar never reads a half-written gg-app.json.
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Hold the same `<file>.lock` the sidecar takes (gg-core `withFileLock`:
/// created exclusively, `{pid,timestamp}` body, stale after 10s), so a Settings
/// save can't interleave with a sidecar read-modify-write of the same file.
/// Gives up waiting after 5s and writes anyway, like the sidecar's lock.
fn with_settings_lock<T>(path: &Path, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    use std::io::Write;
    const STALE_MS: u128 = 10_000;
    let lock = PathBuf::from(format!("{}.lock", path.display()));
    let now_ms = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    };
    let start = std::time::Instant::now();
    let mut held = false;
    while start.elapsed() < std::time::Duration::from_secs(5) {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
        {
            Ok(mut file) => {
                let _ = write!(
                    file,
                    "{{\"pid\":{},\"timestamp\":{}}}",
                    std::process::id(),
                    now_ms()
                );
                held = true;
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = std::fs::read_to_string(&lock)
                    .ok()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                    .and_then(|v| v.get("timestamp").and_then(|t| t.as_u64()))
                    .map(|ts| now_ms().saturating_sub(ts as u128) > STALE_MS)
                    .unwrap_or(true);
                if stale {
                    let _ = std::fs::remove_file(&lock);
                    continue;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => break,
        }
    }
    let result = f();
    if held {
        let _ = std::fs::remove_file(&lock);
    }
    result
}
/// Leads `app_create_project`'s error when the folder is already there, so the
/// New project dialog can offer to open it (the rest is the message to show).
pub(crate) const PROJECT_EXISTS: &str = "exists:";

/// Native: create a new project folder under the configured projects root.
/// Returns `{ path }` on success, an error message on invalid name / conflict.
/// Locally this never needs the sidecar.
#[tauri::command]
pub(crate) async fn app_create_project(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    name: String,
) -> Result<serde_json::Value, String> {
    let name = name.trim();
    if !is_valid_project_name(name) {
        return Err(
            "Project name must be lowercase letters, digits, and dashes (e.g. my-project)."
                .to_string(),
        );
    }
    // kleio: sessions run on the host, and the projects root shown is the
    // HOST's (see app_settings_get), so the folder is made there.
    if kleio::remote().is_some() {
        let port = port_for(&webview).ok_or(STILL_CONNECTING)?;
        let gg_sid = session_for(&webview).ok_or(STILL_CONNECTING)?;
        return kleio::host_create_project(&client, &sidecar_base(port), &gg_sid, name).await;
    }
    // Resolve the projects root the same way app_settings_get does.
    let settings = local_settings_get();
    let root = settings
        .get("projectsRoot")
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(default_projects_root);
    let dir = root.join(name);
    if dir.exists() {
        return Err(format!(
            "{PROJECT_EXISTS}A folder named \"{name}\" already exists."
        ));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "path": dir.to_string_lossy() }))
}

// ── Workspace snapshot (~/.gg/gg-app-workspace.json) ──────────────────────
// Records which project/session is open in each window (plus geometry) so a
// restart — especially the updater's relaunch() — can reopen every window where
// it left off instead of dropping back to a single picker window. Owned by Rust
// (same pattern as gg-app.json), written on project-select / window-close /
// app-exit, replayed in `setup`.

/// One saved window: its mode, cwd, an optional session file to resume, and
/// optional last-known geometry (physical pixels).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct WorkspaceEntry {
    #[serde(default)]
    pub(crate) mode: WorkspaceMode,
    #[serde(rename = "chatAgent", default)]
    pub(crate) chat_agent: ChatAgent,
    pub(crate) cwd: String,
    #[serde(
        rename = "sessionPath",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) session_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) y: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) height: Option<u32>,
}

/// The whole snapshot: an ordered list of open windows (main first).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct Workspace {
    #[serde(default)]
    pub(crate) windows: Vec<WorkspaceEntry>,
}

/// Absolute path to ~/.gg/gg-app-workspace.json.
pub(crate) fn app_workspace_path() -> PathBuf {
    app_state_dir().join("gg-app-workspace.json")
}

/// Read the workspace snapshot; missing/invalid file → an empty workspace.
pub(crate) fn read_workspace() -> Workspace {
    std::fs::read_to_string(app_workspace_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Workspace>(&s).ok())
        .unwrap_or_default()
}

/// Write the workspace snapshot (creating ~/.gg if needed). Best-effort.
pub(crate) fn write_workspace(ws: &Workspace) {
    let path = app_workspace_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(pretty) = serde_json::to_string_pretty(ws) {
        let _ = std::fs::write(&path, pretty);
    }
}

/// Pure: picker-only windows have a daemon session at the default boot cwd but
/// no active workspace target. A selected project remains snapshot-worthy even
/// when its path happens to equal that default cwd.
pub(crate) fn keep_for_snapshot(workspace_selected: bool, cwd: Option<&Path>) -> bool {
    workspace_selected && cwd.is_some()
}

/// Pure: drop restore entries that can't be opened (empty cwd, or a cwd that no
/// longer exists). `exists` is injected so this is testable without the fs.
pub(crate) fn filter_restorable<F: Fn(&str) -> bool>(
    windows: Vec<WorkspaceEntry>,
    exists: F,
) -> Vec<WorkspaceEntry> {
    windows
        .into_iter()
        .filter(|w| !w.cwd.trim().is_empty() && exists(&w.cwd))
        .collect()
}

/// Walk every live window + its `Windows` session entry and write a fresh
/// snapshot. Picker-only windows (without an active target) are excluded.
/// Geometry is captured from each window's current outer position + inner size.
pub(crate) fn snapshot_workspace(app: &tauri::AppHandle) {
    let windows = app.webview_windows();
    let selected_labels: HashSet<String> = app
        .state::<RestoreTargets>()
        .map
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    let state: State<Windows> = app.state();
    let map = state.map.lock().unwrap();

    // Deterministic order: main first, then project-N ascending, so the first
    // restored window reclaims the `main` label.
    let mut labels: Vec<String> = windows.keys().cloned().collect();
    labels.sort_by_key(|a| label_rank(a));

    let mut entries: Vec<WorkspaceEntry> = Vec::new();
    for label in &labels {
        let Some(inst) = map.get(label) else { continue };
        let cwd = inst.cwd.as_deref();
        if !keep_for_snapshot(selected_labels.contains(label), cwd) {
            continue;
        }
        let cwd = cwd.unwrap().to_string_lossy().to_string();
        let (mut x, mut y, mut width, mut height) = (None, None, None, None);
        if let Some(win) = windows.get(label) {
            if let Ok(pos) = win.outer_position() {
                x = Some(pos.x);
                y = Some(pos.y);
            }
            if let Ok(size) = win.inner_size() {
                width = Some(size.width);
                height = Some(size.height);
            }
        }
        entries.push(WorkspaceEntry {
            mode: inst.mode,
            chat_agent: inst.chat_agent,
            cwd,
            session_path: inst.session_path.clone(),
            x,
            y,
            width,
            height,
        });
    }
    drop(map);
    write_workspace(&Workspace { windows: entries });
}

/// Remove one window's entry from the snapshot (deliberate user close). Keyed by
/// the window's recorded mode + cwd, since the snapshot has no labels.
pub(crate) fn remove_window_from_workspace(app: &tauri::AppHandle, label: &str) {
    let target = {
        let state: State<Windows> = app.state();
        let map = state.map.lock().unwrap();
        map.get(label).and_then(|i| {
            i.cwd
                .as_ref()
                .map(|cwd| (i.mode, i.chat_agent, cwd.to_string_lossy().to_string()))
        })
    };
    let Some((mode, chat_agent, cwd)) = target else {
        return;
    };
    let mut ws = read_workspace();
    // Remove a SINGLE matching entry: duplicate windows must restore independently.
    if let Some(idx) = ws
        .windows
        .iter()
        .position(|w| w.mode == mode && w.chat_agent == chat_agent && w.cwd == cwd)
    {
        ws.windows.remove(idx);
        write_workspace(&ws);
    }
}

/// Hand the calling webview its active workspace target so it can skip Home and
/// hydrate the existing daemon session. Unlike the old consume-once target, this
/// remains available across React remounts and WebKit content-process reloads.
#[tauri::command]
pub(crate) fn window_restore_target(webview: WebviewWindow) -> Option<RestoreEntry> {
    let state: State<RestoreTargets> = webview.state();
    let map = state.map.lock().unwrap();
    restore_target(&map, webview.label())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saving_projects_root_keeps_every_other_setting() {
        let existing = r#"{
            "projectsRoot": "/old",
            "projectModels": {"/p": {"provider": "anthropic", "model": "m"}},
            "autopilot": {"/p": true},
            "hiddenProjects": ["/x"],
            "localEndpoints": [{"id": "lan", "baseUrl": "http://h:1"}],
            "someFutureKey": 7
        }"#;
        let merged = merge_projects_root(Some(existing), "/new");
        assert_eq!(merged["projectsRoot"], "/new");
        assert_eq!(merged["projectModels"]["/p"]["model"], "m");
        assert_eq!(merged["autopilot"]["/p"], true);
        assert_eq!(merged["hiddenProjects"][0], "/x");
        assert_eq!(merged["localEndpoints"][0]["id"], "lan");
        assert_eq!(merged["someFutureKey"], 7);
    }

    #[test]
    fn saving_projects_root_over_a_missing_or_broken_file_starts_fresh() {
        for existing in [None, Some("not json"), Some("[1,2]")] {
            let merged = merge_projects_root(existing, "/new");
            assert_eq!(merged, serde_json::json!({ "projectsRoot": "/new" }));
        }
    }

    #[test]
    fn keep_for_snapshot_excludes_only_unselected_picker_windows() {
        let default = Path::new("/home/user");
        // Picker session exists at the boot cwd, but no workspace was chosen.
        assert!(!keep_for_snapshot(false, Some(default)));
        assert!(!keep_for_snapshot(false, None));
        // Explicitly choosing that exact directory must still survive restart.
        assert!(keep_for_snapshot(true, Some(default)));
        assert!(keep_for_snapshot(true, Some(Path::new("/home/user/proj"))));
    }

    #[test]
    fn filter_restorable_drops_missing_and_empty() {
        let windows = vec![
            WorkspaceEntry {
                cwd: "/exists/a".into(),
                ..Default::default()
            },
            WorkspaceEntry {
                cwd: "   ".into(),
                ..Default::default()
            },
            WorkspaceEntry {
                cwd: "/gone/b".into(),
                ..Default::default()
            },
        ];
        let kept = filter_restorable(windows, |c| c == "/exists/a");
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].cwd, "/exists/a");
    }

    #[test]
    fn workspace_roundtrips_through_json() {
        let ws = Workspace {
            windows: vec![
                WorkspaceEntry {
                    mode: WorkspaceMode::Chat,
                    chat_agent: ChatAgent::Research,
                    cwd: "/p/a".into(),
                    session_path: Some("/s/a.jsonl".into()),
                    x: Some(0),
                    y: Some(25),
                    width: Some(1280),
                    height: Some(800),
                },
                WorkspaceEntry {
                    cwd: "/p/b".into(),
                    ..Default::default()
                },
            ],
        };
        let json = serde_json::to_string(&ws).unwrap();
        let back: Workspace = serde_json::from_str(&json).unwrap();
        assert_eq!(ws, back);
        assert_eq!(back.windows[0].mode, WorkspaceMode::Chat);
        assert_eq!(back.windows[0].chat_agent, ChatAgent::Research);
        assert!(json.contains(r#""mode":"chat""#));
        assert!(json.contains(r#""chatAgent":"research""#));
        // The second entry omits optional fields entirely (skip_serializing_if).
        assert!(!json.contains("\"sessionPath\":null"));
    }

    #[test]
    fn workspace_defaults_legacy_and_invalid_modes_to_code() {
        let legacy: Workspace =
            serde_json::from_str(r#"{ "windows": [{ "cwd": "/p/a" }] }"#).unwrap();
        assert_eq!(legacy.windows[0].mode, WorkspaceMode::Code);
        assert_eq!(legacy.windows[0].chat_agent, ChatAgent::General);

        let invalid: Workspace =
            serde_json::from_str(r#"{ "windows": [{ "mode": "future", "cwd": "/p/a" }] }"#)
                .unwrap();
        assert_eq!(invalid.windows[0].mode, WorkspaceMode::Code);
    }

    #[test]
    fn workspace_restores_motion_mode() {
        let motion: Workspace =
            serde_json::from_str(r#"{ "windows": [{ "mode": "motion", "cwd": "/p/a" }] }"#)
                .unwrap();
        assert_eq!(motion.windows[0].mode, WorkspaceMode::Motion);
        assert!(serde_json::to_string(&motion)
            .unwrap()
            .contains(r#""mode":"motion""#));
    }

    #[test]
    fn restore_target_serializes_mode_and_session_path() {
        let target = RestoreEntry {
            mode: WorkspaceMode::Chat,
            chat_agent: ChatAgent::Therapist,
            cwd: "/p/a".into(),
            session_path: Some("/s/a.jsonl".into()),
        };
        let json = serde_json::to_value(target).unwrap();
        assert_eq!(json["mode"], "chat");
        assert_eq!(json["chatAgent"], "therapist");
        assert_eq!(json["cwd"], "/p/a");
        assert_eq!(json["sessionPath"], "/s/a.jsonl");
    }

    #[test]
    fn empty_or_missing_workspace_is_default() {
        let ws: Workspace = serde_json::from_str("{}").unwrap();
        assert!(ws.windows.is_empty());
    }
}
