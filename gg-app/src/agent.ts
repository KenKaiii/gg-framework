// Client bridge to the Node agent sidecar — routed entirely through Rust IPC.
// The webview is served from a secure `tauri://` origin, so it cannot fetch the
// sidecar's plain-HTTP endpoints directly (mixed-content). Rust proxies for us:
//   - invoke("agent_state" | "agent_prompt" | "agent_cancel")
//   - listen("agent-event")  ← forwarded SSE frames
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";
import { routePaneEvent, type PaneEventEnvelope } from "./pane-routing";
import {
  isPhaseStartResult,
  isProjectNotesMigrationOutcome,
  isProjectNotesReadOutcome,
  isProjectNotesSaveOutcome,
  isReminderClaimOutcome,
  isReminderReleaseOutcome,
  isReminderReserveOutcome,
  type NotesClient,
  type PhaseStartResult,
} from "./notes-types";
export { isPhaseLaunchErrorEvent } from "./notes-types";
export type { PhaseLaunchErrorEvent, PhaseLaunchErrorCode } from "./notes-types";

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
  token_usage: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  output?: string;
  error?: string;
}

export interface SidecarEvent {
  type: string;
  data: unknown;
}

export {
  isPhaseCompletionCheckpointFailedEvent,
  isPhaseCompletionReviewBlockedEvent,
  isPhaseCompletionReviewFailedEvent,
} from "./phase-completion-events";
export type {
  PhaseCompletionBlockedGateOutcome,
  PhaseCompletionCheckpointFailedEvent,
  PhaseCompletionCheckpointFailedPayload,
  PhaseCompletionCheckpointFailureCode,
  PhaseCompletionReconciliationKind,
  PhaseCompletionReconciliationOwner,
  PhaseCompletionReviewBlockedEvent,
  PhaseCompletionReviewBlockedPayload,
  PhaseCompletionReviewFailedEvent,
  PhaseCompletionReviewFailedPayload,
  PhaseCompletionReviewFailureCode,
  PhaseCompletionSession,
  PhaseCompletionUnmetGateCode,
} from "./phase-completion-events";

export interface LocalPatchedUpdateEvent {
  type: "started" | "line" | "completed" | "error";
  message?: string;
  line?: string;
  stream?: "stdout" | "stderr";
  exitCode?: number | null;
  installerPath?: string | null;
  opened?: "installer" | "folder" | "none";
}

export async function startLocalPatchedUpdate(repoRoot: string): Promise<void> {
  await invoke("app_local_patched_update_start", { repoRoot });
}

export async function listenLocalPatchedUpdate(
  onEvent: (event: LocalPatchedUpdateEvent) => void,
): Promise<() => void> {
  return appWindow.listen<LocalPatchedUpdateEvent>("local-patched-update", (event) => {
    onEvent(event.payload);
  });
}

/** Subscribe this window to a secret-free model-catalog invalidation. */
export async function onModelsChanged(onChange: () => void): Promise<() => void> {
  return appWindow.listen("agent-models-changed", () => onChange());
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

export interface JiwaChangeEvent extends SidecarEvent {
  type: "jiwa_change";
  data: { count: number };
}

export function isJiwaChangeEvent(event: SidecarEvent): event is JiwaChangeEvent {
  return (
    event.type === "jiwa_change" &&
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

export type JiwaCategory =
  | "identity"
  | "voice"
  | "interaction"
  | "boundaries"
  | "workflow"
  | "other";

export interface JiwaEntry {
  id: string;
  text: string;
  category: JiwaCategory;
  importance: number;
  createdAt: string;
  updatedAt: string;
}

export interface JiwaSnapshot {
  jiwa: JiwaEntry[];
  softLimit: number;
  hardLimit: number;
}

export interface AgentState {
  provider: string;
  model: string;
  cwd: string;
  sessionId?: string;
  sessionPath?: string | null;
  mode: WorkspaceMode;
  chatAgent?: ChatAgentId;
  running: boolean;
  runState?: "idle" | "running" | "cancelling";
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
  /** Tracked, staged, and untracked files not yet committed. */
  gitDirtyFileCount?: number;
  /** Open GitHub issues for the project's origin repo, or null when unknown
   *  (gh CLI missing/unauthed, or origin isn't GitHub). Absent on older sidecars. */
  gitHubIssues?: number | null;
  /** Open GitHub pull requests for the project's origin repo (see gitHubIssues). */
  gitHubPRs?: number | null;
  /** Web URL of the project's GitHub origin repo (title-bar chip links). */
  gitHubRepoUrl?: string | null;
  /** Extra workspace roots added with /add-dir. Absent on older sidecars. */
  additionalRoots?: string[];
  /** True when the active model can accept native video input. */
  supportsVideo?: boolean;
  /** Project-wide Autopilot (auto-review) policy shared live by every pane/window
   *  on this canonical project; absent on frames from older sidecars. */
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
    const res = await invoke<{ tasks: ProjectTask[] }>("agent_tasks", { paneId: "primary" });
    return res.tasks ?? [];
  } catch (e) {
    await logError(`agent_tasks failed: ${String(e)}`);
    return [];
  }
}

/** Run a single task end-to-end in its own fresh session. */
export async function runTask(id: string): Promise<void> {
  await invoke("agent_run_tasks", { paneId: "primary", id, all: false });
}

/** Run every pending task sequentially (a fresh session each), in order. */
export async function runAllTasks(): Promise<void> {
  await invoke("agent_run_tasks", { paneId: "primary", id: null, all: true });
}

/** Delete a task by id. Returns the remaining tasks. */
export async function deleteTask(id: string): Promise<ProjectTask[]> {
  try {
    const res = await invoke<{ tasks: ProjectTask[] }>("agent_delete_task", {
      paneId: "primary",
      id,
    });
    return res.tasks ?? [];
  } catch (e) {
    await logError(`agent_delete_task failed: ${String(e)}`);
    return [];
  }
}

export async function listMemories(): Promise<MemorySnapshot> {
  await waitForReady();
  return invoke<MemorySnapshot>("agent_memories", { paneId: "primary" });
}

export async function deleteMemory(id: string): Promise<MemorySnapshot> {
  await waitForReady();
  return invoke<MemorySnapshot>("agent_delete_memory", { paneId: "primary", id });
}

export async function listJiwa(): Promise<JiwaSnapshot> {
  await waitForReady();
  return invoke<JiwaSnapshot>("agent_jiwa", { paneId: "primary" });
}

export async function deleteJiwa(id: string): Promise<JiwaSnapshot> {
  await waitForReady();
  return invoke<JiwaSnapshot>("agent_delete_jiwa", { paneId: "primary", id });
}

export interface ThinkingState {
  thinkingLevel: string | null;
  supportedThinkingLevels: string[];
}

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  /** True for a locally hosted model (Ollama / LM Studio / llama.cpp / vLLM). */
  local?: boolean;
  /** Display name of the local endpoint serving it, e.g. "Ollama". */
  endpoint?: string;
  /** Local models only: false means it can't call tools, so it can't run the agent. */
  supportsTools?: boolean;
  contextWindow?: number;
  /** False when the local server didn't report a real context length (we guessed). */
  contextWindowKnown?: boolean;
  supportsThinking?: boolean;
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

/** Store a session row came from; absent means a native GG Coder session. */
export type SessionSource = "ggcoder" | "claude-code" | "codex";

export interface RecentSession {
  id: string;
  path: string;
  preview: string;
  lastActiveDisplay: string;
  messageCount: number;
  chatAgent?: ChatAgentId;
  /**
   * Absent (or `ggcoder`) means this resumes directly. A foreign value means
   * `path` is that tool's own transcript, imported before it opens.
   */
  source?: SessionSource;
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
  return invoke<AgentState>("agent_state", { paneId: "primary" });
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
  return invoke<ProgressSnapshot>("agent_progress", { paneId: "primary" });
}

export type SubscriptionUsageProvider = "anthropic" | "openai" | "moonshot";

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
  /** True when the sidecar is replaying its last good snapshot because the
   *  provider's quota endpoint is currently failing (usually a 429). */
  stale?: boolean;
}

/** Fetch OAuth subscription quota. Tokens never leave the sidecar. */
export async function getSubscriptionUsage(
  provider: SubscriptionUsageProvider,
): Promise<SubscriptionUsageProviderSnapshot> {
  await waitForReady();
  return invoke<SubscriptionUsageProviderSnapshot>("agent_usage", { paneId: "primary", provider });
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
  return invoke<EnhanceResult>("agent_enhance_prompt", { paneId: "primary", text });
}

export async function openUrl(url: string): Promise<void> {
  try {
    await invoke("open_url", { url });
  } catch (e) {
    await logError(`open_url failed: ${String(e)}`);
  }
}

export async function openProjectPath(path: string): Promise<void> {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Keep the original string if the model emitted a malformed `%` escape.
  }
  try {
    await invoke("open_project_path", { paneId: "primary", path: decoded });
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

/** Authoritative outcome of submitting one prompt to the sidecar. */
export interface PromptSubmissionResult {
  queued: boolean;
  count: number;
}

export function requirePromptSubmissionResult(value: unknown): PromptSubmissionResult {
  if (typeof value !== "object" || value === null) {
    throw new Error("invalid prompt submission response");
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.queued !== "boolean" ||
    typeof result.count !== "number" ||
    !Number.isSafeInteger(result.count) ||
    result.count < 0 ||
    (result.queued ? result.count < 1 : result.count !== 0)
  ) {
    throw new Error("invalid prompt submission response");
  }
  return { queued: result.queued, count: result.count };
}

export async function sendPrompt(
  text: string,
  attachments: Attachment[] = [],
  meta?: PromptMeta,
): Promise<PromptSubmissionResult> {
  await logInfo(
    `prompt: ${text.slice(0, 80)}${attachments.length ? ` (+${attachments.length} att)` : ""}`,
  );
  try {
    const result = await invoke<unknown>("agent_prompt", {
      paneId: "primary",
      text,
      attachments,
      meta: meta ?? null,
    });
    return requirePromptSubmissionResult(result);
  } catch (e) {
    await logError(`agent_prompt failed: ${String(e)}`);
    throw e;
  }
}

export type PhaseCancellationPersistenceOutcome =
  | "committed"
  | "same-status"
  | "manual-override"
  | "done-terminal"
  | "no-active-phase"
  | "phase-not-found"
  | "phase-archived"
  | "stale-session"
  | "missing"
  | "corrupt"
  | "storage-failure"
  | "ignored"
  | "not-pending";

export interface PhaseCancellationPersistenceResult {
  roadmapStatusSaved: boolean;
  roadmapStatusOutcome: PhaseCancellationPersistenceOutcome;
  roadmapStatusRetryable: boolean;
  roadmapStatusFailure?: {
    operationId: string;
    phaseId: string;
    code: string;
    recovery: string;
    detail?: string;
  };
}

export interface CancelResult extends PhaseCancellationPersistenceResult {
  cancelled: boolean;
  runState: "idle" | "running" | "cancelling";
  drained: string;
}

export interface CancelFailure {
  error: "cancel_failed";
  reason?: "timeout";
  runState?: "running" | "cancelling";
  message?: string;
  drained?: string;
}

export class AgentCancelError extends Error {
  constructor(readonly failure: CancelFailure) {
    super(failure.message ?? `Cancellation failed${failure.reason ? `: ${failure.reason}` : ""}.`);
    this.name = "AgentCancelError";
  }
}

export function parseCancelFailure(error: unknown): CancelFailure {
  if (typeof error === "object" && error !== null && "error" in error) {
    return error as CancelFailure;
  }
  const text = String(error);
  try {
    const parsed = JSON.parse(text) as Partial<CancelFailure>;
    if (parsed.error === "cancel_failed") return parsed as CancelFailure;
  } catch {
    // Tauri/native transport failures are not JSON; normalize below.
  }
  return { error: "cancel_failed", message: text };
}

export async function cancel(): Promise<CancelResult> {
  try {
    return await invoke<CancelResult>("agent_cancel", { paneId: "primary" });
  } catch (error) {
    const failure = parseCancelFailure(error);
    await logError(`agent_cancel failed: ${JSON.stringify(failure)}`);
    throw new AgentCancelError(failure);
  }
}

export async function retryCancelledRoadmapStatus(): Promise<PhaseCancellationPersistenceResult> {
  return invoke<PhaseCancellationPersistenceResult>("agent_cancel_roadmap_status_retry", {
    paneId: "primary",
  });
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
// no new IPC — cancel reuses agent_cancel). Completion persistence failures use
// the typed `phase_completion_*` family. All ride the same generic `agent-event`
// SSE channel:
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
//   phase_completion_checkpoint_failed { code, recovery, … } — checkpoint recovery
//   phase_completion_review_failed { code, recovery, … }     — review persistence recovery
//   phase_completion_review_blocked { unmetGateCodes, … }    — unmet completion gates

/** Ask Ken Kai. Fires the read-only mentor run; reply arrives via `ken_*`
 *  SSE events. Lazily boots Ken's session on first use. */
export async function sendKenPrompt(text: string): Promise<void> {
  await logInfo(`ken prompt: ${text.slice(0, 80)}`);
  try {
    await waitForReady();
    await invoke("agent_ken_prompt", { paneId: "primary", text });
  } catch (e) {
    await logError(`agent_ken_prompt failed: ${String(e)}`);
    throw e;
  }
}

/** Cancel Ken's in-flight run (does not touch GG Coder's run). */
export async function cancelKen(): Promise<void> {
  try {
    await waitForReady();
    await invoke("agent_ken_cancel", { paneId: "primary" });
  } catch (e) {
    await logError(`agent_ken_cancel failed: ${String(e)}`);
  }
}

/** Toggle project-wide Autopilot (auto-review). Persisted server-side and fanned
 *  out live to every pane/window on the same canonical project. */
export async function setAutopilot(enabled: boolean): Promise<boolean> {
  try {
    await waitForReady();
    const res = await invoke<{ autopilot?: boolean }>("agent_autopilot_set", {
      paneId: "primary",
      enabled,
    });
    return res.autopilot ?? enabled;
  } catch (e) {
    await logError(`agent_autopilot_set failed: ${String(e)}`);
    throw e;
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
    await invoke("agent_accept_plan", { paneId: "primary", planPath });
  } catch (e) {
    await logError(`agent_accept_plan failed: ${String(e)}`);
    throw e;
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
    const res = await invoke<{ history: HistoryEntry[] }>("agent_history", { paneId: "primary" });
    return res.history ?? [];
  } catch (e) {
    await logError(`agent_history failed: ${String(e)}`);
    return [];
  }
}

// ── Transcript export ──────────────────────────────────────

/** Suggested filename for this session's Markdown export, e.g.
 *  `your-chat-2026-07-26-1402.md`. Fetched before the save dialog opens. */
export async function exportTranscriptName(): Promise<string | null> {
  try {
    await waitForReady();
    const res = await invoke<{ filename: string }>("agent_export_transcript", { path: null });
    return res.filename ?? null;
  } catch (e) {
    await logError(`agent_export_transcript(name) failed: ${String(e)}`);
    return null;
  }
}

/** Write this session's Markdown transcript to `path`. Rust does the fetch and
 *  the write, so the transcript itself never crosses the IPC bridge. Throws
 *  with a user-facing message so the caller can surface it in a toast. */
export async function saveTranscript(path: string): Promise<{ path: string; bytes: number }> {
  await waitForReady();
  return invoke<{ path: string; bytes: number }>("agent_export_transcript", { path });
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
  await invoke("agent_auth_oauth_start", { paneId: "primary", provider });
}

/** Submit a pasted OAuth code to an in-flight login. Sidecar-proxied like start. */
export async function authOAuthCode(code: string): Promise<void> {
  await waitForReady();
  await invoke("agent_auth_oauth_code", { paneId: "primary", code });
}

/** How the user answered an MCP server's request for input. */
export type McpElicitAction = "accept" | "decline" | "cancel";

/**
 * Answer an MCP server's mid-tool-call request for user input (the `mcp_elicit`
 * SSE event). `content` is the filled form and applies only to `accept`.
 *
 * The MCP tool call — and therefore the whole turn — is blocked until this
 * lands, so every dismissal path must call it. The sidecar only auto-cancels
 * after a multi-minute timeout.
 */
export async function mcpElicit(
  id: string,
  action: McpElicitAction,
  content?: Record<string, unknown>,
): Promise<void> {
  await waitForReady();
  await invoke("agent_mcp_elicit", { id, action, content: content ?? null });
}

/**
 * Disconnect a provider (clear stored credentials). Handled NATIVELY in Rust
 * (removes the provider from ~/.gg/auth.json; moonshot also clears its OAuth
 * key) so it never depends on the sidecar.
 */
export async function authLogout(provider: string): Promise<void> {
  await invoke("app_auth_logout", { provider });
}

export type AzureConnectionSource = "secure" | "environment" | "none";
export type AzureConnectionErrorField = "endpoint" | "deployment" | "apiKey";

export interface AzureConnectionStatus {
  configured: boolean;
  source: AzureConnectionSource;
  endpoint: string | null;
  deployment: string | null;
  endpointSummary: string | null;
  deploymentSummary: string | null;
  hasStoredKey: boolean;
}

export interface SaveAzureConnection {
  endpoint: string;
  deployment: string;
  /** Blank preserves the existing operating-system vault entry. */
  apiKey?: string;
}

/** A secret-free, UI-safe Azure command failure. */
export class AzureConnectionCommandError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly field: AzureConnectionErrorField | null = null,
  ) {
    super(message);
    this.name = "AzureConnectionCommandError";
  }
}

const AZURE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  active_runs: "Finish or cancel every active run before changing the Azure connection.",
  access_forbidden: "This API key cannot access the Azure deployment.",
  api_key_required: "Enter an Azure OpenAI API key.",
  azure_unavailable: "Azure is unavailable right now. Try again shortly.",
  connection_remove_recovery_failed:
    "Azure removal could not be completed safely. Reconnect Azure before using it.",
  connection_rollback_failed:
    "The previous Azure credential could not be restored. Reconnect Azure before using it.",
  deployment_not_found: "The endpoint or deployment could not be found.",
  invalid_api_key: "The Azure OpenAI API key is invalid.",
  invalid_deployment: "Enter a valid Azure deployment name.",
  invalid_endpoint: "Enter a valid HTTPS Azure resource endpoint.",
  metadata_remove_failed: "The Azure connection could not be removed. It remains active.",
  metadata_save_failed:
    "The Azure connection could not be saved. The previous connection remains active.",
  metadata_unavailable: "The saved Azure connection details could not be read. Try again.",
  models_refresh_failed:
    "The Azure connection changed, but models did not refresh. Restart gg-app to apply it.",
  models_refresh_unavailable: "Models could not refresh. Try again after the agent is ready.",
  secure_storage_remove_failed:
    "The credential vault rejected removal. The Azure connection remains active.",
  secure_storage_save_failed:
    "The API key could not be saved in the operating-system credential vault.",
  secure_storage_unavailable:
    "The Azure connection could not be read. Unlock the operating-system credential vault and try again.",
  throttled: "Azure rate-limited the validation request. Try again shortly.",
  validation_failed: "Azure could not validate this connection. Check the details and try again.",
  validation_network_error:
    "Azure could not be reached. Check the endpoint and network connection.",
  validation_timeout: "Azure validation timed out. Check the endpoint and try again.",
  validation_unavailable: "Azure validation is unavailable. Try again shortly.",
};

const AZURE_ERROR_FIELDS: Readonly<Partial<Record<string, AzureConnectionErrorField>>> = {
  api_key_required: "apiKey",
  invalid_api_key: "apiKey",
  invalid_deployment: "deployment",
  invalid_endpoint: "endpoint",
};

export function asAzureCommandError(error: unknown, fallback: string): AzureConnectionCommandError {
  let payload: unknown = error;
  if (typeof error === "string" && error.trimStart().startsWith("{")) {
    try {
      payload = JSON.parse(error);
    } catch {
      payload = null;
    }
  }
  if (typeof payload === "object" && payload !== null) {
    const candidate = payload as { code?: unknown; field?: unknown };
    const candidateCode = typeof candidate.code === "string" ? candidate.code : "";
    const code = Object.prototype.hasOwnProperty.call(AZURE_ERROR_MESSAGES, candidateCode)
      ? candidateCode
      : "unknown";
    const expectedField = AZURE_ERROR_FIELDS[code] ?? null;
    const field = candidate.field === expectedField ? expectedField : null;
    return new AzureConnectionCommandError(
      code === "unknown" ? fallback : AZURE_ERROR_MESSAGES[code],
      code,
      field,
    );
  }
  return new AzureConnectionCommandError(fallback, "unknown");
}

export async function getAzureConnectionStatus(): Promise<AzureConnectionStatus> {
  try {
    return await invoke<AzureConnectionStatus>("azure_connection_status");
  } catch (error) {
    throw asAzureCommandError(error, "Azure connection status could not be loaded. Try again.");
  }
}

export async function saveAzureConnection(
  connection: SaveAzureConnection,
): Promise<AzureConnectionStatus> {
  try {
    return await invoke<AzureConnectionStatus>("azure_connection_save", { connection });
  } catch (error) {
    throw asAzureCommandError(error, "The Azure connection could not be saved. Try again.");
  }
}

export async function removeAzureConnection(): Promise<AzureConnectionStatus> {
  try {
    return await invoke<AzureConnectionStatus>("azure_connection_remove");
  } catch (error) {
    throw asAzureCommandError(error, "The Azure connection could not be removed. Try again.");
  }
}

/** Successful fresh-session creation, correlated with its reset event. */
export interface NewSessionResult {
  operationId: string;
}

export type NewSessionFailureKind = "creation-rejected" | "outcome-unknown";

/** Typed distinction between an HTTP rejection and an indeterminate transport outcome. */
export class NewSessionError extends Error {
  constructor(
    readonly kind: NewSessionFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "NewSessionError";
  }
}

function asNewSessionError(error: unknown): NewSessionError {
  let candidate: unknown = error;
  if (typeof error === "string") {
    try {
      candidate = JSON.parse(error);
    } catch {
      candidate = null;
    }
  }
  if (typeof candidate === "object" && candidate !== null) {
    const value = candidate as { kind?: unknown; message?: unknown; status?: unknown };
    if (
      (value.kind === "creation-rejected" || value.kind === "outcome-unknown") &&
      typeof value.message === "string"
    ) {
      return new NewSessionError(
        value.kind,
        value.message,
        typeof value.status === "number" ? value.status : undefined,
      );
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new NewSessionError("outcome-unknown", message);
}

function requireNewSessionResult(value: unknown): NewSessionResult {
  const operationId =
    typeof value === "object" && value !== null
      ? (value as { operationId?: unknown }).operationId
      : undefined;
  if (typeof operationId !== "string" || operationId.length === 0) {
    throw new Error("invalid new-session response: missing operationId");
  }
  return { operationId };
}

/** Start a fresh session (clears history) for this window's current project. */
export async function newSession(): Promise<NewSessionResult> {
  try {
    return requireNewSessionResult(
      await invoke<NewSessionResult>("agent_new_session", { paneId: "primary" }),
    );
  } catch (e) {
    await logError(`agent_new_session failed: ${String(e)}`);
    throw asNewSessionError(e);
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
    const res = await invoke<RadioState>("agent_radio_state", { paneId: "primary" });
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
  const res = await invoke<{ current: string | null }>("agent_radio_set", {
    paneId: "primary",
    station,
  });
  return res.current ?? null;
}

/** Set app-wide radio volume from 0 to 100. */
export async function setRadioVolume(volume: number): Promise<number> {
  const res = await invoke<{ volume: number }>("agent_radio_volume", { paneId: "primary", volume });
  return Number.isFinite(res.volume) ? res.volume : volume;
}

/** One user message waiting to be injected into the running turn. */
export interface QueuedMessage {
  id: string;
  text: string;
}

/**
 * Cancel one pending queued message by id.
 *
 * Returns the remaining queue, or null if the call itself failed. A `cancelled:
 * false` from the sidecar is NOT a failure: it means the agent consumed the
 * message between the row rendering and the click landing, so the caller should
 * simply reconcile to the returned list.
 */
export async function cancelQueued(id: string): Promise<QueuedMessage[] | null> {
  try {
    const res = await invoke<{ cancelled?: boolean; queued?: QueuedMessage[] }>(
      "agent_cancel_queued",
      { id },
    );
    return res.queued ?? [];
  } catch (e) {
    await logError(`agent_cancel_queued failed: ${String(e)}`);
    return null;
  }
}

/** Stop a background task by id. Returns the sidecar's status message, if any. */
export async function killTask(id: string): Promise<string | null> {
  try {
    const res = await invoke<{ message?: string }>("agent_kill_task", { paneId: "primary", id });
    return res.message ?? null;
  } catch (e) {
    await logError(`agent_kill_task failed: ${String(e)}`);
    return null;
  }
}

/** Result of importing a foreign coding-agent transcript. */
export type ImportTranscriptResult =
  | {
      ok: true;
      sessionId: string;
      sessionPath: string;
      cwd: string;
      format: "claude" | "codex" | "cursor";
      messageCount: number;
      /** Human-readable summary of what the lossy import discarded. */
      dropped: string;
      preview?: string;
    }
  | { ok: false; error: string };

/** Import a foreign coding-agent transcript as a resumable session. */
export async function importTranscript(
  path: string,
  cwd?: string,
): Promise<ImportTranscriptResult> {
  try {
    return await invoke<ImportTranscriptResult>("agent_import_transcript", { path, cwd });
  } catch (error) {
    await logError(`agent_import_transcript failed: ${String(error)}`);
    return { ok: false, error: String(error) };
  }
}
/** Cycle the reasoning/thinking level to the next supported value (or off). */
export async function cycleThinking(): Promise<ThinkingState | null> {
  try {
    return await invoke<ThinkingState>("agent_cycle_thinking", { paneId: "primary" });
  } catch (e) {
    await logError(`agent_cycle_thinking failed: ${String(e)}`);
    return null;
  }
}

/** List workflow (prompt-template) slash commands the agent can run. */
export async function listCommands(): Promise<SlashCommand[]> {
  try {
    const res = await invoke<{ commands: SlashCommand[] }>("agent_commands", { paneId: "primary" });
    return res.commands ?? [];
  } catch (e) {
    await logError(`agent_commands failed: ${String(e)}`);
    return [];
  }
}

/**
 * List models available to the logged-in providers, or `null` when the fetch
 * itself failed.
 *
 * The distinction matters: an empty array is a real answer (every provider was
 * disconnected) and must clear the picker, whereas a failed IPC call must leave
 * the previous list alone. Collapsing both to `[]` meant callers had to guard
 * with `length > 0`, which made disconnecting your last provider leave a picker
 * full of models you can no longer authenticate against.
 */
export async function listModels(): Promise<ModelOption[] | null> {
  try {
    const res = await invoke<{ models: ModelOption[] }>("agent_models", { paneId: "primary" });
    return res.models ?? [];
  } catch (e) {
    await logError(`agent_models failed: ${String(e)}`);
    return null;
  }
}

/**
 * Switch the active model by id. Returns the new provider/model + thinking
 * state, or `{ error }` when the switch was refused.
 *
 * A refusal is a message worth showing, not just logging: the sidecar
 * deliberately explains *why* ("Ollama isn't running at …", "has no tool
 * calling, so it can't run the agent"), and it arrives in the response body
 * rather than as a thrown IPC error — so unpack it here and let the caller
 * surface it.
 */
export async function switchModel(model: string): Promise<SwitchModelResult | { error: string }> {
  try {
    const response = await invoke<SwitchModelResult & { error?: string }>("agent_switch_model", {
      paneId: "primary",
      model,
    });
    if (response.error) {
      await logError(`agent_switch_model refused: ${response.error}`);
      return { error: response.error };
    }
    return response;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logError(`agent_switch_model failed: ${message}`);
    return { error: message };
  }
}

/** Narrow a {@link switchModel} result to the refusal case. */
export function isSwitchModelError(
  result: SwitchModelResult | { error: string },
): result is { error: string } {
  return "error" in result;
}

/** Pin Ken (mentor + autopilot) to a model, or pass null to clear the pin so
 *  he follows GG Coder's model again. Returns his effective model. */
export async function switchKenModel(model: string | null): Promise<SwitchKenModelResult | null> {
  try {
    return await invoke<SwitchKenModelResult>("agent_switch_ken_model", {
      paneId: "primary",
      model,
    });
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
    const res = await invoke<{ projects: DiscoveredProject[] }>("agent_projects", {
      paneId: "primary",
    });
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
    const res = await invoke<{ files: FileHit[] }>("agent_files", { paneId: "primary", query });
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
      paneId: "primary",
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
    paneId: "primary",
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

/** The active project/session Rust can restore into this webview. */
export interface RestoreTarget {
  mode: WorkspaceMode;
  chatAgent?: ChatAgentId;
  cwd: string;
  sessionPath: string | null;
}

export interface PaneCopyResult {
  windowLabel: string;
  reusedWindow: boolean;
}

interface PreparedPaneCopy extends PaneCopyResult {
  copyId: string;
}

export class PaneCopyError extends Error {
  constructor(
    message: string,
    /** null when preparation failed before there was anything to roll back. */
    readonly rollbackSucceeded: boolean | null,
  ) {
    super(message);
    this.name = "PaneCopyError";
  }
}

/**
 * Copy one pane into a new native window without changing its source ownership.
 * Rust derives the source owner from this webview, reserves the destination,
 * starts a separate daemon session, and rolls the reservation back on failure.
 */
export async function copyPaneToNewWindow(paneId: string): Promise<PaneCopyResult> {
  const copyId =
    globalThis.crypto?.randomUUID?.() ??
    `copy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let prepared: PreparedPaneCopy | null = null;
  try {
    prepared = await invoke<PreparedPaneCopy>("agent_pane_copy", { paneId, copyId });
    return await invoke<PaneCopyResult>("agent_pane_copy_startup", { copyId });
  } catch (error) {
    let rollbackSucceeded: boolean | null = null;
    if (prepared) {
      try {
        await invoke("agent_pane_copy_rollback", { copyId });
        rollbackSucceeded = true;
      } catch (rollbackError) {
        await logError(`agent_pane_copy_rollback failed: ${String(rollbackError)}`);
      }
    }
    const suffix = rollbackSucceeded ? "" : " (rollback also failed)";
    throw new PaneCopyError(`${String(error)}${suffix}`, rollbackSucceeded);
  }
}

/** Consume the startup target only when this is an extracted-pane window. */
export async function copiedPaneRestoreTarget(): Promise<RestoreTarget | null> {
  try {
    return await invoke<RestoreTarget | null>("agent_pane_copy_restore");
  } catch (error) {
    await logError(`agent_pane_copy_restore failed: ${String(error)}`);
    return null;
  }
}

/**
 * Return THIS window's active workspace target so the webview can skip Home and
 * hydrate its existing daemon session. Rust retains the target for the window's
 * lifetime, allowing repeated calls after React or WebKit content-process reloads.
 * Returns null only while this is a fresh picker-only window.
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

// ── macOS menu-bar tray ────────────────────────────────────────────────────

/** An action picked from the macOS menu-bar menu. */
export type TrayIntent = "update" | "new-chat" | "new-code" | "remote" | "settings";

/**
 * Subscribe THIS window to tray actions routed to it. Returns an unlisten fn.
 * Used when the tray reuses an already-open window.
 */
export async function onTrayIntent(cb: (intent: TrayIntent) => void): Promise<() => void> {
  return await appWindow.listen<TrayIntent>("tray-intent", (e) => cb(e.payload));
}

/**
 * Claim (once) the tray action THIS window was opened for, or null when the user
 * opened it themselves. A window built by the tray isn't listening yet when the
 * menu is clicked, so Rust parks the intent and the webview claims it on mount.
 */
export async function takeTrayIntent(): Promise<TrayIntent | null> {
  try {
    return await invoke<TrayIntent | null>("window_tray_intent");
  } catch (e) {
    await logError(`window_tray_intent failed: ${String(e)}`);
    return null;
  }
}

/**
 * Tell the tray whether an app update is pending, so "Update now" appears in the
 * menu-bar menu (and disappears again when up to date). `null` = up to date.
 */
export async function setUpdateAvailable(version: string | null): Promise<void> {
  try {
    await invoke("set_update_available", { version });
  } catch (e) {
    await logError(`set_update_available failed: ${String(e)}`);
  }
}

/**
 * Tell the tray whether Remote (the Telegram serve loop) is running, so its menu
 * item reads "Remote" or "Remote · Turn off".
 */
export async function setRemoteActive(active: boolean): Promise<void> {
  try {
    await invoke("set_remote_active", { active });
  } catch (e) {
    await logError(`set_remote_active failed: ${String(e)}`);
  }
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

// ── Local models (Ollama / LM Studio / llama.cpp / vLLM) ──

/** One model as reported by a local server, with its probed capabilities. */
export interface LocalModelRow {
  /** Full registry id (`local/<endpoint>/<rawId>`) — what `switchModel` takes. */
  id: string;
  /** Id on the wire, as the server names it. */
  rawId: string;
  contextWindow: number;
  contextWindowKnown: boolean;
  supportsTools: boolean;
  supportsImages: boolean;
  supportsThinking: boolean;
  /** LM Studio only: whether the model is currently loaded in memory. */
  loaded?: boolean;
}

export interface LocalEndpointRow {
  id: string;
  label: string;
  baseUrl: string;
  kind: "ollama" | "lmstudio" | "llamacpp" | "vllm" | "custom";
  /** User-added endpoints can be removed; built-in ones can't. */
  custom: boolean;
  reachable: boolean;
  /** Why it's unreachable, e.g. "Not running at http://127.0.0.1:11434/v1". */
  reason?: string;
  models: LocalModelRow[];
}

export interface LocalModelsState {
  endpoints: LocalEndpointRow[];
}

/**
 * The Rust proxies pass the sidecar's response body through verbatim, so a
 * validation failure arrives as `{ error }` with no thrown exception. Turn it
 * into a real error here — once — so every caller can just try/catch.
 */
function unwrapLocalState(res: LocalModelsState & { error?: string }): LocalModelsState {
  if (res.error) throw new Error(res.error);
  return { endpoints: res.endpoints ?? [] };
}

/** Last scan's endpoints + models. Cheap — does not probe. */
export async function getLocalModels(): Promise<LocalModelsState> {
  try {
    await waitForReady();
    const res = await invoke<LocalModelsState>("agent_local");
    return unwrapLocalState(res);
  } catch (e) {
    await logError(`agent_local failed: ${String(e)}`);
    return { endpoints: [] };
  }
}

/** Re-probe every local endpoint. Throws with a user-facing message on failure. */
export async function scanLocalModels(): Promise<LocalModelsState> {
  await waitForReady();
  const res = await invoke<LocalModelsState>("agent_local_scan");
  return unwrapLocalState(res);
}

/** Add a custom endpoint, then re-scan. Throws the validation message on a bad URL. */
export async function addLocalEndpoint(
  baseUrl: string,
  label?: string,
  apiKey?: string,
): Promise<LocalModelsState> {
  await waitForReady();
  const res = await invoke<LocalModelsState>("agent_local_endpoint_add", {
    baseUrl,
    label: label ?? null,
    apiKey: apiKey ?? null,
  });
  return unwrapLocalState(res);
}

/** Remove a custom endpoint (and its stored credential), then re-scan. */
export async function removeLocalEndpoint(id: string): Promise<LocalModelsState> {
  await waitForReady();
  const res = await invoke<LocalModelsState>("agent_local_endpoint_remove", { id });
  return unwrapLocalState(res);
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
    return await invoke<TelegramStatus>("agent_telegram_get", { paneId: "primary" });
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
  await invoke("agent_telegram_save", { paneId: "primary", botToken, userId });
}

export interface ServeStatus {
  running: boolean;
  configured: boolean;
}

/** Read whether the Telegram serve loop is running + whether it's configured. */
export async function getServeStatus(): Promise<ServeStatus> {
  try {
    return await invoke<ServeStatus>("agent_serve_status", { paneId: "primary" });
  } catch (e) {
    await logError(`agent_serve_status failed: ${String(e)}`);
    return { running: false, configured: false };
  }
}

/** Start the Telegram serve loop. Throws with a user-facing message on failure. */
export async function startServe(): Promise<void> {
  await waitForReady();
  await invoke("agent_serve_start", { paneId: "primary" });
}

/** Stop the Telegram serve loop. */
export async function stopServe(): Promise<void> {
  await waitForReady();
  await invoke("agent_serve_stop", { paneId: "primary" });
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
      paneId: "primary",
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
  return invoke<AddMcpResult>("agent_mcp_add", {
    paneId: "primary",
    line,
    scope,
    cwd: cwd ?? null,
  });
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
  await invoke("agent_mcp_login", { paneId: "primary", name, scope, cwd: cwd ?? null });
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
      paneId: "primary",
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
const paneEnvelopeSubscribers = new Set<(e: PaneEventEnvelope) => void>();
let tauriListenerStarted = false;

function ensureTauriListener(): void {
  if (tauriListenerStarted) return;
  tauriListenerStarted = true;
  void appWindow.listen<PaneEventEnvelope>("agent-event", (e) => {
    const envelope = e.payload;
    for (const fn of paneEnvelopeSubscribers) fn(envelope);
    const primary = routePaneEvent(envelope, [{ paneId: "primary" }]);
    if (primary)
      for (const fn of localSubscribers) fn({ type: envelope.type, data: envelope.data });
  });
}

function subscribePaneEnvelope(onEvent: (e: PaneEventEnvelope) => void): () => void {
  ensureTauriListener();
  paneEnvelopeSubscribers.add(onEvent);
  return () => paneEnvelopeSubscribers.delete(onEvent);
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

export interface PaneStartupStatus {
  ready: boolean;
  error: string | null;
  generation: number;
  sessionId: string | null;
}

interface PaneLifecycleEvent {
  paneId: string;
  generation: number;
  error?: string;
}

/** Wait for one logical pane. Listeners are installed before the first status
 * read, and polling remains active until settlement so status/event races close. */
export async function waitForPaneReady(paneId: string = "primary"): Promise<PaneStartupStatus> {
  return new Promise<PaneStartupStatus>((resolve, reject) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => fail(`pane '${paneId}' did not start in time`), 30000);
    const unlisteners: Array<() => void> = [];

    const cleanup = (): void => {
      if (poll) clearInterval(poll);
      if (timeout) clearTimeout(timeout);
      for (const unlisten of unlisteners.splice(0)) unlisten();
    };
    const succeed = (status: PaneStartupStatus): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(status);
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const readStatus = async (): Promise<void> => {
      try {
        const status = await invoke<PaneStartupStatus>("agent_pane_status", { paneId });
        if (settled) return;
        if (status.error) fail(`pane '${paneId}' failed to start: ${status.error}`);
        else if (status.ready) succeed(status);
      } catch {
        // A pane may not be registered yet. Persistent polling observes it later.
      }
    };
    const install = async <T>(name: string, handler: (payload: T) => void): Promise<void> => {
      try {
        const unlisten = await appWindow.listen<T>(name, (event) => handler(event.payload));
        if (settled) unlisten();
        else unlisteners.push(unlisten);
      } catch (error) {
        fail(`failed to listen for pane '${paneId}' readiness: ${String(error)}`);
      }
    };

    void Promise.all([
      install<PaneLifecycleEvent>("agent-pane-ready", (event) => {
        if (event.paneId === paneId) void readStatus();
      }),
      install<PaneLifecycleEvent>("agent-pane-error", (event) => {
        if (event.paneId === paneId)
          fail(`pane '${paneId}' failed to start: ${event.error ?? "unknown error"}`);
      }),
      install<string>("sidecar-error", (message) => fail(`agent daemon failed: ${message}`)),
    ]).then(() => {
      if (settled) return;
      void readStatus();
      poll = setInterval(() => void readStatus(), 500);
    });
  });
}

/** Preserve the existing primary-pane readiness API. */
export async function waitForReady(): Promise<void> {
  await waitForPaneReady("primary");
}

/** Inputs shared by pane creation/restoration and workspace selection. */
export interface PaneSessionTarget {
  mode: WorkspaceMode;
  cwd: string;
  sessionPath?: string | null;
  chatAgent?: ChatAgentId;
}

/** Dispose a pane without requiring the caller to retain its generation. */
export function disposePaneSession(paneId: string, generation?: number): Promise<void> {
  return invoke("agent_pane_dispose", { paneId, generation: generation ?? null });
}

export interface PaneAgentClient extends NotesClient {
  readonly paneId: string;
  status(): Promise<PaneStartupStatus>;
  waitForReady(): Promise<PaneStartupStatus>;
  create(target: PaneSessionTarget): Promise<number>;
  restore(target: PaneSessionTarget): Promise<number>;
  dispose(generation: number): Promise<void>;
  selectWorkspace(target: PaneSessionTarget, expectedGeneration: number): Promise<number>;
  subscribe(onEvent: (event: SidecarEvent) => void): () => void;
  getState(): Promise<AgentState>;
  startPhase(phaseId: string): Promise<PhaseStartResult>;
  listMemories(): Promise<MemorySnapshot>;
  deleteMemory(id: string): Promise<MemorySnapshot>;
  listJiwa(): Promise<JiwaSnapshot>;
  deleteJiwa(id: string): Promise<JiwaSnapshot>;
  getProgress(): Promise<ProgressSnapshot>;
  getSubscriptionUsage(
    provider: SubscriptionUsageProvider,
  ): Promise<SubscriptionUsageProviderSnapshot>;
  enhancePrompt(text: string): Promise<EnhanceResult>;
  sendPrompt(
    text: string,
    attachments?: Attachment[],
    meta?: PromptMeta,
  ): Promise<PromptSubmissionResult>;
  cancel(): Promise<CancelResult>;
  retryCancelledRoadmapStatus(): Promise<PhaseCancellationPersistenceResult>;
  sendKenPrompt(text: string): Promise<void>;
  cancelKen(): Promise<void>;
  setAutopilot(enabled: boolean): Promise<boolean>;
  acceptPlan(planPath: string | null): Promise<void>;
  listHistory(): Promise<HistoryEntry[]>;
  cancelQueued(id: string): Promise<QueuedMessage[] | null>;
  exportTranscriptName(): Promise<string | null>;
  saveTranscript(path: string): Promise<{ path: string; bytes: number }>;
  authOAuthStart(provider: string): Promise<void>;
  authOAuthCode(code: string): Promise<void>;
  newSession(): Promise<NewSessionResult>;
  getRadioState(): Promise<RadioState>;
  setRadio(station: string): Promise<string | null>;
  setRadioVolume(volume: number): Promise<number>;
  listTasks(): Promise<ProjectTask[]>;
  runTask(id: string): Promise<void>;
  runAllTasks(): Promise<void>;
  deleteTask(id: string): Promise<ProjectTask[]>;
  killTask(id: string): Promise<string | null>;
  cycleThinking(): Promise<ThinkingState | null>;
  listCommands(): Promise<SlashCommand[]>;
  listModels(): Promise<ModelOption[]>;
  switchModel(model: string): Promise<SwitchModelResult | { error: string }>;
  switchKenModel(model: string | null): Promise<SwitchKenModelResult | null>;
  getSettings(): Promise<AppSettings | null>;
  saveSettings(projectsRoot: string): Promise<void>;
  listProjects(): Promise<DiscoveredProject[]>;
  searchFiles(query: string): Promise<FileHit[]>;
  listSessions(cwd: string, chatAgent?: ChatAgentId | "all"): Promise<RecentSession[]>;
  getTelegramStatus(): Promise<TelegramStatus>;
  saveTelegramConfig(botToken: string, userId: string): Promise<void>;
  getServeStatus(): Promise<ServeStatus>;
  startServe(): Promise<void>;
  stopServe(): Promise<void>;
  listMcpServers(cwd?: string): Promise<McpServerRow[]>;
  addMcpServer(line: string, scope: "global" | "project", cwd?: string): Promise<AddMcpResult>;
  loginMcpServer(name: string, scope: "global" | "project", cwd?: string): Promise<void>;
  removeMcpServer(
    name: string,
    scope: "global" | "project",
    cwd?: string,
  ): Promise<{ removed: boolean }>;
}

/** Primary compatibility client for legacy children/tests during the pane extraction. */
export const primaryPaneAgentClient: PaneAgentClient = new Proxy(
  { paneId: "primary" } as PaneAgentClient,
  {
    get(_target, property) {
      return createPaneAgentClient("primary")[property as keyof PaneAgentClient];
    },
  },
);

/** Current-v2 pane-scoped bridge. Compatibility exports above remain primary-only. */
export function createPaneAgentClient(paneId: string): PaneAgentClient {
  const call = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> =>
    invoke<T>(command, { paneId, ...args });
  const ready = (): Promise<PaneStartupStatus> => waitForPaneReady(paneId);
  const targetArgs = (target: PaneSessionTarget) => ({
    mode: target.mode,
    chatAgent: target.chatAgent ?? "general",
    cwd: target.cwd,
    sessionPath: target.sessionPath ?? null,
  });
  const safeArray = async <T>(
    command: string,
    key: string,
    args: Record<string, unknown> = {},
  ): Promise<T[]> => {
    try {
      return (await call<Record<string, T[]>>(command, args))[key] ?? [];
    } catch (e) {
      await logError(`${command} failed: ${String(e)}`);
      return [];
    }
  };

  return {
    paneId,
    status: () => call("agent_pane_status"),
    waitForReady: ready,
    create: (target) => call("agent_pane_create", targetArgs(target)),
    restore: (target) => call("agent_pane_restore", targetArgs(target)),
    dispose: (generation) => call("agent_pane_dispose", { generation }),
    async selectWorkspace(target, expectedGeneration) {
      try {
        const status = await call<PaneStartupStatus>("agent_pane_status");
        return call("select_project", {
          ...targetArgs(target),
          expectedGeneration: expectedGeneration > 0 ? expectedGeneration : status.generation,
        });
      } catch {
        // A brand-new auxiliary pane has no native registry entry until its first
        // target is chosen. Create it instead of trying to replace it.
        return call("agent_pane_create", targetArgs(target));
      }
    },
    subscribe(onEvent) {
      let activeSessionId: string | null = null;
      let generation: number | null = null;
      let identityResolved = false;
      let disposed = false;
      let refreshEpoch = 0;
      const pendingEnvelopes: PaneEventEnvelope[] = [];
      const deliverPending = (): void => {
        if (disposed || !identityResolved) return;
        const envelopes = pendingEnvelopes.splice(0);
        for (const event of envelopes) {
          if (disposed) return;
          if (event.sessionId === activeSessionId) {
            onEvent({ type: event.type, data: event.data });
          }
        }
      };
      const refresh = async (): Promise<void> => {
        const epoch = ++refreshEpoch;
        identityResolved = false;
        let nextSessionId: string | null = null;
        let nextGeneration: number | null = null;
        try {
          const status = await call<PaneStartupStatus>("agent_pane_status");
          nextSessionId = status.sessionId;
          nextGeneration = status.generation;
        } catch {
          // Retry a failed lookup when the next tagged envelope arrives.
        }
        if (disposed || epoch !== refreshEpoch) return;
        activeSessionId = nextSessionId;
        generation = nextGeneration;
        identityResolved = true;
        deliverPending();
      };
      const unlisten = subscribePaneEnvelope((event) => {
        if (disposed || event.paneId !== paneId) return;
        pendingEnvelopes.push(event);
        if (!identityResolved) return;
        if (event.sessionId === activeSessionId) {
          deliverPending();
        } else {
          void refresh();
        }
      });
      const unlistenReadyPromise = appWindow.listen<PaneLifecycleEvent>(
        "agent-pane-ready",
        (event) => {
          if (event.payload.paneId === paneId && event.payload.generation !== generation)
            void refresh();
        },
      );
      void refresh();
      return () => {
        disposed = true;
        refreshEpoch += 1;
        pendingEnvelopes.length = 0;
        unlisten();
        void unlistenReadyPromise.then((unlistenReady) => unlistenReady());
      };
    },
    getState: () => call("agent_state"),
    async getNotes() {
      const outcome = await call<unknown>("agent_notes_get");
      if (!isProjectNotesReadOutcome(outcome)) throw new Error("invalid Notes read response");
      return outcome;
    },
    async migrateNotes(document) {
      const outcome = await call<unknown>("agent_notes_migrate", { document });
      if (!isProjectNotesMigrationOutcome(outcome)) {
        throw new Error("invalid Notes migration response");
      }
      return outcome;
    },
    async saveNotes(expectedRevision, document) {
      const outcome = await call<unknown>("agent_notes_save", { expectedRevision, document });
      if (!isProjectNotesSaveOutcome(outcome)) throw new Error("invalid Notes save response");
      return outcome;
    },
    async reserveReminder(focused) {
      const outcome = await call<unknown>("agent_reminder_reserve", { focused });
      if (!isReminderReserveOutcome(outcome)) {
        throw new Error("invalid reminder reserve response");
      }
      return outcome;
    },
    async claimReminder(leaseToken, channel, permission) {
      const outcome = await call<unknown>("agent_reminder_claim", {
        leaseToken,
        channel,
        permission,
      });
      if (!isReminderClaimOutcome(outcome)) {
        throw new Error("invalid reminder claim response");
      }
      return outcome;
    },
    async releaseReminder(leaseToken) {
      const outcome = await call<unknown>("agent_reminder_release", { leaseToken });
      if (!isReminderReleaseOutcome(outcome)) {
        throw new Error("invalid reminder release response");
      }
      return outcome;
    },
    async startPhase(phaseId) {
      const outcome = await call<unknown>("agent_phase_start", { phaseId });
      if (!isPhaseStartResult(outcome)) throw new Error("invalid phase start response");
      return outcome;
    },
    listMemories: async () => {
      await ready();
      return call("agent_memories");
    },
    deleteMemory: async (id) => {
      await ready();
      return call("agent_delete_memory", { id });
    },
    listJiwa: async () => {
      await ready();
      return call("agent_jiwa");
    },
    deleteJiwa: async (id) => {
      await ready();
      return call("agent_delete_jiwa", { id });
    },
    getProgress: async () => {
      await ready();
      return call("agent_progress");
    },
    getSubscriptionUsage: async (provider) => {
      await ready();
      return call("agent_usage", { provider });
    },
    enhancePrompt: async (text) => {
      await ready();
      return call("agent_enhance_prompt", { text });
    },
    sendPrompt: async (text, attachments = [], meta) =>
      requirePromptSubmissionResult(
        await call<unknown>("agent_prompt", { text, attachments, meta: meta ?? null }),
      ),
    async cancel() {
      try {
        return await call<CancelResult>("agent_cancel");
      } catch (e) {
        throw new AgentCancelError(parseCancelFailure(e));
      }
    },
    retryCancelledRoadmapStatus: () =>
      call<PhaseCancellationPersistenceResult>("agent_cancel_roadmap_status_retry"),
    sendKenPrompt: async (text) => {
      await ready();
      await call("agent_ken_prompt", { text });
    },
    cancelKen: async () => {
      await ready();
      await call("agent_ken_cancel");
    },
    async setAutopilot(enabled) {
      await ready();
      try {
        return (
          (await call<{ autopilot?: boolean }>("agent_autopilot_set", { enabled })).autopilot ??
          enabled
        );
      } catch (error) {
        await logError(`agent_autopilot_set failed: ${String(error)}`);
        throw error;
      }
    },
    acceptPlan: (planPath) => call("agent_accept_plan", { planPath }),
    listHistory: () => safeArray("agent_history", "history"),
    async cancelQueued(id) {
      try {
        const response = await call<{ queued?: QueuedMessage[] }>("agent_cancel_queued", { id });
        return response.queued ?? [];
      } catch {
        return null;
      }
    },
    async exportTranscriptName() {
      try {
        await ready();
        const response = await call<{ filename?: string }>("agent_export_transcript", {
          path: null,
        });
        return response.filename ?? null;
      } catch {
        return null;
      }
    },
    async saveTranscript(path) {
      await ready();
      return call("agent_export_transcript", { path });
    },
    authOAuthStart: async (provider) => {
      await ready();
      await call("agent_auth_oauth_start", { provider });
    },
    authOAuthCode: async (code) => {
      await ready();
      await call("agent_auth_oauth_code", { code });
    },
    async newSession() {
      try {
        return requireNewSessionResult(await call("agent_new_session"));
      } catch (error) {
        throw asNewSessionError(error);
      }
    },
    async getRadioState() {
      try {
        const r = await call<RadioState>("agent_radio_state");
        return {
          stations: r.stations ?? [],
          current: r.current ?? null,
          volume: Number.isFinite(r.volume) ? r.volume : 70,
        };
      } catch {
        return { stations: [], current: null, volume: 70 };
      }
    },
    async setRadio(station) {
      return (
        (await call<{ current: string | null }>("agent_radio_set", { station })).current ?? null
      );
    },
    async setRadioVolume(volume) {
      const r = await call<{ volume: number }>("agent_radio_volume", { volume });
      return Number.isFinite(r.volume) ? r.volume : volume;
    },
    listTasks: () => safeArray("agent_tasks", "tasks"),
    runTask: (id) => call("agent_run_tasks", { id, all: false }),
    runAllTasks: () => call("agent_run_tasks", { id: null, all: true }),
    deleteTask: async (id) => {
      try {
        return (await call<{ tasks: ProjectTask[] }>("agent_delete_task", { id })).tasks ?? [];
      } catch {
        return [];
      }
    },
    async killTask(id) {
      try {
        return (await call<{ message?: string }>("agent_kill_task", { id })).message ?? null;
      } catch {
        return null;
      }
    },
    async cycleThinking() {
      try {
        return await call("agent_cycle_thinking");
      } catch {
        return null;
      }
    },
    listCommands: () => safeArray("agent_commands", "commands"),
    listModels: () => safeArray("agent_models", "models"),
    async switchModel(model) {
      try {
        const response = await call<SwitchModelResult & { error?: string }>("agent_switch_model", {
          model,
        });
        return response.error ? { error: response.error } : response;
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    async switchKenModel(model) {
      try {
        return await call("agent_switch_ken_model", { model });
      } catch {
        return null;
      }
    },
    async getSettings() {
      try {
        return await call<AppSettings>("agent_settings");
      } catch {
        return null;
      }
    },
    saveSettings: (projectsRoot) => call("agent_save_settings", { projectsRoot }),
    listProjects: () => safeArray("agent_projects", "projects"),
    searchFiles: (query) => safeArray("agent_files", "files", { query }),
    listSessions: (cwd, chatAgent) =>
      safeArray("agent_sessions", "sessions", { cwd, chatAgent: chatAgent ?? null }),
    async getTelegramStatus() {
      try {
        return await call("agent_telegram_get");
      } catch {
        return { configured: false };
      }
    },
    saveTelegramConfig: async (botToken, userId) => {
      await ready();
      await call("agent_telegram_save", { botToken, userId });
    },
    async getServeStatus() {
      try {
        return await call("agent_serve_status");
      } catch {
        return { running: false, configured: false };
      }
    },
    startServe: async () => {
      await ready();
      await call("agent_serve_start");
    },
    stopServe: async () => {
      await ready();
      await call("agent_serve_stop");
    },
    listMcpServers: async (cwd) => {
      await ready();
      return safeArray("agent_mcp_list", "servers", { cwd: cwd ?? null });
    },
    addMcpServer: async (line, scope, cwd) => {
      await ready();
      return call("agent_mcp_add", { line, scope, cwd: cwd ?? null });
    },
    loginMcpServer: async (name, scope, cwd) => {
      await ready();
      await call("agent_mcp_login", { name, scope, cwd: cwd ?? null });
    },
    async removeMcpServer(name, scope, cwd) {
      await ready();
      try {
        return await call("agent_mcp_remove", { name, scope, cwd: cwd ?? null });
      } catch {
        return { removed: false };
      }
    },
  };
}
