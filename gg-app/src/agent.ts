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

export interface SubAgentStatePayload {
  agent_id: string;
  task_name: string;
  state: "starting" | "running" | "completed" | "failed" | "interrupted" | "closed";
  started_at: number;
  updated_at: number;
  elapsed_ms: number;
  current_activity?: string;
  turn_count: number;
  tool_use_count: number;
  token_usage: { input: number; output: number };
  output?: string;
  error?: string;
}

export interface SidecarEvent {
  type: string;
  data: unknown;
}

export interface MemoryChangeEvent extends SidecarEvent {
  type: "memory_change";
  data: { count: number };
}

export function isMemoryChangeEvent(event: SidecarEvent): event is MemoryChangeEvent {
  return (
    event.type === "memory_change" &&
    typeof event.data === "object" &&
    event.data !== null &&
    typeof (event.data as { count?: unknown }).count === "number"
  );
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

export type WorkspaceMode = "code" | "chat";
export type ChatAgentId = "general" | "therapist" | "research";

export type MemoryCategory =
  | "identity"
  | "preference"
  | "project"
  | "relationship"
  | "health"
  | "other";

export interface Memory {
  id: string;
  text: string;
  category: MemoryCategory;
  importance: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySnapshot {
  memories: Memory[];
  softLimit: number;
  hardLimit: number;
}

export interface AgentState {
  provider: string;
  model: string;
  cwd: string;
  mode: WorkspaceMode;
  chatAgent?: ChatAgentId;
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
  /** True when the active model can accept native video input. */
  supportsVideo?: boolean;
  /** Autopilot (auto-review) toggle for this window's project. Per-window,
   *  persisted server-side; absent on frames from older sidecars. */
  autopilot?: boolean;
  /** Provider of the model Ken (mentor + autopilot) uses next turn. */
  kenProvider?: string;
  /** The model Ken uses next turn — his pin when set, else GG Coder's model.
   *  Absent on frames from older sidecars (footer falls back to `model`). */
  kenModel?: string;
  /** True when Ken is pinned to his own model (not following GG Coder). */
  kenModelOverride?: boolean;
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

export async function listMemories(): Promise<MemorySnapshot> {
  await waitForReady();
  return invoke<MemorySnapshot>("agent_memories");
}

export async function deleteMemory(id: string): Promise<MemorySnapshot> {
  await waitForReady();
  return invoke<MemorySnapshot>("agent_delete_memory", { id });
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
  chatAgent?: ChatAgentId;
}

export interface SwitchModelResult extends ThinkingState {
  provider: string;
  model: string;
}

/** Result of pinning/clearing Ken's model — his effective model afterward. */
export interface SwitchKenModelResult {
  kenProvider: string;
  kenModel: string;
  kenModelOverride: boolean;
}

export async function getState(): Promise<AgentState> {
  return invoke<AgentState>("agent_state");
}

// ── Progress (Ranks) ─────────────────────────────────────────────────────

/** One rung of the 50-rank ladder, as computed by the sidecar. */
export interface RankLadderEntry {
  level: number;
  name: string;
  tier: number;
  tierName: string;
  effectId: string;
  xpRequired: number;
}

export interface LevelUpEvent {
  from: number;
  to: number;
  rankName: string;
}

/** XP/rank snapshot — fully computed sidecar-side; the webview renders it verbatim. */
export interface ProgressSnapshot {
  level: number;
  rankName: string;
  tier: number;
  tierName: string;
  tierGlyph: string;
  effectId: string;
  xp: number;
  xpIntoLevel: number;
  xpForLevel: number;
  percent: number;
  streak: { current: number; best: number };
  totals: { prompts: number; commits: number; linesShipped: number; projects: number };
  xpBySource: { prompts: number; commits: number; streakBonus: number };
  memberSince: string;
  ladder: RankLadderEntry[];
  levelUp: LevelUpEvent | null;
  eventNonce: string | null;
  /** True only on the frame sent to the window whose run earned the XP —
   *  gates window-local feedback (sounds, XP chips). Absent on GET /progress. */
  origin?: boolean;
}

/** Fetch the current XP/rank snapshot (initial paint; live updates ride `progress` frames). */
export async function getProgress(): Promise<ProgressSnapshot> {
  await waitForReady();
  return invoke<ProgressSnapshot>("agent_progress");
}

export type SubscriptionUsageProvider = "anthropic" | "openai";

export interface SubscriptionUsageWindow {
  kind: "current" | "weekly";
  label: string;
  usedPercent: number;
  /** Unix epoch milliseconds. */
  resetsAt?: number;
}

export interface SubscriptionUsageProviderSnapshot {
  provider: SubscriptionUsageProvider;
  displayName: string;
  connected: boolean;
  windows: SubscriptionUsageWindow[];
  fetchedAt: number;
  error?: string;
}

/** Fetch OAuth subscription quota. Tokens never leave the sidecar. */
export async function getSubscriptionUsage(
  provider: SubscriptionUsageProvider,
): Promise<SubscriptionUsageProviderSnapshot> {
  await waitForReady();
  return invoke<SubscriptionUsageProviderSnapshot>("agent_usage", { provider });
}

/**
 * One piece of an enhanced prompt. A `text` segment is verbatim prose; a `term`
 * segment is a corrected technical term the model swapped in, carrying the
 * user's `original` phrasing (and an optional `note`) so the UI can teach the
 * difference via a tooltip. Mirrors the sidecar's PromptSegment.
 */
export type PromptSegment =
  | { kind: "text"; text: string }
  | { kind: "term"; text: string; original: string; note?: string };

export interface EnhanceResult {
  /** The plain rewritten prompt — exactly what gets sent to the agent. */
  enhanced: string;
  /** The same prompt split into prose + corrected-term segments for the UI. */
  segments: PromptSegment[];
}

/**
 * Rewrite the current draft into a tighter, terminology-correct prompt using
 * the active model. Throws with a user-facing message on failure (the caller
 * surfaces it via toast).
 */
export async function enhancePrompt(text: string): Promise<EnhanceResult> {
  await waitForReady();
  return invoke<EnhanceResult>("agent_enhance_prompt", { text });
}

export async function openProjectPath(path: string, reveal = false): Promise<void> {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Keep the original string if the model emitted a malformed `%` escape.
  }
  try {
    await invoke("open_project_path", { path: decoded, reveal });
  } catch (e) {
    await logError(`open_project_path failed: ${String(e)}`);
  }
}

export interface DroppedPathInfo {
  path: string;
  isDir: boolean;
}

export async function getDroppedPathInfo(paths: string[]): Promise<DroppedPathInfo[]> {
  if (paths.length === 0) return [];
  try {
    return await invoke<DroppedPathInfo[]>("dropped_path_info", { paths });
  } catch (e) {
    await logError(`dropped_path_info failed: ${String(e)}`);
    return paths.map((path) => ({ path, isDir: false }));
  }
}

/** A chat-input attachment (image / video / other file) sent with a prompt. */
export interface Attachment {
  kind: "image" | "video" | "file";
  name: string;
  mediaType: string;
  /** base64 with NO data: prefix. */
  data: string;
}

/** Read a natively-dropped (non-directory) file's bytes as base64, since a
 *  native drag-drop only gives us a path — no browser File object. Returns
 *  null (logging) on failure (e.g. permission denied, file too large) so one
 *  bad file in a multi-file drop doesn't block the rest. */
export async function readDroppedFileAttachment(path: string): Promise<Attachment | null> {
  try {
    const res = await invoke<{ name: string; mediaType: string; data: string }>(
      "read_dropped_file_attachment",
      { path },
    );
    const kind: Attachment["kind"] = res.mediaType.startsWith("image/")
      ? "image"
      : res.mediaType.startsWith("video/")
        ? "video"
        : "file";
    return { kind, name: res.name, mediaType: res.mediaType, data: res.data };
  } catch (e) {
    await logError(`read_dropped_file_attachment failed for ${path}: ${String(e)}`);
    return null;
  }
}

/** Display hints for the user bubble this prompt creates — persisted by the
 *  sidecar so a resumed session re-renders the same bubble (Ken "Sent to GG
 *  Coder" label, enhancer term highlights). */
export interface PromptMeta {
  kenSent?: boolean;
  enhancements?: PromptSegment[];
}

export async function sendPrompt(
  text: string,
  attachments: Attachment[] = [],
  meta?: PromptMeta,
): Promise<void> {
  await logInfo(
    `prompt: ${text.slice(0, 80)}${attachments.length ? ` (+${attachments.length} att)` : ""}`,
  );
  try {
    await invoke("agent_prompt", { text, attachments, meta: meta ?? null });
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

// ── Ken Kai (mentor agent) ──────────────────────────────────
// Ken is a second, read-only agent in this window. The user reaches him with
// `@Ken …`; he reads GG Coder's transcript and hands back runnable prompts +
// blunt mentorship. His replies stream over the SAME SSE channel as GG Coder's
// but with `ken_`-prefixed event types, so the webview routes them to a separate
// magenta bubble:
//   ken_run_start { text }         — Ken started thinking
//   ken_text_delta { text }        — streaming reply text
//   ken_thinking_delta { text }    — streaming reasoning
//   ken_tool_call_start/_update/_end — Ken's read-only tool activity
//   ken_turn_end { … }            — a turn finished
//   ken_run_end { cancelled? }     — Ken finished (or was cancelled)
//   ken_error { message }          — Ken failed
//
// Autopilot Ken (auto-reviewer) is a SEPARATE, non-chatty mode of the same Ken.
// When autopilot is on, after each GG Coder run the sidecar silently drives a
// review→prompt→review loop and emits the `autopilot_*` family (no chat bubble,
// no new IPC — cancel reuses agent_cancel). All ride the same generic
// `agent-event` SSE channel:
//   autopilot_review_start {}       — Ken started an auto-review (spinner)
//   autopilot_prompted { round }    — Ken fed GG Coder another prompt (marker)
//   autopilot_done {}               — Ken gave the all-clear, loop stops
//   autopilot_ignored {}            — nothing worth reviewing, loop stops SILENTLY (no marker)
//   autopilot_human { reason }      — Ken needs a human decision, loop stops
//   autopilot_capped { rounds }     — round cap hit, loop paused
//   autopilot_plan_accepted {}      — Ken approved a submitted plan; broadcast
//                                     BEFORE the session_reset that follows so
//                                     the webview can seed the plan-progress
//                                     widget from the still-open plan modal
//   autopilot_error { headline, … } — a review failed (structured, like error)

/** Ask Ken Kai. Fires the read-only mentor run; reply arrives via `ken_*`
 *  SSE events. Lazily boots Ken's session on first use. */
export async function sendKenPrompt(text: string): Promise<void> {
  await logInfo(`ken prompt: ${text.slice(0, 80)}`);
  try {
    await waitForReady();
    await invoke("agent_ken_prompt", { text });
  } catch (e) {
    await logError(`agent_ken_prompt failed: ${String(e)}`);
    throw e;
  }
}

/** Cancel Ken's in-flight run (does not touch GG Coder's run). */
export async function cancelKen(): Promise<void> {
  try {
    await waitForReady();
    await invoke("agent_ken_cancel");
  } catch (e) {
    await logError(`agent_ken_cancel failed: ${String(e)}`);
  }
}

/** Toggle autopilot (auto-review) for this window's project. Persisted
 *  server-side (~/.gg/gg-app.json, keyed by cwd). Returns the new value. */
export async function setAutopilot(enabled: boolean): Promise<boolean> {
  try {
    await waitForReady();
    const res = await invoke<{ autopilot?: boolean }>("agent_autopilot_set", { enabled });
    return res.autopilot ?? enabled;
  } catch (e) {
    await logError(`agent_autopilot_set failed: ${String(e)}`);
    return enabled;
  }
}

/**
 * Accept the pending plan: bakes its `## Steps` into the agent's system prompt
 * so it emits `[DONE:n]` progress markers as it implements each step (which the
 * activity bar's "Plan Steps n/total" widget reads). Call this BEFORE sending
 * the "implement it now" prompt. `planPath` comes from the `plan_exit` event.
 */
export async function acceptPlan(planPath: string | null): Promise<void> {
  try {
    await invoke("agent_accept_plan", { planPath });
  } catch (e) {
    await logError(`agent_accept_plan failed: ${String(e)}`);
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
  /** True when this user message is a post-compaction summary marker, so the
   *  webview renders the quiet compaction notice instead of the summary body. */
  compacted?: boolean;
  /** Persisted counts for a compacted row's "N → M messages" summary. */
  compactionCounts?: { originalCount: number; newCount: number };
  /** True when this entry is a persisted Ken Kai (mentor) turn: a `user` row is
   *  the `@Ken` question, an `assistant` row is Ken's reply. Rendered in Ken's
   *  color (user bubble tinted, assistant as a Ken bubble) on resume. */
  ken?: boolean;
  /** Present when this entry is a persisted autopilot verdict marker. Rendered
   *  identically to the live `autopilot` item (Ken-tinted bubble), never as
   *  the raw verdict keyword the model replied with (e.g. `ALL_CLEAR`). */
  autopilot?: {
    phase: "prompted" | "done" | "human" | "capped" | "plan_approved";
    reason?: string;
    body?: string;
    /** Stable seed from persisted marker data so resumed all-clear copy doesn't flicker. */
    copySeed?: string;
  };
  /** True when this user prompt came from a Ken "Send to GG Coder" button —
   *  render the shimmering label instead of the prompt body (matches live). */
  kenSent?: boolean;
  /** Enhancer highlight segments, restored for unedited enhanced sends. */
  enhancements?: PromptSegment[];
  /** Plan-mode entry banner (reason), persisted at plan_enter. */
  plan?: { reason: string };
  /** Task header row (title), persisted at task_start. */
  task?: { title: string };
  /** Error row persisted by the sidecar's broadcastError. `scope` selects the
   *  live headline prefix (ken_error → "Ken: ", autopilot_error → "Autopilot: "). */
  error?: { scope: string; headline: string; message?: string; guidance?: string };
  /** Webview-copy info row marker (e.g. the video-capability warning). */
  infoKind?: "video_warning";
  /** Tool-produced images rendered inline (same as live `images` items),
   *  reconstructed from ImageContent blocks in persisted tool results. */
  toolImages?: Array<{ src: string; path?: string }>;
  /** Sub-agent delegation group (same as live `subagent_group` items). */
  subagentGroup?: Array<{
    agentName?: string;
    status: "done" | "error";
    toolUseCount: number;
  }>;
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

/**
 * One API-key option for a provider that splits auth across multiple distinct
 * endpoints/credentials (currently only Xiaomi: Token Plan vs. API Credits).
 */
export interface ApiKeyVariant {
  /** Storage key in auth.json (distinct from the provider `value`). */
  key: string;
  /** Display label, e.g. "Token Plan" or "API Credits". */
  label: string;
  baseUrl?: string;
}

export interface AuthProvider {
  value: string;
  label: string;
  description: string;
  methods: AuthMethod[];
  apiKeyLabel?: string;
  apiKeyBaseUrl?: string;
  /** When set, the API-key flow must ask which variant before submitting. */
  apiKeyVariants?: ApiKeyVariant[];
  /** Live connection status from ~/.gg/auth.json. */
  connected: boolean;
}

/**
 * List providers with their supported auth methods + live connection status.
 *
 * Handled NATIVELY in Rust (static list + reads ~/.gg/auth.json directly) so the
 * login hub always renders even when the Node sidecar is slow/crashed — it used
 * to show a blank list, the same failure mode as the project-folder bug. The
 * login ACTIONS (OAuth, key save, logout) still go through the sidecar.
 */
export async function authStatus(): Promise<AuthProvider[]> {
  try {
    const res = await invoke<{ providers: AuthProvider[] }>("app_auth_status");
    return res.providers ?? [];
  } catch (e) {
    await logError(`app_auth_status failed: ${String(e)}`);
    return [];
  }
}

/**
 * Store an API key for a provider. Handled NATIVELY in Rust (writes ~/.gg/auth.json
 * directly) so it never depends on the per-window sidecar being up — a fresh
 * user's sidecar may not have booted yet, and a sidecar round-trip would hang.
 * Throws with a user-facing message on error.
 */
export async function authApiKey(provider: string, key: string, variant?: string): Promise<void> {
  await invoke("app_auth_apikey", { provider, key, variant });
}

/**
 * Begin an OAuth login; progress arrives via subscribe() auth_* events. Unlike
 * the API-key/logout paths (handled natively in Rust), the OAuth flow is proxied
 * through the per-window Node sidecar, so wait for it to come up first — on the
 * login hub the sidecar may still be booting, and invoking early throws the
 * "sidecar not ready" error users hit when clicking Continue.
 */
export async function authOAuthStart(provider: string): Promise<void> {
  await waitForReady();
  await invoke("agent_auth_oauth_start", { provider });
}

/** Submit a pasted OAuth code to an in-flight login. Sidecar-proxied like start. */
export async function authOAuthCode(code: string): Promise<void> {
  await waitForReady();
  await invoke("agent_auth_oauth_code", { code });
}

/**
 * Disconnect a provider (clear stored credentials). Handled NATIVELY in Rust
 * (removes the provider from ~/.gg/auth.json; moonshot also clears its OAuth
 * key) so it never depends on the sidecar.
 */
export async function authLogout(provider: string): Promise<void> {
  await invoke("app_auth_logout", { provider });
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
  /** Currently-playing station id app-wide, or null when paused. */
  current: string | null;
  volume: number;
}

/** Read app-wide radio state (stations, playback, and volume). */
export async function getRadioState(): Promise<RadioState> {
  try {
    const res = await invoke<RadioState>("agent_radio_state");
    return {
      stations: res.stations ?? [],
      current: res.current ?? null,
      volume: Number.isFinite(res.volume) ? res.volume : 70,
    };
  } catch (e) {
    await logError(`agent_radio_state failed: ${String(e)}`);
    return { stations: [], current: null, volume: 70 };
  }
}

/** Play a station by id, or pause with "off". */
export async function setRadio(station: string): Promise<string | null> {
  const res = await invoke<{ current: string | null }>("agent_radio_set", { station });
  return res.current ?? null;
}

/** Set app-wide radio volume from 0 to 100. */
export async function setRadioVolume(volume: number): Promise<number> {
  const res = await invoke<{ volume: number }>("agent_radio_volume", { volume });
  return Number.isFinite(res.volume) ? res.volume : volume;
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

/** Pin Ken (mentor + autopilot) to a model, or pass null to clear the pin so
 *  he follows GG Coder's model again. Returns his effective model. */
export async function switchKenModel(model: string | null): Promise<SwitchKenModelResult | null> {
  try {
    return await invoke<SwitchKenModelResult>("agent_switch_ken_model", { model });
  } catch (e) {
    await logError(`agent_switch_ken_model failed: ${String(e)}`);
    return null;
  }
}

/** App settings. `configured` is true only when the user explicitly set a
 * projects root (not the default fallback). */
export interface AppSettings {
  projectsRoot: string;
  configured: boolean;
}

/**
 * Read gg-app settings (projects root folder + whether it was explicitly set).
 *
 * Handled NATIVELY in Rust (reads ~/.gg/gg-app.json directly) so the home
 * screen never depends on the Node sidecar being up — a slow/crashed sidecar on
 * a fresh install used to leave "Your Projects" dimmed and saves timing out.
 */
export async function getSettings(): Promise<AppSettings | null> {
  try {
    return await invoke<AppSettings>("app_settings_get");
  } catch (e) {
    await logError(`app_settings_get failed: ${String(e)}`);
    return null;
  }
}

/**
 * Save gg-app settings. Handled NATIVELY in Rust (writes ~/.gg/gg-app.json
 * directly) — no sidecar round-trip, so saving the project folder works even
 * before/while the sidecar is still booting. Throws on a write error.
 */
export async function saveSettings(projectsRoot: string): Promise<void> {
  await invoke("app_settings_save", { projectsRoot });
}

export interface PermissionsStatus {
  /** False on platforms with nothing to grant (Windows/Linux today) — the
   *  caller should hide the permissions row entirely rather than show a
   *  badge for a permission that doesn't exist. */
  applicable: boolean;
  granted: boolean;
}

/**
 * OS permission needed for sub-agents to run without repeat "Allow" prompts:
 * each subagent call spawns a fresh `ggnode` process, and macOS re-triggers
 * its per-folder privacy prompt (Desktop/Documents/Downloads/iCloud) for every
 * newly-spawned binary unless Full Disk Access is granted. Handled NATIVELY in
 * Rust so it works even before the sidecar is up. Falls back to "not
 * applicable" on any failure so the row degrades to hidden, never stuck open.
 */
export async function getPermissionsStatus(): Promise<PermissionsStatus> {
  try {
    return await invoke<PermissionsStatus>("permissions_status");
  } catch (e) {
    await logError(`permissions_status failed: ${String(e)}`);
    return { applicable: false, granted: false };
  }
}

/** Open the OS's permission-grant screen (macOS: System Settings → Privacy &
 *  Security → Full Disk Access). No-op on platforms where it's not applicable. */
export async function openPermissionsSettings(): Promise<void> {
  try {
    await invoke("open_permissions_settings");
  } catch (e) {
    await logError(`open_permissions_settings failed: ${String(e)}`);
  }
}

/**
 * Create a new project folder (lowercase/dashes name) under the configured
 * projects root. Returns the created absolute path. Handled NATIVELY in Rust
 * (no sidecar), so it can't fail with "sidecar not ready". Throws with a
 * user-facing message on invalid name / conflict.
 */
export async function createProject(name: string): Promise<string> {
  const res = await invoke<{ path: string }>("app_create_project", { name });
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

/** A project file surfaced in the chat input's `@` picker. */
export interface FileHit {
  /** Project-relative POSIX path, e.g. "src/App.tsx". */
  path: string;
  /** File name only, e.g. "App.tsx". */
  name: string;
}

/**
 * Search the current project's files for the `@` mention picker. An empty
 * `query` returns the most-recently-modified files; a query returns fuzzy
 * matches. Honors .gitignore and skips node_modules/.git. Capped sidecar-side.
 */
export async function searchFiles(query: string): Promise<FileHit[]> {
  try {
    const res = await invoke<{ files: FileHit[] }>("agent_files", { query });
    return res.files ?? [];
  } catch (e) {
    await logError(`agent_files failed: ${String(e)}`);
    return [];
  }
}

/** List the latest sessions for a project, one chat agent, or every chat agent. */
export async function listSessions(
  cwd: string,
  chatAgent?: ChatAgentId | "all",
): Promise<RecentSession[]> {
  try {
    const res = await invoke<{ sessions: RecentSession[] }>("agent_sessions", {
      cwd,
      chatAgent: chatAgent ?? null,
    });
    return res.sessions ?? [];
  } catch (e) {
    await logError(`agent_sessions failed: ${String(e)}`);
    return [];
  }
}

/**
 * Re-point this window's agent at a workspace: respawns the sidecar at `cwd`,
 * optionally resuming `sessionPath`. The caller re-runs the ready flow after.
 */
export async function selectWorkspace(
  mode: WorkspaceMode,
  cwd: string,
  sessionPath?: string,
  chatAgent: ChatAgentId = "general",
): Promise<void> {
  await invoke("select_project", {
    mode,
    chatAgent,
    cwd,
    sessionPath: sessionPath ?? null,
  });
}

/** Re-point this window at a coding project. */
export async function selectProject(cwd: string, sessionPath?: string): Promise<void> {
  await selectWorkspace("code", cwd, sessionPath);
}

/** The project/session a window was restored to on app boot (workspace restore). */
export interface RestoreTarget {
  mode: WorkspaceMode;
  chatAgent?: ChatAgentId;
  cwd: string;
  sessionPath: string | null;
}

/**
 * If THIS window was reopened from the saved workspace (after a restart/update),
 * return its restore target so the webview can skip the project picker and
 * hydrate straight into the resumed project/session. Returns null for a normal
 * (freshly launched) window. Consume-once: a second call returns null.
 */
export async function restoreTarget(): Promise<RestoreTarget | null> {
  try {
    return await invoke<RestoreTarget | null>("window_restore_target");
  } catch (e) {
    await logError(`window_restore_target failed: ${String(e)}`);
    return null;
  }
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

/** Open the dedicated, screen-centered "What's new" window (or refocus it if it's
 *  already open). Only the main window calls this, exactly once per update — see
 *  WhatsNewTrigger. */
export async function openWhatsNewWindow(): Promise<void> {
  try {
    await invoke("open_whatsnew_window");
  } catch (e) {
    await logError(`open_whatsnew_window failed: ${String(e)}`);
    throw e;
  }
}

// ── Gaze focus (webcam eye/head tracking → window focus) ───────────

/** Payload of the `gaze-target` event broadcast to every window. `target` is the
 *  window the gaze currently rests on (null off any window); `committed` is the
 *  window that currently holds focus. Each window paints a solid ring when it's
 *  `committed`, a soft highlight when it's the (un-committed) `target`. */
export interface GazeTargetEvent {
  target: string | null;
  committed: string | null;
}

/** Map a normalized monitor point to a window. With `commit`, commit OS focus to
 *  the hit window. `committed` is the currently-focused window so the broadcast
 *  border persists. Always broadcasts `gaze-target`. Returns the hit label. */
export async function gazeFocus(
  nx: number,
  ny: number,
  commit: boolean,
  committed: string | null,
): Promise<string | null> {
  try {
    return await invoke<string | null>("gaze_focus", { nx, ny, commit, committed });
  } catch (e) {
    await logError(`gaze_focus failed: ${String(e)}`);
    return null;
  }
}

/** Subscribe THIS window to gaze-target broadcasts. Returns an unlisten fn. */
export async function onGazeTarget(cb: (e: GazeTargetEvent) => void): Promise<() => void> {
  const un = await appWindow.listen<GazeTargetEvent>("gaze-target", (e) => cb(e.payload));
  return un;
}

/** Open a single new project window (Cmd/Ctrl+N). Never re-tiles existing ones. */
export async function newWindow(): Promise<void> {
  try {
    await invoke("new_window");
  } catch (e) {
    await logError(`new_window failed: ${String(e)}`);
    throw e;
  }
}

/**
 * Cycle keyboard focus by `offset` positions (wraps around) through windows in
 * reading order. +1 = forward (Cmd/Ctrl+`), -1 = backward (Cmd/Ctrl+Shift+`).
 * No-op when ≤1 window is open.
 */
export async function focusWindowByOffset(offset: number): Promise<void> {
  try {
    await invoke("focus_window_by_offset", { offset });
  } catch (e) {
    await logError(`focus_window_by_offset failed: ${String(e)}`);
  }
}

/** Re-tile every open window into a clean grid (no create/destroy). */
export async function arrangeAllWindows(): Promise<void> {
  try {
    await invoke("arrange_all");
  } catch (e) {
    await logError(`arrange_all failed: ${String(e)}`);
  }
}

/**
 * Payload of the `window-order` broadcast: window labels in reading order
 * (rows top→bottom, left→right within a row) and the label of the
 * currently-focused window (or null).
 */
export interface WindowOrderEvent {
  order: string[];
  focused: string | null;
}

/** Subscribe THIS window to reading-order broadcasts. Returns an unlisten fn. */
export async function onWindowOrder(cb: (e: WindowOrderEvent) => void): Promise<() => void> {
  const un = await appWindow.listen<WindowOrderEvent>("window-order", (e) => cb(e.payload));
  return un;
}

// ── Telegram serve (remote control via Telegram) ───────────

/** Telegram config status. `configured` is false until a bot token + user id
 *  are saved; `tokenPreview` is a masked hint (never the real token). */
export interface TelegramStatus {
  configured: boolean;
  userId?: number;
  tokenPreview?: string;
}

/** Read the saved Telegram config status (masked). */
export async function getTelegramStatus(): Promise<TelegramStatus> {
  try {
    return await invoke<TelegramStatus>("agent_telegram_get");
  } catch (e) {
    await logError(`agent_telegram_get failed: ${String(e)}`);
    return { configured: false };
  }
}

/**
 * Save Telegram config. Leave `botToken` blank to keep the existing token. The
 * sidecar verifies the token via getMe; throws with a user-facing message on
 * rejection.
 */
export async function saveTelegramConfig(botToken: string, userId: string): Promise<void> {
  await waitForReady();
  await invoke("agent_telegram_save", { botToken, userId });
}

export interface ServeStatus {
  running: boolean;
  configured: boolean;
}

/** Read whether the Telegram serve loop is running + whether it's configured. */
export async function getServeStatus(): Promise<ServeStatus> {
  try {
    return await invoke<ServeStatus>("agent_serve_status");
  } catch (e) {
    await logError(`agent_serve_status failed: ${String(e)}`);
    return { running: false, configured: false };
  }
}

/** Start the Telegram serve loop. Throws with a user-facing message on failure. */
export async function startServe(): Promise<void> {
  await waitForReady();
  await invoke("agent_serve_start");
}

/** Stop the Telegram serve loop. */
export async function stopServe(): Promise<void> {
  await waitForReady();
  await invoke("agent_serve_stop");
}

// ── MCP server management (mirrors `ggcoder mcp`) ────────────

/** One configured MCP server joined with its live connection status. */
export interface McpServerRow {
  name: string;
  scope: "global" | "project";
  ok: boolean;
  toolCount: number;
  error?: string;
  /** "http" for http/sse transports, "stdio" for spawned processes. */
  kind: "stdio" | "http";
  /** Transport summary for display (URL or command+args). */
  summary: string;
  /** True when the server returned 401 and needs an interactive OAuth login. */
  requiresAuth?: boolean;
}

/** Outcome of adding an MCP server from a pasted command line. */
export interface AddMcpResult {
  ok: boolean;
  name: string;
  /** Whether the probe connection succeeded (the config is saved regardless). */
  connected: boolean;
  toolCount: number;
  error?: string;
  /** True when the server needs an interactive OAuth login before it connects. */
  requiresAuth?: boolean;
}

/** List configured MCP servers with live connection status + tool counts.
 *  `cwd` scopes the project servers to a specific project path (global servers
 *  always show); omit for the window's current project. */
export async function listMcpServers(cwd?: string): Promise<McpServerRow[]> {
  try {
    await waitForReady();
    const res = await invoke<{ servers: McpServerRow[] }>("agent_mcp_list", {
      cwd: cwd ?? null,
    });
    return res.servers ?? [];
  } catch (e) {
    await logError(`agent_mcp_list failed: ${String(e)}`);
    return [];
  }
}

/** Add an MCP server from a pasted `claude mcp add …` line. `cwd` is required
 *  for project scope (the target project path). Throws with a user-facing
 *  message on parse/save failure. */
export async function addMcpServer(
  line: string,
  scope: "global" | "project",
  cwd?: string,
): Promise<AddMcpResult> {
  await waitForReady();
  return invoke<AddMcpResult>("agent_mcp_add", { line, scope, cwd: cwd ?? null });
}

/** Begin an interactive OAuth login for a remote (HTTP) MCP server. Returns
 *  immediately; progress + outcome arrive via subscribe() `mcp_auth_*` events.
 *  `cwd` is required for project scope. Throws a user-facing message on failure
 *  to start (e.g. not an HTTP server, server not found). */
export async function loginMcpServer(
  name: string,
  scope: "global" | "project",
  cwd?: string,
): Promise<void> {
  await waitForReady();
  await invoke("agent_mcp_login", { name, scope, cwd: cwd ?? null });
}

/** Remove an MCP server by name. `cwd` is required for project scope. Returns
 *  whether it existed. */
export async function removeMcpServer(
  name: string,
  scope: "global" | "project",
  cwd?: string,
): Promise<{ removed: boolean }> {
  try {
    await waitForReady();
    return await invoke<{ removed: boolean }>("agent_mcp_remove", {
      name,
      scope,
      cwd: cwd ?? null,
    });
  } catch (e) {
    await logError(`agent_mcp_remove failed: ${String(e)}`);
    return { removed: false };
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
