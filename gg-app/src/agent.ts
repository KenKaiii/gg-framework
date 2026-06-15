// Client bridge to the Node agent sidecar — routed entirely through Rust IPC.
// The webview is served from a secure `tauri://` origin, so it cannot fetch the
// sidecar's plain-HTTP endpoints directly (mixed-content). Rust proxies for us:
//   - invoke("agent_state" | "agent_prompt" | "agent_cancel")
//   - listen("agent-event")  ← forwarded SSE frames
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";

// Per-window event bus. The Rust side emits agent traffic with `emit_to` the
// specific window label, so each window must listen on ITS OWN webview target —
// a global `listen` (target "Any") would never receive window-scoped events.
// This is what keeps multiple project windows fully isolated.
const appWindow = getCurrentWebviewWindow();

/** This webview's window label (`main` for the first window, `project-N` for
 *  windows opened via the Windows button). */
export const windowLabel = appWindow.label;

/** True for secondary windows opened via the Windows button (not the main one). */
export const isSecondaryWindow = appWindow.label !== "main";

/** Set the native (macOS overlay) window title bar text for THIS window. */
export function setWindowTitle(title: string): void {
  void appWindow.setTitle(title).catch(() => {});
}

export interface SidecarEvent {
  type: string;
  data: unknown;
}

/** A background process (bash run_in_background), mirrored from the sidecar. */
export interface BackgroundTask {
  id: string;
  pid: number;
  command: string;
  startedAt: number;
  /** null while running; a number once the process has exited. */
  exitCode: number | null;
}

export interface AgentState {
  provider: string;
  model: string;
  cwd: string;
  running: boolean;
  /** Current reasoning level, or null when thinking is off. May be absent on
   * frames from older sidecars / partial model_change spreads. */
  thinkingLevel?: string | null;
  /** Levels this provider/model supports, in cycle order. May be absent. */
  supportedThinkingLevels?: string[];
  /** True while the agent is in read-only plan mode. */
  planMode?: boolean;
  /** Token budget for the active model — denominator for the context meter. */
  contextWindow?: number;
  /** Current git branch of the project cwd, or null when not a repo. */
  gitBranch?: string | null;
  /** True when the project cwd is inside a git work tree. */
  isGitRepo?: boolean;
  /** Live background tasks (footer indicator). */
  tasks?: BackgroundTask[];
}

/** A project task from the ~/.gg-tasks store (the agent's `tasks` tool). */
export interface ProjectTask {
  id: string;
  title: string;
  prompt: string;
  status: "pending" | "in-progress" | "done";
  createdAt: string;
}

/** List this project's tasks (pending / in-progress / done). */
export async function listTasks(): Promise<ProjectTask[]> {
  try {
    const res = await invoke<{ tasks: ProjectTask[] }>("agent_tasks");
    return res.tasks ?? [];
  } catch (e) {
    await logError(`agent_tasks failed: ${String(e)}`);
    return [];
  }
}

/** Run a single task end-to-end in its own fresh session. */
export async function runTask(id: string): Promise<void> {
  await invoke("agent_run_tasks", { id, all: false });
}

/** Run every pending task sequentially (a fresh session each), in order. */
export async function runAllTasks(): Promise<void> {
  await invoke("agent_run_tasks", { id: null, all: true });
}

/** Delete a task by id. Returns the remaining tasks. */
export async function deleteTask(id: string): Promise<ProjectTask[]> {
  try {
    const res = await invoke<{ tasks: ProjectTask[] }>("agent_delete_task", { id });
    return res.tasks ?? [];
  } catch (e) {
    await logError(`agent_delete_task failed: ${String(e)}`);
    return [];
  }
}

export interface ThinkingState {
  thinkingLevel: string | null;
  supportedThinkingLevels: string[];
}

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

export interface SlashCommand {
  name: string;
  aliases: string[];
  description: string;
  /** "built-in" prompt template or a user ".gg/commands" custom command. */
  source?: "built-in" | "custom";
}

export interface DiscoveredProject {
  name: string;
  path: string;
  lastActiveDisplay: string;
  sources: string[];
}

export interface RecentSession {
  id: string;
  path: string;
  preview: string;
  lastActiveDisplay: string;
  messageCount: number;
}

export interface SwitchModelResult extends ThinkingState {
  provider: string;
  model: string;
}

export async function getState(): Promise<AgentState> {
  return invoke<AgentState>("agent_state");
}

/** A chat-input attachment (image / video / other file) sent with a prompt. */
export interface Attachment {
  kind: "image" | "video" | "file";
  name: string;
  mediaType: string;
  /** base64 with NO data: prefix. */
  data: string;
}

export async function sendPrompt(text: string, attachments: Attachment[] = []): Promise<void> {
  await logInfo(
    `prompt: ${text.slice(0, 80)}${attachments.length ? ` (+${attachments.length} att)` : ""}`,
  );
  try {
    await invoke("agent_prompt", { text, attachments });
  } catch (e) {
    await logError(`agent_prompt failed: ${String(e)}`);
    throw e;
  }
}

export async function cancel(): Promise<void> {
  try {
    await invoke("agent_cancel");
  } catch (e) {
    await logError(`agent_cancel failed: ${String(e)}`);
  }
}

/** A resumed transcript entry (user or assistant text) for hydration. When
 *  `hook` is set, this user message is an injected self-correction hook prompt
 *  and should render as the short hook notice, not the raw prompt body. */
export interface HistoryEntry {
  role: "user" | "assistant";
  text: string;
  /** Attached image data URLs, reconstructed so they re-render on resume. */
  images?: string[];
  hook?: "ideal" | "loop_break" | "regrounding" | null;
  /** True when `text` is a recovered `/name [args]` command invocation, so the
   *  webview renders the short command chip instead of the expanded body. */
  command?: boolean;
}

/** Fetch the resumed session's prior messages so the transcript can hydrate. */
export async function listHistory(): Promise<HistoryEntry[]> {
  try {
    const res = await invoke<{ history: HistoryEntry[] }>("agent_history");
    return res.history ?? [];
  } catch (e) {
    await logError(`agent_history failed: ${String(e)}`);
    return [];
  }
}

// ── Provider auth (login) ──────────────────────────────────
export type AuthMethod = "oauth" | "apikey";

export interface AuthProvider {
  value: string;
  label: string;
  description: string;
  methods: AuthMethod[];
  apiKeyLabel?: string;
  apiKeyBaseUrl?: string;
  /** Live connection status from ~/.gg/auth.json. */
  connected: boolean;
}

/** List providers with their supported auth methods + live connection status. */
export async function authStatus(): Promise<AuthProvider[]> {
  try {
    const res = await invoke<{ providers: AuthProvider[] }>("agent_auth_status");
    return res.providers ?? [];
  } catch (e) {
    await logError(`agent_auth_status failed: ${String(e)}`);
    return [];
  }
}

/** Store an API key for a provider. Throws with a user-facing message on error. */
export async function authApiKey(provider: string, key: string): Promise<void> {
  await invoke("agent_auth_apikey", { provider, key });
}

/** Begin an OAuth login; progress arrives via subscribe() auth_* events. */
export async function authOAuthStart(provider: string): Promise<void> {
  await invoke("agent_auth_oauth_start", { provider });
}

/** Submit a pasted OAuth code to an in-flight login. */
export async function authOAuthCode(code: string): Promise<void> {
  await invoke("agent_auth_oauth_code", { code });
}

/** Disconnect a provider (clear stored credentials). */
export async function authLogout(provider: string): Promise<void> {
  await invoke("agent_auth_logout", { provider });
}

/** Start a fresh session (clears history) for this window's current project. */
export async function newSession(): Promise<void> {
  try {
    await invoke("agent_new_session");
  } catch (e) {
    await logError(`agent_new_session failed: ${String(e)}`);
    throw e;
  }
}

/** A radio station available to play in this window. */
export interface RadioStation {
  id: string;
  name: string;
  description: string;
  url: string;
}

export interface RadioState {
  stations: RadioStation[];
  /** Currently-playing station id for THIS window, or null when off. */
  current: string | null;
}

/** Read this window's radio state (available stations + what's playing). */
export async function getRadioState(): Promise<RadioState> {
  try {
    const res = await invoke<RadioState>("agent_radio_state");
    return { stations: res.stations ?? [], current: res.current ?? null };
  } catch (e) {
    await logError(`agent_radio_state failed: ${String(e)}`);
    return { stations: [], current: null };
  }
}

/**
 * Play a station by id, or stop with "off". Playback is isolated to this
 * window's sidecar. Returns the now-playing id (null when stopped). Throws with
 * a user-facing message when no player is installed.
 */
export async function setRadio(station: string): Promise<string | null> {
  const res = await invoke<{ current: string | null }>("agent_radio_set", { station });
  return res.current ?? null;
}

/** Stop a background task by id. Returns the sidecar's status message, if any. */
export async function killTask(id: string): Promise<string | null> {
  try {
    const res = await invoke<{ message?: string }>("agent_kill_task", { id });
    return res.message ?? null;
  } catch (e) {
    await logError(`agent_kill_task failed: ${String(e)}`);
    return null;
  }
}

/** Cycle the reasoning/thinking level to the next supported value (or off). */
export async function cycleThinking(): Promise<ThinkingState | null> {
  try {
    return await invoke<ThinkingState>("agent_cycle_thinking");
  } catch (e) {
    await logError(`agent_cycle_thinking failed: ${String(e)}`);
    return null;
  }
}

/** List workflow (prompt-template) slash commands the agent can run. */
export async function listCommands(): Promise<SlashCommand[]> {
  try {
    const res = await invoke<{ commands: SlashCommand[] }>("agent_commands");
    return res.commands ?? [];
  } catch (e) {
    await logError(`agent_commands failed: ${String(e)}`);
    return [];
  }
}

/** List models available to the logged-in providers. */
export async function listModels(): Promise<ModelOption[]> {
  try {
    const res = await invoke<{ models: ModelOption[] }>("agent_models");
    return res.models ?? [];
  } catch (e) {
    await logError(`agent_models failed: ${String(e)}`);
    return [];
  }
}

/** Switch the active model by id. Returns the new provider/model + thinking state. */
export async function switchModel(model: string): Promise<SwitchModelResult | null> {
  try {
    return await invoke<SwitchModelResult>("agent_switch_model", { model });
  } catch (e) {
    await logError(`agent_switch_model failed: ${String(e)}`);
    return null;
  }
}

/** App settings. `configured` is true only when the user explicitly set a
 * projects root (not the default fallback). */
export interface AppSettings {
  projectsRoot: string;
  configured: boolean;
}

/** Read gg-app settings (projects root folder + whether it was explicitly set). */
export async function getSettings(): Promise<AppSettings | null> {
  try {
    return await invoke<AppSettings>("agent_settings");
  } catch (e) {
    await logError(`agent_settings failed: ${String(e)}`);
    return null;
  }
}

/** Save gg-app settings. */
export async function saveSettings(projectsRoot: string): Promise<void> {
  await invoke("agent_save_settings", { projectsRoot });
}

/**
 * Create a new project folder (lowercase/dashes name) under the configured
 * projects root. Returns the created absolute path. Throws with a user-facing
 * message on invalid name / conflict.
 */
export async function createProject(name: string): Promise<string> {
  // Mutating op: gate on readiness so a fast click on a slow-booting (release)
  // sidecar waits instead of throwing "sidecar not ready".
  await waitForReady();
  const res = await invoke<{ path: string }>("agent_create_project", { name });
  return res.path;
}

/** Discover known projects (ggcoder + Claude Code + Codex), most recent first. */
export async function listProjects(): Promise<DiscoveredProject[]> {
  try {
    const res = await invoke<{ projects: DiscoveredProject[] }>("agent_projects");
    return res.projects ?? [];
  } catch (e) {
    await logError(`agent_projects failed: ${String(e)}`);
    return [];
  }
}

/** List the latest sessions for a project cwd (newest first, with previews). */
export async function listSessions(cwd: string): Promise<RecentSession[]> {
  try {
    const res = await invoke<{ sessions: RecentSession[] }>("agent_sessions", { cwd });
    return res.sessions ?? [];
  } catch (e) {
    await logError(`agent_sessions failed: ${String(e)}`);
    return [];
  }
}

/**
 * Re-point this window's agent at a project: respawns the sidecar at `cwd`,
 * optionally resuming `sessionPath`. The caller re-runs the ready flow after.
 */
export async function selectProject(cwd: string, sessionPath?: string): Promise<void> {
  await invoke("select_project", { cwd, sessionPath: sessionPath ?? null });
}

/**
 * Open enough new project windows (each with its own agent) to reach `count`
 * total, then tile the first `count` windows into a 2- or 4-up grid filling the
 * screen work area.
 */
export async function setupWindows(count: number): Promise<void> {
  try {
    await invoke("setup_windows", { count });
  } catch (e) {
    await logError(`setup_windows failed: ${String(e)}`);
    throw e;
  }
}

// Single Tauri listener for the whole app, fanned out to local subscribers.
// Registering the OS-level listener once at module scope (not per React mount)
// eliminates the StrictMode/HMR double-mount race where two async `listen()`
// calls leave two live listeners updating two independent state trees.
const localSubscribers = new Set<(e: SidecarEvent) => void>();
let tauriListenerStarted = false;

function ensureTauriListener(): void {
  if (tauriListenerStarted) return;
  tauriListenerStarted = true;
  void appWindow.listen<SidecarEvent>("agent-event", (e) => {
    for (const fn of localSubscribers) fn(e.payload);
  });
}

/**
 * Subscribe to forwarded agent events. Synchronous add/remove against the local
 * fan-out — no async cleanup window, so exactly one render tree sees events.
 */
export function subscribe(onEvent: (e: SidecarEvent) => void): () => void {
  ensureTauriListener();
  localSubscribers.add(onEvent);
  return () => localSubscribers.delete(onEvent);
}

/** Wait until the sidecar reports a port (proves the agent is up). */
export async function waitForReady(): Promise<void> {
  const immediate = await invoke<number | null>("sidecar_port").catch(() => null);
  if (typeof immediate === "number") return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const timeout = setTimeout(() => {
      if (!settled) {
        clearInterval(poll);
        unlisten?.();
        reject(new Error("sidecar did not start in time"));
      }
    }, 30000);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      unlisten?.();
      resolve();
    };
    appWindow
      .listen<number>("sidecar-ready", finish)
      .then((u) => {
        if (settled) u();
        else unlisten = u;
      })
      .catch(() => {});
    const poll = setInterval(() => {
      void invoke<number | null>("sidecar_port").then((p) => {
        if (typeof p === "number") finish();
      });
    }, 500);
  });
}
