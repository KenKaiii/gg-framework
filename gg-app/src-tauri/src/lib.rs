mod azure_connection;

use azure_connection::commands::{
    azure_connection_remove, azure_connection_save, azure_connection_status,
    AzureConnectionMutations,
};

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt as WindowsCommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

use base64::Engine as _;
use futures_util::StreamExt;
use tauri::{
    Emitter, EventTarget, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

/// The single shared Node daemon process. Every window's `AgentSession` lives
/// inside this one process as an in-process object, addressed by a session id
/// (see `Windows`). Replaces the old one-sidecar-process-per-window model: one
/// Node runtime + one module graph for all windows, instead of N.
#[derive(Default)]
struct Daemon {
    /// The daemon child process (process-group leader). `None` until spawned.
    child: Mutex<Option<Child>>,
    /// The daemon's HTTP port, learned from its `GG_APP_LISTENING` handshake.
    /// `None` until ready; reset to `None` across a crash-respawn.
    port: Mutex<Option<u16>>,
    /// Consecutive short-lived crashes. A daemon that stays up for the stable
    /// window resets this budget; repeated crashes hit a circuit breaker.
    respawn_attempts: Mutex<u32>,
    /// Monotonic successful-spawn counter used to await a completed refresh.
    generation: AtomicU64,
    /// Distinguishes a requested configuration refresh from a process crash.
    planned_reload: AtomicBool,
    /// Window labels awaiting a complete pane recovery before model refresh.
    model_refresh_windows: Mutex<HashSet<String>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum WorkspaceMode {
    Chat,
    #[default]
    #[serde(other)]
    Code,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum ChatAgent {
    Therapist,
    Research,
    #[default]
    #[serde(other)]
    General,
}

const PRIMARY_PANE_ID: &str = "primary";
const MAX_PANE_ID_LEN: usize = 64;
const MAX_AGENT_PANES_PER_WINDOW: usize = 12;
const DAEMON_SESSION_DISPOSAL_TIMEOUT: Duration = Duration::from_secs(10);

/// One logical pane's session inside the shared daemon.
#[derive(Default, Clone, Debug, PartialEq, Eq)]
struct PaneSession {
    session_id: Option<String>,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: Option<PathBuf>,
    session_path: Option<String>,
    generation: u64,
    startup_error: Option<String>,
}

#[derive(Default)]
struct PaneRegistry {
    windows: HashMap<String, HashMap<String, PaneSession>>,
    next_generation: u64,
}

impl std::ops::Deref for PaneRegistry {
    type Target = HashMap<String, HashMap<String, PaneSession>>;

    fn deref(&self) -> &Self::Target {
        &self.windows
    }
}

impl std::ops::DerefMut for PaneRegistry {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.windows
    }
}

/// Pane registry keyed by native owner window then validated logical pane ID.
#[derive(Default)]
struct Windows {
    map: Mutex<PaneRegistry>,
}

fn validate_pane_id(pane_id: &str) -> Result<(), String> {
    if pane_id.is_empty() || pane_id.len() > MAX_PANE_ID_LEN {
        return Err("pane id must contain 1-64 characters".into());
    }
    if !pane_id
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err("pane id contains unsupported characters".into());
    }
    Ok(())
}

fn resolve_owned_pane<'a>(
    registry: &'a PaneRegistry,
    owner_label: &str,
    pane_id: &str,
) -> Option<&'a PaneSession> {
    registry.get(owner_label)?.get(pane_id)
}

fn record_pane_target(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: PathBuf,
    session_path: Option<String>,
) -> u64 {
    registry.next_generation = registry.next_generation.saturating_add(1);
    let generation = registry.next_generation;
    registry.entry(owner_label.to_string()).or_default().insert(
        pane_id.to_string(),
        PaneSession {
            session_id: None,
            mode,
            chat_agent,
            cwd: Some(cwd),
            session_path,
            generation,
            startup_error: None,
        },
    );
    generation
}

fn create_pane_target(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: PathBuf,
    session_path: Option<String>,
) -> Result<u64, String> {
    validate_pane_id(pane_id)?;
    let panes = registry.get(owner_label);
    if panes.is_some_and(|panes| panes.contains_key(pane_id)) {
        return Err(format!("pane '{pane_id}' already exists"));
    }
    if panes.is_some_and(|panes| panes.len() >= MAX_AGENT_PANES_PER_WINDOW) {
        return Err(format!(
            "window cannot contain more than {MAX_AGENT_PANES_PER_WINDOW} agent panes"
        ));
    }
    Ok(record_pane_target(
        registry,
        owner_label,
        pane_id,
        mode,
        chat_agent,
        cwd,
        session_path,
    ))
}

fn restore_pane_target(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: PathBuf,
    session_path: Option<String>,
) -> Result<(u64, bool), String> {
    validate_pane_id(pane_id)?;
    if let Some(existing) = registry
        .get(owner_label)
        .and_then(|panes| panes.get(pane_id))
    {
        let generated_session_path = existing.session_id.is_some()
            && existing.session_path.is_none()
            && session_path.is_some();
        let bound_runtime_is_authoritative = existing.session_id.is_some();
        if (!bound_runtime_is_authoritative
            && (existing.mode != mode || existing.chat_agent != chat_agent))
            || existing.cwd.as_ref() != Some(&cwd)
            || (existing.session_path != session_path && !generated_session_path)
        {
            return Err(format!(
                "pane '{pane_id}' already exists with a different session target"
            ));
        }
        let should_relaunch = existing.session_id.is_none() || existing.startup_error.is_some();
        if !should_relaunch {
            let generation = existing.generation;
            if generated_session_path {
                registry
                    .get_mut(owner_label)
                    .and_then(|panes| panes.get_mut(pane_id))
                    .expect("pane existence checked")
                    .session_path = session_path;
            }
            return Ok((generation, false));
        }

        registry.next_generation = registry.next_generation.saturating_add(1);
        let generation = registry.next_generation;
        let existing = registry
            .get_mut(owner_label)
            .and_then(|panes| panes.get_mut(pane_id))
            .expect("pane existence checked");
        if generated_session_path {
            existing.session_path = session_path;
        }
        existing.generation = generation;
        existing.session_id = None;
        existing.startup_error = None;
        return Ok((generation, true));
    }
    create_pane_target(
        registry,
        owner_label,
        pane_id,
        mode,
        chat_agent,
        cwd,
        session_path,
    )
    .map(|generation| (generation, true))
}

fn take_pane_session(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
) -> Option<PaneSession> {
    let panes = registry.get_mut(owner_label)?;
    let pane = panes.remove(pane_id);
    if panes.is_empty() {
        registry.remove(owner_label);
    }
    pane
}

fn pane_disposal_target(
    registry: &PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    allow_primary: bool,
    expected_generation: Option<u64>,
) -> Result<PaneSession, String> {
    validate_pane_id(pane_id)?;
    if pane_id == PRIMARY_PANE_ID && !allow_primary {
        return Err("primary pane cannot be disposed".into());
    }
    let pane = resolve_owned_pane(registry, owner_label, pane_id)
        .ok_or_else(|| format!("pane '{pane_id}' does not exist"))?;
    if expected_generation.is_some_and(|generation| pane.generation != generation) {
        return Err(format!("pane '{pane_id}' generation is stale"));
    }
    Ok(pane.clone())
}

fn dispose_pane_target(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    allow_primary: bool,
    expected_generation: Option<u64>,
) -> Result<PaneSession, String> {
    pane_disposal_target(
        registry,
        owner_label,
        pane_id,
        allow_primary,
        expected_generation,
    )?;
    take_pane_session(registry, owner_label, pane_id)
        .ok_or_else(|| format!("pane '{pane_id}' does not exist"))
}

fn complete_pane_disposal(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    generation: u64,
    deletion_result: Result<(), String>,
) -> Result<(), String> {
    deletion_result?;
    dispose_pane_target(registry, owner_label, pane_id, false, Some(generation)).map(|_| ())
}

fn bind_pane_session(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    generation: u64,
    session_id: String,
) -> bool {
    let Some(pane) = registry
        .get_mut(owner_label)
        .and_then(|panes| panes.get_mut(pane_id))
    else {
        return false;
    };
    if pane.generation != generation || pane.session_id.is_some() {
        return false;
    }
    pane.session_id = Some(session_id);
    pane.startup_error = None;
    true
}

fn record_pane_startup_error(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    generation: u64,
    message: String,
) -> bool {
    let Some(pane) = registry
        .get_mut(owner_label)
        .and_then(|panes| panes.get_mut(pane_id))
    else {
        return false;
    };
    if pane.generation != generation || pane.session_id.is_some() {
        return false;
    }
    pane.startup_error = Some(message);
    true
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PaneStartupStatus {
    ready: bool,
    error: Option<String>,
    generation: u64,
    session_id: Option<String>,
}

fn pane_startup_status(
    registry: &PaneRegistry,
    owner_label: &str,
    pane_id: &str,
) -> Result<PaneStartupStatus, String> {
    validate_pane_id(pane_id)?;
    let pane = resolve_owned_pane(registry, owner_label, pane_id)
        .ok_or_else(|| format!("pane '{pane_id}' does not exist"))?;
    Ok(PaneStartupStatus {
        ready: pane.startup_error.is_none() && pane.session_id.is_some(),
        error: pane.startup_error.clone(),
        generation: pane.generation,
        session_id: pane.session_id.clone(),
    })
}

fn take_window_panes(registry: &mut PaneRegistry, owner_label: &str) -> Vec<PaneSession> {
    registry
        .remove(owner_label)
        .map(|panes| panes.into_values().collect())
        .unwrap_or_default()
}

type RecoveryTarget = (
    String,
    String,
    WorkspaceMode,
    ChatAgent,
    PathBuf,
    Option<String>,
    u64,
);

fn recovery_targets(registry: &PaneRegistry) -> Vec<RecoveryTarget> {
    registry
        .iter()
        .flat_map(|(label, panes)| {
            panes.iter().filter_map(move |(pane_id, pane)| {
                pane.cwd.clone().map(|cwd| {
                    (
                        label.clone(),
                        pane_id.clone(),
                        pane.mode,
                        pane.chat_agent,
                        cwd,
                        pane.session_path.clone(),
                        pane.generation,
                    )
                })
            })
        })
        .collect()
}

fn pane_identity_is_current(
    registry: &PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    generation: u64,
    session_id: &str,
) -> bool {
    resolve_owned_pane(registry, owner_label, pane_id).is_some_and(|pane| {
        pane.generation == generation && pane.session_id.as_deref() == Some(session_id)
    })
}

fn trusted_event_envelope(
    pane_id: &str,
    session_id: &str,
    value: &serde_json::Value,
) -> Option<serde_json::Value> {
    if value.get("sessionId").and_then(|v| v.as_str()) != Some(session_id) {
        return None;
    }
    let event_type = value.get("type")?.as_str()?;
    let data = value.get("data")?.clone();
    Some(serde_json::json!({
        "paneId": pane_id,
        "sessionId": session_id,
        "type": event_type,
        "data": data,
    }))
}

/// True once the app has begun quitting. Set on `ExitRequested` so the cascade
/// of per-window `Destroyed` events during shutdown does NOT prune the workspace
/// snapshot — the last full snapshot is what we restore next launch.
#[derive(Default)]
struct AppExiting(AtomicBool);

/// One window's active target (mode, cwd, and optional session), returned by
/// `window_restore_target` so the webview can recover without showing Home.
#[derive(Clone, serde::Serialize)]
struct RestoreEntry {
    mode: WorkspaceMode,
    #[serde(rename = "chatAgent")]
    chat_agent: ChatAgent,
    cwd: String,
    #[serde(rename = "sessionPath")]
    session_path: Option<String>,
}

#[derive(serde::Serialize)]
struct DroppedPathInfo {
    path: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
}

/// OS-level permission status shown in the Settings modal's "Grant
/// Permissions" row. Only macOS has anything to grant today (Full Disk
/// Access — needed because the subagent tool spawns a fresh `ggnode` process
/// per call, which re-triggers macOS's per-folder privacy prompts under
/// Desktop/Documents/Downloads/iCloud). Windows/Linux report
/// `applicable: false` so the webview hides the row entirely instead of
/// showing a badge for a permission that doesn't exist there.
#[derive(serde::Serialize)]
struct PermissionsStatus {
    applicable: bool,
    granted: bool,
}

/// Per-window active workspace targets. An entry exists only after the user has
/// chosen a workspace (or when one was restored at boot). Targets stay available
/// for the lifetime of the window so a WebKit content-process reload can recover
/// the same workspace instead of falling back to Home.
#[derive(Default)]
struct RestoreTargets {
    map: Mutex<HashMap<String, RestoreEntry>>,
}

#[derive(Clone)]
struct PaneCopyOperation {
    source_owner: String,
    target_label: String,
    restore: RestoreEntry,
    cloned_session_path: Option<PathBuf>,
    started: bool,
}

#[derive(Default)]
struct PaneCopyRegistry {
    operations: HashMap<(String, String), PaneCopyOperation>,
    target_owners: HashMap<String, (String, String)>,
    rolling_back: HashSet<String>,
}

#[derive(Default)]
struct PaneCopies {
    map: Mutex<PaneCopyRegistry>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedPaneCopy {
    copy_id: String,
    window_label: String,
    reused_window: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PaneCopyResult {
    window_label: String,
    reused_window: bool,
}

fn remove_copy_operation(
    registry: &mut PaneCopyRegistry,
    source_owner: &str,
    copy_id: &str,
) -> Option<PaneCopyOperation> {
    let key = (source_owner.to_string(), copy_id.to_string());
    let operation = registry.operations.remove(&key)?;
    registry.target_owners.remove(&operation.target_label);
    Some(operation)
}

fn consume_copy_restore_target(
    copies: &PaneCopyRegistry,
    targets: &mut HashMap<String, RestoreEntry>,
    target_label: &str,
) -> Option<RestoreEntry> {
    copies.target_owners.get(target_label)?;
    remove_restore_target(targets, target_label)
}

fn register_restore_target(
    targets: &mut HashMap<String, RestoreEntry>,
    label: String,
    entry: RestoreEntry,
) {
    targets.insert(label, entry);
}

fn restore_target(targets: &HashMap<String, RestoreEntry>, label: &str) -> Option<RestoreEntry> {
    targets.get(label).cloned()
}

fn remove_restore_target(
    targets: &mut HashMap<String, RestoreEntry>,
    label: &str,
) -> Option<RestoreEntry> {
    targets.remove(label)
}

/// The label of the currently-focused window, updated on `Focused` window
/// events. `broadcast_window_order` reads this so every window knows which one
/// is active (and `focus_window_by_offset` cycles from here).
#[derive(Default)]
struct FocusedWindow(Mutex<Option<String>>);

/// Debounce token for `Moved` window events: the `Instant` of the last move.
/// Only the deferred task whose captured `Instant` still matches the stored one
/// fires the broadcast — earlier moves are superseded.
#[derive(Default)]
struct MoveDebounce(Mutex<Option<std::time::Instant>>);

/// Windows-only: per-window last-known minimized state. Used to detect the
/// minimized→restored edge in `Resized` events (on Windows, minimize fires
/// `Resized(0,0)` / `is_minimized()==true`, restore fires `Resized(real)` /
/// `is_minimized()==false`) so that restoring ONE window brings all its
/// siblings back too — matching the macOS dock-reopen behavior. On macOS the
/// OS already restores every window from a single dock click, so the whole
/// `Resized` arm is compiled out there and this state is never populated.
#[cfg(target_os = "windows")]
#[derive(Default)]
struct MinimizeState(Mutex<HashMap<String, bool>>);

/// Windows-only: on the minimized→restored edge of one window, un-minimize
/// every sibling so a single taskbar click brings the whole workspace back
/// (like macOS). Ordinary resizes/drags are ignored — only a true
/// minimized→restored transition triggers the cascade. We pre-mark every
/// window as restored before calling `unminimize()`, so the `Resized` events
/// those calls generate don't re-cascade. No `set_focus()` — un-minimizing
/// siblings must not steal focus from the window the user actually clicked.
#[cfg(target_os = "windows")]
fn restore_sibling_windows(window: &tauri::Window) {
    let app = window.app_handle();
    let label = window.label().to_string();
    let cur = window.is_minimized().unwrap_or(false);
    let state: State<MinimizeState> = app.state();
    // Act only on an actual minimized (prev) → restored (cur == false) edge.
    let cascade = {
        let mut map = state.0.lock().unwrap();
        let prev = map.get(&label).copied().unwrap_or(false);
        map.insert(label.clone(), cur);
        prev && !cur
    };
    if !cascade {
        return;
    }
    // Collect siblings AND pre-mark every window restored, holding the lock only
    // briefly — never across a window call. `unminimize()` on Windows can
    // synchronously re-enter this handler (ShowWindow dispatches WM_SIZE), so a
    // lock held across it would deadlock the (non-reentrant) mutex. Pre-marking
    // makes any such re-entrant call read prev == false and skip the cascade.
    let siblings: Vec<WebviewWindow> = {
        let mut map = state.0.lock().unwrap();
        let mut out = Vec::new();
        for (sib_label, win) in app.webview_windows() {
            map.insert(sib_label.clone(), false);
            if sib_label != label {
                out.push(win);
            }
        }
        out
    };
    for win in siblings {
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
    }
}

/// App-wide guard: only one source rebase/build may run across all windows.
#[derive(Default)]
struct LocalPatchedUpdate {
    running: Mutex<bool>,
}

fn sidecar_base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Gracefully terminate a sidecar child AND its entire process tree so MCP/LSP
/// children (spawned without `detached`, so they share the sidecar's process
/// group) die with it — no orphans on window-close/project-switch/quit.
///
/// On Unix the daemon is spawned as a process-group leader (see
/// `spawn_daemon`), so sending signals to `-pid` (negative pid =
/// the whole group) reaps every descendant in one shot. We SIGTERM the group so
/// the sidecar's SIGTERM handler can run `session.dispose()`, poll `try_wait()`
/// for up to ~3s, then SIGKILL the group and `wait()` to reap the direct child
/// (std `Child` never auto-reaps).
///
/// On Windows there is no process-group kill, so we tree-kill via
/// `taskkill /T /F` (kills the descendant tree), then `wait()` to reap.
fn terminate_child(mut child: Child) {
    let pid = child.id() as i32;
    #[cfg(unix)]
    unsafe {
        // Negative pid = signal the entire process group. The sidecar is its
        // own group leader (pgid == sidecar pid), so this reaches every
        // non-detached descendant (MCP stdio children, LSP servers).
        libc::kill(-pid, libc::SIGTERM);
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
            // Grace period expired — force-kill the whole group.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
        #[cfg(not(unix))]
        {
            // Tree-kill on Windows: /T kills the descendant tree, /F forces it.
            let _ = hide_console(&mut std::process::Command::new("taskkill"))
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            // Fall back to direct kill if taskkill is unavailable.
            let _ = child.kill();
        }
        let _ = child.wait(); // reap the direct child (avoid zombie)
    });
}

// ── Startup orphan sweeper ─────────────────────────────────────────────────
// When the app is force-quit, crashes, or is killed during a dev run, the
// sidecar process tree (Node sidecar + MCP stdio children + LSP servers) is
// orphaned — reparented to init (pid 1) or an orphan-reaper. Rust only kills
// the direct sidecar PID, so children survive. Without a startup sweep these
// accumulate forever. We run once at the top of `.setup`, before new sidecars
// are spawned.
//
// Cross-platform: the pure classifier (`orphan_killset`) is OS-agnostic; only
// the process-table snapshot and the force-kill primitive differ between
// Unix (`ps` + `libc::kill`) and Windows (PowerShell CIM + `taskkill`).

/// One process row from the OS process table (pid, parent pid, process-group
/// id, full command). `pgid` is 0 on platforms without process groups
/// (Windows) — it's only consulted on Unix, where the sidecar is spawned as a
/// group leader (`process_group(0)`) so every non-detached descendant inherits
/// `pgid == sidecar_pid`. That inherited pgid survives the sidecar's death (the
/// children reparent to init but keep their group id), which is what lets the
/// sweep recognise a crashed sidecar's MCP/LSP children by lineage instead of
/// by a hardcoded name whitelist.
struct ProcInfo {
    pid: i32,
    ppid: i32,
    pgid: i32,
    command: String,
}

/// Command substrings that identify a GG Coder *sidecar* process itself.
/// `app-sidecar` matches both bundled `app-sidecar.mjs` and dev
/// `app-sidecar.js`. This is our OWN binary name (fully under our control, not
/// a third-party MCP name), so it's a safe, stable anchor. MCP children are NOT
/// matched by name — there are thousands of possible MCP servers and users can
/// add any of them — they're recognised structurally instead (descendant walk +
/// process-group lineage; see `orphan_killset`).
const SIDECAR_COMMAND_PATTERNS: &[&str] = &["app-sidecar"];

/// Pure (no I/O): given a process-table snapshot, the current app's pid, and the
/// set of process-group ids belonging to sidecars we have ever spawned (the
/// ledger — see `read_sidecar_ledger`), return the orphaned sidecar-tree PIDs to
/// SIGKILL.
///
/// A sidecar-tree member is killed when ANY of these hold and it isn't self:
///
/// 1. **Orphaned sidecar** — command matches `SIDECAR_COMMAND_PATTERNS` and its
///    parent is dead (`ppid == 1` or `ppid` absent from the snapshot).
/// 2. **Descendant of an orphaned sidecar** — transitively reachable via the
///    ppid tree from a (1) root. Catches MCP/LSP children still linked to a
///    freshly-dead sidecar that's still in this snapshot.
/// 3. **Process-group lineage (name-agnostic)** — the process's `pgid` is a
///    ledgered sidecar group whose *leader is dead* (no live process has
///    `pid == pgid`). This is the key case: after a crash/force-quit the sidecar
///    is long gone and its MCP children have reparented to init, but they keep
///    the sidecar's pgid. Any MCP server, of any name the user added, is caught
///    here — no whitelist. PID-recycle-safe: a group whose leader is alive is
///    skipped entirely (either a still-live sidecar, whose children we must NOT
///    kill, or an unrelated process that recycled the pid).
///
/// The current app pid and its live sidecars are never matched — a live
/// sidecar's parent is the still-running `gg-app`, so its `ppid` is alive, and
/// its group leader is alive so lineage skips it.
fn orphan_killset(snapshot: &[ProcInfo], self_pid: i32, ledger_pgids: &HashSet<i32>) -> Vec<i32> {
    let live_pids: HashSet<i32> = snapshot.iter().map(|p| p.pid).collect();
    let mut parent_children: HashMap<i32, Vec<i32>> = HashMap::new();
    for p in snapshot {
        parent_children.entry(p.ppid).or_default().push(p.pid);
    }

    let matches_sidecar = |cmd: &str| SIDECAR_COMMAND_PATTERNS.iter().any(|pat| cmd.contains(pat));
    let parent_dead = |ppid: i32| ppid == 1 || !live_pids.contains(&ppid);

    // The subset of ledgered sidecar groups whose LEADER is dead. A group whose
    // leader (pid == pgid) is still alive is skipped: it's either a live sidecar
    // (its children are in use) or an unrelated process that recycled the pid.
    let dead_leader_groups: HashSet<i32> = ledger_pgids
        .iter()
        .copied()
        .filter(|&g| g > 1 && !live_pids.contains(&g))
        .collect();

    let mut killset: HashSet<i32> = HashSet::new();

    // (1) Orphaned sidecars + (3) process-group lineage. Both are single-pass
    // over the snapshot.
    for p in snapshot {
        if p.pid == self_pid {
            continue;
        }
        let orphaned_sidecar = matches_sidecar(&p.command) && parent_dead(p.ppid);
        let orphaned_group_member = p.pgid > 1 && dead_leader_groups.contains(&p.pgid);
        if orphaned_sidecar || orphaned_group_member {
            killset.insert(p.pid);
        }
    }

    // (2) Descendants: transitively collect children of each root via the map.
    // Catches freshly-orphaned MCP/LSP trees still linked to a dead sidecar
    // that remains in this snapshot (its pgid leader still "alive").
    let mut stack: Vec<i32> = killset.iter().copied().collect();
    while let Some(parent) = stack.pop() {
        if let Some(children) = parent_children.get(&parent) {
            for &child in children {
                if child != self_pid && killset.insert(child) {
                    stack.push(child);
                }
            }
        }
    }

    let mut result: Vec<i32> = killset.into_iter().collect();
    result.sort_unstable();
    result
}

/// Pure parser for `ps -eo pid=,ppid=,pgid=,command=` output (one row per
/// line). Column padding (multiple spaces) is collapsed by `split_whitespace`.
/// Available on all platforms so the parsing can be unit-tested.
fn parse_ps_output(stdout: &str) -> Vec<ProcInfo> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid: i32 = parts.next()?.parse().ok()?;
            let ppid: i32 = parts.next()?.parse().ok()?;
            let pgid: i32 = parts.next()?.parse().ok()?;
            // The rest of the line is the full command (may contain spaces).
            // Pattern matching uses .contains(), so rejoining with single
            // spaces is fine.
            let command = parts.collect::<Vec<_>>().join(" ");
            Some(ProcInfo {
                pid,
                ppid,
                pgid,
                command,
            })
        })
        .collect()
}

/// Pure parser for PowerShell CIM output: one line per process as
/// `pid|ppid|command` (see `process_snapshot` on Windows). The command field
/// may contain `|` and spaces — `splitn(3, '|')` captures it verbatim.
/// Available on all platforms so the parsing can be unit-tested.
/// `allow(dead_code)`: on Unix its only caller is `#[cfg(not(unix))]`, so the
/// compiler flags it as dead; on Windows it IS used by `process_snapshot`.
#[allow(dead_code)]
fn parse_cim_output(stdout: &str) -> Vec<ProcInfo> {
    stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            // splitn(3, '|') — the command field may itself contain '|',
            // but only the first two fields matter and the third captures
            // everything else verbatim.
            let mut parts = line.splitn(3, '|');
            let pid: i32 = parts.next()?.trim().parse().ok()?;
            let ppid: i32 = parts.next()?.trim().parse().ok()?;
            let command = parts.next()?.trim().to_string();
            // Windows has no POSIX process groups; pgid is unused there (set to
            // 0 so the lineage rule in `orphan_killset`, which requires pgid > 1,
            // never fires — Windows relies on name + descendant matching).
            Some(ProcInfo {
                pid,
                ppid,
                pgid: 0,
                command,
            })
        })
        .collect()
}

/// Snapshot the OS process table into `ProcInfo` rows (pid, ppid, command).
/// Returns `None` if the process-listing command is unavailable — the sweep
/// then silently does nothing.
#[cfg(unix)]
fn process_snapshot() -> Option<Vec<ProcInfo>> {
    let output = Command::new("ps")
        .args(["-eo", "pid=,ppid=,pgid=,command="])
        .output()
        .ok()?;
    Some(parse_ps_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Windows snapshot via PowerShell CIM — the modern replacement for the
/// deprecated `wmic`. Emits one line per process: `pid|ppid|command`, using
/// `|` as a field delimiter. CommandLine may be empty for kernel processes;
/// those won't match any pattern so they're harmless.
#[cfg(not(unix))]
fn process_snapshot() -> Option<Vec<ProcInfo>> {
    // Single-quoted '|' inside the script is a literal separator, not a pipe.
    // The script string uses Rust line continuations (\) so it reads as one
    // logical line of PowerShell.
    let script = "Get-CimInstance Win32_Process | ForEach-Object { \
        [string]$_.ProcessId + '|' + [string]$_.ParentProcessId + '|' + [string]$_.CommandLine \
    }";
    let output = hide_console(&mut Command::new("powershell"))
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .ok()?;
    Some(parse_cim_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Force-kill a single PID (best-effort, errors ignored).
#[cfg(unix)]
fn force_kill_pid(pid: i32) {
    unsafe {
        let _ = libc::kill(pid, libc::SIGKILL);
    }
}

/// Force-kill a single PID via `taskkill /F` (no descendant tree walk needed —
/// the sweeper kills every orphan-tree member individually from the snapshot).
#[cfg(not(unix))]
fn force_kill_pid(pid: i32) {
    let _ = hide_console(&mut Command::new("taskkill"))
        .args(["/PID", &pid.to_string(), "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Absolute path to the sidecar PID ledger (`~/.gg/gg-app-sidecars`).
///
/// Newline-delimited list of PIDs of every Node sidecar this app has spawned.
/// Because each sidecar is spawned as a process-group leader (`process_group(0)`
/// on Unix), its PID equals the pgid shared by all of its MCP/LSP children. So a
/// ledgered PID doubles as "a GG process-group id", which is how the sweep
/// recognises a crashed sidecar's children by lineage — no MCP-name whitelist.
fn sidecar_ledger_path() -> PathBuf {
    home_dir().join(".gg").join("gg-app-sidecars")
}

/// Read the ledgered sidecar PIDs (== process-group ids). Missing/garbage file
/// → empty set (the sweep then degrades to name + descendant matching, exactly
/// the pre-ledger behaviour). Best-effort, never panics.
fn read_sidecar_ledger() -> HashSet<i32> {
    let Ok(contents) = std::fs::read_to_string(sidecar_ledger_path()) else {
        return HashSet::new();
    };
    contents
        .lines()
        .filter_map(|l| l.trim().parse::<i32>().ok())
        .filter(|&p| p > 1)
        .collect()
}

/// Append a freshly-spawned sidecar's PID to the ledger. Called right after
/// `spawn_daemon` gets a live child. Creates `~/.gg` if needed. Best-effort:
/// a write failure only means that sidecar's orphans fall back to name matching.
fn record_sidecar_pid(pid: i32) {
    let path = sidecar_ledger_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{pid}");
    }
}

/// Rewrite the ledger to keep only PIDs whose process group is still live —
/// i.e. a process with `pid == pgid` exists in the snapshot (a still-running
/// sidecar, ours or a concurrent instance's). Drops dead groups (their members
/// were just swept) and pids recycled away, so the file can't grow without
/// bound. Best-effort.
fn prune_sidecar_ledger(ledger: &HashSet<i32>, snapshot: &[ProcInfo]) {
    let live_pids: HashSet<i32> = snapshot.iter().map(|p| p.pid).collect();
    let keep: Vec<i32> = ledger
        .iter()
        .copied()
        .filter(|g| live_pids.contains(g))
        .collect();
    let path = sidecar_ledger_path();
    if keep.is_empty() {
        // Nothing worth keeping — remove the file so a stale set can't linger.
        let _ = std::fs::remove_file(&path);
        return;
    }
    let body = keep
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let _ = std::fs::write(&path, format!("{body}\n"));
}

/// Snapshot the process table, classify orphaned sidecar trees, and force-kill
/// each. Best-effort + logged; never panics. Runs once at startup before any
/// sidecar is spawned.
fn sweep_orphan_sidecars() {
    let Some(snapshot) = process_snapshot() else {
        log::warn!("orphan sweep: process listing unavailable, skipping");
        return;
    };
    let self_pid = std::process::id() as i32;
    let ledger = read_sidecar_ledger();

    let killset = orphan_killset(&snapshot, self_pid, &ledger);
    if killset.is_empty() {
        log::info!("orphan sweep: no stale sidecars found");
        prune_sidecar_ledger(&ledger, &snapshot);
        return;
    }

    log::info!("orphan sweep: killing {} stale process(es)", killset.len());
    for pid in &killset {
        let cmd = snapshot
            .iter()
            .find(|p| &p.pid == pid)
            .map(|p| p.command.as_str())
            .unwrap_or("?");
        log::info!("orphan sweep: killing pid {pid}: {cmd}");
        force_kill_pid(*pid);
    }
    prune_sidecar_ledger(&ledger, &snapshot);
}

/// The shared daemon port (same for every window). Named `port_for` so the ~35
/// proxy commands keep their call shape; the per-window routing is the session
/// id (`session_for`), attached as the `x-gg-session` header.
fn port_for(webview: &WebviewWindow) -> Option<u16> {
    let daemon: State<Daemon> = webview.state();
    let port = *daemon.port.lock().unwrap();
    port
}

fn pane_session_for(webview: &WebviewWindow, pane_id: &str) -> Option<String> {
    validate_pane_id(pane_id).ok()?;
    let windows: State<Windows> = webview.state();
    let registry = windows.map.lock().unwrap();
    resolve_owned_pane(&registry, webview.label(), pane_id)?
        .session_id
        .clone()
}

fn session_for(webview: &WebviewWindow) -> Option<String> {
    pane_session_for(webview, PRIMARY_PANE_ID)
}

fn pane_cwd_for(webview: &WebviewWindow, pane_id: &str) -> Option<PathBuf> {
    validate_pane_id(pane_id).ok()?;
    let windows: State<Windows> = webview.state();
    let registry = windows.map.lock().unwrap();
    resolve_owned_pane(&registry, webview.label(), pane_id)?
        .cwd
        .clone()
}

/// Await the daemon's HTTP port (set by its `GG_APP_LISTENING` handshake),
/// polling up to ~30s. Returns `None` if the daemon never came up. Mirrors the
/// webview's `waitForReady` poll cadence.
async fn await_daemon_port(app: &tauri::AppHandle) -> Option<u16> {
    for _ in 0..600 {
        if let Some(p) = *app.state::<Daemon>().port.lock().unwrap() {
            return Some(p);
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    None
}

/// Frontend compatibility readiness seam, explicitly routed to one pane.
#[tauri::command]
fn sidecar_port(webview: WebviewWindow, pane_id: Option<String>) -> Option<u16> {
    let pane_id = pane_id.as_deref().unwrap_or(PRIMARY_PANE_ID);
    pane_session_for(&webview, pane_id)?;
    port_for(&webview)
}

#[tauri::command]
fn agent_pane_status(webview: WebviewWindow, pane_id: String) -> Result<PaneStartupStatus, String> {
    let mut status = {
        let windows: State<Windows> = webview.state();
        let registry = windows.map.lock().unwrap();
        pane_startup_status(&registry, webview.label(), &pane_id)?
    };
    status.ready &= port_for(&webview).is_some();
    Ok(status)
}

#[tauri::command]
fn dropped_path_info(paths: Vec<String>) -> Vec<DroppedPathInfo> {
    paths
        .into_iter()
        .map(|path| {
            let is_dir = std::fs::metadata(&path)
                .map(|m| m.is_dir())
                .unwrap_or(false);
            DroppedPathInfo { path, is_dir }
        })
        .collect()
}

/// Cap on a single dropped file's size for base64 attachment — large drops
/// (e.g. multi-GB video) would blow up the base64 payload and the IPC/agent
/// prompt pipeline; point the user at the file path instead via the error.
const MAX_DROPPED_FILE_BYTES: u64 = 100 * 1024 * 1024;

/// Guess a media type from the file extension. Covers the kinds the chat
/// input already accepts (image/video via the attach button, everything else
/// falls back to a generic binary type like a browser's File.type would for
/// an unrecognized extension).
fn guess_media_type(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// A native drag-drop only gives us absolute paths (no browser File object),
/// so a regular file dropped on the window (as opposed to a folder, handled
/// separately by inserting its path into the draft) is read here and handed
/// back as base64 — the same shape `fileToPending` builds for a pasted/picked
/// file — so it attaches identically regardless of how it entered the input.
#[tauri::command]
fn read_dropped_file_attachment(path: String) -> Result<serde_json::Value, String> {
    let p = Path::new(&path);
    let metadata = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_DROPPED_FILE_BYTES {
        return Err(format!(
            "{} is too large to attach ({} MB, limit {} MB)",
            path,
            metadata.len() / (1024 * 1024),
            MAX_DROPPED_FILE_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let media_type = guess_media_type(p);
    Ok(serde_json::json!({ "name": name, "mediaType": media_type, "data": data }))
}

fn strip_file_location_suffix(path: &str) -> &str {
    let mut end = path.len();
    for _ in 0..2 {
        let Some(colon) = path[..end].rfind(':') else {
            break;
        };
        let suffix = &path[colon + 1..end];
        if suffix.is_empty() || !suffix.chars().all(|c| c.is_ascii_digit()) {
            break;
        }
        let last_sep = path[..colon].rfind(|c| c == '/' || c == '\\').unwrap_or(0);
        if colon <= last_sep {
            break;
        }
        end = colon;
    }
    &path[..end]
}

/// Open a project file linked from the chat. Relative paths resolve against this
/// window's sidecar cwd; `:line[:col]` and `#Lline` decorations are tolerated.
#[tauri::command]
fn open_project_path(
    webview: WebviewWindow,
    pane_id: Option<String>,
    path: String,
) -> Result<(), String> {
    let pane_id = pane_id.as_deref().unwrap_or(PRIMARY_PANE_ID);
    let cwd = pane_cwd_for(&webview, pane_id).ok_or("sidecar not ready")?;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty path".into());
    }
    if trimmed.contains("://") && !trimmed.starts_with("file://") {
        return Err("not a file path".into());
    }

    let without_file_scheme = trimmed.strip_prefix("file://").unwrap_or(trimmed);
    let without_anchor = without_file_scheme
        .split_once("#L")
        .map(|(p, _)| p)
        .unwrap_or(without_file_scheme);
    let without_query = without_anchor
        .split_once('?')
        .map(|(p, _)| p)
        .unwrap_or(without_anchor);
    let cleaned = strip_file_location_suffix(without_query);
    let candidate = PathBuf::from(cleaned);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        cwd.join(candidate)
    };
    let canonical = strip_extended_prefix(
        resolved
            .canonicalize()
            .map_err(|_| format!("file not found: {}", cleaned))?,
    );

    webview
        .opener()
        .open_path(canonical.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| e.to_string())
}

/// Open an http(s) URL in the system browser (title-bar GitHub issue/PR links).
/// Scheme-validated so the webview can't turn this into a local-file opener.
#[tauri::command]
fn open_url(webview: WebviewWindow, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
        return Err("only http(s) URLs can be opened".into());
    }
    webview
        .opener()
        .open_url(trimmed, None::<String>)
        .map_err(|e| e.to_string())
}

/// Proxy: current agent/session state.
#[tauri::command]
async fn agent_state(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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

fn normalize_notes_response(
    status: reqwest::StatusCode,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let typed_outcome = body
        .get("status")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| {
            matches!(value, "ok" | "missing" | "corrupt" | "conflict" | "invalid")
        });
    if status.is_success() || typed_outcome {
        return Ok(body);
    }
    Err(body
        .get("message")
        .or_else(|| body.get("error"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("notes request failed")
        .to_string())
}

async fn notes_response(response: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = response.status();
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())?;
    normalize_notes_response(status, body)
}

/// Proxy: load the authenticated pane's project Notes snapshot.
#[tauri::command]
async fn agent_notes_get(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .get(format!("{}/notes", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    notes_response(response).await
}

fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn phase_start_path(phase_id: &str) -> String {
    format!("/phases/{}/start", encode_path_segment(phase_id))
}

fn normalize_phase_start_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<serde_json::Value, String> {
    let value = serde_json::from_str::<serde_json::Value>(body)
        .map_err(|_| "invalid phase-start response".to_string())?;
    let typed = value
        .get("status")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|candidate| matches!(candidate, "accepted" | "already-bound" | "failed"));
    if status.is_success() || typed {
        Ok(value)
    } else {
        Err(sidecar_error_text(status, body))
    }
}

#[cfg(feature = "native-smoke")]
fn audit_native_phase_start(
    pane_id: &str,
    phase_id: &str,
    status: reqwest::StatusCode,
    result: &Result<serde_json::Value, String>,
) {
    use std::io::Write as _;

    let Ok(path) = std::env::var("GG_PHASE21_NATIVE_SMOKE_AUDIT_FILE") else {
        return;
    };
    let outcome = match result {
        Ok(value) => serde_json::json!({ "response": value }),
        Err(error) => serde_json::json!({ "error": error }),
    };
    let entry = serde_json::json!({
        "route": "agent_phase_start",
        "paneId": pane_id,
        "phaseId": phase_id,
        "httpStatus": status.as_u16(),
        "authenticated": true,
        "outcome": outcome,
    });
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{entry}");
    }
}

/// Proxy: atomically bind and start one Roadmap phase for the authenticated pane.
#[tauri::command]
async fn agent_phase_start(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    phase_id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!(
            "{}{}",
            sidecar_base(port),
            phase_start_path(&phase_id)
        ))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let result = normalize_phase_start_response(status, &body);
    #[cfg(feature = "native-smoke")]
    audit_native_phase_start(&pane_id, &phase_id, status, &result);
    result
}

/// Proxy: create the pane's project Notes repository only when absent.
#[tauri::command]
async fn agent_notes_migrate(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    document: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/notes/migrate", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "document": document }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    notes_response(response).await
}

/// Proxy: compare-and-swap the pane's project Notes document.
#[tauri::command]
async fn agent_notes_save(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    expected_revision: u64,
    document: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .put(format!("{}/notes", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({
            "expectedRevision": expected_revision,
            "document": document,
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    notes_response(response).await
}

const ROADMAP_REMINDER_NOTIFICATION_TITLE: &str = "Roadmap reminder due";
const ROADMAP_REMINDER_NOTIFICATION_BODY: &str = "Open Supah Coder to review it.";

#[derive(Debug, PartialEq)]
struct RoadmapReminderNotificationSpec {
    title: &'static str,
    body: &'static str,
    sound: Option<&'static str>,
}

fn roadmap_reminder_sound() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        return "Submarine";
    }
    #[cfg(target_os = "windows")]
    {
        return "Mail";
    }
    #[cfg(target_os = "linux")]
    {
        return "message-new-instant";
    }
    #[allow(unreachable_code)]
    "default"
}

fn roadmap_reminder_notification_spec(sound_enabled: bool) -> RoadmapReminderNotificationSpec {
    RoadmapReminderNotificationSpec {
        title: ROADMAP_REMINDER_NOTIFICATION_TITLE,
        body: ROADMAP_REMINDER_NOTIFICATION_BODY,
        sound: sound_enabled.then(roadmap_reminder_sound),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NotificationAvailabilitySignal {
    Enabled,
    Disabled,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
enum RoadmapReminderNotificationPermission {
    Granted,
    Denied,
    Unavailable,
}

fn notification_permission_from_signal(
    signal: NotificationAvailabilitySignal,
) -> RoadmapReminderNotificationPermission {
    match signal {
        NotificationAvailabilitySignal::Enabled => RoadmapReminderNotificationPermission::Granted,
        NotificationAvailabilitySignal::Disabled => RoadmapReminderNotificationPermission::Denied,
        NotificationAvailabilitySignal::Unknown => {
            RoadmapReminderNotificationPermission::Unavailable
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_notification_signal(
    setting: Option<windows::UI::Notifications::NotificationSetting>,
) -> NotificationAvailabilitySignal {
    use windows::UI::Notifications::NotificationSetting;

    match setting {
        Some(NotificationSetting::Enabled) => NotificationAvailabilitySignal::Enabled,
        Some(
            NotificationSetting::DisabledForApplication
            | NotificationSetting::DisabledForUser
            | NotificationSetting::DisabledByGroupPolicy
            | NotificationSetting::DisabledByManifest,
        ) => NotificationAvailabilitySignal::Disabled,
        Some(_) | None => NotificationAvailabilitySignal::Unknown,
    }
}

#[cfg(target_os = "windows")]
fn platform_notification_signal(app_id: &str) -> NotificationAvailabilitySignal {
    use windows::core::HSTRING;
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
    use windows::UI::Notifications::ToastNotificationManager;

    let initialized = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
    let setting = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
        .and_then(|notifier| notifier.Setting());
    if initialized {
        unsafe { RoUninitialize() };
    }
    match setting {
        Ok(setting) => windows_notification_signal(Some(setting)),
        Err(error) => {
            log::warn!("Windows notification availability probe failed: {error}");
            windows_notification_signal(None)
        }
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MacosNotificationState {
    Enabled,
    Disabled,
    NotDetermined,
    Unknown,
}

#[cfg(target_os = "macos")]
fn macos_notification_state(
    authorization: objc2_user_notifications::UNAuthorizationStatus,
    alert: objc2_user_notifications::UNNotificationSetting,
) -> MacosNotificationState {
    use objc2_user_notifications::{UNAuthorizationStatus, UNNotificationSetting};

    match authorization {
        UNAuthorizationStatus::Denied => MacosNotificationState::Disabled,
        UNAuthorizationStatus::Authorized
        | UNAuthorizationStatus::Provisional
        | UNAuthorizationStatus::Ephemeral
            if alert == UNNotificationSetting::Enabled =>
        {
            MacosNotificationState::Enabled
        }
        UNAuthorizationStatus::Authorized
        | UNAuthorizationStatus::Provisional
        | UNAuthorizationStatus::Ephemeral => MacosNotificationState::Disabled,
        UNAuthorizationStatus::NotDetermined => MacosNotificationState::NotDetermined,
        _ => MacosNotificationState::Unknown,
    }
}

#[cfg(all(target_os = "macos", test))]
fn macos_notification_signal(
    authorization: objc2_user_notifications::UNAuthorizationStatus,
    alert: objc2_user_notifications::UNNotificationSetting,
) -> NotificationAvailabilitySignal {
    match macos_notification_state(authorization, alert) {
        MacosNotificationState::Enabled => NotificationAvailabilitySignal::Enabled,
        MacosNotificationState::Disabled => NotificationAvailabilitySignal::Disabled,
        MacosNotificationState::NotDetermined | MacosNotificationState::Unknown => {
            NotificationAvailabilitySignal::Unknown
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_current_notification_state() -> MacosNotificationState {
    use block2::RcBlock;
    use objc2_user_notifications::{UNNotificationSettings, UNUserNotificationCenter};
    use std::ptr::NonNull;
    use std::sync::mpsc;

    let (sender, receiver) = mpsc::sync_channel(1);
    let callback = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        let settings = unsafe { settings.as_ref() };
        let _ = sender.send(macos_notification_state(
            settings.authorizationStatus(),
            settings.alertSetting(),
        ));
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .getNotificationSettingsWithCompletionHandler(&callback);
    receiver
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or(MacosNotificationState::Unknown)
}

#[cfg(target_os = "macos")]
fn platform_notification_signal(_app_id: &str) -> NotificationAvailabilitySignal {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::NSError;
    use objc2_user_notifications::{UNAuthorizationOptions, UNUserNotificationCenter};
    use std::sync::mpsc;

    match macos_current_notification_state() {
        MacosNotificationState::Enabled => return NotificationAvailabilitySignal::Enabled,
        MacosNotificationState::Disabled => return NotificationAvailabilitySignal::Disabled,
        MacosNotificationState::Unknown => return NotificationAvailabilitySignal::Unknown,
        MacosNotificationState::NotDetermined => {}
    }

    let (sender, receiver) = mpsc::sync_channel(1);
    let callback = RcBlock::new(move |granted: Bool, error: *mut NSError| {
        let _ = sender.send(if !error.is_null() {
            NotificationAvailabilitySignal::Unknown
        } else if granted.as_bool() {
            NotificationAvailabilitySignal::Enabled
        } else {
            NotificationAvailabilitySignal::Disabled
        });
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &callback,
        );
    let requested = receiver
        .recv_timeout(Duration::from_secs(30))
        .unwrap_or(NotificationAvailabilitySignal::Unknown);
    if requested != NotificationAvailabilitySignal::Enabled {
        return requested;
    }

    match macos_current_notification_state() {
        MacosNotificationState::Enabled => NotificationAvailabilitySignal::Enabled,
        MacosNotificationState::Disabled => NotificationAvailabilitySignal::Disabled,
        MacosNotificationState::NotDetermined | MacosNotificationState::Unknown => {
            NotificationAvailabilitySignal::Unknown
        }
    }
}

#[cfg(target_os = "linux")]
fn platform_notification_signal(_app_id: &str) -> NotificationAvailabilitySignal {
    // Freedesktop notification services expose delivery, not a reliable per-app
    // authorization state. Linux therefore uses the visible in-app fallback and
    // records `unavailable` instead of manufacturing a `granted` audit result.
    NotificationAvailabilitySignal::Unknown
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn platform_notification_signal(_app_id: &str) -> NotificationAvailabilitySignal {
    NotificationAvailabilitySignal::Unknown
}

#[tauri::command]
async fn roadmap_reminder_notification_permission(
    app: tauri::AppHandle,
) -> RoadmapReminderNotificationPermission {
    let app_id = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || platform_notification_signal(&app_id))
        .await
        .map(notification_permission_from_signal)
        .unwrap_or(RoadmapReminderNotificationPermission::Unavailable)
}

#[tauri::command]
fn show_roadmap_reminder_notification(
    app: tauri::AppHandle,
    sound_enabled: bool,
) -> Result<(), String> {
    let spec = roadmap_reminder_notification_spec(sound_enabled);
    let mut notification = app
        .notification()
        .builder()
        .title(spec.title)
        .body(spec.body);
    if let Some(sound) = spec.sound {
        notification = notification.sound(sound);
    }
    notification.show().map_err(|error| error.to_string())
}

fn normalize_reminder_response(
    status: reqwest::StatusCode,
    body: &str,
    allowed_statuses: &[&str],
) -> Result<serde_json::Value, String> {
    let value = serde_json::from_str::<serde_json::Value>(body)
        .map_err(|_| "invalid reminder response".to_string())?;
    let typed_status = value
        .get("status")
        .and_then(serde_json::Value::as_str)
        .filter(|candidate| allowed_statuses.contains(candidate));
    if typed_status.is_some() {
        return Ok(value);
    }
    Err(if status.is_success() {
        "invalid reminder response".to_string()
    } else {
        sidecar_error_text(status, body)
    })
}

async fn reminder_response(
    response: reqwest::Response,
    allowed_statuses: &[&str],
) -> Result<serde_json::Value, String> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    normalize_reminder_response(status, &body, allowed_statuses)
}

#[tauri::command]
async fn agent_reminder_reserve(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    focused: bool,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/reminders/reserve", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "focused": focused }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    reminder_response(
        response,
        &[
            "reserved",
            "deferred",
            "leased",
            "none",
            "already-delivered",
            "missing",
            "corrupt",
        ],
    )
    .await
}

#[tauri::command]
async fn agent_reminder_claim(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    lease_token: String,
    channel: String,
    permission: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/reminders/claim", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({
            "leaseToken": lease_token,
            "channel": channel,
            "permission": permission,
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    reminder_response(
        response,
        &[
            "ok",
            "phase-not-found",
            "phase-inactive",
            "phase-archived",
            "reminder-not-found",
            "stale-occurrence",
            "not-due",
            "already-delivered",
            "invalid-lease",
            "expired-lease",
            "wrong-session",
            "invalid",
            "missing",
            "corrupt",
        ],
    )
    .await
}

#[tauri::command]
async fn agent_reminder_release(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    lease_token: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/reminders/release", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "leaseToken": lease_token }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    reminder_response(
        response,
        &[
            "released",
            "invalid-lease",
            "expired-lease",
            "wrong-session",
        ],
    )
    .await
}

/// Proxy: shared durable chat memories.
#[tauri::command]
async fn agent_memories(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_delete_memory(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_jiwa(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_delete_jiwa(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_progress(
    webview: WebviewWindow,
    _pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
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
async fn agent_usage(
    webview: WebviewWindow,
    _pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
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

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptSubmissionResult {
    queued: bool,
    count: usize,
}

fn parse_prompt_submission_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<PromptSubmissionResult, String> {
    if !status.is_success() {
        return Err(sidecar_error_text(status, body));
    }
    let result: PromptSubmissionResult =
        serde_json::from_str(body).map_err(|_| "invalid prompt submission response".to_string())?;
    if (result.queued && result.count == 0) || (!result.queued && result.count != 0) {
        return Err("invalid prompt submission response".into());
    }
    Ok(result)
}

async fn post_sidecar_prompt(
    client: &reqwest::Client,
    endpoint: &str,
    gg_sid: &str,
    text: String,
    attachments: Option<serde_json::Value>,
    meta: Option<serde_json::Value>,
) -> Result<PromptSubmissionResult, String> {
    let response = client
        .post(endpoint)
        .header("x-gg-session", gg_sid)
        .json(&serde_json::json!({
            "text": text,
            "attachments": attachments.unwrap_or(serde_json::Value::Array(vec![])),
            "meta": meta.unwrap_or(serde_json::Value::Null),
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    parse_prompt_submission_response(status, &body)
}

/// Proxy: submit a prompt (optionally with attachments). The reply streams back
/// via the `agent-event` event. `attachments` is passed through opaquely.
#[tauri::command]
async fn agent_prompt(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    text: String,
    attachments: Option<serde_json::Value>,
    meta: Option<serde_json::Value>,
) -> Result<PromptSubmissionResult, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    post_sidecar_prompt(
        &client,
        &format!("{}/prompt", sidecar_base(port)),
        &gg_sid,
        text,
        attachments,
        meta,
    )
    .await
}

async fn sidecar_get_json(
    webview: &WebviewWindow,
    pane_id: &str,
    client: &reqwest::Client,
    path: &str,
) -> Result<serde_json::Value, String> {
    let port = port_for(webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(webview, pane_id).ok_or("session not ready")?;
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
#[tauri::command]
async fn agent_history(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    sidecar_get_json(&webview, &pane_id, &client, "/history").await
}

/// Proxy: export this window's session as Markdown.
#[tauri::command]
async fn agent_export_transcript(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    let pane_id = pane_id.as_deref().unwrap_or(PRIMARY_PANE_ID);
    let Some(path) = path else {
        return sidecar_get_json(&webview, pane_id, &client, "/export?name=1").await;
    };
    let body = sidecar_get_json(&webview, pane_id, &client, "/export").await?;
    let markdown = body
        .get("markdown")
        .and_then(|value| value.as_str())
        .ok_or("sidecar returned no transcript")?;
    std::fs::write(&path, markdown)
        .map_err(|error| format!("could not save transcript: {error}"))?;
    Ok(serde_json::json!({ "path": path, "bytes": markdown.len() }))
}

fn sidecar_error_text(status: reqwest::StatusCode, body: &str) -> String {
    let trimmed = body.trim();
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(message) = json
            .get("message")
            .or_else(|| json.get("error"))
            .and_then(|value| value.as_str())
        {
            return message.to_string();
        }
        return json.to_string();
    }
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    format!("sidecar request failed with HTTP {status}")
}

fn parse_sidecar_json_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<serde_json::Value, String> {
    if !status.is_success() {
        return Err(sidecar_error_text(status, body));
    }
    serde_json::from_str(body).map_err(|error| error.to_string())
}

fn parse_new_session_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<serde_json::Value, String> {
    if !status.is_success() {
        let kind = if status.is_client_error() {
            "creation-rejected"
        } else {
            "outcome-unknown"
        };
        return Err(serde_json::json!({
            "kind": kind,
            "status": status.as_u16(),
            "message": sidecar_error_text(status, body),
        })
        .to_string());
    }
    let value = serde_json::from_str::<serde_json::Value>(body)
        .map_err(|_| "invalid new-session response".to_string())?;
    let operation_id = value
        .get("operationId")
        .and_then(|candidate| candidate.as_str())
        .filter(|candidate| !candidate.is_empty())
        .ok_or_else(|| "invalid new-session response: missing operationId".to_string())?;
    Ok(serde_json::json!({ "operationId": operation_id }))
}

/// Proxy: start a fresh session (clears history) for this window's project.
#[tauri::command]
async fn agent_new_session(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/new-session", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    parse_new_session_response(status, &body)
}

/// Proxy: store an API key for a provider.
#[tauri::command]
async fn agent_auth_apikey(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    provider: String,
    key: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_auth_oauth_start(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    provider: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_auth_oauth_code(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    code: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_mcp_elicit(
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

/// Proxy: disconnect a provider (clear its stored credentials).
#[tauri::command]
async fn agent_auth_logout(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    provider: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_cancel_queued(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let pane_id = pane_id.as_deref().unwrap_or(PRIMARY_PANE_ID);
    let gg_sid = pane_session_for(&webview, pane_id).ok_or("session not ready")?;
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
async fn agent_kill_task(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_import_transcript(
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
async fn agent_radio_state(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_radio_set(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    station: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_radio_volume(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    volume: f64,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_tasks(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_run_tasks(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    id: Option<String>,
    all: bool,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/tasks/run", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "id": id, "all": all }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    parse_sidecar_json_response(status, &body)
}

/// Proxy: delete a task by id. Returns the remaining `{ tasks }`.
#[tauri::command]
async fn agent_delete_task(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_accept_plan(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    plan_path: Option<String>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/plan/accept", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "planPath": plan_path }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    parse_sidecar_json_response(status, &body).map(|_| ())
}

fn parse_cancel_response(
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
async fn agent_cancel(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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

/// Proxy: retry only the Project Notes write for an already acknowledged cancellation.
#[tauri::command]
async fn agent_cancel_roadmap_status_retry(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!(
            "{}/cancel/roadmap-status/retry",
            sidecar_base(port)
        ))
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
async fn agent_ken_prompt(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    text: String,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_ken_cancel(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_autopilot_set(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_commands(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_models(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_switch_model(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    model: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_switch_ken_model(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    model: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_enhance_prompt(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    text: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/enhance", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "text": text }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: cycle the reasoning/thinking level to the next supported value.
/// Returns the new `{ thinkingLevel, supportedThinkingLevels }`.
#[tauri::command]
async fn agent_cycle_thinking(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_settings(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_save_settings(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    projects_root: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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

// ── Native app settings (~/.gg/gg-app.json) ───────────────────────────────
// The project folder is a plain home-dir file with NOTHING to do with the
// agent, so Rust reads/writes it directly. This makes the home-screen Settings
// + New project flow independent of the Node sidecar's boot — a slow or crashed
// sidecar used to make "Save project folder" silently fail or time out even on
// up-to-date builds. (The sidecar keeps its own /settings endpoint for its
// internal use; this is the authoritative path for the webview.)

/// Absolute path to ~/.gg/gg-app.json.
fn app_settings_path() -> PathBuf {
    home_dir().join(".gg").join("gg-app.json")
}

/// Default projects root: ~/gg-projects.
fn default_projects_root() -> PathBuf {
    home_dir().join("gg-projects")
}

/// Validate a project folder name: lowercase letters, digits, single dashes
/// between segments (mirrors the sidecar's isValidProjectName).
fn is_valid_project_name(name: &str) -> bool {
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
fn app_settings_get() -> serde_json::Value {
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
fn app_settings_save(projects_root: String) -> Result<serde_json::Value, String> {
    let trimmed = projects_root.trim();
    if trimmed.is_empty() {
        return Err("projectsRoot is required".to_string());
    }
    let path = app_settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::json!({ "projectsRoot": trimmed });
    let pretty = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "projectsRoot": trimmed }))
}

/// Native: create a new project folder under the configured projects root.
/// Returns `{ path }` on success, an error message on invalid name / conflict.
/// Never needs the sidecar.
#[tauri::command]
fn app_create_project(name: String) -> Result<serde_json::Value, String> {
    let name = name.trim();
    if !is_valid_project_name(name) {
        return Err(
            "Project name must be lowercase letters, digits, and dashes (e.g. my-project)."
                .to_string(),
        );
    }
    // Resolve the projects root the same way app_settings_get does.
    let settings = app_settings_get();
    let root = settings
        .get("projectsRoot")
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(default_projects_root);
    let dir = root.join(name);
    if dir.exists() {
        return Err(format!("A folder named \"{name}\" already exists."));
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
struct WorkspaceEntry {
    #[serde(default)]
    mode: WorkspaceMode,
    #[serde(rename = "chatAgent", default)]
    chat_agent: ChatAgent,
    cwd: String,
    #[serde(
        rename = "sessionPath",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    session_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    y: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
}

/// The whole snapshot: an ordered list of open windows (main first).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
struct Workspace {
    #[serde(default)]
    windows: Vec<WorkspaceEntry>,
}

/// Absolute path to ~/.gg/gg-app-workspace.json.
fn app_workspace_path() -> PathBuf {
    home_dir().join(".gg").join("gg-app-workspace.json")
}

/// Read the workspace snapshot; missing/invalid file → an empty workspace.
fn read_workspace() -> Workspace {
    std::fs::read_to_string(app_workspace_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Workspace>(&s).ok())
        .unwrap_or_default()
}

/// Write the workspace snapshot (creating ~/.gg if needed). Best-effort.
fn write_workspace(ws: &Workspace) {
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
fn keep_for_snapshot(workspace_selected: bool, cwd: Option<&Path>) -> bool {
    workspace_selected && cwd.is_some()
}

/// Pure: drop restore entries that can't be opened (empty cwd, or a cwd that no
/// longer exists). `exists` is injected so this is testable without the fs.
fn filter_restorable<F: Fn(&str) -> bool>(
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
fn snapshot_workspace(app: &tauri::AppHandle) {
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
        let Some(inst) = map.get(label).and_then(|panes| panes.get(PRIMARY_PANE_ID)) else {
            continue;
        };
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
fn remove_window_from_workspace(app: &tauri::AppHandle, label: &str) {
    let target = {
        let state: State<Windows> = app.state();
        let map = state.map.lock().unwrap();
        map.get(label)
            .and_then(|panes| panes.get(PRIMARY_PANE_ID))
            .and_then(|i| {
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
fn window_restore_target(webview: WebviewWindow) -> Option<RestoreEntry> {
    let state: State<RestoreTargets> = webview.state();
    let map = state.map.lock().unwrap();
    restore_target(&map, webview.label())
}

// ── Native provider auth status (~/.gg/auth.json) ─────────────────────────
// The AI-providers list is STATIC metadata and the "connected" badge only needs
// to read which provider keys exist in ~/.gg/auth.json — neither needs the Node
// agent. Reading it natively means the login hub always renders even when the
// sidecar is slow/crashed (it used to show a blank list, identical in spirit to
// the project-folder bug). The login ACTIONS (OAuth flow, key storage, logout)
// still go through the sidecar — those genuinely need the agent.
//
// This list mirrors packages/ggcoder/src/core/auth-providers.ts (AUTH_PROVIDERS).
// Keep the two in sync when adding a provider.

/// Absolute path to ~/.gg/auth.json.
fn auth_file_path() -> PathBuf {
    home_dir().join(".gg").join("auth.json")
}

/// One API-key option for a provider that splits auth across multiple
/// distinct endpoints/credentials (currently only Xiaomi: Token Plan vs.
/// API Credits). Mirrors `ApiKeyVariant` in
/// packages/ggcoder/src/core/auth-providers.ts.
#[derive(PartialEq, Debug)]
struct ApiKeyVariant {
    /// Storage key in auth.json (distinct from the provider `value`).
    key: &'static str,
    /// Display label, e.g. "Token Plan" or "API Credits".
    label: &'static str,
    /// Base URL stored alongside this variant's credential.
    base_url: Option<&'static str>,
}

/// Static metadata for one AI provider in the login hub. Mirrors
/// packages/ggcoder/src/core/auth-providers.ts (AUTH_PROVIDERS) — keep in sync.
struct ProviderMeta {
    /// Storage key in auth.json + the value the webview passes back.
    value: &'static str,
    label: &'static str,
    description: &'static str,
    /// Supported auth methods, e.g. `["oauth"]`, `["apikey"]`, or both.
    methods: &'static [&'static str],
    api_key_label: Option<&'static str>,
    /// Custom API base URL stored alongside an API-key credential. Used as the
    /// default when `api_key_variants` is empty.
    api_key_base_url: Option<&'static str>,
    /// When a provider's API-key auth splits across multiple endpoints, the
    /// choices to present (first = default). Empty for every single-credential
    /// provider.
    api_key_variants: &'static [ApiKeyVariant],
}

/// The provider catalog (single source of truth for app_auth_status +
/// app_auth_apikey). Order is the display order in the login hub.
const AUTH_PROVIDERS: &[ProviderMeta] = &[
    ProviderMeta {
        value: "anthropic",
        label: "Anthropic",
        description: "Claude Fable 5, Opus 4.8, Sonnet 5, Haiku 4.5",
        methods: &["oauth"],
        api_key_label: None,
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "openai",
        label: "OpenAI",
        description: "GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.5",
        methods: &["oauth"],
        api_key_label: None,
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "gemini",
        label: "Gemini",
        description: "Gemini 3.1 Flash Lite, Gemini 3.5 Flash, Gemini 3.1 Pro (Preview)",
        methods: &["oauth"],
        api_key_label: None,
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "xai",
        label: "xAI (Grok)",
        description: "Grok 4.5",
        methods: &["apikey"],
        api_key_label: Some("xAI"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "moonshot",
        label: "Moonshot",
        description: "Kimi K3, K2.7 Code · OAuth or API key",
        methods: &["oauth", "apikey"],
        api_key_label: Some("Moonshot"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "glm",
        label: "Z.AI (GLM)",
        description: "GLM-5.2, GLM-5.1, GLM-4.7, GLM-4.7 Flash",
        methods: &["apikey"],
        api_key_label: Some("Z.AI"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "minimax",
        label: "MiniMax",
        description: "MiniMax M3",
        methods: &["apikey"],
        api_key_label: Some("MiniMax"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "xiaomi",
        label: "Xiaomi (MiMo)",
        description:
            "MiMo-V2.5-Pro, MiMo-V2.5-Pro-UltraSpeed, MiMo-V2.5 · Token Plan or API Credits",
        methods: &["apikey"],
        api_key_label: Some("Xiaomi MiMo"),
        api_key_base_url: Some("https://token-plan-sgp.xiaomimimo.com/v1"),
        api_key_variants: &[
            ApiKeyVariant {
                key: "xiaomi",
                label: "Token Plan",
                base_url: Some("https://token-plan-sgp.xiaomimimo.com/v1"),
            },
            ApiKeyVariant {
                key: "xiaomi-credits",
                label: "API Credits (required for UltraSpeed)",
                base_url: Some("https://api.xiaomimimo.com/v1"),
            },
        ],
    },
    ProviderMeta {
        value: "deepseek",
        label: "DeepSeek",
        description: "DeepSeek V4 Pro, V4 Flash",
        methods: &["apikey"],
        api_key_label: Some("DeepSeek"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "sakana",
        label: "Sakana (Fugu)",
        description: "Fugu, Fugu Ultra",
        methods: &["apikey"],
        api_key_label: Some("Sakana"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "openrouter",
        label: "OpenRouter",
        description: "Multi-provider gateway",
        methods: &["apikey"],
        api_key_label: Some("OpenRouter"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
];

/// Pure: resolve `(storage_key, base_url)` for an API-key submission to
/// `provider`, given an optional variant key. Providers with multiple
/// `api_key_variants` (currently only Xiaomi: Token Plan vs. API Credits)
/// select the matching variant, defaulting to the first/primary one when
/// `variant` is absent or unknown. Single-variant providers ignore `variant`
/// and use the flat `api_key_base_url`. Returns `None` if `provider` is
/// unknown or doesn't support API-key auth.
fn resolve_apikey_target(
    provider: &str,
    variant: Option<&str>,
) -> Option<(String, Option<&'static str>)> {
    let meta = AUTH_PROVIDERS
        .iter()
        .find(|p| p.value == provider && p.methods.contains(&"apikey"))?;
    if meta.api_key_variants.is_empty() {
        return Some((meta.value.to_string(), meta.api_key_base_url));
    }
    let chosen = variant
        .and_then(|v| meta.api_key_variants.iter().find(|x| x.key == v))
        .unwrap_or(&meta.api_key_variants[0]);
    Some((chosen.key.to_string(), chosen.base_url))
}

/// Native: provider list + live connection status, read directly from
/// ~/.gg/auth.json. `connected` is true when a credential key is present
/// (moonshot is satisfied by either its OAuth key `moonshot-oauth` or the
/// `moonshot` API key; a multi-variant provider like Xiaomi is satisfied by
/// ANY of its variant keys — mirrors AuthStorage.hasProviderAuth). Never needs
/// the sidecar.
#[tauri::command]
fn app_auth_status() -> serde_json::Value {
    // Parse the auth file into a JSON object; missing/invalid → empty (no creds).
    let creds = std::fs::read_to_string(auth_file_path())
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    let has_key = |key: &str| -> bool {
        creds
            .as_ref()
            .and_then(|v| v.get(key))
            .map(|v| !v.is_null())
            .unwrap_or(false)
    };
    let connected = |p: &ProviderMeta| -> bool {
        if p.value == "moonshot" {
            return has_key("moonshot-oauth") || has_key("moonshot");
        }
        if !p.api_key_variants.is_empty() {
            return has_key(p.value) || p.api_key_variants.iter().any(|v| has_key(v.key));
        }
        has_key(p.value)
    };

    let list: Vec<serde_json::Value> = AUTH_PROVIDERS
        .iter()
        .map(|p| {
            let mut obj = serde_json::json!({
                "value": p.value,
                "label": p.label,
                "description": p.description,
                "methods": p.methods,
                "connected": connected(p),
            });
            if let Some(l) = p.api_key_label {
                obj["apiKeyLabel"] = serde_json::json!(l);
            }
            if let Some(u) = p.api_key_base_url {
                obj["apiKeyBaseUrl"] = serde_json::json!(u);
            }
            if !p.api_key_variants.is_empty() {
                let variants: Vec<serde_json::Value> = p
                    .api_key_variants
                    .iter()
                    .map(|v| {
                        serde_json::json!({
                            "key": v.key,
                            "label": v.label,
                            "baseUrl": v.base_url,
                        })
                    })
                    .collect();
                obj["apiKeyVariants"] = serde_json::json!(variants);
            }
            obj
        })
        .collect();

    serde_json::json!({ "providers": list })
}

// ── Native API-key auth writes (~/.gg/auth.json) ──────────────────────────
// Storing/removing an API key is a pure mutation of auth.json — the SAME file
// app_auth_status reads. Doing it natively (not via the sidecar) means a fresh
// user can log in even though their not-yet-configured sidecar may not be up:
// the sidecar used to crash on boot when no provider was configured, so a
// sidecar-routed key write would hang forever. Mirrors AuthStorage on the Node
// side (the credential shape + moonshot's dual-key logout).

/// API-key credentials never expire in practice; mirror the sidecar's ~100-year
/// horizon (365d * 100) so refresh logic never treats them as stale.
const API_KEY_TTL_MS: i64 = 365 * 24 * 60 * 60 * 1000 * 100;

/// Pure: build the OAuthCredentials JSON object for an API key (matches
/// AuthStorage's shape: accessToken + empty refreshToken + far-future expiry +
/// optional baseUrl). `now_ms` is injected for testability.
fn apikey_credential_json(key: &str, base_url: Option<&str>, now_ms: i64) -> serde_json::Value {
    let mut obj = serde_json::json!({
        "accessToken": key,
        "refreshToken": "",
        "expiresAt": now_ms + API_KEY_TTL_MS,
    });
    if let Some(url) = base_url {
        obj["baseUrl"] = serde_json::json!(url);
    }
    obj
}

/// Pure: upsert an API-key credential into the existing auth.json text
/// (read-modify-write), preserving every other provider's entry. Returns the
/// new pretty-printed JSON. `existing` is the current file contents (None when
/// the file is missing). Errors only on a malformed (non-object) existing file.
fn apply_apikey(
    existing: Option<&str>,
    provider: &str,
    base_url: Option<&str>,
    now_ms: i64,
    key: &str,
) -> Result<String, String> {
    let mut root = parse_auth_object(existing)?;
    if let Some(map) = root.as_object_mut() {
        map.insert(
            provider.to_string(),
            apikey_credential_json(key, base_url, now_ms),
        );
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Pure: remove a provider's credential from the existing auth.json text.
/// Moonshot also drops its distinct OAuth key (`moonshot-oauth`) so a single
/// "disconnect" fully removes Kimi OAuth + the Moonshot API key. Returns the new
/// pretty-printed JSON (an empty object `{}` when nothing remains / no file).
fn apply_logout(existing: Option<&str>, provider: &str) -> Result<String, String> {
    let mut root = parse_auth_object(existing)?;
    if let Some(map) = root.as_object_mut() {
        map.remove(provider);
        if provider == "moonshot" {
            map.remove("moonshot-oauth");
        }
        if let Some(meta) = AUTH_PROVIDERS.iter().find(|p| p.value == provider) {
            for v in meta.api_key_variants {
                map.remove(v.key);
            }
        }
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Parse auth.json text into a JSON object value. Missing file → empty object.
/// A present-but-malformed/non-object file is an error (refuse to clobber it).
fn parse_auth_object(existing: Option<&str>) -> Result<serde_json::Value, String> {
    match existing {
        None => Ok(serde_json::json!({})),
        Some(s) if s.trim().is_empty() => Ok(serde_json::json!({})),
        Some(s) => {
            let v: serde_json::Value =
                serde_json::from_str(s).map_err(|e| format!("auth.json is not valid JSON: {e}"))?;
            if v.is_object() {
                Ok(v)
            } else {
                Err("auth.json is not a JSON object".to_string())
            }
        }
    }
}

/// Atomically write auth.json (temp file + rename), creating ~/.gg if needed.
/// On unix the file is mode 0600 (credentials). Mirrors gg-core's atomicWriteFile.
fn write_auth_file(contents: &str) -> Result<(), String> {
    let path = auth_file_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(())
}

/// Native: store an API key for a provider directly in ~/.gg/auth.json. Never
/// touches the sidecar, so it can't hang on a not-yet-booted agent. Validates
/// that the provider exists and supports API-key auth, and that the key is
/// non-empty. `variant` selects which storage key/base URL to use for
/// providers with multiple API-key options (currently only Xiaomi); omitted or
/// unknown defaults to the first/primary variant. Returns `{ ok: true }`.
#[tauri::command]
fn app_auth_apikey(
    provider: String,
    key: String,
    variant: Option<String>,
) -> Result<serde_json::Value, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("API key is required".to_string());
    }
    let (storage_key, base_url) = resolve_apikey_target(&provider, variant.as_deref())
        .ok_or_else(|| "provider does not support API key auth".to_string())?;
    let existing = std::fs::read_to_string(auth_file_path()).ok();
    let now_ms = current_unix_millis();
    let next = apply_apikey(existing.as_deref(), &storage_key, base_url, now_ms, key)?;
    write_auth_file(&next)?;
    Ok(serde_json::json!({ "ok": true }))
}

/// Native: disconnect a provider (remove its credential from ~/.gg/auth.json).
/// Moonshot also clears its OAuth key; any provider with multiple
/// `api_key_variants` (currently only Xiaomi) clears every variant key, so a
/// single "disconnect" fully removes all of a provider's credentials. Never
/// touches the sidecar. Returns `{ ok: true }`.
#[tauri::command]
fn app_auth_logout(app: tauri::AppHandle, provider: String) -> Result<serde_json::Value, String> {
    let existing = std::fs::read_to_string(auth_file_path()).ok();
    // Nothing to remove and no file → succeed silently (idempotent).
    if existing.is_none() {
        return Ok(serde_json::json!({ "ok": true }));
    }
    let next = apply_logout(existing.as_deref(), &provider)?;
    write_auth_file(&next)?;
    // Disconnecting removes that provider's models from `/models` and clears
    // its connection dot. Logout is deliberately native (it must work even with
    // no daemon), so the sidecar never learns about it — tell every window
    // directly, or their pickers keep offering models the user can no longer
    // authenticate against and the login screen still shows them connected.
    broadcast_agent_event(&app, "models_change", serde_json::json!({}));
    broadcast_agent_event(
        &app,
        "auth_change",
        serde_json::json!({ "provider": provider }),
    );
    Ok(serde_json::json!({ "ok": true }))
}

/// Emit one `agent-event` frame to EVERY window, matching the shape the SSE
/// bridge produces. For global state changed natively, outside any session.
fn broadcast_agent_event(app: &tauri::AppHandle, event_type: &str, data: serde_json::Value) {
    for label in app.webview_windows().keys() {
        let _ = app.emit_to(
            EventTarget::webview_window(label.clone()),
            "agent-event",
            serde_json::json!({ "type": event_type, "data": data }),
        );
    }
}

/// Current unix time in milliseconds (wall clock; fine for an expiry stamp).
fn current_unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Proxy: read Telegram config status (configured + masked preview).
#[tauri::command]
async fn agent_telegram_get(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_local(
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
async fn agent_local_scan(
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
async fn agent_local_endpoint_add(
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
async fn agent_local_endpoint_remove(
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

/// Proxy: save Telegram config (bot token + user id). Verifies the token via
/// getMe sidecar-side; returns an error message on rejection.
#[tauri::command]
async fn agent_telegram_save(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    bot_token: String,
    user_id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_serve_status(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_serve_start(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_serve_stop(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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

/// Proxy: list MCP servers with live connection status (`{ servers: […] }`).
/// `cwd` (project scope) scopes the project servers to a specific project path.
#[tauri::command]
async fn agent_mcp_list(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_mcp_add(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    line: String,
    scope: String,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_mcp_remove(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    name: String,
    scope: String,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_mcp_login(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    name: String,
    scope: String,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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
async fn agent_create_project(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    name: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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

/// Proxy: discover known projects across ggcoder/Claude Code/Codex stores.
#[tauri::command]
async fn agent_projects(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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

/// Proxy: list recent sessions for a project cwd.
#[tauri::command]
async fn agent_sessions(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    cwd: String,
    chat_agent: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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

/// Proxy: search project files for the chat input's `@` picker. Empty `query`
/// returns the most-recently-modified files; a query returns fuzzy matches.
#[tauri::command]
async fn agent_files(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    query: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
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

const LOCAL_PATCHED_UPDATE_EVENT: &str = "local-patched-update";

#[tauri::command]
fn app_local_patched_update_start(
    app: tauri::AppHandle,
    update_state: State<'_, LocalPatchedUpdate>,
    repo_root: String,
) -> Result<serde_json::Value, String> {
    let repo = resolve_local_update_repo_root(repo_root)?;
    {
        let mut running = update_state.running.lock().unwrap();
        if *running {
            return Err("A local-patched update is already running.".into());
        }
        *running = true;
    }
    std::thread::spawn(move || run_local_patched_update(app, repo));
    Ok(serde_json::json!({ "started": true }))
}

fn resolve_local_update_repo_root(repo_root: String) -> Result<PathBuf, String> {
    let raw = if repo_root.trim().is_empty() {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
    } else {
        PathBuf::from(repo_root)
    };
    let repo = std::fs::canonicalize(&raw).map_err(|e| {
        format!(
            "Could not find the local source checkout at {}: {e}",
            raw.display()
        )
    })?;
    if !repo.join("package.json").is_file()
        || !repo.join("gg-app/package.json").is_file()
        || !repo
            .join("gg-app/scripts/update-with-local-fixes.mjs")
            .is_file()
    {
        return Err(format!(
            "{} does not look like the local gg-framework checkout.",
            repo.display()
        ));
    }
    Ok(repo)
}

fn emit_local_patched_update(app: &tauri::AppHandle, payload: serde_json::Value) {
    let _ = app.emit(LOCAL_PATCHED_UPDATE_EVENT, payload);
}

fn run_local_patched_update(app: tauri::AppHandle, repo: PathBuf) {
    emit_local_patched_update(
        &app,
        serde_json::json!({
            "type": "started",
            "message": "Starting protected source update: backup, fetch, rebase, restore, check, and build.",
        }),
    );
    let mut command = local_patched_update_command();
    command
        .current_dir(&repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            finish_local_patched_update(
                &app,
                serde_json::json!({
                    "type": "error",
                    "message": format!("Failed to start the local source updater: {error}"),
                }),
            );
            return;
        }
    };
    let mut readers: Vec<JoinHandle<()>> = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        readers.push(stream_local_update_output(app.clone(), "stdout", stdout));
    }
    if let Some(stderr) = child.stderr.take() {
        readers.push(stream_local_update_output(app.clone(), "stderr", stderr));
    }
    let status = child.wait();
    for reader in readers {
        let _ = reader.join();
    }

    match status {
        Ok(status) if status.success() => {
            let installer = newest_rebuilt_installer(&repo);
            let opened = open_rebuilt_update_result(&app, installer.as_deref(), &repo);
            emit_local_patched_update(
                &app,
                serde_json::json!({
                    "type": "completed",
                    "exitCode": status.code().unwrap_or(0),
                    "installerPath": installer.map(|path| path.to_string_lossy().to_string()),
                    "opened": opened,
                    "message": completed_local_update_message(opened),
                }),
            );
            clear_local_patched_update_running(&app);
        }
        Ok(status) => finish_local_patched_update(
            &app,
            serde_json::json!({
                "type": "error",
                "exitCode": status.code(),
                "message": format!(
                    "Local-patched update failed with exit code {}. Review the progress output for recovery instructions.",
                    status.code().map_or_else(|| "unknown".into(), |code| code.to_string())
                ),
            }),
        ),
        Err(error) => finish_local_patched_update(
            &app,
            serde_json::json!({
                "type": "error",
                "message": format!("Local-patched update process failed: {error}"),
            }),
        ),
    }
}

fn local_patched_update_command() -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("cmd");
        command.args([
            "/C",
            "pnpm",
            "--filter",
            "gg-app",
            "update:local-fixes",
            "--",
            "--check",
        ]);
        command
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut command = Command::new("pnpm");
        command.args(["--filter", "gg-app", "update:local-fixes", "--", "--check"]);
        command
    }
}

fn stream_local_update_output<R: Read + Send + 'static>(
    app: tauri::AppHandle,
    stream: &'static str,
    reader: R,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            emit_local_patched_update(
                &app,
                serde_json::json!({ "type": "line", "stream": stream, "line": line }),
            );
        }
    })
}

fn newest_rebuilt_installer(repo: &Path) -> Option<PathBuf> {
    let bundle = repo.join("gg-app/src-tauri/target/release/bundle");
    let directories = ["nsis", "msi", "dmg", "appimage", "deb", "rpm"];
    let mut newest: Option<(SystemTime, PathBuf)> = None;
    for directory in directories.map(|name| bundle.join(name)) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            if !["exe", "msi", "dmg", "AppImage", "deb", "rpm"]
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
            {
                continue;
            }
            let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
                continue;
            };
            if newest.as_ref().is_none_or(|(time, _)| modified > *time) {
                newest = Some((modified, path));
            }
        }
    }
    newest.map(|(_, path)| path)
}

fn open_rebuilt_update_result(
    app: &tauri::AppHandle,
    installer: Option<&Path>,
    repo: &Path,
) -> &'static str {
    if let Some(installer) = installer {
        if app
            .opener()
            .open_path(installer.to_string_lossy().to_string(), None::<String>)
            .is_ok()
        {
            return "installer";
        }
    }
    let bundle = repo.join("gg-app/src-tauri/target/release/bundle");
    if app
        .opener()
        .open_path(bundle.to_string_lossy().to_string(), None::<String>)
        .is_ok()
    {
        "folder"
    } else {
        "none"
    }
}

fn completed_local_update_message(opened: &str) -> &'static str {
    match opened {
        "installer" => "Patched installer built and opened. Finish installation to update the app.",
        "folder" => "Patched installer built. Opened its containing folder.",
        _ => "Patched installer built under gg-app/src-tauri/target/release/bundle.",
    }
}

fn finish_local_patched_update(app: &tauri::AppHandle, payload: serde_json::Value) {
    emit_local_patched_update(app, payload);
    clear_local_patched_update_running(app);
}

fn clear_local_patched_update_running(app: &tauri::AppHandle) {
    let state: State<LocalPatchedUpdate> = app.state();
    *state.running.lock().unwrap() = false;
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
fn exact_fixture_opt_in(enabled: bool, value: Option<&str>) -> bool {
    enabled && value == Some("1")
}

fn phase25_dev_fixture_enabled() -> bool {
    exact_fixture_opt_in(
        cfg!(debug_assertions),
        std::env::var("GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP")
            .ok()
            .as_deref(),
    )
}

#[cfg(all(debug_assertions, target_os = "macos"))]
fn phase26_macos_smoke_enabled() -> bool {
    exact_fixture_opt_in(
        cfg!(all(debug_assertions, target_os = "macos")),
        std::env::var("GG_PHASE26_MACOS_SMOKE").ok().as_deref(),
    )
}

fn build_app_window_with_visibility(
    app: &tauri::AppHandle,
    label: &str,
    visible: bool,
) -> Result<WebviewWindow, String> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Supah Coder")
        .inner_size(1024.0, 720.0)
        .min_inner_size(480.0, 360.0)
        .background_color(APP_BG)
        .visible(visible);
    #[cfg(target_os = "windows")]
    if cfg!(feature = "native-smoke") || phase25_dev_fixture_enabled() {
        let port_variable = if cfg!(feature = "native-smoke") {
            "GG_APP_NATIVE_SMOKE_CDP_PORT"
        } else {
            "GG_PHASE25_DEV_FIXTURE_CDP_PORT"
        };
        let cdp_port = std::env::var(port_variable)
            .map_err(|_| format!("{port_variable} is required"))?
            .parse::<u16>()
            .map_err(|_| format!("{port_variable} must be a TCP port"))?;
        let browser_args = format!("--remote-debugging-port={cdp_port}");
        builder = builder.additional_browser_args(&browser_args);
    }
    // Windows needs HTML5 drop enabled for the existing browser attachment path.
    // macOS keeps Tauri's native handler so folder drops include absolute paths.
    #[cfg(target_os = "windows")]
    {
        builder = builder.disable_drag_drop_handler();
    }
    if matches!(window_chrome(), WindowChrome::MacOverlay) {
        builder = apply_mac_overlay(builder);
    }
    builder.build().map_err(|e| e.to_string())
}

fn build_app_window(app: &tauri::AppHandle, label: &str) -> Result<WebviewWindow, String> {
    build_app_window_with_visibility(app, label, true)
}

/// Open enough new project windows to reach `count` total (each with its own
/// agent sidecar at the default cwd), then tile the first `count` windows across
/// the work area like macOS fill&arrange. Project selection per window happens
/// in-app via the picker; windows open immediately.
///
/// MUST be `async`: on Windows, `WebviewWindowBuilder::build()` deadlocks when
/// called from a SYNCHRONOUS command (WebView2 runs window creation on the
/// event loop the sync command is blocking). The symptom was a blank,
/// unresponsive, uncloseable window. An async command runs off that thread, so
/// creation completes normally. See the docs.rs WebviewWindowBuilder "Known
/// issues" note.
#[tauri::command]
async fn setup_windows(app: tauri::AppHandle, count: usize) -> Result<(), String> {
    let existing = app.webview_windows().len();
    let to_create = count.saturating_sub(existing);
    for _ in 0..to_create {
        let label = next_window_label(&app);
        // macOS-only chrome: the Overlay title bar + hidden title lets the
        // webview draw under the traffic lights. Windows/Linux keep native
        // chrome (Overlay is a no-op / unsupported there) and the webview CSS
        // drops the mac traffic-light insets via the `.platform-*` class.
        let win = build_app_window(&app, &label)?;
        start_window_session(
            app.clone(),
            label,
            WorkspaceMode::Code,
            ChatAgent::General,
            default_cwd(),
            None,
        );
        let _ = win.set_focus();
    }
    arrange_windows(&app, count);
    broadcast_window_order(&app);
    Ok(())
}

fn copy_window_label(copy_id: &str) -> String {
    format!("copy-{copy_id}")
}

fn clone_pane_session_file(source: &Path, copy_id: &str) -> Result<PathBuf, String> {
    if !source.is_file() {
        return Err("the pane session is not available to copy".into());
    }
    let parent = source
        .parent()
        .ok_or("the pane session has no parent directory")?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("session");
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("jsonl");
    let destination = parent.join(format!("{stem}-copy-{copy_id}.{extension}"));
    if destination.exists() {
        return Ok(destination);
    }

    // Copy to a sibling temporary file, validate complete JSONL, assign the
    // duplicate a fresh durable session identity, then publish by atomic rename.
    // The caller only allows idle panes, so no session writer is active.
    let temporary = parent.join(format!(".{stem}-copy-{copy_id}.tmp"));
    std::fs::copy(source, &temporary).map_err(|error| error.to_string())?;
    let contents = std::fs::read_to_string(&temporary).map_err(|error| error.to_string())?;
    let parsed = (|| -> Option<String> {
        if !contents.ends_with('\n') {
            return None;
        }
        let first_newline = contents.find('\n')?;
        let mut header =
            serde_json::from_str::<serde_json::Value>(&contents[..first_newline]).ok()?;
        if header.get("type").and_then(|value| value.as_str()) != Some("session") {
            return None;
        }
        if !contents[first_newline + 1..]
            .lines()
            .all(|line| serde_json::from_str::<serde_json::Value>(line).is_ok())
        {
            return None;
        }
        header["id"] = serde_json::Value::String(copy_id.to_string());
        Some(format!("{}{}", header, &contents[first_newline..]))
    })();
    let Some(rewritten) = parsed else {
        let _ = std::fs::remove_file(&temporary);
        return Err("the pane session changed while it was being copied".into());
    };
    if let Err(error) = std::fs::write(&temporary, rewritten) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    std::fs::rename(&temporary, &destination).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        error.to_string()
    })?;
    Ok(destination)
}

/// Prepare an owner-scoped copy. The source pane stays registered and running;
/// only its durable session file is snapshotted to a new path for the destination.
#[tauri::command]
async fn agent_pane_copy(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    client: tauri::State<'_, reqwest::Client>,
    pane_id: String,
    copy_id: String,
) -> Result<PreparedPaneCopy, String> {
    validate_pane_id(&pane_id)?;
    validate_pane_id(&copy_id)?;
    let owner = webview.label().to_string();

    if let Some(existing) = app
        .state::<PaneCopies>()
        .map
        .lock()
        .unwrap()
        .operations
        .get(&(owner.clone(), copy_id.clone()))
        .cloned()
    {
        return Ok(PreparedPaneCopy {
            copy_id,
            window_label: existing.target_label,
            reused_window: true,
        });
    }

    let source = {
        let windows: State<Windows> = app.state();
        let registry = windows.map.lock().unwrap();
        resolve_owned_pane(&registry, &owner, &pane_id)
            .cloned()
            .ok_or_else(|| format!("pane '{pane_id}' does not exist in this window"))?
    };
    let session_id = source
        .session_id
        .clone()
        .ok_or("pane session is not ready")?;
    let state = sidecar_get_json(&webview, &pane_id, &client, "/state").await?;
    if state.get("running").and_then(|value| value.as_bool()) == Some(true)
        || state.get("runState").and_then(|value| value.as_str()) != Some("idle")
    {
        return Err("wait for the pane to finish before copying it".into());
    }
    let live_session_path = state
        .get("sessionPath")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| source.session_path.as_ref().map(PathBuf::from))
        .ok_or("pane session has not been persisted yet")?;

    {
        let windows: State<Windows> = app.state();
        let registry = windows.map.lock().unwrap();
        if !pane_identity_is_current(&registry, &owner, &pane_id, source.generation, &session_id) {
            return Err("pane changed while the copy was being prepared".into());
        }
    }

    let cloned_path = clone_pane_session_file(&live_session_path, &copy_id)?;
    let cwd = source.cwd.ok_or("pane has no project target")?;
    let restore = RestoreEntry {
        mode: source.mode,
        chat_agent: source.chat_agent,
        cwd: cwd.to_string_lossy().to_string(),
        session_path: Some(cloned_path.to_string_lossy().to_string()),
    };
    let target_label = {
        let copies: State<PaneCopies> = app.state();
        let mut registry = copies.map.lock().unwrap();
        let key = (owner.clone(), copy_id.clone());
        if let Some(existing) = registry.operations.get(&key) {
            return Ok(PreparedPaneCopy {
                copy_id,
                window_label: existing.target_label.clone(),
                reused_window: true,
            });
        }
        let label = copy_window_label(&copy_id);
        if app.get_webview_window(&label).is_some() || registry.target_owners.contains_key(&label) {
            let _ = std::fs::remove_file(&cloned_path);
            return Err("copy destination label is already in use".into());
        }
        registry.target_owners.insert(label.clone(), key.clone());
        registry.operations.insert(
            key,
            PaneCopyOperation {
                source_owner: owner,
                target_label: label.clone(),
                restore,
                cloned_session_path: Some(cloned_path),
                started: false,
            },
        );
        label
    };
    Ok(PreparedPaneCopy {
        copy_id,
        window_label: target_label,
        reused_window: false,
    })
}

async fn rollback_pane_copy(app: &tauri::AppHandle, operation: PaneCopyOperation) {
    remove_restore_target(
        &mut app.state::<RestoreTargets>().map.lock().unwrap(),
        &operation.target_label,
    );
    let panes = {
        let windows: State<Windows> = app.state();
        let mut registry = windows.map.lock().unwrap();
        take_window_panes(&mut registry, &operation.target_label)
    };
    let daemon_port = *app.state::<Daemon>().port.lock().unwrap();
    if let Some(port) = daemon_port {
        for pane in panes {
            if let Some(session_id) = pane.session_id {
                let _ = daemon_delete_session(app, port, &session_id).await;
            }
        }
    }
    if let Some(path) = operation.cloned_session_path {
        let _ = std::fs::remove_file(path);
    }
    if let Some(window) = app.get_webview_window(&operation.target_label) {
        app.state::<PaneCopies>()
            .map
            .lock()
            .unwrap()
            .rolling_back
            .insert(operation.target_label.clone());
        let _ = window.close();
    }
}

/// Build/start the reserved destination. Retries with the same copy id focus the
/// already-started window instead of creating another one.
#[tauri::command]
async fn agent_pane_copy_startup(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    copy_id: String,
) -> Result<PaneCopyResult, String> {
    validate_pane_id(&copy_id)?;
    let owner = webview.label().to_string();
    let operation = app
        .state::<PaneCopies>()
        .map
        .lock()
        .unwrap()
        .operations
        .get(&(owner.clone(), copy_id.clone()))
        .cloned()
        .ok_or("pane copy reservation does not exist")?;
    if operation.source_owner != owner {
        return Err("pane copy reservation belongs to another window".into());
    }
    if operation.started {
        if let Some(window) = app.get_webview_window(&operation.target_label) {
            let _ = window.set_focus();
            return Ok(PaneCopyResult {
                window_label: operation.target_label,
                reused_window: true,
            });
        }
        return Err("the copied window closed before startup completed".into());
    }

    register_restore_target(
        &mut app.state::<RestoreTargets>().map.lock().unwrap(),
        operation.target_label.clone(),
        operation.restore.clone(),
    );
    let window = match build_app_window_with_visibility(&app, &operation.target_label, false) {
        Ok(window) => window,
        Err(error) => {
            let removed = remove_copy_operation(
                &mut app.state::<PaneCopies>().map.lock().unwrap(),
                &owner,
                &copy_id,
            );
            if let Some(removed) = removed {
                rollback_pane_copy(&app, removed).await;
            }
            return Err(error);
        }
    };
    start_window_session(
        app.clone(),
        operation.target_label.clone(),
        operation.restore.mode,
        operation.restore.chat_agent,
        PathBuf::from(&operation.restore.cwd),
        operation.restore.session_path.clone(),
    );

    let mut startup_error = None;
    for _ in 0..600 {
        if app.get_webview_window(&operation.target_label).is_none() {
            startup_error = Some("copied window closed during startup".into());
            break;
        }
        let status = {
            let windows: State<Windows> = app.state();
            let registry = windows.map.lock().unwrap();
            pane_startup_status(&registry, &operation.target_label, PRIMARY_PANE_ID).ok()
        };
        if let Some(status) = status {
            if let Some(error) = status.error {
                startup_error = Some(error);
                break;
            }
            if status.ready && port_for(&webview).is_some() {
                let marked_started = app
                    .state::<PaneCopies>()
                    .map
                    .lock()
                    .unwrap()
                    .operations
                    .get_mut(&(owner.clone(), copy_id.clone()))
                    .map(|operation| operation.started = true)
                    .is_some();
                if !marked_started {
                    startup_error = Some("copy was closed during startup".into());
                    break;
                }
                let _ = window.show();
                let _ = window.set_focus();
                snapshot_workspace(&app);
                broadcast_window_order(&app);
                return Ok(PaneCopyResult {
                    window_label: operation.target_label,
                    reused_window: false,
                });
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let removed = remove_copy_operation(
        &mut app.state::<PaneCopies>().map.lock().unwrap(),
        &owner,
        &copy_id,
    );
    if let Some(removed) = removed {
        rollback_pane_copy(&app, removed).await;
    }
    Err(startup_error.unwrap_or_else(|| "copied pane did not start in time".into()))
}

/// Consume-once destination hydration. A source or unrelated window cannot read
/// the target because ownership is looked up from the calling webview label.
#[tauri::command]
fn agent_pane_copy_restore(webview: WebviewWindow) -> Option<RestoreEntry> {
    let copies: State<PaneCopies> = webview.state();
    let targets: State<RestoreTargets> = webview.state();
    let copies = copies.map.lock().unwrap();
    let mut targets = targets.map.lock().unwrap();
    consume_copy_restore_target(&copies, &mut targets, webview.label())
}

#[tauri::command]
async fn agent_pane_copy_rollback(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    copy_id: String,
) -> Result<(), String> {
    validate_pane_id(&copy_id)?;
    let operation = remove_copy_operation(
        &mut app.state::<PaneCopies>().map.lock().unwrap(),
        webview.label(),
        &copy_id,
    );
    if let Some(operation) = operation {
        rollback_pane_copy(&app, operation).await;
    }
    Ok(())
}

/// Open a single new project window with its own agent sidecar (default cwd) and
/// focus it. Unlike `setup_windows`, this never re-tiles existing windows — it's
/// the Cmd/Ctrl+N "new window" shortcut. Project selection happens per-window.
///
/// `async` for the same reason as `setup_windows`: a synchronous window-building
/// command deadlocks WebView2 on Windows.
#[tauri::command]
async fn new_window(app: tauri::AppHandle) -> Result<(), String> {
    let label = next_window_label(&app);
    let win = build_app_window(&app, &label)?;
    start_window_session(
        app.clone(),
        label,
        WorkspaceMode::Code,
        ChatAgent::General,
        default_cwd(),
        None,
    );
    let _ = win.set_focus();
    broadcast_window_order(&app);
    Ok(())
}

/// The "What's new" modal lives in its OWN dedicated window so it appears EXACTLY
/// once (the main webview decides; see WhatsNewTrigger) and centers on the user's
/// SCREEN rather than inside whichever tiled project window happens to be open.
/// Reuses `index.html` with a `?whatsnew=1` flag — main.tsx renders only the
/// modal for that flag, so no second Vite entry / build-config change is needed.
/// Borderless + centered + always-on-top + off the taskbar so it reads as a
/// transient OS dialog. The window closes itself from the webview
/// (`getCurrentWebviewWindow().close()`); re-invoking just refocuses an open one.
///
/// `async` for the same WebView2 reason as `setup_windows`/`new_window`.
#[tauri::command]
async fn open_whatsnew_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("whatsnew") {
        let _ = win.set_focus();
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(
        &app,
        "whatsnew",
        WebviewUrl::App("index.html?whatsnew=1".into()),
    )
    .title("What's new")
    .inner_size(600.0, 640.0)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .center()
    .build()
    .map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    Ok(())
}

/// Cycle keyboard focus by `offset` (±1) through windows in reading order,
/// wrapping around. No-op when ≤1 window is open. Forward = +1, backward = -1
/// (Shift held). Bound to Cmd/Ctrl + Backquote (±Shift).
#[tauri::command]
fn focus_window_by_offset(app: tauri::AppHandle, offset: i32) -> Result<(), String> {
    let order = compute_window_order(&app);
    if order.len() <= 1 {
        return Ok(());
    }
    let cur = app
        .state::<FocusedWindow>()
        .0
        .lock()
        .unwrap()
        .clone()
        .and_then(|f| order.iter().position(|l| l == &f))
        .unwrap_or(0) as i32;
    let len = order.len() as i32;
    // Wrap-safe modulo for negative offsets (backward cycling).
    let next = ((cur + offset) % len + len) % len;
    if let Some(label) = order.get(next as usize) {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.set_focus();
        }
    }
    Ok(())
}

/// Re-tile EVERY currently open window into a clean grid (no create/destroy),
/// then broadcast the new order. Works for any count (3, 5, 7, 9, 12, …).
///
/// Applies the rects in a STAGGERED async loop (~30ms between windows). On macOS
/// `set_size`/`set_position` dispatch to the main thread asynchronously, and
/// firing all of them in a tight loop lets the window server coalesce the later
/// dispatches — so the trailing windows would move but keep their old size.
/// Staggering lets each window's size+position fully commit before the next's
/// hits the main-thread queue.
#[tauri::command]
async fn arrange_all(app: tauri::AppHandle) -> Result<(), String> {
    let count = app.webview_windows().len();
    let tiles = sorted_windows(&app, count);
    let rects = if tiles.is_empty() {
        Vec::new()
    } else {
        let Some(monitor) = tiles[0].primary_monitor().ok().flatten() else {
            broadcast_window_order(&app);
            return Ok(());
        };
        let area = monitor.work_area();
        tile_rects(
            count,
            area.position.x,
            area.position.y,
            area.size.width as i32,
            area.size.height as i32,
        )
    };
    for (win, rect) in tiles.iter().zip(rects.iter()) {
        apply_tile(win, *rect);
        // Let the main thread commit this window before queuing the next.
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
    broadcast_window_order(&app);
    Ok(())
}

/// Re-point THIS window's agent at a chosen project: dispose its current daemon
/// session and create a fresh one at `cwd`, optionally resuming the session file
/// `session_path`. The command resolves only after the daemon session is ready,
/// so a failed resume stays in the picker instead of opening an endless skeleton.
#[tauri::command]
async fn select_project(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    pane_id: String,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: String,
    session_path: Option<String>,
    expected_generation: Option<u64>,
) -> Result<u64, String> {
    validate_pane_id(&pane_id)?;
    let label = webview.label().to_string();
    let old = {
        let windows: State<Windows> = app.state();
        let mut registry = windows.map.lock().unwrap();
        if pane_id != PRIMARY_PANE_ID && expected_generation.is_none() {
            return Err(format!(
                "pane '{pane_id}' replacement requires its generation"
            ));
        }
        dispose_pane_target(&mut registry, &label, &pane_id, true, expected_generation)?
    };
    if let (Some(port), Some(id)) = (port_for(&webview), old.session_id) {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = daemon_delete_session(&app2, port, &id).await;
        });
    }
    let generation = start_pane_session(
        app.clone(),
        label,
        pane_id.clone(),
        mode,
        chat_agent,
        PathBuf::from(cwd),
        session_path,
    );
    if pane_id == PRIMARY_PANE_ID {
        snapshot_workspace(&app);
    }
    Ok(generation)
}

#[tauri::command]
fn agent_pane_create(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    pane_id: String,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: String,
    session_path: Option<String>,
) -> Result<u64, String> {
    let label = webview.label().to_string();
    let generation = {
        let windows: State<Windows> = app.state();
        let mut registry = windows.map.lock().unwrap();
        create_pane_target(
            &mut registry,
            &label,
            &pane_id,
            mode,
            chat_agent,
            PathBuf::from(&cwd),
            session_path.clone(),
        )?
    };
    launch_pane_session(
        app,
        label,
        pane_id,
        mode,
        chat_agent,
        PathBuf::from(cwd),
        session_path,
        generation,
    );
    Ok(generation)
}

#[tauri::command]
fn agent_pane_restore(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    pane_id: String,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: String,
    session_path: Option<String>,
) -> Result<u64, String> {
    let label = webview.label().to_string();
    let (generation, created) = {
        let windows: State<Windows> = app.state();
        let mut registry = windows.map.lock().unwrap();
        restore_pane_target(
            &mut registry,
            &label,
            &pane_id,
            mode,
            chat_agent,
            PathBuf::from(&cwd),
            session_path.clone(),
        )?
    };
    if created {
        launch_pane_session(
            app,
            label,
            pane_id,
            mode,
            chat_agent,
            PathBuf::from(cwd),
            session_path,
            generation,
        );
    }
    Ok(generation)
}

#[tauri::command]
async fn agent_pane_dispose(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    pane_id: String,
    generation: Option<u64>,
) -> Result<(), String> {
    let pane = {
        let windows: State<Windows> = app.state();
        let registry = windows.map.lock().unwrap();
        pane_disposal_target(&registry, webview.label(), &pane_id, false, generation)?
    };
    let deletion_result = match (port_for(&webview), pane.session_id.as_deref()) {
        (Some(port), Some(id)) => daemon_delete_session(&app, port, id).await,
        (None, Some(_)) => Err("agent daemon is unavailable; pane session was not disposed".into()),
        (_, None) => Ok(()),
    };
    let windows: State<Windows> = app.state();
    let mut registry = windows.map.lock().unwrap();
    complete_pane_disposal(
        &mut registry,
        webview.label(),
        &pane_id,
        pane.generation,
        deletion_result,
    )
}

/// Map a normalized gaze point to a window and (optionally) focus it.
///
/// The webview can't see other windows' screen rectangles, so the gaze tracker
/// (which only knows a normalized point across the primary monitor) hands the
/// point to Rust. We convert it to physical coordinates using the primary
/// monitor work area, hit-test every open window's outer rect, then:
///   - emit `gaze-target { target, committed }` to ALL windows so each paints
///     its own border: the `committed` (currently focused) window holds a solid
///     ring, the `target` window a soft "dwelling here" highlight, and
///   - call `set_focus()` on the hit window only when `commit` is true (after
///     the controller's dwell), so a glance never steals keyboard focus.
///
/// `committed` is the controller's currently-focused window label, passed every
/// frame so the focused border PERSISTS rather than flashing for one frame.
///
/// Returns the hit window's label (or null when the point lands on no window).
#[tauri::command]
fn gaze_focus(
    app: tauri::AppHandle,
    nx: f64,
    ny: f64,
    commit: bool,
    committed: Option<String>,
) -> Result<Option<String>, String> {
    let windows = app.webview_windows();
    let Some(any) = windows.values().next() else {
        return Ok(None);
    };
    let Some(monitor) = any.primary_monitor().ok().flatten() else {
        return Ok(None);
    };
    let area = monitor.work_area();
    let nx = nx.clamp(0.0, 1.0);
    let ny = ny.clamp(0.0, 1.0);
    let px = area.position.x as f64 + nx * area.size.width as f64;
    let py = area.position.y as f64 + ny * area.size.height as f64;

    // Hit-test: first window whose outer rect contains the point.
    let mut target: Option<String> = None;
    for (label, win) in windows.iter() {
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
            continue;
        };
        let x0 = pos.x as f64;
        let y0 = pos.y as f64;
        let x1 = x0 + size.width as f64;
        let y1 = y0 + size.height as f64;
        if px >= x0 && px < x1 && py >= y0 && py < y1 {
            target = Some(label.clone());
            break;
        }
    }

    // Broadcast both labels to every window; each computes its own border style.
    for (label, win) in windows.iter() {
        let _ = app.emit_to(
            EventTarget::webview_window(label.clone()),
            "gaze-target",
            serde_json::json!({ "target": target, "committed": committed }),
        );
        if commit {
            if let Some(t) = &target {
                if t == label {
                    let _ = win.set_focus();
                }
            }
        }
    }
    Ok(target)
}

// ── System tray (macOS menu bar / Windows notification area) ──────────────
// One status item giving the app a presence while its windows are hidden behind
// a fullscreen editor.
//
// The icon is platform-split, and the split is NOT cosmetic:
//   macOS   — a black-on-transparent "G" flagged as a TEMPLATE image, which the
//             system re-tints for light/dark menu bars. Feeding the rounded app
//             tile here would render as a solid blob.
//   Windows — the full-colour app icon. Windows has no template concept, so a
//             monochrome mark would vanish on either the light or the dark
//             taskbar; the tile carries its own background and reads on both.
// (Same split, same reasoning, as openclaw's Tauri tray.)
//
// Linux is excluded: it needs libayatana-appindicator and we don't ship Linux
// (see the release workflow's matrix).
//
// The menu has no per-item visibility API in muda, so "Update now" is added and
// removed by REBUILDING the menu whenever the webview reports a change
// (`set_update_available` / `set_remote_active`).

/// Tray menu item ids. Kept as one list so the builder and the click handler
/// can never drift apart.
#[cfg(any(target_os = "macos", windows))]
mod tray_id {
    pub const UPDATE: &str = "tray:update";
    pub const NEW_CHAT: &str = "tray:new-chat";
    pub const NEW_CODE: &str = "tray:new-code";
    pub const REMOTE: &str = "tray:remote";
    pub const SETTINGS: &str = "tray:settings";
}

/// Everything the tray menu's labels depend on. Both fields are pushed down by
/// the webview (Rust owns neither the updater nor the Telegram serve loop), and
/// any change rebuilds the menu.
#[derive(Default, Clone, PartialEq, Eq)]
struct TrayStatus {
    /// Pending update version, or `None` when up to date. Drives whether the
    /// "Update now" item exists at all.
    update_version: Option<String>,
    /// True while the Telegram serve loop is running. Flips the Remote item
    /// between "Remote" and "Remote · Turn off".
    remote_active: bool,
}

#[derive(Default)]
struct TrayState(Mutex<TrayStatus>);

/// Tray actions handed to a window that does not exist yet. A freshly built
/// window's webview isn't listening when the menu is clicked, so the intent is
/// parked here and the webview claims it on mount via `window_tray_intent`.
#[derive(Default)]
struct TrayIntents(Mutex<HashMap<String, String>>);

/// True for the real app windows (`main`, `project-N`) — excludes transient
/// chrome like the borderless `whatsnew` dialog, which must never be treated as
/// a place to route a tray action.
fn is_app_window(label: &str) -> bool {
    label == "main" || label.starts_with("project-")
}

/// App-window labels in reading order (left-to-right, top-to-bottom).
fn app_window_labels(app: &tauri::AppHandle) -> Vec<String> {
    compute_window_order(app)
        .into_iter()
        .filter(|l| is_app_window(l))
        .collect()
}

/// The window a tray action should target: the focused app window when there is
/// one, else the first in reading order. `None` when no app window is open.
fn tray_target_window(app: &tauri::AppHandle) -> Option<String> {
    let labels = app_window_labels(app);
    let focused = app.state::<FocusedWindow>().0.lock().unwrap().clone();
    focused
        .filter(|l| labels.iter().any(|x| x == l))
        .or_else(|| labels.first().cloned())
}

/// Build the tray menu for a given status. "Update now" is present ONLY while
/// `update_version` is `Some` — muda has no per-item visibility API, so the menu
/// is rebuilt instead.
#[cfg(any(target_os = "macos", windows))]
fn build_tray_menu(
    app: &tauri::AppHandle,
    status: &TrayStatus,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let menu = Menu::new(app)?;
    if let Some(version) = status.update_version.as_deref() {
        menu.append(&MenuItem::with_id(
            app,
            tray_id::UPDATE,
            format!("Update now \u{2192} v{version}"),
            true,
            None::<&str>,
        )?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(
        app,
        tray_id::NEW_CHAT,
        "New chat session",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        tray_id::NEW_CODE,
        "New code session",
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        tray_id::REMOTE,
        if status.remote_active {
            "Remote \u{b7} Turn off"
        } else {
            "Remote"
        },
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        tray_id::SETTINGS,
        "Settings",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

/// Install the status item. Called once from `setup`.
#[cfg(any(target_os = "macos", windows))]
fn init_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::image::Image;
    use tauri::tray::TrayIconBuilder;

    // Black-on-transparent 72x72 PNG, flagged as a template below so macOS
    // re-tints it per menu-bar appearance instead of us shipping two assets.
    #[cfg(target_os = "macos")]
    let icon = Image::from_bytes(include_bytes!("../icons/tray-mac.png"))?;
    // Windows: the full-colour app tile. `CreateIcon` uses the bitmap at its
    // native size, so this is the 32x32 asset (16pt at 200% DPI) rather than the
    // 72px mac one, which the shell would have to scale down.
    #[cfg(windows)]
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    TrayIconBuilder::with_id("gg")
        .icon(icon)
        // Template tinting is a macOS concept; on Windows it must stay off or the
        // colour tile would be flattened.
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Supah Coder")
        .menu(&build_tray_menu(app, &TrayStatus::default())?)
        // The icon has no action other than its menu, so a click that did nothing
        // would read as broken. Right-click opens it too (tray-icon defaults
        // `menu_on_right_click` to true and tracks the two independently), so
        // Windows still gets its expected right-click behaviour.
        //
        // Apps that ALSO open a window on left click must set this to `false` on
        // Windows or the click does two things at once (rustdesk #15215). That
        // does not apply here precisely because the menu is the only action — so
        // don't "fix" this by copying their `cfg(windows)` override.
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let action = match event.id().as_ref() {
                tray_id::UPDATE => "update",
                tray_id::NEW_CHAT => "new-chat",
                tray_id::NEW_CODE => "new-code",
                tray_id::REMOTE => "remote",
                tray_id::SETTINGS => "settings",
                _ => return,
            };
            dispatch_tray_action(app.clone(), action);
        })
        .build(app)?;
    Ok(())
}

/// Route a tray action to a window and tell that window's webview what to do.
///
/// `new-chat` / `new-code` reuse the single open window when there is exactly
/// one; with several windows open there is no unambiguous "current" one, so a
/// NEW window is opened for the session instead of hijacking someone's work.
/// `remote` / `settings` always act on the existing target window (they're
/// app-wide, not per-session) and only open a window when none exists.
fn dispatch_tray_action(app: tauri::AppHandle, action: &'static str) {
    let labels = app_window_labels(&app);
    let wants_new_window = match action {
        "new-chat" | "new-code" => labels.len() != 1,
        _ => labels.is_empty(),
    };

    if !wants_new_window {
        let Some(label) = tray_target_window(&app) else {
            return;
        };
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }
        let _ = app.emit_to(EventTarget::webview_window(&label), "tray-intent", action);
        return;
    }

    // Window building must not run on the caller's thread (see `new_window`).
    tauri::async_runtime::spawn(async move {
        let label = next_window_label(&app);
        // Park the intent BEFORE the webview can mount, so the claim on mount
        // never races the window build.
        app.state::<TrayIntents>()
            .0
            .lock()
            .unwrap()
            .insert(label.clone(), action.to_string());
        let Ok(win) = build_app_window(&app, &label) else {
            app.state::<TrayIntents>().0.lock().unwrap().remove(&label);
            return;
        };
        start_window_session(
            app.clone(),
            label,
            WorkspaceMode::Code,
            ChatAgent::General,
            default_cwd(),
            None,
        );
        let _ = win.set_focus();
        broadcast_window_order(&app);
    });
}

/// Claim (once) the tray action this window was opened for. Returns `None` for
/// windows the user opened themselves.
#[tauri::command]
fn window_tray_intent(webview: WebviewWindow) -> Option<String> {
    let state: State<TrayIntents> = webview.state();
    let mut map = state.0.lock().unwrap();
    map.remove(webview.label())
}

/// Apply `edit` to the tray status and rebuild the menu IF anything changed.
/// The no-change guard matters: every window pushes status on a timer, so
/// without it the menu would be rebuilt constantly (and would collapse while
/// open).
fn update_tray_status(app: &tauri::AppHandle, edit: impl FnOnce(&mut TrayStatus)) {
    let next = {
        let state: State<TrayState> = app.state();
        let mut current = state.0.lock().unwrap();
        let mut next = current.clone();
        edit(&mut next);
        if next == *current {
            return;
        }
        *current = next.clone();
        next
    };
    let _ = &next;
    #[cfg(any(target_os = "macos", windows))]
    {
        use tauri::tray::TrayIconId;
        if let Some(tray) = app.tray_by_id(&TrayIconId::new("gg")) {
            match build_tray_menu(app, &next) {
                Ok(menu) => {
                    let _ = tray.set_menu(Some(menu));
                }
                Err(e) => log::warn!("tray menu rebuild failed: {e}"),
            }
        }
    }
}

/// Report update availability from the webview so the tray can show or hide
/// "Update now". `version` is `None` when up to date.
#[tauri::command]
fn set_update_available(app: tauri::AppHandle, version: Option<String>) {
    update_tray_status(&app, |s| s.update_version = version);
}

/// Report whether the Telegram serve loop is running, so the tray's Remote item
/// reads "Remote" or "Remote · Turn off".
#[tauri::command]
fn set_remote_active(app: tauri::AppHandle, active: bool) {
    update_tray_status(&app, |s| s.remote_active = active);
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

/// Pure: the tile rects `(x, y, width, height)` for `count` windows arranged in
/// a generalized grid (`cols = ceil(sqrt(N))`) filling the work area `(ox, oy, w, h)`,
/// in order (row-major: left→right within a row, top→bottom across rows).
fn tile_rects(count: usize, ox: i32, oy: i32, w: i32, h: i32) -> Vec<(i32, i32, u32, u32)> {
    if count == 0 {
        return Vec::new();
    }
    let cols = grid_cols(count);
    let rows: i32 = ((count as i32) + cols - 1) / cols;
    let cell_w = w / cols;
    let cell_h = h / rows;
    (0..count as i32)
        .map(|i| {
            let col = i % cols;
            let row = i / cols;
            (
                ox + col * cell_w,
                oy + row * cell_h,
                cell_w as u32,
                cell_h as u32,
            )
        })
        .collect()
}

/// The first `count` open windows (main first, then project-N ascending). Returns
/// the live window handles in label order. `take`-limited by `count`.
fn sorted_windows(app: &tauri::AppHandle, count: usize) -> Vec<WebviewWindow> {
    let mut windows: Vec<WebviewWindow> = app.webview_windows().into_values().collect();
    // Deterministic order: main first, then project-N ascending.
    windows.sort_by_key(|w| label_rank(w.label()));
    windows.into_iter().take(count).collect()
}

/// Apply one tile rect to a window. Order matters on macOS: `set_size` and
/// `set_position` both dispatch to the main thread asynchronously (tao's
/// `set_content_size_async` / `set_frame_top_left_point_async`), and
/// `setFrameTopLeftPoint` anchors against the window's CURRENT frame size — so
/// resize FIRST (establish correct dimensions), then move to the cell origin.
fn apply_tile(win: &WebviewWindow, rect: (i32, i32, u32, u32)) {
    let (x, y, w, h) = rect;
    let _ = win.set_size(tauri::PhysicalSize::new(w, h));
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

/// Tile the first `count` windows into a grid filling the primary work area.
/// Synchronous (applies all rects immediately) — used at window-creation time
/// (`setup_windows` / restore), where the OS commits each before the next shows.
fn arrange_windows(app: &tauri::AppHandle, count: usize) {
    let tiles = sorted_windows(app, count);
    if tiles.is_empty() {
        return;
    }
    let Some(monitor) = tiles[0].primary_monitor().ok().flatten() else {
        return;
    };
    let area = monitor.work_area();
    let rects = tile_rects(
        count,
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
    );
    for (win, rect) in tiles.iter().zip(rects.iter()) {
        apply_tile(win, *rect);
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

/// Pure: labels in reading order — rows top→bottom, left→right within a row.
/// Windows whose y differs by < `row_tolerance` from the row's anchor (first
/// member) are treated as the same row. `positions` is `(label, x, y)`.
fn reading_order(positions: &[(String, i32, i32)], row_tolerance: i32) -> Vec<String> {
    if positions.is_empty() {
        return Vec::new();
    }
    // Sort by y so we can walk top→bottom and group into rows.
    let mut sorted: Vec<&(String, i32, i32)> = positions.iter().collect();
    sorted.sort_by_key(|p| p.2);

    let mut rows: Vec<Vec<&(String, i32, i32)>> = Vec::new();
    for &p in &sorted {
        let need_new_row = match rows.last() {
            // Same row when the y gap to the row's anchor is within tolerance.
            Some(row) => (p.2 - row[0].2).abs() > row_tolerance,
            None => true,
        };
        if need_new_row {
            rows.push(vec![p]);
        } else {
            rows.last_mut().unwrap().push(p);
        }
    }

    // Within each row sort left→right by x, then collect labels in order.
    let mut out = Vec::with_capacity(positions.len());
    for mut row in rows {
        row.sort_by_key(|p| p.1);
        for p in row {
            out.push(p.0.clone());
        }
    }
    out
}

/// Pure: column count for a generalized grid tiling N windows.
/// cols = ceil(sqrt(N)) → 1→1, 2→2, 3→2, 4→2, 6→3, 9→3, 12→4.
fn grid_cols(count: usize) -> i32 {
    if count == 0 {
        return 1;
    }
    ((count as f64).sqrt().ceil() as i32).max(1)
}

/// Every open window's label, in reading order (rows top→bottom, left→right
/// within a row). Tolerance ≈ half the smallest window height so tiled same-row
/// windows group reliably while free-floating windows still get a stable order.
fn compute_window_order(app: &tauri::AppHandle) -> Vec<String> {
    let windows = app.webview_windows();
    let mut positions: Vec<(String, i32, i32)> = Vec::with_capacity(windows.len());
    let mut min_height: i32 = i32::MAX;
    for (label, win) in &windows {
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
            continue;
        };
        let h = size.height as i32;
        if h > 0 && h < min_height {
            min_height = h;
        }
        positions.push((label.clone(), pos.x, pos.y));
    }
    // Floor the tolerance so a single tiny window doesn't collapse rows together.
    let tolerance = (min_height / 2).max(40);
    reading_order(&positions, tolerance)
}

/// Broadcast the current reading order + focused label to every window so each
/// can derive its own position (e.g. "1/4") and whether it's the active window.
fn broadcast_window_order(app: &tauri::AppHandle) {
    let order = compute_window_order(app);
    let focused = app.state::<FocusedWindow>().0.lock().unwrap().clone();
    let payload = serde_json::json!({ "order": order, "focused": focused });
    for label in app.webview_windows().keys() {
        let _ = app.emit_to(
            EventTarget::webview_window(label.clone()),
            "window-order",
            payload.clone(),
        );
    }
}

/// Drain every complete SSE frame (frames are separated by a blank line) from a
/// rolling BYTE buffer, returning each frame's decoded text and leaving any
/// trailing partial frame in `buf`.
///
/// Why a byte buffer instead of decoding each network chunk: `bytes_stream()`
/// splits on arbitrary TCP boundaries, so a multibyte UTF-8 codepoint (emoji,
/// ✓, box-drawing, CJK, accented chars — all common in agent output) can
/// straddle two chunks. Decoding a chunk that ends mid-codepoint replaces the
/// partial bytes with U+FFFD and corrupts the stream for good. A complete frame
/// always ends at an ASCII `\n`, so its bytes never split a codepoint — decoding
/// per-frame is lossless, and any partial tail stays buffered until its rest
/// arrives.
fn drain_sse_frames(buf: &mut Vec<u8>) -> Vec<String> {
    let mut frames = Vec::new();
    while let Some(pos) = buf.windows(2).position(|w| w == b"\n\n") {
        let drained: Vec<u8> = buf.drain(..pos + 2).collect();
        // Bytes before the `\n\n` are the complete frame (whole codepoints).
        frames.push(String::from_utf8_lossy(&drained[..pos]).into_owned());
    }
    frames
}

/// Connect to exactly one pane identity's SSE stream. The bridge remains valid
/// only while `(owner label, pane id, generation, session id)` still matches the
/// registry. Sidecar payload identity is untrusted: frames for any other session
/// are dropped, and only the expected identity plus `{type, data}` is emitted.
fn start_event_bridge(
    app: tauri::AppHandle,
    label: String,
    pane_id: String,
    generation: u64,
    port: u16,
    session_id: String,
) {
    let client = app.state::<reqwest::Client>().inner().clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let identity_is_current = {
                let state: State<Windows> = app.state();
                let registry = state.map.lock().unwrap();
                pane_identity_is_current(&registry, &label, &pane_id, generation, &session_id)
            };
            if !identity_is_current {
                log::debug!(
                    "event bridge retired for {label}/{pane_id} generation {generation} session {session_id}"
                );
                return;
            }

            let url = format!(
                "{}/events?session={}",
                sidecar_base(port),
                urlencoding(&session_id)
            );
            match client.get(&url).send().await {
                Ok(res) => {
                    let mut stream = res.bytes_stream();
                    let mut buf: Vec<u8> = Vec::new();
                    while let Some(chunk) = stream.next().await {
                        let identity_is_current = {
                            let state: State<Windows> = app.state();
                            let registry = state.map.lock().unwrap();
                            resolve_owned_pane(&registry, &label, &pane_id).is_some_and(|pane| {
                                pane.generation == generation
                                    && pane.session_id.as_deref() == Some(&session_id)
                            })
                        };
                        if !identity_is_current {
                            log::debug!(
                                "event bridge retired for {label}/{pane_id} generation {generation} session {session_id}"
                            );
                            return;
                        }
                        let Ok(bytes) = chunk else { break };
                        buf.extend_from_slice(&bytes);
                        for frame in drain_sse_frames(&mut buf) {
                            for line in frame.lines() {
                                let Some(payload) = line.strip_prefix("data: ") else {
                                    continue;
                                };
                                let Ok(value) = serde_json::from_str::<serde_json::Value>(payload)
                                else {
                                    continue;
                                };
                                let Some(trusted) =
                                    trusted_event_envelope(&pane_id, &session_id, &value)
                                else {
                                    continue;
                                };
                                let _ = app.emit_to(
                                    EventTarget::webview_window(label.clone()),
                                    "agent-event",
                                    trusted,
                                );
                            }
                        }
                    }
                    log::warn!("agent event stream ended for {label}/{pane_id}, reconnecting");
                }
                Err(e) => {
                    log::error!("failed to connect to event stream for {label}/{pane_id}: {e}");
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
/// workspace Error Mom wrapper relative to this crate.
///
/// Bundled (release): resolve the single-file ESM sidecar shipped under
/// `bundle.resources` via the Tauri resource directory.
fn resolve_sidecar(app: &tauri::AppHandle) -> PathBuf {
    let resource = app
        .path()
        .resolve(
            "sidecar/app-sidecar.mjs",
            tauri::path::BaseDirectory::Resource,
        )
        .ok();
    pick_sidecar(
        std::env::var("GG_SIDECAR_PATH").ok(),
        cfg!(debug_assertions),
        resource.as_deref(),
    )
}

/// Path to the workspace dev sidecar wrapper, relative to this crate. The
/// wrapper initializes Error Mom before importing ggcoder's built sidecar.
fn workspace_sidecar() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/error-mom-sidecar.mjs")
}

/// Pure sidecar-path decision (testable without an AppHandle).
/// - `env_override` (GG_SIDECAR_PATH) always wins.
/// - dev build → workspace Error Mom sidecar wrapper.
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
    strip_extended_prefix(std::fs::canonicalize(&raw).unwrap_or(raw))
}

/// Drop Windows' extended-length (`\\?\`) prefix from a canonicalized path.
///
/// `std::fs::canonicalize` ALWAYS returns `\\?\C:\…` on Windows. That string is
/// not interchangeable with the plain `C:\…` form everyone else produces:
/// project paths from discovery, the workspace snapshot, and the picker's
/// selected-project comparison all use the plain form, so the prefixed value
/// silently matched nothing and leaked into the UI as `\\?\C:\Users\…`. Shell
/// APIs (`ShellExecute`, hence the opener) also reject the prefixed form, so
/// clicking a file path in a tool result did nothing.
///
/// UNC canonicalizes to `\\?\UNC\server\share`, which maps back to
/// `\\server\share`. No-op on other platforms and for unprefixed paths.
fn strip_extended_prefix(path: PathBuf) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path;
    };
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// The current user's home directory.
///
/// MUST agree with Node's `os.homedir()` in the sidecar — both sides read and
/// write the same `~/.gg` files (auth.json, gg-app.json, the workspace file,
/// the sidecar ledger). libuv resolves Windows homes as
/// `USERPROFILE` → `HOMEDRIVE`+`HOMEPATH`, and ignores `HOME` entirely; a
/// Windows box with `HOME` set (Git for Windows / MSYS sets it, often to a
/// POSIX-style `/c/Users/x` that no Win32 API can open) made the Rust shell
/// look for settings, auth and projects in a directory the sidecar never
/// wrote — the app came up logged out with an empty project picker.
fn home_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            if !profile.is_empty() {
                return PathBuf::from(profile);
            }
        }
        if let (Some(drive), Some(path)) =
            (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH"))
        {
            if !drive.is_empty() && !path.is_empty() {
                let mut home = std::ffi::OsString::from(drive);
                home.push(path);
                return PathBuf::from(home);
            }
        }
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Whether this process can read inside a macOS TCC-protected folder (probed
/// via the user's Documents directory, present on every account). Full Disk
/// Access grants blanket read access to all of them at once; a narrower grant
/// (e.g. only Desktop) would still fail this Documents probe, which is the
/// intentionally strict behavior — the Settings badge should read "not
/// granted" until Full Disk Access covers everything the subagent process
/// might need. Returns `true` immediately on non-macOS (no probe needed).
#[cfg(target_os = "macos")]
fn full_disk_access_granted() -> bool {
    let probe = home_dir().join("Documents");
    std::fs::read_dir(&probe).is_ok()
}

#[cfg(not(target_os = "macos"))]
fn full_disk_access_granted() -> bool {
    true
}

/// Report whether there's an OS permission to grant on this platform, and
/// whether it's currently granted. Windows/Linux have nothing to grant (the
/// subagent-respawn TCC issue is macOS-only), so `applicable` is false and the
/// Settings modal hides the row entirely.
#[tauri::command]
fn permissions_status() -> PermissionsStatus {
    PermissionsStatus {
        applicable: cfg!(target_os = "macos"),
        granted: full_disk_access_granted(),
    }
}

/// Open System Settings' Full Disk Access pane directly (macOS only — the
/// frontend only shows the button when `permissions_status().applicable` is
/// true). `x-apple.systempreferences` deep-links straight past the generic
/// Privacy & Security landing page.
#[tauri::command]
fn open_permissions_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("not applicable on this platform".into())
    }
}

/// Pure cwd decision (testable without touching env/filesystem).
/// - `env_override` (GG_APP_CWD) always wins.
/// - dev build → the workspace root (`CARGO_MANIFEST_DIR/../..`).
/// - bundled (release) → `home`. `CARGO_MANIFEST_DIR` is baked in at COMPILE
///   time, so in a shipped binary it's the CI build machine's path (e.g.
///   `/Users/runner/work/...`) which doesn't exist on the user's machine — the
///   sidecar would crash with EACCES trying to use it. Home always exists and
///   is writable; the project picker re-points the window immediately anyway.
fn pick_cwd(
    env_override: Option<String>,
    is_dev: bool,
    dev_root: PathBuf,
    home: PathBuf,
) -> PathBuf {
    if let Some(p) = env_override {
        return PathBuf::from(p);
    }
    if is_dev {
        return dev_root;
    }
    home
}

const DAEMON_STABLE_UPTIME: std::time::Duration = std::time::Duration::from_secs(60);
const DAEMON_MAX_RESPAWNS: u32 = 5;

/// Exponential crash-loop backoff: 1s, 2s, 4s, 8s, 16s, then stop.
/// A hard retry budget prevents a broken sidecar/signature/configuration from
/// turning the desktop shell into an unbounded process-spawn and disk-write loop.
fn daemon_respawn_delay(attempt: u32) -> Option<std::time::Duration> {
    if attempt == 0 || attempt > DAEMON_MAX_RESPAWNS {
        return None;
    }
    Some(std::time::Duration::from_secs(1 << (attempt - 1)))
}

fn emit_daemon_error(app: &tauri::AppHandle, message: &str) {
    for label in app.webview_windows().keys() {
        let _ = app.emit_to(
            EventTarget::webview_window(label.clone()),
            "sidecar-error",
            message,
        );
    }
}

/// Spawn the ONE shared Node daemon. Reads its `GG_APP_LISTENING` handshake to
/// learn the shared port; on an unexpected exit it reaps the dead child, applies
/// bounded exponential backoff, and re-creates every live window's session.
/// Five short-lived respawns exhaust the retry budget; one minute of stable
/// uptime resets it.
///
/// The daemon is a process-group leader (Unix), so `terminate_child` reaps its
/// entire descendant tree (every session's MCP stdio children + LSP servers) in
/// one group-kill — no orphans on quit.
fn spawn_daemon(app: tauri::AppHandle, is_respawn: bool) {
    let started_at = std::time::Instant::now();
    let script = resolve_sidecar(&app);
    let node = resolve_node(&app);
    log::info!("spawning daemon: {} {}", node.display(), script.display());

    let mut cmd = Command::new(node);
    hide_console(&mut cmd);
    cmd.arg(&script)
        // Port 0 → the OS assigns a free port, reported back via the
        // GG_APP_LISTENING handshake.
        .env("GG_APP_PORT", "0")
        .env("ERROR_MOM_RELEASE", env!("CARGO_PKG_VERSION"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let secure_azure = azure_connection::secure_config().unwrap_or_else(|_| {
        log::warn!("Azure secure configuration is unavailable; preserving inherited environment");
        None
    });
    azure_connection::lifecycle::configure_daemon_azure_environment(
        &mut cmd,
        secure_azure.as_ref(),
    );
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = match cmd.spawn() {
        Ok(c) => {
            // Record the sidecar PID (== its process-group id on Unix, since it's
            // a group leader). The startup orphan sweep uses this ledger to
            // recognise this sidecar's MCP/LSP children by lineage if the app is
            // later crashed/force-quit — works for ANY MCP server, no name list.
            record_sidecar_pid(c.id() as i32);
            c
        }
        Err(e) => {
            let message = format!("failed to spawn daemon: {e}");
            log::error!("{message}");
            emit_daemon_error(&app, &message);
            return;
        }
    };

    // Publish the child before starting pipe readers. A process can fail before
    // the reader thread starts; storing first guarantees the crash handler can
    // still take and reap that exact child instead of leaving a zombie behind.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    {
        let daemon: State<Daemon> = app.state();
        *daemon.child.lock().unwrap() = Some(child);
    }

    if let Some(stdout) = stdout {
        let app2 = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("GG_APP_LISTENING ") {
                    if let Ok(port) = rest.trim().parse::<u16>() {
                        log::info!("daemon listening on port {port}");
                        let daemon = app2.state::<Daemon>();
                        *daemon.port.lock().unwrap() = Some(port);
                        daemon.generation.fetch_add(1, Ordering::SeqCst);
                        // On a respawn the windows already exist with (now
                        // stale) sessions — re-create them all. On the initial
                        // spawn `restore_or_default_windows` drives creation.
                        if is_respawn {
                            recreate_all_window_sessions(app2.clone());
                        }
                    }
                } else {
                    log::debug!("[daemon] {line}");
                }
            }

            // stdout closed → the daemon exited (or lost its control pipe). If
            // the app isn't quitting, remove the stale port and reap/terminate
            // the exact child before considering a bounded respawn.
            if app2.state::<AppExiting>().0.load(Ordering::SeqCst) {
                return;
            }

            let attempt = {
                let daemon: State<Daemon> = app2.state();
                let planned = daemon.planned_reload.swap(false, Ordering::SeqCst);
                if planned {
                    log::info!("daemon exited for Azure configuration refresh — respawning");
                }
                *daemon.port.lock().unwrap() = None;
                if let Some(mut old_child) = daemon.child.lock().unwrap().take() {
                    match old_child.try_wait() {
                        Ok(Some(_)) => {
                            let _ = old_child.wait();
                        }
                        _ => terminate_child(old_child),
                    }
                }
                let mut attempts = daemon.respawn_attempts.lock().unwrap();
                if planned || started_at.elapsed() >= DAEMON_STABLE_UPTIME {
                    *attempts = 0;
                }
                *attempts += 1;
                *attempts
            };

            let Some(delay) = daemon_respawn_delay(attempt) else {
                let message =
                    "Agent daemon stopped after repeated crashes. Restart Supah Coder to try again.";
                log::error!("daemon crash circuit breaker opened after {attempt} crashes");
                emit_daemon_error(&app2, message);
                return;
            };

            log::warn!(
                "daemon exited unexpectedly — respawn {attempt}/{DAEMON_MAX_RESPAWNS} in {}s",
                delay.as_secs()
            );
            std::thread::sleep(delay);
            if !app2.state::<AppExiting>().0.load(Ordering::SeqCst) {
                clear_runtime_pane_sessions(&app2);
                spawn_daemon(app2.clone(), true);
            }
        });
    }

    if let Some(stderr) = stderr {
        let app3 = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                log::error!("[daemon:stderr] {line}");
                if line.starts_with("GG_APP_FATAL") {
                    emit_daemon_error(&app3, &line);
                }
            }
        });
    }
}

fn parse_daemon_create_session_response(
    status: reqwest::StatusCode,
    value: &serde_json::Value,
) -> Result<String, String> {
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(|error| error.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("agent daemon rejected session with HTTP {status}")));
    }
    value
        .get("sessionId")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| "agent daemon response did not include a session id".to_string())
}

/// POST /session to the daemon for `cwd` (+ optional resume `session_path`);
/// returns the new session id or the daemon's concrete rejection reason.
async fn daemon_create_session(
    app: &tauri::AppHandle,
    port: u16,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: &Path,
    session_path: Option<&str>,
) -> Result<String, String> {
    let client = app.state::<reqwest::Client>().inner().clone();
    let body = serde_json::json!({
        "mode": mode,
        "chatAgent": chat_agent,
        "cwd": cwd.to_string_lossy(),
        "sessionPath": session_path,
    });
    let response = client
        .post(format!("{}/session", sidecar_base(port)))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("failed to reach agent daemon: {error}"))?;
    let status = response.status();
    let value = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("agent daemon returned an invalid response: {error}"))?;
    parse_daemon_create_session_response(status, &value)
}

/// DELETE /session/:id on the daemon and require an acknowledged success response.
async fn daemon_delete_session(app: &tauri::AppHandle, port: u16, id: &str) -> Result<(), String> {
    let client = app.state::<reqwest::Client>().inner().clone();
    let response = client
        .delete(format!(
            "{}/session/{}",
            sidecar_base(port),
            urlencoding(id)
        ))
        .timeout(DAEMON_SESSION_DISPOSAL_TIMEOUT)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "agent daemon timed out during session disposal; retry closing the pane".to_string()
            } else {
                format!("failed to reach agent daemon for session disposal: {error}")
            }
        })?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = response.text().await.unwrap_or_default();
    let detail = body.trim();
    Err(if detail.is_empty() {
        format!("agent daemon rejected session disposal with HTTP {status}")
    } else {
        format!("agent daemon rejected session disposal with HTTP {status}: {detail}")
    })
}

fn start_pane_session(
    app: tauri::AppHandle,
    label: String,
    pane_id: String,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: PathBuf,
    session_path: Option<String>,
) -> u64 {
    let generation = {
        let windows: State<Windows> = app.state();
        let mut registry = windows.map.lock().unwrap();
        record_pane_target(
            &mut registry,
            &label,
            &pane_id,
            mode,
            chat_agent,
            cwd.clone(),
            session_path.clone(),
        )
    };
    launch_pane_session(
        app,
        label,
        pane_id,
        mode,
        chat_agent,
        cwd,
        session_path,
        generation,
    );
    generation
}

#[expect(
    clippy::too_many_arguments,
    reason = "launch requires the complete immutable pane target and generation"
)]
fn launch_pane_session(
    app: tauri::AppHandle,
    label: String,
    pane_id: String,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: PathBuf,
    session_path: Option<String>,
    generation: u64,
) {
    tauri::async_runtime::spawn(async move {
        let Some(port) = await_daemon_port(&app).await else {
            let message = "daemon did not start in time".to_string();
            let recorded = {
                let windows: State<Windows> = app.state();
                let mut registry = windows.map.lock().unwrap();
                record_pane_startup_error(
                    &mut registry,
                    &label,
                    &pane_id,
                    generation,
                    message.clone(),
                )
            };
            if recorded {
                let _ = app.emit_to(
                    EventTarget::webview_window(label.clone()),
                    "agent-pane-error",
                    serde_json::json!({
                        "paneId": pane_id,
                        "generation": generation,
                        "error": message,
                    }),
                );
            }
            return;
        };
        match daemon_create_session(&app, port, mode, chat_agent, &cwd, session_path.as_deref())
            .await
        {
            Ok(id) => {
                let bound = {
                    let windows: State<Windows> = app.state();
                    let mut registry = windows.map.lock().unwrap();
                    bind_pane_session(&mut registry, &label, &pane_id, generation, id.clone())
                };
                if !bound {
                    let _ = daemon_delete_session(&app, port, &id).await;
                    return;
                }
                log::info!(
                    "pane session bound: window_label={label} pane_id={pane_id} generation={generation} session_id={id}"
                );
                start_event_bridge(
                    app.clone(),
                    label.clone(),
                    pane_id.clone(),
                    generation,
                    port,
                    id.clone(),
                );
                let _ = app.emit_to(
                    EventTarget::webview_window(label.clone()),
                    "agent-pane-ready",
                    serde_json::json!({
                        "paneId": pane_id,
                        "generation": generation,
                    }),
                );
                azure_connection::lifecycle::take_ready_model_refresh_windows(&app);
                if pane_id == PRIMARY_PANE_ID {
                    let _ = app.emit_to(
                        EventTarget::webview_window(label.clone()),
                        "sidecar-ready",
                        port,
                    );
                }
            }
            Err(message) => {
                let recorded = {
                    let windows: State<Windows> = app.state();
                    let mut registry = windows.map.lock().unwrap();
                    record_pane_startup_error(
                        &mut registry,
                        &label,
                        &pane_id,
                        generation,
                        message.clone(),
                    )
                };
                if recorded {
                    let _ = app.emit_to(
                        EventTarget::webview_window(label.clone()),
                        "agent-pane-error",
                        serde_json::json!({
                            "paneId": pane_id,
                            "generation": generation,
                            "error": message,
                        }),
                    );
                }
            }
        }
    });
}

fn start_window_session(
    app: tauri::AppHandle,
    label: String,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: PathBuf,
    session_path: Option<String>,
) {
    start_pane_session(
        app,
        label,
        PRIMARY_PANE_ID.to_string(),
        mode,
        chat_agent,
        cwd,
        session_path,
    );
}

/// Invalidate every daemon-owned runtime identity immediately after a crash so
/// stale bridges and proxy calls retire while the replacement daemon starts.
fn clear_runtime_pane_sessions(app: &tauri::AppHandle) {
    let windows: State<Windows> = app.state();
    let mut registry = windows.map.lock().unwrap();
    let labels: Vec<String> = registry.keys().cloned().collect();
    for label in labels {
        let pane_ids: Vec<String> = registry
            .get(&label)
            .map(|panes| panes.keys().cloned().collect())
            .unwrap_or_default();
        for pane_id in pane_ids {
            registry.next_generation = registry.next_generation.saturating_add(1);
            let generation = registry.next_generation;
            if let Some(pane) = registry
                .get_mut(&label)
                .and_then(|panes| panes.get_mut(&pane_id))
            {
                pane.session_id = None;
                pane.startup_error = None;
                pane.generation = generation;
            }
        }
    }
}

/// After a daemon respawn, re-create a session for every live pane from its
/// stored `{mode, chat_agent, cwd, session_path}` target.
fn recreate_all_window_sessions(app: tauri::AppHandle) {
    let targets = {
        let windows: State<Windows> = app.state();
        let registry = windows.map.lock().unwrap();
        recovery_targets(&registry)
    };
    for (label, pane_id, mode, chat_agent, cwd, session_path, generation) in targets {
        launch_pane_session(
            app.clone(),
            label,
            pane_id,
            mode,
            chat_agent,
            cwd,
            session_path,
            generation,
        );
    }
}

/// Boot the app's windows. If a workspace snapshot has restorable windows (each
/// with a cwd that still exists on disk), reopen one window per entry — pointed
/// at its project + session, with saved geometry — and record a per-window
/// restore target so the webview skips the picker. Otherwise fall back to the
/// single default `main` window at the boot cwd (the picker then shows).
fn restore_or_default_windows(app: &tauri::AppHandle) -> Result<(), String> {
    let ws = read_workspace();
    let entries = filter_restorable(ws.windows, |c| Path::new(c).exists());
    if entries.is_empty() {
        // Fresh boot / nothing to restore: the usual single main window.
        build_app_window(app, "main")?;
        start_window_session(
            app.clone(),
            "main".into(),
            WorkspaceMode::Code,
            ChatAgent::General,
            default_cwd(),
            None,
        );
        broadcast_window_order(app);
        return Ok(());
    }

    let count = entries.len();
    let mut any_geometry = false;
    for (i, entry) in entries.into_iter().enumerate() {
        // First restored window reclaims `main`; the rest get project-N.
        let label = if i == 0 {
            "main".to_string()
        } else {
            format!("project-{i}")
        };
        // Register the target before constructing the webview: even a hidden
        // webview may execute immediately after build() returns.
        {
            let state: State<RestoreTargets> = app.state();
            register_restore_target(
                &mut state.map.lock().unwrap(),
                label.clone(),
                RestoreEntry {
                    mode: entry.mode,
                    chat_agent: entry.chat_agent,
                    cwd: entry.cwd.clone(),
                    session_path: entry.session_path.clone(),
                },
            );
        }
        let win = match build_app_window_with_visibility(app, &label, false) {
            Ok(win) => win,
            Err(error) => {
                remove_restore_target(
                    &mut app.state::<RestoreTargets>().map.lock().unwrap(),
                    &label,
                );
                return Err(error);
            }
        };
        start_window_session(
            app.clone(),
            label.clone(),
            entry.mode,
            entry.chat_agent,
            PathBuf::from(&entry.cwd),
            entry.session_path.clone(),
        );
        // Apply saved geometry when present; else we tile after the loop.
        if let (Some(x), Some(y)) = (entry.x, entry.y) {
            any_geometry = true;
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        }
        if let (Some(w), Some(h)) = (entry.width, entry.height) {
            any_geometry = true;
            let _ = win.set_size(tauri::PhysicalSize::new(w, h));
        }
        let _ = win.show();
    }
    if !any_geometry {
        arrange_windows(app, count);
    }
    broadcast_window_order(app);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(all(debug_assertions, target_os = "macos"))]
    let builder = if phase26_macos_smoke_enabled() {
        builder.plugin(tauri_plugin_webdriver_automation::init())
    } else {
        builder
    };
    builder
        .plugin(tauri_plugin_notification::init())
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
        .manage(Daemon::default())
        .manage(Windows::default())
        .manage(RestoreTargets::default())
        .manage(PaneCopies::default())
        .manage(AppExiting::default())
        .manage(FocusedWindow::default())
        .manage(MoveDebounce::default())
        .manage(TrayState::default())
        .manage(TrayIntents::default())
        .manage(AzureConnectionMutations::default())
        .manage(LocalPatchedUpdate::default())
        .manage(reqwest::Client::new())
        .invoke_handler(tauri::generate_handler![
            sidecar_port,
            agent_pane_status,
            agent_pane_create,
            agent_pane_restore,
            agent_pane_dispose,
            agent_pane_copy,
            agent_pane_copy_startup,
            agent_pane_copy_restore,
            agent_pane_copy_rollback,
            dropped_path_info,
            permissions_status,
            open_permissions_settings,
            read_dropped_file_attachment,
            open_project_path,
            open_url,
            agent_state,
            agent_notes_get,
            agent_phase_start,
            agent_notes_migrate,
            agent_notes_save,
            agent_reminder_reserve,
            agent_reminder_claim,
            agent_reminder_release,
            roadmap_reminder_notification_permission,
            show_roadmap_reminder_notification,
            agent_memories,
            agent_delete_memory,
            agent_jiwa,
            agent_delete_jiwa,
            agent_progress,
            agent_usage,
            agent_prompt,
            agent_cancel,
            agent_cancel_roadmap_status_retry,
            agent_ken_prompt,
            agent_ken_cancel,
            agent_autopilot_set,
            agent_accept_plan,
            agent_new_session,
            agent_history,
            agent_export_transcript,
            agent_auth_apikey,
            agent_auth_oauth_start,
            agent_auth_oauth_code,
            agent_mcp_elicit,
            agent_auth_logout,
            agent_kill_task,
            agent_import_transcript,
            agent_cancel_queued,
            agent_radio_state,
            agent_radio_set,
            agent_radio_volume,
            agent_tasks,
            agent_run_tasks,
            agent_delete_task,
            agent_cycle_thinking,
            agent_models,
            agent_switch_model,
            agent_switch_ken_model,
            agent_enhance_prompt,
            agent_commands,
            setup_windows,
            new_window,
            open_whatsnew_window,
            select_project,
            agent_projects,
            agent_sessions,
            agent_files,
            agent_settings,
            agent_save_settings,
            agent_create_project,
            app_settings_get,
            app_settings_save,
            app_create_project,
            app_local_patched_update_start,
            app_auth_status,
            app_auth_apikey,
            app_auth_logout,
            azure_connection_status,
            azure_connection_save,
            azure_connection_remove,
            agent_telegram_get,
            agent_telegram_save,
            agent_local,
            agent_local_scan,
            agent_local_endpoint_add,
            agent_local_endpoint_remove,
            agent_serve_status,
            agent_serve_start,
            agent_serve_stop,
            agent_mcp_list,
            agent_mcp_add,
            agent_mcp_remove,
            agent_mcp_login,
            gaze_focus,
            focus_window_by_offset,
            arrange_all,
            window_restore_target,
            window_tray_intent,
            set_update_available,
            set_remote_active
        ])
        .setup(|app| {
            // Windows-only: track per-window minimized state so restoring one
            // window can restore its siblings (macOS does this natively).
            #[cfg(target_os = "windows")]
            app.manage(MinimizeState::default());
            // Sweep orphaned sidecars from previous (crashed/force-quit) app
            // instances BEFORE spawning any new sidecars — they'd otherwise
            // accumulate forever across launches. Best-effort + logged.
            // Cross-platform: uses `ps` on Unix, PowerShell CIM on Windows.
            // The isolated Phase 25 dev fixture must never inspect or terminate
            // a pre-existing host sidecar.
            if !phase25_dev_fixture_enabled() {
                sweep_orphan_sidecars();
            }
            // macOS menu-bar / Windows notification-area presence.
            #[cfg(any(target_os = "macos", windows))]
            if let Err(e) = init_tray(&app.handle().clone()) {
                log::warn!("tray init failed: {e}");
            }
            // Spawn the ONE shared Node daemon before any window asks for a
            // session. Window session creation (in restore/setup) awaits its
            // `GG_APP_LISTENING` port via `await_daemon_port`.
            spawn_daemon(app.handle().clone(), false);
            // Restore the previous session's windows (each at its project +
            // session) when a workspace snapshot exists; otherwise build the
            // single default `main` window. Windows are built in code (not from
            // config) so macOS gets `hidden_title(true)` via the builder.
            restore_or_default_windows(&app.handle().clone())?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Destroyed => {
                let app = window.app_handle();
                // A target can remain pending when a webview closes before mount.
                remove_restore_target(
                    &mut app.state::<RestoreTargets>().map.lock().unwrap(),
                    window.label(),
                );
                // Rollback-created windows were never committed to the workspace;
                // pruning by cwd could otherwise delete the still-open source copy.
                let rolling_back = app
                    .state::<PaneCopies>()
                    .map
                    .lock()
                    .unwrap()
                    .rolling_back
                    .remove(window.label());
                // A deliberate close (app NOT quitting) drops this window from the
                // workspace so it doesn't reopen next launch. During quit the
                // AppExiting flag is set, so the snapshot is preserved intact.
                let exiting = app.state::<AppExiting>().0.load(Ordering::SeqCst);
                if !exiting && !rolling_back {
                    remove_window_from_workspace(app, window.label());
                }
                let stale_source_copies = {
                    let copies: State<PaneCopies> = app.state();
                    let mut registry = copies.map.lock().unwrap();
                    if let Some(key) = registry.target_owners.get(window.label()).cloned() {
                        let started = registry
                            .operations
                            .get(&key)
                            .is_some_and(|operation| operation.started);
                        if started {
                            registry.target_owners.remove(window.label());
                            registry.operations.remove(&key);
                        }
                    }
                    let stale_keys: Vec<_> = registry
                        .operations
                        .iter()
                        .filter(|(_, operation)| {
                            operation.source_owner == window.label() && !operation.started
                        })
                        .map(|(key, _)| key.clone())
                        .collect();
                    stale_keys
                        .into_iter()
                        .filter_map(|key| {
                            let operation = registry.operations.remove(&key)?;
                            registry.target_owners.remove(&operation.target_label);
                            Some(operation)
                        })
                        .collect::<Vec<_>>()
                };
                for operation in stale_source_copies {
                    remove_restore_target(
                        &mut app.state::<RestoreTargets>().map.lock().unwrap(),
                        &operation.target_label,
                    );
                    if let Some(path) = operation.cloned_session_path {
                        let _ = std::fs::remove_file(path);
                    }
                    if let Some(copy_window) = app.get_webview_window(&operation.target_label) {
                        let _ = copy_window.close();
                    }
                }
                // Dispose only THIS window's session in the shared daemon so
                // other projects keep running. The daemon process itself is
                // never killed here (that happens only on app exit).
                let state: State<Windows> = window.state();
                let panes = {
                    let mut registry = state.map.lock().unwrap();
                    take_window_panes(&mut registry, window.label())
                };
                if let Some(port) = *app.state::<Daemon>().port.lock().unwrap() {
                    let app2 = app.clone();
                    tauri::async_runtime::spawn(async move {
                        for pane in panes {
                            if let Some(id) = pane.session_id {
                                let _ = daemon_delete_session(&app2, port, &id).await;
                            }
                        }
                    });
                }
                // Update peers: the closed window is gone from the reading order.
                broadcast_window_order(app);
            }
            // Track which window holds keyboard focus and notify peers so each
            // can dim/brighten its position label + input border.
            tauri::WindowEvent::Focused(focused) if *focused => {
                let app = window.app_handle().clone();
                {
                    let state: State<FocusedWindow> = app.state();
                    *state.0.lock().unwrap() = Some(window.label().to_string());
                }
                broadcast_window_order(&app);
            }
            // Windows-only: a single taskbar click un-minimizes just the picked
            // window. Cascade the restore to its siblings so the whole workspace
            // reopens together, like macOS. Compiled out on macOS (falls to `_`).
            #[cfg(target_os = "windows")]
            tauri::WindowEvent::Resized(_) => {
                restore_sibling_windows(window);
            }
            // Debounced: native drag fires Moved per pixel. Only the last move's
            // deferred task fires (its captured Instant still matches), so peers
            // learn the new reading order ~150ms after the drag settles.
            tauri::WindowEvent::Moved(_) => {
                let app = window.app_handle().clone();
                let now = std::time::Instant::now();
                {
                    let state: State<MoveDebounce> = app.state();
                    *state.0.lock().unwrap() = Some(now);
                }
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    let fire = {
                        let state: State<MoveDebounce> = app.state();
                        let guard = state.0.lock().unwrap();
                        *guard == Some(now)
                    };
                    if fire {
                        broadcast_window_order(&app);
                    }
                });
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // Mark the quit BEFORE windows start tearing down, so the
                // Destroyed handlers preserve the snapshot, then write the final
                // snapshot (current geometry + each window's live cwd/session).
                app.state::<AppExiting>().0.store(true, Ordering::SeqCst);
                refresh_live_sessions(app);
                snapshot_workspace(app);
                // Terminate the daemon's process group once — reaps every
                // session's MCP/LSP children in one shot (no orphans).
                let child = app.state::<Daemon>().child.lock().unwrap().take();
                if let Some(child) = child {
                    terminate_child(child);
                }
            }
        });
}

/// Before the final exit snapshot, re-read each live session's `/state` (via the
/// shared daemon, keyed by the window's `x-gg-session` header) so a window that
/// started a new session mid-run (changing its session file) is recorded at its
/// CURRENT session, not the one it was created with. Best-effort + time-boxed:
/// any window we can't reach keeps its last-known session_path.
fn refresh_live_sessions(app: &tauri::AppHandle) {
    let Some(port) = *app.state::<Daemon>().port.lock().unwrap() else {
        return;
    };
    let targets: Vec<(String, String)> = {
        let state: State<Windows> = app.state();
        let map = state.map.lock().unwrap();
        map.iter()
            .filter_map(|(label, panes)| {
                panes
                    .get(PRIMARY_PANE_ID)
                    .and_then(|pane| pane.session_id.clone())
                    .map(|id| (label.clone(), id))
            })
            .collect()
    };
    if targets.is_empty() {
        return;
    }
    let client = app.state::<reqwest::Client>().inner().clone();
    // The exit callback runs on the main event-loop thread (outside the async
    // runtime), so block_on is safe here. Each request is time-boxed so a hung
    // session can't stall quit.
    let results: Vec<(String, Option<String>, Option<PathBuf>)> =
        tauri::async_runtime::block_on(async {
            let mut out = Vec::with_capacity(targets.len());
            for (label, sid) in targets {
                let url = format!("{}/state", sidecar_base(port));
                let req = client
                    .get(&url)
                    .header("x-gg-session", &sid)
                    .timeout(std::time::Duration::from_millis(400))
                    .send()
                    .await;
                let Ok(res) = req else {
                    continue;
                };
                let Ok(body) = res.json::<serde_json::Value>().await else {
                    continue;
                };
                let session_path = body
                    .get("sessionPath")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                let cwd = body
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from);
                out.push((label, session_path, cwd));
            }
            out
        });
    let state: State<Windows> = app.state();
    let mut map = state.map.lock().unwrap();
    for (label, session_path, cwd) in results {
        if let Some(inst) = map
            .get_mut(&label)
            .and_then(|panes| panes.get_mut(PRIMARY_PANE_ID))
        {
            if session_path.is_some() {
                inst.session_path = session_path;
            }
            if let Some(cwd) = cwd {
                inst.cwd = Some(cwd);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_fixture_flags_require_debug_builds_and_exact_opt_in() {
        for value in [None, Some(""), Some("0"), Some("true")] {
            assert!(!exact_fixture_opt_in(true, value));
            assert!(!exact_fixture_opt_in(false, value));
        }
        assert!(exact_fixture_opt_in(true, Some("1")));
        assert!(!exact_fixture_opt_in(false, Some("1")));
    }

    #[test]
    fn release_builds_ignore_dev_fixture_environment_opt_in() {
        assert!(!exact_fixture_opt_in(false, Some("1")));
    }

    #[test]
    fn debug_dev_fixture_can_suppress_only_the_startup_sweep() {
        assert!(exact_fixture_opt_in(true, Some("1")));
    }

    fn prompt_proxy_result(
        status: reqwest::StatusCode,
        body: &str,
    ) -> Result<PromptSubmissionResult, String> {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response_body = body.to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = [0_u8; 4096];
            let read = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("POST /prompt HTTP/1.1"));
            assert!(request.contains("x-gg-session: test-session"));

            let response = format!(
                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Unknown"),
                response_body.len(),
                response_body,
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        let client = reqwest::Client::new();
        let endpoint = format!("http://{address}/prompt");
        let result = tauri::async_runtime::block_on(post_sidecar_prompt(
            &client,
            &endpoint,
            "test-session",
            "Ship the fix".to_string(),
            Some(serde_json::json!([])),
            Some(serde_json::json!({ "kenSent": true })),
        ));
        server.join().unwrap();
        result
    }

    #[test]
    fn daemon_session_response_preserves_resume_identity_rejections() {
        for message in [
            "Cannot resume a session from another project",
            "Cannot resume phase context from another project",
        ] {
            assert_eq!(
                parse_daemon_create_session_response(
                    reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                    &serde_json::json!({ "error": message }),
                ),
                Err(message.to_string())
            );
        }
        assert_eq!(
            parse_daemon_create_session_response(
                reqwest::StatusCode::OK,
                &serde_json::json!({ "sessionId": "same-project-session" }),
            ),
            Ok("same-project-session".to_string())
        );
    }

    #[test]
    fn phase_start_proxy_encodes_ids_and_preserves_typed_outcomes() {
        assert_eq!(
            phase_start_path("phase/21 review"),
            "/phases/phase%2F21%20review/start"
        );
        for (status, body) in [
            (
                reqwest::StatusCode::ACCEPTED,
                r#"{"status":"accepted","operationId":"op-1","session":{"sessionId":"s","sessionPath":"/s"},"packageTokenCount":42}"#,
            ),
            (
                reqwest::StatusCode::CONFLICT,
                r#"{"status":"failed","code":"session-busy","operationId":null,"message":"Wait"}"#,
            ),
        ] {
            let parsed = normalize_phase_start_response(status, body).unwrap();
            assert!(matches!(
                parsed.get("status").and_then(serde_json::Value::as_str),
                Some("accepted" | "failed")
            ));
        }
    }

    #[test]
    fn phase_start_proxy_rejects_transport_ambiguity() {
        assert_eq!(
            normalize_phase_start_response(reqwest::StatusCode::BAD_GATEWAY, "not json"),
            Err("invalid phase-start response".to_string())
        );
        assert_eq!(
            normalize_phase_start_response(
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"error":"unknown"}"#,
            ),
            Err("unknown".to_string())
        );
    }

    #[test]
    fn normalize_notes_response_preserves_expected_non_success_outcomes() {
        for (status, body) in [
            (
                reqwest::StatusCode::CONFLICT,
                serde_json::json!({ "status": "conflict", "snapshot": { "revision": 2 } }),
            ),
            (
                reqwest::StatusCode::NOT_FOUND,
                serde_json::json!({ "status": "missing" }),
            ),
            (
                reqwest::StatusCode::BAD_REQUEST,
                serde_json::json!({
                    "status": "invalid",
                    "error": { "path": "$", "message": "invalid request body" }
                }),
            ),
            (
                reqwest::StatusCode::BAD_REQUEST,
                serde_json::json!({
                    "status": "invalid",
                    "error": { "path": "$", "message": "malformed JSON request body" }
                }),
            ),
            (
                reqwest::StatusCode::BAD_REQUEST,
                serde_json::json!({
                    "status": "invalid",
                    "error": {
                        "path": "phases[0].roadmapEvents[0].type",
                        "message": "privileged roadmap events require their dedicated authority path"
                    }
                }),
            ),
            (
                reqwest::StatusCode::PAYLOAD_TOO_LARGE,
                serde_json::json!({
                    "status": "invalid",
                    "error": {
                        "path": "$",
                        "message": "notes request body exceeds 1048576 bytes"
                    }
                }),
            ),
        ] {
            assert_eq!(
                normalize_notes_response(status, body.clone()).unwrap(),
                body
            );
        }
    }

    #[test]
    fn normalize_notes_response_rejects_untyped_server_failures() {
        let error = normalize_notes_response(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!({ "status": "error", "message": "notes request failed" }),
        )
        .unwrap_err();
        assert_eq!(error, "notes request failed");
    }

    #[test]
    fn roadmap_reminder_notification_is_fixed_private_and_uses_at_most_one_platform_sound() {
        let muted = roadmap_reminder_notification_spec(false);
        assert_eq!(muted.title, "Roadmap reminder due");
        assert_eq!(muted.body, "Open Supah Coder to review it.");
        assert_eq!(muted.sound, None);

        let audible = roadmap_reminder_notification_spec(true);
        assert_eq!(audible.title, muted.title);
        assert_eq!(audible.body, muted.body);
        assert_eq!(audible.sound, Some(roadmap_reminder_sound()));
        #[cfg(target_os = "windows")]
        assert_eq!(audible.sound, Some("Mail"));
        #[cfg(target_os = "macos")]
        assert_eq!(audible.sound, Some("Submarine"));
        #[cfg(target_os = "linux")]
        assert_eq!(audible.sound, Some("message-new-instant"));
    }

    #[test]
    fn notification_availability_maps_enabled_disabled_and_unknown_without_drift() {
        assert_eq!(
            notification_permission_from_signal(NotificationAvailabilitySignal::Enabled),
            RoadmapReminderNotificationPermission::Granted
        );
        assert_eq!(
            notification_permission_from_signal(NotificationAvailabilitySignal::Disabled),
            RoadmapReminderNotificationPermission::Denied
        );
        assert_eq!(
            notification_permission_from_signal(NotificationAvailabilitySignal::Unknown),
            RoadmapReminderNotificationPermission::Unavailable
        );
        assert_eq!(
            serde_json::to_value(RoadmapReminderNotificationPermission::Granted).unwrap(),
            serde_json::json!("granted")
        );
        assert_eq!(
            serde_json::to_value(RoadmapReminderNotificationPermission::Denied).unwrap(),
            serde_json::json!("denied")
        );
        assert_eq!(
            serde_json::to_value(RoadmapReminderNotificationPermission::Unavailable).unwrap(),
            serde_json::json!("unavailable")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_toast_setting_maps_enabled_disabled_and_unknown() {
        use windows::UI::Notifications::NotificationSetting;

        assert_eq!(
            windows_notification_signal(Some(NotificationSetting::Enabled)),
            NotificationAvailabilitySignal::Enabled
        );
        for setting in [
            NotificationSetting::DisabledForApplication,
            NotificationSetting::DisabledForUser,
            NotificationSetting::DisabledByGroupPolicy,
            NotificationSetting::DisabledByManifest,
        ] {
            assert_eq!(
                windows_notification_signal(Some(setting)),
                NotificationAvailabilitySignal::Disabled
            );
        }
        assert_eq!(
            windows_notification_signal(None),
            NotificationAvailabilitySignal::Unknown
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_authorization_maps_enabled_disabled_and_unknown() {
        use objc2_user_notifications::{UNAuthorizationStatus, UNNotificationSetting};

        assert_eq!(
            macos_notification_signal(
                UNAuthorizationStatus::Authorized,
                UNNotificationSetting::Enabled,
            ),
            NotificationAvailabilitySignal::Enabled
        );
        assert_eq!(
            macos_notification_signal(
                UNAuthorizationStatus::Denied,
                UNNotificationSetting::Disabled,
            ),
            NotificationAvailabilitySignal::Disabled
        );
        assert_eq!(
            macos_notification_state(
                UNAuthorizationStatus::NotDetermined,
                UNNotificationSetting::NotSupported,
            ),
            MacosNotificationState::NotDetermined
        );
        assert_eq!(
            macos_notification_signal(
                UNAuthorizationStatus::NotDetermined,
                UNNotificationSetting::NotSupported,
            ),
            NotificationAvailabilitySignal::Unknown
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_policy_reports_unavailable_instead_of_granted() {
        assert_eq!(
            platform_notification_signal("com.ggcoder.app"),
            NotificationAvailabilitySignal::Unknown
        );
    }

    #[test]
    fn reminder_proxy_preserves_only_route_typed_outcomes() {
        let reserved = r#"{"status":"reserved","leaseToken":"lease-1"}"#;
        assert_eq!(
            normalize_reminder_response(
                reqwest::StatusCode::OK,
                reserved,
                &["reserved", "deferred", "none"],
            )
            .unwrap(),
            serde_json::from_str::<serde_json::Value>(reserved).unwrap()
        );
        let denied = r#"{"status":"wrong-session"}"#;
        assert_eq!(
            normalize_reminder_response(reqwest::StatusCode::OK, denied, &["ok", "wrong-session"],)
                .unwrap(),
            serde_json::json!({ "status": "wrong-session" })
        );
        assert_eq!(
            normalize_reminder_response(
                reqwest::StatusCode::OK,
                r#"{"status":"released"}"#,
                &["reserved", "deferred", "none"],
            ),
            Err("invalid reminder response".to_string())
        );
    }

    #[test]
    fn reminder_proxy_rejects_malformed_and_ambiguous_responses() {
        assert_eq!(
            normalize_reminder_response(
                reqwest::StatusCode::BAD_GATEWAY,
                "not json",
                &["reserved"],
            ),
            Err("invalid reminder response".to_string())
        );
        assert_eq!(
            normalize_reminder_response(
                reqwest::StatusCode::OK,
                r#"{"status":"maybe"}"#,
                &["reserved"],
            ),
            Err("invalid reminder response".to_string())
        );
    }

    #[test]
    fn prompt_proxy_preserves_direct_and_queued_sidecar_202_results() {
        assert_eq!(
            prompt_proxy_result(
                reqwest::StatusCode::ACCEPTED,
                r#"{"queued":false,"count":0}"#,
            ),
            Ok(PromptSubmissionResult {
                queued: false,
                count: 0,
            })
        );
        assert_eq!(
            prompt_proxy_result(
                reqwest::StatusCode::ACCEPTED,
                r#"{"queued":true,"count":2}"#,
            ),
            Ok(PromptSubmissionResult {
                queued: true,
                count: 2,
            })
        );
    }

    #[test]
    fn prompt_proxy_rejects_malformed_success_shapes() {
        for body in [
            r#"{"accepted":true}"#,
            r#"{"queued":true,"count":0}"#,
            r#"{"queued":false,"count":1}"#,
        ] {
            assert_eq!(
                prompt_proxy_result(reqwest::StatusCode::ACCEPTED, body),
                Err("invalid prompt submission response".to_string())
            );
        }
    }

    #[test]
    fn prompt_proxy_rejects_sidecar_400_409_and_500_with_backend_text() {
        for (status, body, expected) in [
            (
                reqwest::StatusCode::BAD_REQUEST,
                r#"{"error":"empty prompt"}"#,
                "empty prompt",
            ),
            (
                reqwest::StatusCode::CONFLICT,
                r#"{"error":"configuration refresh in progress"}"#,
                "configuration refresh in progress",
            ),
            (
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"error":"provider exploded"}"#,
                "provider exploded",
            ),
        ] {
            assert_eq!(prompt_proxy_result(status, body), Err(expected.to_string()));
        }
    }

    #[test]
    fn sidecar_json_response_rejects_non_success_statuses() {
        assert_eq!(
            parse_sidecar_json_response(
                reqwest::StatusCode::CONFLICT,
                r#"{"error":"session mutation in progress"}"#,
            ),
            Err("session mutation in progress".to_string())
        );
        assert_eq!(
            parse_sidecar_json_response(
                reqwest::StatusCode::ACCEPTED,
                r#"{"accepted":true,"operationId":"operation-1"}"#,
            ),
            Ok(serde_json::json!({
                "accepted": true,
                "operationId": "operation-1"
            }))
        );
    }

    #[test]
    fn new_session_response_forwards_operation_identity() {
        assert_eq!(
            parse_new_session_response(
                reqwest::StatusCode::OK,
                r#"{"ok":true,"operationId":"operation-42"}"#,
            ),
            Ok(serde_json::json!({ "operationId": "operation-42" }))
        );
        assert_eq!(
            parse_new_session_response(reqwest::StatusCode::OK, r#"{"ok":true}"#),
            Err("invalid new-session response: missing operationId".to_string())
        );
        let rejected = parse_new_session_response(
            reqwest::StatusCode::CONFLICT,
            r#"{"error":"session is already resetting"}"#,
        )
        .unwrap_err();
        let rejected: serde_json::Value = serde_json::from_str(&rejected).unwrap();
        assert_eq!(
            rejected,
            serde_json::json!({
                "kind": "creation-rejected",
                "status": 409,
                "message": "session is already resetting",
            })
        );
        let unknown = parse_new_session_response(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"error":"storage failed after reset"}"#,
        )
        .unwrap_err();
        let unknown: serde_json::Value = serde_json::from_str(&unknown).unwrap();
        assert_eq!(
            unknown,
            serde_json::json!({
                "kind": "outcome-unknown",
                "status": 500,
                "message": "storage failed after reset",
            })
        );
    }

    #[test]
    fn new_session_error_preserves_json_error_text() {
        assert_eq!(
            sidecar_error_text(
                reqwest::StatusCode::CONFLICT,
                r#"{"message":"session is already resetting"}"#,
            ),
            "session is already resetting"
        );
        assert_eq!(
            sidecar_error_text(
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"error":{"code":"reset_failed","retryable":true}}"#,
            ),
            r#"{"error":{"code":"reset_failed","retryable":true}}"#
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

    #[test]
    fn daemon_respawns_with_bounded_exponential_backoff() {
        let delays: Vec<u64> = (1..=DAEMON_MAX_RESPAWNS)
            .map(|attempt| daemon_respawn_delay(attempt).unwrap().as_secs())
            .collect();
        assert_eq!(delays, vec![1, 2, 4, 8, 16]);
    }

    #[test]
    fn daemon_crash_loop_opens_circuit_breaker() {
        assert!(daemon_respawn_delay(0).is_none());
        assert!(daemon_respawn_delay(DAEMON_MAX_RESPAWNS + 1).is_none());
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

    #[test]
    fn auth_providers_keep_regional_groups_and_openrouter_last() {
        let values: Vec<&str> = AUTH_PROVIDERS
            .iter()
            .map(|provider| provider.value)
            .collect();
        assert_eq!(
            values,
            vec![
                "anthropic",
                "openai",
                "gemini",
                "xai",
                "moonshot",
                "glm",
                "minimax",
                "xiaomi",
                "deepseek",
                "sakana",
                "openrouter",
            ]
        );
    }

    #[test]
    fn resolve_apikey_target_gates_on_apikey_support() {
        // OAuth-only provider → not an API-key provider.
        assert!(resolve_apikey_target("anthropic", None).is_none());
        // Unknown provider → None.
        assert!(resolve_apikey_target("nope", None).is_none());
        // API-key provider with no custom base URL, no variants.
        assert_eq!(
            resolve_apikey_target("glm", None),
            Some(("glm".to_string(), None)),
        );
        // Moonshot supports both oauth + apikey, no variants.
        assert_eq!(
            resolve_apikey_target("moonshot", None),
            Some(("moonshot".to_string(), None)),
        );
        // xAI uses the public OpenAI-compatible API with a console.x.ai key.
        assert_eq!(
            resolve_apikey_target("xai", None),
            Some(("xai".to_string(), None)),
        );
    }

    #[test]
    fn resolve_apikey_target_xiaomi_defaults_to_token_plan() {
        // No variant requested → first/primary variant (Token Plan), storage
        // key unchanged from the provider id for backward compat.
        assert_eq!(
            resolve_apikey_target("xiaomi", None),
            Some((
                "xiaomi".to_string(),
                Some("https://token-plan-sgp.xiaomimimo.com/v1")
            )),
        );
    }

    #[test]
    fn resolve_apikey_target_xiaomi_credits_variant() {
        assert_eq!(
            resolve_apikey_target("xiaomi", Some("xiaomi-credits")),
            Some((
                "xiaomi-credits".to_string(),
                Some("https://api.xiaomimimo.com/v1")
            )),
        );
    }

    #[test]
    fn resolve_apikey_target_unknown_variant_falls_back_to_first() {
        assert_eq!(
            resolve_apikey_target("xiaomi", Some("bogus")),
            Some((
                "xiaomi".to_string(),
                Some("https://token-plan-sgp.xiaomimimo.com/v1")
            )),
        );
    }

    #[test]
    fn apply_logout_xiaomi_drops_both_variant_keys() {
        let existing = r#"{ "xiaomi": { "accessToken": "tp", "refreshToken": "", "expiresAt": 1 }, "xiaomi-credits": { "accessToken": "cr", "refreshToken": "", "expiresAt": 1 } }"#;
        let out = apply_logout(Some(existing), "xiaomi").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("xiaomi").is_none());
        assert!(v.get("xiaomi-credits").is_none());
    }

    #[test]
    fn apikey_credential_has_far_future_expiry_and_optional_base_url() {
        let now = 1_000_000_000_000i64;
        let cred = apikey_credential_json("sk-test", None, now);
        assert_eq!(cred["accessToken"], "sk-test");
        assert_eq!(cred["refreshToken"], "");
        assert_eq!(cred["expiresAt"].as_i64().unwrap(), now + API_KEY_TTL_MS);
        assert!(cred.get("baseUrl").is_none());

        let with_url = apikey_credential_json("k", Some("https://x/v1"), now);
        assert_eq!(with_url["baseUrl"], "https://x/v1");
    }

    #[test]
    fn apply_apikey_creates_file_when_missing() {
        let out = apply_apikey(None, "glm", None, 0, "sk-1").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["glm"]["accessToken"], "sk-1");
    }

    #[test]
    fn apply_apikey_preserves_other_providers() {
        let existing = r#"{ "anthropic": { "accessToken": "oauth-tok", "refreshToken": "r", "expiresAt": 5 } }"#;
        let out = apply_apikey(Some(existing), "glm", None, 0, "sk-1").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        // New provider added.
        assert_eq!(v["glm"]["accessToken"], "sk-1");
        // Existing provider untouched.
        assert_eq!(v["anthropic"]["accessToken"], "oauth-tok");
        assert_eq!(v["anthropic"]["refreshToken"], "r");
    }

    #[test]
    fn apply_apikey_carries_base_url() {
        let out = apply_apikey(None, "xiaomi", Some("https://x/v1"), 0, "sk-2").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["xiaomi"]["baseUrl"], "https://x/v1");
    }

    #[test]
    fn apply_apikey_rejects_malformed_file() {
        assert!(apply_apikey(Some("not json"), "glm", None, 0, "k").is_err());
        assert!(apply_apikey(Some("[1,2,3]"), "glm", None, 0, "k").is_err());
    }

    #[test]
    fn apply_logout_removes_provider() {
        let existing = r#"{ "glm": { "accessToken": "k", "refreshToken": "", "expiresAt": 1 }, "openai": { "accessToken": "o", "refreshToken": "", "expiresAt": 1 } }"#;
        let out = apply_logout(Some(existing), "glm").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("glm").is_none());
        assert_eq!(v["openai"]["accessToken"], "o");
    }

    #[test]
    fn apply_logout_moonshot_drops_both_keys() {
        let existing = r#"{ "moonshot": { "accessToken": "key", "refreshToken": "", "expiresAt": 1 }, "moonshot-oauth": { "accessToken": "oauth", "refreshToken": "r", "expiresAt": 1 } }"#;
        let out = apply_logout(Some(existing), "moonshot").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("moonshot").is_none());
        assert!(v.get("moonshot-oauth").is_none());
    }

    #[test]
    fn apply_logout_missing_file_is_empty_object() {
        let out = apply_logout(None, "glm").unwrap();
        assert_eq!(out.trim(), "{}");
    }

    #[test]
    fn pick_node_env_override_wins() {
        let got = pick_node(Some("/opt/node".into()), true, None);
        assert_eq!(got, PathBuf::from("/opt/node"));
        // ...even in bundled mode with a present exe dir.
        let got = pick_node(Some("/opt/node".into()), false, Some(Path::new("/app")));
        assert_eq!(got, PathBuf::from("/opt/node"));
    }

    #[test]
    fn strip_extended_prefix_normalizes_windows_canonical_paths() {
        // canonicalize() always returns the \\?\ form on Windows; nothing else
        // in the app (discovery, workspace json, the picker) produces it, and
        // ShellExecute rejects it outright.
        assert_eq!(
            strip_extended_prefix(PathBuf::from(r"\\?\C:\Users\dev\proj")),
            PathBuf::from(r"C:\Users\dev\proj")
        );
        assert_eq!(
            strip_extended_prefix(PathBuf::from(r"\\?\UNC\server\share\proj")),
            PathBuf::from(r"\\server\share\proj")
        );
        // Unprefixed and POSIX paths pass through untouched.
        assert_eq!(
            strip_extended_prefix(PathBuf::from(r"C:\Users\dev")),
            PathBuf::from(r"C:\Users\dev")
        );
        assert_eq!(
            strip_extended_prefix(PathBuf::from("/Users/dev")),
            PathBuf::from("/Users/dev")
        );
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
        let got = pick_cwd(
            None,
            true,
            PathBuf::from("/repo"),
            PathBuf::from("/home/user"),
        );
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

    // ── SSE frame decoding (drain_sse_frames) ────────────────────────────────

    #[test]
    fn drains_complete_frames_and_keeps_partial() {
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(b"data: one\n\ndata: two\n\ndata: par");
        let frames = drain_sse_frames(&mut buf);
        assert_eq!(
            frames,
            vec!["data: one".to_string(), "data: two".to_string()]
        );
        // The unterminated "data: par" stays buffered for the next chunk.
        assert_eq!(buf, b"data: par");
    }

    #[test]
    fn no_complete_frame_leaves_buffer_intact() {
        let mut buf: Vec<u8> = b"data: incomplete\n".to_vec();
        assert!(drain_sse_frames(&mut buf).is_empty());
        assert_eq!(buf, b"data: incomplete\n");
    }

    #[test]
    fn multibyte_codepoint_split_across_chunks_is_not_corrupted() {
        // "✓ 🚀 café" — ✓ (3 bytes), 🚀 (4 bytes), é (2 bytes). Feed the
        // frame one byte at a time so every codepoint straddles a chunk
        // boundary. The old per-chunk from_utf8_lossy would emit U+FFFD; the
        // byte-buffered drainer must reconstruct the exact text.
        let payload = "data: ✓ 🚀 café";
        let wire = format!("{payload}\n\n");
        let mut buf: Vec<u8> = Vec::new();
        let mut frames: Vec<String> = Vec::new();
        for &byte in wire.as_bytes() {
            buf.push(byte);
            frames.extend(drain_sse_frames(&mut buf));
        }
        assert_eq!(frames, vec![payload.to_string()]);
        assert!(
            !frames[0].contains('\u{FFFD}'),
            "no replacement chars: {:?}",
            frames[0]
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn multiple_frames_in_one_chunk() {
        let mut buf: Vec<u8> = b"data: a\n\ndata: b\n\ndata: c\n\n".to_vec();
        let frames = drain_sse_frames(&mut buf);
        assert_eq!(frames, vec!["data: a", "data: b", "data: c"]);
        assert!(buf.is_empty());
    }

    // ── orphan_killset classifier tests ──────────────────────────────────────

    /// Helper: build a ProcInfo row whose process group is itself (a group
    /// leader / a process not tracked by lineage). Good enough for the
    /// name+descendant cases; use `proc_g` to set an explicit pgid.
    fn proc(pid: i32, ppid: i32, command: &str) -> ProcInfo {
        proc_g(pid, ppid, pid, command)
    }

    /// Helper: build a ProcInfo row with an explicit process-group id — used to
    /// model MCP/LSP children that inherited a (now-dead) sidecar's pgid.
    fn proc_g(pid: i32, ppid: i32, pgid: i32, command: &str) -> ProcInfo {
        ProcInfo {
            pid,
            ppid,
            pgid,
            command: command.to_string(),
        }
    }

    /// The empty ledger — for tests that exercise only name + descendant rules.
    fn no_ledger() -> HashSet<i32> {
        HashSet::new()
    }

    /// A ledger containing the given sidecar pgids.
    fn ledger(pgids: &[i32]) -> HashSet<i32> {
        pgids.iter().copied().collect()
    }

    #[test]
    fn orphan_sidecar_with_ppid_1_is_killed() {
        // A sidecar reparented to init is an orphan (matched by our own name).
        let snap = vec![proc(500, 1, "node /app/sidecar/app-sidecar.mjs")];
        let ks = orphan_killset(&snap, 100, &no_ledger());
        assert_eq!(ks, vec![500]);
    }

    #[test]
    fn live_sidecar_with_alive_parent_is_excluded() {
        // The current gg-app (pid 100) is the parent of a live sidecar (pid 200).
        let snap = vec![
            proc(100, 1, "/Applications/GG Coder.app/Contents/MacOS/gg-app"),
            proc(200, 100, "ggnode app-sidecar.mjs"),
        ];
        let ks = orphan_killset(&snap, 100, &no_ledger());
        assert!(ks.is_empty(), "live sidecar must not be killed: {ks:?}");
    }

    #[test]
    fn orphan_sidecar_with_dead_parent_not_in_snapshot() {
        // Parent pid 999 is absent from the snapshot and ≠ 1 → dead → orphan.
        let snap = vec![proc(300, 999, "node app-sidecar.js")];
        let ks = orphan_killset(&snap, 100, &no_ledger());
        assert!(ks.contains(&300));
    }

    #[test]
    fn reparented_mcp_child_killed_by_group_lineage() {
        // THE crash case: the sidecar (pgid 500) is long gone; its MCP child
        // reparented to init (ppid 1) but kept pgid 500. The command is an
        // arbitrary user-added MCP name we've never heard of. With 500 in the
        // ledger and no live pid==500, lineage kills it — no name whitelist.
        let snap = vec![proc_g(701, 1, 500, "node some-random-user-mcp-server")];
        let ks = orphan_killset(&snap, 100, &ledger(&[500]));
        assert_eq!(ks, vec![701]);
    }

    #[test]
    fn reparented_mcp_child_spared_when_group_leader_alive() {
        // Same shape, but a process with pid==500 is still alive (a live sidecar,
        // or a recycled pid). The group is NOT dead → its members are left alone.
        // The live app (pid 100, self) is in the snapshot so the sidecar's parent
        // reads as alive too.
        let snap = vec![
            proc(100, 1, "gg-app"),
            proc(500, 100, "ggnode app-sidecar.mjs"),
            proc_g(701, 500, 500, "node some-user-mcp-server"),
        ];
        let ks = orphan_killset(&snap, 100, &ledger(&[500]));
        assert!(ks.is_empty(), "live-group members must be spared: {ks:?}");
    }

    #[test]
    fn unledgered_group_is_not_killed_by_lineage() {
        // A reparented process whose pgid is NOT in the ledger is none of our
        // business — lineage only fires for groups we recorded spawning.
        let snap = vec![proc_g(701, 1, 900, "node some-user-mcp-server")];
        let ks = orphan_killset(&snap, 100, &ledger(&[500]));
        assert!(ks.is_empty(), "unledgered group must be spared: {ks:?}");
    }

    #[test]
    fn orphan_descendant_tree_is_collected() {
        // sidecar(500, orphaned) → npm exec(501) → node kencode-search(502).
        // Children still linked to the in-snapshot dead sidecar are caught by
        // the descendant walk regardless of their names.
        let snap = vec![
            proc(500, 1, "node app-sidecar.js"),
            proc(501, 500, "npm exec @kenkaiiii/kencode-search"),
            proc(502, 501, "node kencode-search"),
        ];
        let ks = orphan_killset(&snap, 100, &no_ledger());
        assert!(ks.contains(&500));
        assert!(ks.contains(&501));
        assert!(ks.contains(&502));
        assert_eq!(ks.len(), 3);
    }

    #[test]
    fn current_app_pid_never_killed() {
        // Even if self somehow matches a pattern and has a dead parent, exclude it.
        let snap = vec![proc(100, 1, "node app-sidecar.js")];
        let ks = orphan_killset(&snap, 100, &no_ledger());
        assert!(ks.is_empty(), "self pid must never be in killset: {ks:?}");
    }

    #[test]
    fn unrelated_node_with_dead_parent_excluded() {
        // A vite process with a dead parent, no matching name, no ledgered group
        // → excluded.
        let snap = vec![proc(800, 1, "node vite")];
        let ks = orphan_killset(&snap, 100, &ledger(&[500]));
        assert!(
            ks.is_empty(),
            "non-matching process must not be killed: {ks:?}"
        );
    }

    #[test]
    fn dedup_when_descendant_also_matches_lineage() {
        // sidecar(500, orphaned) → MCP child(501) sharing pgid 500. 501 is both a
        // descendant AND a lineage member. It must appear exactly once.
        let snap = vec![
            proc_g(500, 1, 500, "node app-sidecar.js"),
            proc_g(501, 500, 500, "node some-user-mcp-server"),
        ];
        let ks = orphan_killset(&snap, 100, &ledger(&[500]));
        let count_501 = ks.iter().filter(|&&p| p == 501).count();
        assert_eq!(count_501, 1, "pid 501 must appear exactly once: {ks:?}");
        assert_eq!(ks.len(), 2);
    }

    #[test]
    fn multi_instance_concurrent_dev_runs_safe() {
        // Two gg-app instances each with their own live sidecar. Both sidecar
        // pgids are ledgered, but both leaders are alive → neither is swept.
        let snap = vec![
            proc(100, 1, "gg-app"),
            proc_g(200, 100, 200, "node app-sidecar.js"),
            proc(300, 1, "gg-app"),
            proc_g(400, 300, 400, "node app-sidecar.js"),
        ];
        let led = ledger(&[200, 400]);
        // Instance 1 sweeps.
        assert!(orphan_killset(&snap, 100, &led).is_empty());
        // Instance 2 sweeps.
        assert!(orphan_killset(&snap, 300, &led).is_empty());
    }

    // ── Output parser tests (cross-platform) ────────────────────────────────
    // These verify the parsing of real OS process-listing output so the Windows
    // CIM path is exercised on macOS (where the Windows snapshot command can't
    // run, but the parser can).

    #[test]
    fn parse_ps_handles_column_padding_and_spaces_in_command() {
        // Real `ps -eo pid=,ppid=,pgid=,command=` output: multiple spaces
        // between fields. Columns are pid, ppid, pgid, then the command.
        let raw = "    1     0     1 /sbin/launchd\n\
                   11541     1 11541 /Applications/GG Coder.app/Contents/MacOS/gg-app\n\
                   11553 11541 11553 /Applications/GG Coder.app/Contents/MacOS/ggnode app-sidecar.mjs";
        let rows = parse_ps_output(raw);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].pid, 1);
        assert_eq!(rows[0].ppid, 0);
        assert_eq!(rows[0].pgid, 1);
        assert_eq!(rows[0].command, "/sbin/launchd");
        // The sidecar is its own group leader (pgid == pid).
        assert_eq!(rows[2].pgid, 11553);
        // Command with spaces is rejoined correctly.
        assert!(rows[2].command.contains("app-sidecar.mjs"));
        assert!(rows[2].command.contains("ggnode"));
    }

    #[test]
    fn parse_ps_skips_unparseable_lines() {
        let raw = "pid ppid pgid command\n\
                   abc def ghi not-a-number\n\
                   42 1 42 node";
        let rows = parse_ps_output(raw);
        // Header + garbage lines are skipped; only the valid row survives.
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, 42);
        assert_eq!(rows[0].pgid, 42);
    }

    #[test]
    fn parse_cim_handles_pipe_delimited_output() {
        // Real PowerShell CIM output: pid|ppid|CommandLine.
        let raw = "4|0|\n\
                   5204|5200|C:\\Program Files\\nodejs\\node.exe app-sidecar.mjs\n\
                   5300|5204|C:\\Program Files\\nodejs\\node.exe kencode-search";
        let rows = parse_cim_output(raw);
        assert_eq!(rows.len(), 3);
        // Kernel process with empty CommandLine.
        assert_eq!(rows[0].pid, 4);
        assert_eq!(rows[0].ppid, 0);
        assert_eq!(rows[0].command, "");
        // Sidecar with full path.
        assert!(rows[1].command.contains("app-sidecar.mjs"));
        // kencode grandchild.
        assert_eq!(rows[2].ppid, 5204);
        assert!(rows[2].command.contains("kencode-search"));
    }

    #[test]
    fn parse_cim_command_with_pipe_is_preserved() {
        // A command line containing a pipe character must not be split further.
        let raw = "100|1|cmd /c echo hi | findstr foo";
        let rows = parse_cim_output(raw);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, 100);
        assert_eq!(rows[0].ppid, 1);
        // The third field captures everything after the second '|'.
        assert_eq!(rows[0].command, "cmd /c echo hi | findstr foo");
    }

    #[test]
    fn parse_cim_skips_blank_and_garbage_lines() {
        let raw = "\n\
                   \r\n\
                   abc|def|garbage\n\
                   42|1|node app-sidecar.mjs";
        let rows = parse_cim_output(raw);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, 42);
    }

    #[test]
    fn full_windows_sweep_pipeline() {
        // End-to-end: CIM output → parse → classify → killset. Simulates a
        // Windows machine where a previous gg-app instance was force-quit,
        // orphaning its sidecar tree (parent PIDs absent from the snapshot).
        let raw = "4|0|\n\
                   1000|4|C:\\Windows\\System32\\cmd.exe\n\
                   5000|9999|C:\\nodejs\\node.exe app-sidecar.mjs\n\
                   5001|5000|C:\\nodejs\\node.exe kencode-search\n\
                   6000|4|C:\\Program Files\\GG Coder\\gg-app.exe\n\
                   6001|6000|C:\\nodejs\\node.exe app-sidecar.mjs";
        let snapshot = parse_cim_output(raw);
        assert_eq!(snapshot.len(), 6);
        // Self = the new gg-app (pid 6000). Its sidecar (6001) has a live parent.
        // Windows has no pgid (all 0), so classification relies on the sidecar
        // name (5000) + descendant walk (5001) — ledger is irrelevant here.
        let killset = orphan_killset(&snapshot, 6000, &no_ledger());
        // Orphaned sidecar (5000, parent 9999 dead) + its kencode child (5001).
        assert!(killset.contains(&5000));
        assert!(killset.contains(&5001));
        // Live sidecar (6001) must NOT be killed.
        assert!(!killset.contains(&6001));
        assert_eq!(killset.len(), 2);
    }

    // ── reading_order + grid_cols tests ───────────────────────────────────────

    /// Helper: build a (label, x, y) position tuple.
    fn pos(label: &str, x: i32, y: i32) -> (String, i32, i32) {
        (label.to_string(), x, y)
    }

    #[test]
    fn reading_order_empty_is_empty() {
        assert!(reading_order(&[], 50).is_empty());
    }

    #[test]
    fn reading_order_2x2_grid_is_reading_order() {
        // Four quadrants given out of order → TL, TR, BL, BR.
        let positions = vec![
            pos("br", 500, 400),
            pos("tl", 0, 0),
            pos("tr", 500, 0),
            pos("bl", 0, 400),
        ];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["tl", "tr", "bl", "br"]);
    }

    #[test]
    fn reading_order_single_row_left_to_right() {
        // Three same-row windows given out of order → left, center, right.
        let positions = vec![pos("c", 500, 0), pos("a", 0, 0), pos("b", 250, 0)];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["a", "b", "c"]);
    }

    #[test]
    fn reading_order_tolerance_groups_nearby_rows() {
        // Two windows whose y differs by 30 (< tolerance 50) → same row, x order.
        let positions = vec![pos("b", 500, 30), pos("a", 0, 0)];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["a", "b"]);
    }

    #[test]
    fn reading_order_large_gap_splits_rows() {
        // y gap of 400 (> tolerance 50) → separate rows.
        let positions = vec![pos("top", 500, 0), pos("bot", 0, 400)];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["top", "bot"]);
    }

    #[test]
    fn reading_order_three_rows() {
        // 3×2 grid (6 windows) → row1 L→R, row2 L→R, row3 L→R.
        let positions = vec![
            pos("c", 500, 0),
            pos("f", 500, 800),
            pos("a", 0, 0),
            pos("e", 0, 800),
            pos("d", 0, 400),
            pos("b", 500, 400),
        ];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["a", "c", "d", "b", "e", "f"]);
    }

    #[test]
    fn grid_cols_generalizes_any_count() {
        assert_eq!(grid_cols(0), 1); // guard against division-by-zero
        assert_eq!(grid_cols(1), 1);
        assert_eq!(grid_cols(2), 2);
        assert_eq!(grid_cols(3), 2);
        assert_eq!(grid_cols(4), 2);
        assert_eq!(grid_cols(5), 3);
        assert_eq!(grid_cols(6), 3);
        assert_eq!(grid_cols(7), 3);
        assert_eq!(grid_cols(8), 3);
        assert_eq!(grid_cols(9), 3);
        assert_eq!(grid_cols(12), 4);
    }

    #[test]
    fn tile_rects_fills_work_area_row_major() {
        // 1920×1080 work area, origin (0,0). 4 windows → 2×2.
        let rects = tile_rects(4, 0, 0, 1920, 1080);
        assert_eq!(rects.len(), 4);
        // Row 0: left & right halves.
        assert_eq!(rects[0], (0, 0, 960, 540));
        assert_eq!(rects[1], (960, 0, 960, 540));
        // Row 1: left & right halves.
        assert_eq!(rects[2], (0, 540, 960, 540));
        assert_eq!(rects[3], (960, 540, 960, 540));
    }

    #[test]
    fn tile_rects_five_is_three_cols_two_rows() {
        // 5 windows → cols=3, rows=2. The last two land in row 1 (col 0 & 1).
        let rects = tile_rects(5, 0, 0, 3000, 1000);
        assert_eq!(rects.len(), 5);
        let cell_w = 3000 / 3; // 1000
        let cell_h = 1000 / 2; // 500
                               // Indices 3 & 4 are the bottom row — they must be sized to the cell.
        assert_eq!(rects[3], (0, cell_h, cell_w as u32, cell_h as u32));
        assert_eq!(rects[4], (cell_w, cell_h, cell_w as u32, cell_h as u32));
    }

    #[test]
    fn tile_rects_empty_is_empty() {
        assert!(tile_rects(0, 0, 0, 1920, 1080).is_empty());
    }

    // ── Pane registry lifecycle ──────────────────────────────────────────────

    fn add_pane(registry: &mut PaneRegistry, window: &str, pane: &str, cwd: &str) -> u64 {
        create_pane_target(
            registry,
            window,
            pane,
            WorkspaceMode::Code,
            ChatAgent::General,
            PathBuf::from(cwd),
            None,
        )
        .unwrap()
    }

    #[test]
    fn arbitrary_panes_in_one_window_are_independent() {
        let mut registry = PaneRegistry::default();
        let left = add_pane(&mut registry, "main", "left", "/left");
        let right = add_pane(&mut registry, "main", "right", "/right");
        assert!(bind_pane_session(
            &mut registry,
            "main",
            "left",
            left,
            "sid-left".into()
        ));
        assert!(bind_pane_session(
            &mut registry,
            "main",
            "right",
            right,
            "sid-right".into()
        ));
        assert_eq!(
            resolve_owned_pane(&registry, "main", "left")
                .unwrap()
                .session_id
                .as_deref(),
            Some("sid-left")
        );
        assert_eq!(
            resolve_owned_pane(&registry, "main", "right")
                .unwrap()
                .session_id
                .as_deref(),
            Some("sid-right")
        );
    }

    #[test]
    fn same_pane_ids_in_different_windows_do_not_collide() {
        let mut registry = PaneRegistry::default();
        let first = add_pane(&mut registry, "main", "chat", "/one");
        let second = add_pane(&mut registry, "project-1", "chat", "/two");
        assert!(bind_pane_session(
            &mut registry,
            "main",
            "chat",
            first,
            "one".into()
        ));
        assert!(bind_pane_session(
            &mut registry,
            "project-1",
            "chat",
            second,
            "two".into()
        ));
        assert_eq!(
            resolve_owned_pane(&registry, "main", "chat")
                .unwrap()
                .session_id
                .as_deref(),
            Some("one")
        );
        assert_eq!(
            resolve_owned_pane(&registry, "project-1", "chat")
                .unwrap()
                .session_id
                .as_deref(),
            Some("two")
        );
    }

    #[test]
    fn stale_create_or_select_bind_cannot_overwrite_newer_generation() {
        let mut registry = PaneRegistry::default();
        let stale = add_pane(&mut registry, "main", "chat", "/old");
        dispose_pane_target(&mut registry, "main", "chat", true, Some(stale)).unwrap();
        let current = add_pane(&mut registry, "main", "chat", "/new");
        assert!(!bind_pane_session(
            &mut registry,
            "main",
            "chat",
            stale,
            "stale".into()
        ));
        assert!(bind_pane_session(
            &mut registry,
            "main",
            "chat",
            current,
            "current".into()
        ));
        assert_eq!(
            resolve_owned_pane(&registry, "main", "chat")
                .unwrap()
                .session_id
                .as_deref(),
            Some("current")
        );
    }

    #[test]
    fn pane_disposal_success_removes_acknowledged_generation() {
        let mut registry = PaneRegistry::default();
        let generation = add_pane(&mut registry, "main", "chat", "/project");
        let target =
            pane_disposal_target(&registry, "main", "chat", false, Some(generation)).unwrap();

        complete_pane_disposal(&mut registry, "main", "chat", target.generation, Ok(())).unwrap();

        assert!(resolve_owned_pane(&registry, "main", "chat").is_none());
    }

    #[test]
    fn pane_disposal_failure_preserves_registry_for_retry() {
        let mut registry = PaneRegistry::default();
        let generation = add_pane(&mut registry, "main", "chat", "/project");

        let error = complete_pane_disposal(
            &mut registry,
            "main",
            "chat",
            generation,
            Err("daemon rejected disposal".into()),
        )
        .unwrap_err();

        assert_eq!(error, "daemon rejected disposal");
        assert_eq!(
            resolve_owned_pane(&registry, "main", "chat")
                .unwrap()
                .generation,
            generation
        );
    }

    #[test]
    fn pane_disposal_stale_generation_preserves_replacement() {
        let mut registry = PaneRegistry::default();
        let stale = add_pane(&mut registry, "main", "chat", "/old");
        dispose_pane_target(&mut registry, "main", "chat", true, Some(stale)).unwrap();
        let current = add_pane(&mut registry, "main", "chat", "/new");

        let error =
            complete_pane_disposal(&mut registry, "main", "chat", stale, Ok(())).unwrap_err();

        assert!(error.contains("generation is stale"));
        assert_eq!(
            resolve_owned_pane(&registry, "main", "chat")
                .unwrap()
                .generation,
            current
        );
    }

    #[test]
    fn generation_mismatched_disposal_cannot_remove_replacement() {
        let mut registry = PaneRegistry::default();
        let stale = add_pane(&mut registry, "main", "chat", "/old");
        dispose_pane_target(&mut registry, "main", "chat", true, Some(stale)).unwrap();
        let current = add_pane(&mut registry, "main", "chat", "/new");
        assert!(dispose_pane_target(&mut registry, "main", "chat", true, Some(stale)).is_err());
        assert_eq!(
            resolve_owned_pane(&registry, "main", "chat")
                .unwrap()
                .generation,
            current
        );
    }

    #[test]
    fn window_close_drains_only_its_panes() {
        let mut registry = PaneRegistry::default();
        add_pane(&mut registry, "main", "one", "/one");
        add_pane(&mut registry, "main", "two", "/two");
        add_pane(&mut registry, "peer", "one", "/peer");
        assert_eq!(take_window_panes(&mut registry, "main").len(), 2);
        assert!(registry.get("main").is_none());
        assert!(resolve_owned_pane(&registry, "peer", "one").is_some());
    }

    #[test]
    fn recovery_enumerates_every_pane_target() {
        let mut registry = PaneRegistry::default();
        add_pane(&mut registry, "main", "one", "/one");
        add_pane(&mut registry, "main", "two", "/two");
        add_pane(&mut registry, "peer", "one", "/peer");
        let targets = recovery_targets(&registry);
        let identities: HashSet<_> = targets
            .iter()
            .map(|target| (target.0.as_str(), target.1.as_str()))
            .collect();
        assert_eq!(
            identities,
            HashSet::from([("main", "one"), ("main", "two"), ("peer", "one")])
        );
    }

    #[test]
    fn event_forwarding_requires_matching_generation_session_and_envelope() {
        let mut registry = PaneRegistry::default();
        let generation = add_pane(&mut registry, "main", "chat", "/chat");
        assert!(bind_pane_session(
            &mut registry,
            "main",
            "chat",
            generation,
            "sid".into()
        ));
        assert!(pane_identity_is_current(
            &registry, "main", "chat", generation, "sid"
        ));
        assert!(!pane_identity_is_current(
            &registry,
            "main",
            "chat",
            generation + 1,
            "sid"
        ));
        assert!(!pane_identity_is_current(
            &registry, "main", "chat", generation, "other"
        ));

        let event = serde_json::json!({"sessionId": "sid", "type": "delta", "data": {"text": "ok"}, "paneId": "spoofed"});
        let trusted = trusted_event_envelope("chat", "sid", &event).unwrap();
        assert_eq!(trusted["paneId"], "chat");
        assert_eq!(trusted["sessionId"], "sid");
        assert_eq!(trusted["type"], "delta");
        assert!(trusted_event_envelope("chat", "other", &event).is_none());
        assert!(
            trusted_event_envelope("chat", "sid", &serde_json::json!({"sessionId": "sid"}))
                .is_none()
        );
    }

    #[test]
    fn restore_target_survives_repeated_webview_mounts_until_cleanup() {
        let mut targets = HashMap::new();
        let entry = RestoreEntry {
            mode: WorkspaceMode::Code,
            chat_agent: ChatAgent::General,
            cwd: "/project".into(),
            session_path: Some("/sessions/one.jsonl".into()),
        };

        register_restore_target(&mut targets, "main".into(), entry);
        assert_eq!(
            restore_target(&targets, "main").map(|target| target.cwd),
            Some("/project".into())
        );
        assert_eq!(
            restore_target(&targets, "main").map(|target| target.cwd),
            Some("/project".into())
        );
        assert!(remove_restore_target(&mut targets, "main").is_some());
        assert!(restore_target(&targets, "main").is_none());
    }

    fn copy_operation(owner: &str, target: &str) -> PaneCopyOperation {
        PaneCopyOperation {
            source_owner: owner.into(),
            target_label: target.into(),
            restore: RestoreEntry {
                mode: WorkspaceMode::Code,
                chat_agent: ChatAgent::General,
                cwd: "/project".into(),
                session_path: Some("/sessions/copy.jsonl".into()),
            },
            cloned_session_path: Some(PathBuf::from("/sessions/copy.jsonl")),
            started: false,
        }
    }

    #[test]
    fn copy_restore_is_destination_scoped_and_consume_once() {
        let key = ("main".to_string(), "copy-id".to_string());
        let mut copies = PaneCopyRegistry::default();
        copies
            .operations
            .insert(key.clone(), copy_operation("main", "copy-copy-id"));
        copies.target_owners.insert("copy-copy-id".into(), key);
        let mut targets = HashMap::from([(
            "copy-copy-id".into(),
            copy_operation("main", "copy-copy-id").restore,
        )]);

        assert!(consume_copy_restore_target(&copies, &mut targets, "main").is_none());
        assert!(consume_copy_restore_target(&copies, &mut targets, "copy-copy-id").is_some());
        assert!(consume_copy_restore_target(&copies, &mut targets, "copy-copy-id").is_none());
    }

    #[test]
    fn copy_rollback_is_source_owner_scoped() {
        let key = ("main".to_string(), "copy-id".to_string());
        let mut copies = PaneCopyRegistry::default();
        copies
            .operations
            .insert(key.clone(), copy_operation("main", "copy-copy-id"));
        copies.target_owners.insert("copy-copy-id".into(), key);

        assert!(remove_copy_operation(&mut copies, "peer", "copy-id").is_none());
        assert!(copies.target_owners.contains_key("copy-copy-id"));
        assert!(remove_copy_operation(&mut copies, "main", "copy-id").is_some());
        assert!(copies.operations.is_empty());
        assert!(copies.target_owners.is_empty());
    }

    #[test]
    fn repeated_copy_id_reuses_the_reserved_window() {
        let key = ("main".to_string(), "copy-id".to_string());
        let mut copies = PaneCopyRegistry::default();
        copies
            .operations
            .insert(key.clone(), copy_operation("main", "copy-copy-id"));
        copies
            .target_owners
            .insert("copy-copy-id".into(), key.clone());

        let first = copies.operations.get(&key).unwrap().target_label.clone();
        let second = copies.operations.get(&key).unwrap().target_label.clone();
        assert_eq!(first, second);
        assert_eq!(copy_window_label("copy-id"), "copy-copy-id");
    }

    #[test]
    fn session_clone_validates_complete_jsonl_before_publish() {
        let dir = std::env::temp_dir().join(format!("gg-copy-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.jsonl");
        std::fs::write(
            &source,
            "{\"type\":\"session\",\"id\":\"source\"}\n{\"type\":\"message\"}\n",
        )
        .unwrap();
        let copied = clone_pane_session_file(&source, "valid").unwrap();
        assert!(copied.is_file());
        let copied_contents = std::fs::read_to_string(&copied).unwrap();
        let copied_header: serde_json::Value =
            serde_json::from_str(copied_contents.lines().next().unwrap()).unwrap();
        assert_eq!(copied_header["id"], "valid");
        assert!(!dir.join(".source-copy-valid.tmp").exists());

        std::fs::write(&source, "{\"type\":\"session\"}\n{\"partial\":").unwrap();
        assert!(clone_pane_session_file(&source, "partial").is_err());
        assert!(!dir.join("source-copy-partial.jsonl").exists());
        assert!(!dir.join(".source-copy-partial.tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
