//! Tauri-managed shared state: the daemon handle, window↔session map, restore targets.

use crate::*;

/// The single shared Node daemon process. Every window's `AgentSession` lives
/// inside this one process as an in-process object, addressed by a session id
/// (see `Windows`). Replaces the old one-sidecar-process-per-window model: one
/// Node runtime + one module graph for all windows, instead of N.
#[derive(Default)]
pub(crate) struct Daemon {
    /// The daemon child process (process-group leader). `None` until spawned.
    pub(crate) child: Mutex<Option<Child>>,
    /// The daemon's HTTP port, learned from its `GG_APP_LISTENING` handshake.
    /// `None` until ready; reset to `None` across a crash-respawn.
    pub(crate) port: Mutex<Option<u16>>,
    /// Consecutive short-lived crashes. A daemon that stays up for the stable
    /// window resets this budget; repeated crashes hit a circuit breaker.
    pub(crate) respawn_attempts: Mutex<u32>,
    /// Per-launch bearer token the daemon requires as `x-gg-token` on every
    /// request. Generated here, handed to the daemon via GG_APP_TOKEN, and
    /// attached by the shared reqwest client's default headers — without it
    /// any local process could drive the agent through the loopback port.
    pub(crate) token: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WorkspaceMode {
    Chat,
    Motion,
    #[default]
    #[serde(other)]
    Code,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ChatAgent {
    Therapist,
    Research,
    #[default]
    #[serde(other)]
    General,
}

/// One window's session inside the shared daemon. The routing fields mirror
/// session creation so workspace restore and crash recovery preserve the agent.
#[derive(Default, Clone)]
pub(crate) struct WindowSession {
    pub(crate) session_id: Option<String>,
    pub(crate) mode: WorkspaceMode,
    pub(crate) chat_agent: ChatAgent,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) session_path: Option<String>,
    pub(crate) generation: u64,
}

/// Per-window session registry, keyed by window label.
#[derive(Default)]
pub(crate) struct Windows {
    pub(crate) map: Mutex<HashMap<String, WindowSession>>,
    pub(crate) next_generation: AtomicU64,
}

/// True once the app has begun quitting. Set on `ExitRequested` so the cascade
/// of per-window `Destroyed` events during shutdown does NOT prune the workspace
/// snapshot — the last full snapshot is what we restore next launch.
#[derive(Default)]
pub(crate) struct AppExiting(pub(crate) AtomicBool);

/// One window's active target (mode, cwd, and optional session), returned by
/// `window_restore_target` so the webview can recover without showing Home.
#[derive(Clone, serde::Serialize)]
pub(crate) struct RestoreEntry {
    pub(crate) mode: WorkspaceMode,
    #[serde(rename = "chatAgent")]
    pub(crate) chat_agent: ChatAgent,
    pub(crate) cwd: String,
    #[serde(rename = "sessionPath")]
    pub(crate) session_path: Option<String>,
}

#[derive(serde::Serialize)]
pub(crate) struct DroppedPathInfo {
    pub(crate) path: String,
    #[serde(rename = "isDir")]
    pub(crate) is_dir: bool,
}

/// OS-level permission status shown in the Settings modal's "Grant
/// Permissions" row. Only macOS has anything to grant today (Full Disk
/// Access — needed because the subagent tool spawns a fresh `ggnode` process
/// per call, which re-triggers macOS's per-folder privacy prompts under
/// Desktop/Documents/Downloads/iCloud). Windows/Linux report
/// `applicable: false` so the webview hides the row entirely instead of
/// showing a badge for a permission that doesn't exist there.
#[derive(serde::Serialize)]
pub(crate) struct PermissionsStatus {
    pub(crate) applicable: bool,
    pub(crate) granted: bool,
}

/// Per-window active workspace targets. An entry exists only after the user has
/// chosen a workspace (or when one was restored at boot). Targets stay available
/// for the lifetime of the window so a WebKit content-process reload can recover
/// the same workspace instead of falling back to Home.
#[derive(Default)]
pub(crate) struct RestoreTargets {
    pub(crate) map: Mutex<HashMap<String, RestoreEntry>>,
}

pub(crate) fn register_restore_target(
    targets: &mut HashMap<String, RestoreEntry>,
    label: String,
    entry: RestoreEntry,
) {
    targets.insert(label, entry);
}

pub(crate) fn restore_target(
    targets: &HashMap<String, RestoreEntry>,
    label: &str,
) -> Option<RestoreEntry> {
    targets.get(label).cloned()
}

pub(crate) fn remove_restore_target(
    targets: &mut HashMap<String, RestoreEntry>,
    label: &str,
) -> Option<RestoreEntry> {
    targets.remove(label)
}

/// The label of the currently-focused window, updated on `Focused` window
/// events. `broadcast_window_order` reads this so every window knows which one
/// is active (and `focus_window_by_offset` cycles from here).
#[derive(Default)]
pub(crate) struct FocusedWindow(pub(crate) Mutex<Option<String>>);

/// Debounce token for `Moved` window events: the `Instant` of the last move.
/// Only the deferred task whose captured `Instant` still matches the stored one
/// fires the broadcast — earlier moves are superseded.
#[derive(Default)]
pub(crate) struct MoveDebounce(pub(crate) Mutex<Option<std::time::Instant>>);
