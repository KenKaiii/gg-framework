import { useState, useRef, useEffect, useLayoutEffect, useCallback, memo } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { theme } from "./theme";
import {
  waitForReady,
  getState,
  sendPrompt,
  sendKenPrompt,
  cancelKen,
  setAutopilot,
  cancel,
  newSession,
  cycleThinking,
  listModels,
  switchModel,
  switchKenModel,
  listCommands,
  listHistory,
  listTasks,
  runTask,
  runAllTasks,
  deleteTask,
  newWindow,
  focusWindowByOffset,
  arrangeAllWindows,
  onWindowOrder,
  restoreTarget,
  acceptPlan as acceptPlanIPC,
  subscribe,
  isSecondaryWindow,
  windowLabel,
  setWindowTitle,
  openProjectPath,
  type AgentState,
  type WorkspaceMode,
  type ModelOption,
  type SlashCommand,
  type BackgroundTask,
  type ProjectTask,
  type FileHit,
  searchFiles,
  enhancePrompt,
  getDroppedPathInfo,
  readDroppedFileAttachment,
  type Attachment,
  type PromptSegment,
} from "./agent";
import { ActivityBar } from "./ActivityBar";
import { KenActivityBar } from "./KenActivityBar";
import { AutopilotReviewBar } from "./AutopilotReviewBar";
import { useKenMentor } from "./useKenMentor";
import { useAutopilot } from "./useAutopilot";
import { useAgentEvents, HOOK_PRESENTATION, type HookKind } from "./useAgentEvents";
import { LiveToolPanel, type LiveToolEntry } from "./LiveToolPanel";
import { SubAgentFeed, type SubAgentLine } from "./SubAgentFeed";
import { CompactionNotice } from "./CompactionNotice";
import { ModelSelect } from "./ModelSelect";
import { SlashMenu } from "./SlashMenu";
import { FileMentionMenu } from "./FileMentionMenu";
import { ReferencedFiles, appendReferencedFiles, parseReferencedFiles } from "./ReferencedFiles";
import { ContextMeter } from "./ContextMeter";
import { BackgroundTasksButton } from "./BackgroundTasksButton";
import { TasksModal } from "./TasksModal";
import { NotesModal } from "./NotesModal";
import { MemoryModal } from "./MemoryModal";
import { ShimmerText } from "./ShimmerText";
import { WakeScreen } from "./WakeScreen";
import { ConfirmModal } from "./ConfirmModal";
import { InitGitModal } from "./InitGitModal";
import { PlanModeLogo } from "./PlanModeLogo";
import { KenPowerBanner } from "./KenPowerBanner";
import { PlanReviewModal } from "./PlanReviewModal";
import { WindowLayoutButton } from "./WindowLayoutButton";
// Experimental gaze focus — disabled for now (see main.tsx).
// import { GazeButton } from "./GazeButton";
import { RadioButton } from "./RadioButton";
import { ProjectPicker } from "./ProjectPicker";
import { ChatPicker } from "./ChatPicker";
import { BackButton } from "./BackButton";
import { Badge } from "./Badge";
import { AutopilotToggle } from "./AutopilotToggle";
import { HomeScreen } from "./HomeScreen";
import { initialEntryView, type EntryView } from "./app-entry-view";
import { Toaster } from "./Toaster";
import { Confetti } from "./Confetti";
import { RankBadge } from "./RankBadge";
import { ScorecardModal } from "./ScorecardModal";
import { TitleUsageMeter } from "./TitleUsageMeter";
import { formatWorkspaceTitle, WorkspaceHeader } from "./WorkspaceHeader";
import { useProgress } from "./useProgress";
import { LoginScreen } from "./LoginScreen";
import { Markdown, PromptSendProvider } from "./Markdown";
import { FooterSkeleton, TranscriptSkeleton, Skeleton } from "./Skeleton";
import { useAppUpdate } from "./update";
import { recoverPromptLabel } from "./prompt-labels";
import { playSound } from "./sounds";
import { segmentDoneMarkers, hasDoneMarker, countPlanSteps } from "./plan-steps";
import { Paperclip, AtSign } from "lucide-react";
import { AttachmentBar } from "./AttachmentBar";
import { EnhancedSegments } from "./PromptEnhancement";
import { EnhanceDissolve } from "./EnhanceDissolve";
import { toast } from "./toast";
import { fileToPending, toWire, attachmentToPending, type PendingAttachment } from "./attachments";
import "./App.css";

const DEFAULT_INPUT_PLACEHOLDER = "Type a message, / commands, @ files, @Ken for help";
const INPUT_PLACEHOLDERS = [
  DEFAULT_INPUT_PLACEHOLDER,
  "Need a second opinion? Ask @Ken",
  "Stuck on what to do next? Ask @Ken",
  DEFAULT_INPUT_PLACEHOLDER,
  "Want a second set of eyes? Ask @Ken",
  "Unsure how to proceed? Ask @Ken",
  "Need a quick review? Ask @Ken",
] as const;
const RUNNING_INPUT_PLACEHOLDERS = [
  "Agent is working. Add a follow-up if you want",
  "Got another thought? Queue it here",
  "Agent is on it. You can stack the next note",
  "Thinking ahead? Drop the next instruction",
  "Keep going. Your next message will queue up",
] as const;
const INPUT_PLACEHOLDER_INTERVAL_MS = 12_000;
const PLACEHOLDER_SHUFFLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const PLACEHOLDER_SHUFFLE_FRAMES = 18;
const PLACEHOLDER_SHUFFLE_FRAME_MS = 24;

// Autopilot Ken's "all clear" line, rotated so the auto-review loop doesn't
// repeat the exact same sentence every time GG Coder's work checks out.
// Info row shown when a video attachment is sent to a model without native
// video analysis. Shared by the live send path and history restore so the
// resumed transcript matches the live one exactly.
const VIDEO_CAPABILITY_WARNING =
  "This model can't watch video directly. The agent can still extract frames or audio with ffmpeg if needed — switch to a video-capable model (Gemini, Kimi, MiniMax) for native video analysis.";

const ALL_CLEAR_VARIATIONS = [
  "All clear. Looks good to me.",
  "Checks out. Nothing left to flag.",
  "Nice, this holds up. Nothing more from me.",
  "Solid work. I've got no notes.",
  "Yep, that covers it. All good.",
  "Looks right to me — ship it.",
  "Clean pass. Nothing to add here.",
  "That does the job. No complaints.",
  "Good to go, no issues found.",
  "This holds together. All clear.",
] as const;

function stableIndex(seed: string, modulo: number): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % modulo;
}

function allClearCopy(seed: string | undefined, fallbackId: number): string {
  const index = seed
    ? stableIndex(seed, ALL_CLEAR_VARIATIONS.length)
    : fallbackId % ALL_CLEAR_VARIATIONS.length;
  return ALL_CLEAR_VARIATIONS[index];
}

function shufflePlaceholderFrame(target: string, frame: number): string {
  const revealCount = Math.ceil((target.length * frame) / PLACEHOLDER_SHUFFLE_FRAMES);
  return Array.from(target, (char, index) => {
    if (index < revealCount || /\s|[.,?/@]/.test(char)) return char;
    const pick = Math.floor(Math.random() * PLACEHOLDER_SHUFFLE_CHARS.length);
    return PLACEHOLDER_SHUFFLE_CHARS[pick];
  }).join("");
}

// ── Transcript model ───────────────────────────────────────
// Tool activity lives in the pinned LiveToolPanel, never in the transcript.
// Exported (type-only) so the Ken mentor hook can produce/typecheck ken + error
// transcript items without a runtime import cycle.
export type Item =
  // `command` marks a workflow slash command — rendered as just the short
  // `/name` with a highlight + shimmer, never the expanded prompt body.
  // `label` overrides what's shown with a friendly shimmer phrase (e.g.
  // "Initializing Git…") while the full prompt still goes to the agent.
  | {
      kind: "user";
      id: number;
      text: string;
      command?: boolean;
      label?: string;
      images?: string[];
      files?: string[];
      // Corrected-term segments from the prompt enhancer, when this message was
      // sent unedited straight after an enhance. Drives the highlighted bubble.
      enhancements?: PromptSegment[];
      // True while this message is still waiting in the mid-run steering queue.
      // Rendered dimmed; cleared at run_end once the agent has consumed it.
      queued?: boolean;
      // True when this prompt was addressed to Ken (`@Ken …`). Renders the bubble
      // in Ken's color so the transcript shows it went to the mentor, not GG Coder.
      ken?: boolean;
      // True when this bubble came from clicking a "Send to GG Coder" button on
      // one of Ken's recommended prompts. Renders as a shimmering "Sent to GG
      // Coder" label in Ken's color (like a slash command shows `/name`), instead
      // of the full prompt body that was actually sent to GG Coder.
      kenSent?: boolean;
    }
  | { kind: "assistant"; id: number; text: string }
  // Ken Kai (mentor agent) reply — magenta-tinted bubble + "Ken Kai" badge,
  // streamed from the ken_* SSE events. Never mistaken for GG Coder.
  | { kind: "ken"; id: number; text: string }
  | { kind: "info"; id: number; text: string }
  // Structured error (see gg-ai's formatError): headline always answers "is this
  // me or them", message is the raw detail (omitted when redundant with the
  // headline), guidance is the action line (retry / switch model / log in /
  // wait until a reset time). `text` is a legacy fallback for older items.
  | {
      kind: "error";
      id: number;
      text?: string;
      headline?: string;
      message?: string;
      guidance?: string;
    }
  // Agent self-correction hook notice (ideal review / loop-break / re-grounding),
  // rendered like the TUI: a shimmering tone-colored one-liner.
  | { kind: "hook"; id: number; hook: HookKind }
  // Images produced by a tool (screenshot / read of an image file).
  | { kind: "images"; id: number; images: TranscriptImage[]; caption?: string }
  // Image generation in progress — a shimmering square placeholder that gets
  // replaced by the final image when the tool result arrives.
  | { kind: "generating_image"; id: number; prompt: string }
  // Plan-mode entry banner (ASCII logo + optional reason).
  | { kind: "plan"; id: number; reason: string }
  // A task kicked off from the Tasks modal (shown at the top of its session).
  | { kind: "task"; id: number; title: string }
  // Sub-agents delegated in a turn — a live, in-chat feed of each one's tools.
  | { kind: "subagent_group"; id: number; agents: SubAgentLine[]; aborted?: boolean }
  // Context compaction — shimmering "compacting…" while running, then a quiet
  // "compacted · N → M messages" summary when done.
  | {
      kind: "compaction";
      id: number;
      status: "running" | "done";
      originalCount?: number;
      newCount?: number;
    }
  // Autopilot Ken verdict — emitted by the auto-review loop and rendered like a
  // normal @Ken reply bubble (Ken dot + text), not a separate marker style.
  // `phase` selects the message: he prompted GG Coder (with the `body` he sent),
  // gave the all-clear, needs a human (with `reason`), or hit the round cap.
  | {
      kind: "autopilot";
      id: number;
      phase: "prompted" | "done" | "human" | "capped" | "plan_approved";
      reason?: string;
      body?: string;
      /** Stable seed from persisted marker data so resumed all-clear copy doesn't flicker. */
      copySeed?: string;
    };

export interface TranscriptImage {
  /** data: URL (base64) ready to drop into <img src>. */
  src: string;
  /** Source file path, shown as a caption + used as a stable key. */
  path?: string;
}

let idSeq = 0;
const nextId = (): number => ++idSeq;

// Vertical divider between footer segments (mirrors the TUI's ` \u2502 ` in
// border color). Rendered between adjacent groups, never leading/trailing.
function FooterSep(): React.ReactElement {
  return (
    <span className="footer-sep" style={{ color: theme.border }}>
      {"\u2502"}
    </span>
  );
}

// BLACK_CIRCLE — ⏺ on mac (matches the TUI figure).
const DOT = "\u23FA";

// Thinking-tier color, mirroring the ggcoder TUI footer's getThinkingColor:
// warmer/more saturated as the tier rises; xhigh/max are "max power" hot pink.
const MAX_POWER_COLOR = "#db2777";
const MAX_POWER_SHIMMER = "#f472b6";
function thinkingColor(level: string | null | undefined): string {
  if (!level) return theme.textDim;
  if (level === "low") return theme.textMuted;
  if (level === "medium") return theme.accent;
  if (level === "high") return theme.warning;
  return MAX_POWER_COLOR; // xhigh / max
}

function hasDraggedFiles(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}

type WebkitEntry = { isDirectory?: boolean };
type DirectoryAwareDataTransferItem = DataTransferItem & {
  webkitGetAsEntry?: () => WebkitEntry | null;
};

function isDirectoryDragItem(item: DataTransferItem): boolean {
  const entry = (item as DirectoryAwareDataTransferItem).webkitGetAsEntry?.();
  return entry?.isDirectory === true;
}

function filesForAttachment(dataTransfer: DataTransfer): File[] {
  const items = Array.from(dataTransfer.items ?? []);
  if (items.length === 0) return Array.from(dataTransfer.files);
  return items
    .filter((item) => item.kind === "file" && !isDirectoryDragItem(item))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function canHandleWindowFileDrop(): boolean {
  return !document.querySelector(".modal-backdrop");
}

function App(): React.ReactElement {
  const [items, setItems] = useState<Item[]>([]);
  // Ken Kai (mentor agent): own running flag, token/thinking metrics, streaming
  // bubble, and `ken_*` SSE handling. Lives in its own hook; App just consumes
  // the state for rendering and delegates ken events to `handleKenEvent`.
  const {
    kenRunning,
    kenTokens,
    kenRunStartTs,
    kenIsThinking,
    kenThinkingStartTs,
    kenThinkingAccumMs,
    handleKenEvent,
  } = useKenMentor({ setItems, nextId });
  // Autopilot Ken (auto-reviewer): consumes the `autopilot_*` event family into
  // compact transcript markers + a "Ken reviewing…" flag. Separate hook, same
  // shared setItems/nextId pattern as useKenMentor.
  const { autopilotReviewing, handleAutopilotEvent } = useAutopilot({ setItems, nextId });
  const { snapshot: progress, levelUp, levelUpNonce, levelUpOrigin } = useProgress();
  const [showScorecard, setShowScorecard] = useState(false);
  const [rankCelebrateNonce, setRankCelebrateNonce] = useState<string | null>(null);
  const [xpChips, setXpChips] = useState<Array<{ id: string; label: string }>>([]);
  const lastProgressXpRef = useRef<number | null>(null);
  const [confettiNonce, setConfettiNonce] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [displayPlaceholder, setDisplayPlaceholder] = useState(DEFAULT_INPUT_PLACEHOLDER);
  const displayPlaceholderRef = useRef(DEFAULT_INPUT_PLACEHOLDER);
  // Shell-style prompt history for ↑/↓ recall in the chat input. Newest entries
  // last. `historyIndex` is null while editing a fresh draft; stepping ↑ walks
  // backwards into history, ↓ forwards. `historyDraftRef` stashes the in-progress
  // text so stepping ↓ past the newest entry restores what was being typed.
  const promptHistoryRef = useRef<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const historyDraftRef = useRef("");
  // Staged attachments (paste / attach button / whole-window drag-drop) shown above the input.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The most recent prompt-enhancement result. `plain` is the text now in the
  // textarea; `segments` drive the inline highlight overlay + the sent bubble.
  // It's dropped the moment the textarea diverges from `plain` so highlights
  // never misalign. `enhancing` shows the pulse on the Enhance pill mid-call.
  const [enhancement, setEnhancement] = useState<{
    plain: string;
    segments: PromptSegment[];
  } | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  // The floating "Enhance" pill is shown only after the user pauses typing for
  // ~1s (and hidden again on the next keystroke / send / empty input).
  const [enhanceHintVisible, setEnhanceHintVisible] = useState(false);
  // Drives the Matrix dissolve→decode animation over the input while enhancing.
  // `newText` is null until the enhancer returns (dissolve/scramble), then the
  // enhanced text (decode). Null when no animation is playing.
  const [enhanceAnim, setEnhanceAnim] = useState<{
    oldText: string;
    newText: string | null;
  } | null>(null);
  // Holds the resolved enhancement so the animation's onDone can apply it once
  // the decode settles (rather than popping the text in mid-animation).
  const pendingEnhanceRef = useRef<{ enhanced: string; segments: PromptSegment[] } | null>(null);
  // Number of messages queued mid-run (injected as steering by the sidecar).
  const [queuedCount, setQueuedCount] = useState(0);
  const [state, setState] = useState<AgentState | null>(null);
  // Transient "KEN IS ON"/"KEN IS OFF" takeover banner shown when Autopilot
  // is toggled. Null = not showing; the banner clears itself via `onDone`
  // once its slide-out animation finishes.
  const [kenPowerBanner, setKenPowerBanner] = useState<"on" | "off" | null>(null);
  const [running, setRunning] = useState(false);
  const cancelling = state?.runState === "cancelling";
  const requestCancel = useCallback(() => {
    if (cancelling) return;
    void cancel().catch(() => {
      // Native/sidecar transport failures may prevent the SSE cancel_failed
      // frame; restore the owned-running affordance so retry remains possible.
      setState((previous) =>
        previous ? { ...previous, running: true, runState: "running" } : previous,
      );
      setRunning(true);
      setStatus("cancellation failed; agent still running");
    });
  }, [cancelling]);
  const [status, setStatus] = useState("connecting to agent\u2026");
  const [liveToolFeed, setLiveToolFeed] = useState<LiveToolEntry[]>([]);
  const [tokens, setTokens] = useState(0);
  const [doneStatus, setDoneStatus] = useState<string | null>(null);
  // Pending plan awaiting review (the markdown). Non-null opens the review modal.
  const [planReview, setPlanReview] = useState<string | null>(null);
  // Path of the plan awaiting review, captured from `plan_exit`. Needed on accept
  // to bake the plan's `## Steps` into the agent's system prompt so it emits
  // `[DONE:n]` progress markers (drives the activity bar's Plan Steps widget).
  const planReviewPathRef = useRef<string | null>(null);
  // Approved-plan progress for the activity bar: total steps + completed set.
  const [planTotal, setPlanTotal] = useState(0);
  const [planDone, setPlanDone] = useState<Set<number>>(new Set());
  // Refs mirror the plan progress state for the memoized SSE event handler,
  // which intentionally does not re-capture React state on every render.
  const planTotalRef = useRef(0);
  const planDoneRef = useRef<Set<number>>(new Set());
  // Approval-time count kept only as a compatibility fallback for an older
  // sidecar whose session_reset has no canonical live-file total.
  const pendingPlanTotalRef = useRef<number | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingStartTs, setThinkingStartTs] = useState<number | null>(null);
  const [thinkingAccumMs, setThinkingAccumMs] = useState(0);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  // `@`-mention file picker state. `mention` is the active token being typed
  // (its query + where it starts in the input); `fileMatches` is the live
  // search result; `fileIndex` is the keyboard-highlighted row.
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [fileMatches, setFileMatches] = useState<FileHit[]>([]);
  const [fileIndex, setFileIndex] = useState(0);
  // Files referenced via `@`, tracked as chips (NOT left in the input text).
  // Their paths are appended to the prompt on submit.
  const [mentionedPaths, setMentionedPaths] = useState<string[]>([]);
  // Footer extras mirrored from the sidecar: live background tasks and the
  // running context-window usage (input-side tokens of the latest turn).
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [contextTokens, setContextTokens] = useState(0);
  // Project task list (the agent's `tasks` tool store) + the Tasks modal.
  // Updated live via the `tasks_list` SSE event while a run-all sweep advances.
  const [projectTasks, setProjectTasks] = useState<ProjectTask[]>([]);
  const [showTasks, setShowTasks] = useState(false);
  // Free-form per-project notes, persisted to localStorage keyed by project cwd.
  const [showNotes, setShowNotes] = useState(false);
  const [showMemories, setShowMemories] = useState(false);
  const [notes, setNotes] = useState("");
  // Every window chooses a code or chat workspace before connecting. Mode stays
  // separate from picker visibility so restore and reopened pickers are explicit.
  const [needsProject, setNeedsProject] = useState(true);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("code");
  // False until the boot-time workspace-restore check resolves.
  const [restoreChecked, setRestoreChecked] = useState(false);
  // Every window starts from the mode-neutral home screen before choosing Code or Chat.
  const [entryView, setEntryView] = useState<EntryView>(initialEntryView(isSecondaryWindow));
  // Re-open the matching session picker over an already-open workspace.
  const [showPicker, setShowPicker] = useState(false);
  // Bumped on each workspace/session choice to force re-hydration.
  const [hydrateNonce, setHydrateNonce] = useState(0);
  // New-session confirmation modal + in-flight guard.
  const [confirmNewSession, setConfirmNewSession] = useState(false);
  // Hide/show the nav button row (the bar + centered title always stay).
  // Persisted across reloads.
  const [navHidden, setNavHidden] = useState(() => {
    try {
      return localStorage.getItem("gg-nav-hidden") === "1";
    } catch {
      return false;
    }
  });
  const setNavHiddenPersisted = useCallback((hidden: boolean) => {
    try {
      localStorage.setItem("gg-nav-hidden", hidden ? "1" : "0");
    } catch {
      /* ignore */
    }
    setNavHidden(hidden);
  }, []);
  const toggleNav = useCallback(
    () => setNavHiddenPersisted(!navHidden),
    [navHidden, setNavHiddenPersisted],
  );
  // Hide/show the live tool panel (the rolling feed above the activity bar).
  // Mirrors navHidden: persisted across reloads, and auto-enabled when windows
  // are tiled (tight space) so freshly opened windows boot with it collapsed.
  const [toolsHidden, setToolsHidden] = useState(() => {
    try {
      return localStorage.getItem("gg-tools-hidden") === "1";
    } catch {
      return false;
    }
  });
  const setToolsHiddenPersisted = useCallback((hidden: boolean) => {
    try {
      localStorage.setItem("gg-tools-hidden", hidden ? "1" : "0");
    } catch {
      /* ignore */
    }
    setToolsHidden(hidden);
  }, []);
  const toggleTools = useCallback(
    () => setToolsHiddenPersisted(!toolsHidden),
    [toolsHidden, setToolsHiddenPersisted],
  );
  const [newSessionBusy, setNewSessionBusy] = useState(false);
  // App self-update (GitHub releases). Drives the footer update banner.
  const appUpdate = useAppUpdate();
  // Initialize-git modal (shown via the top-right button when not yet a repo).
  const [showInitGit, setShowInitGit] = useState(false);
  // True once the initial hydrate (state + models + commands + history) has
  // settled for the current project/session. Gates the footer + chrome so they
  // reveal fully-formed in one pass instead of popping in piecemeal (cwd, git,
  // thinking, model each arriving separately would reflow the bar mid-load).
  const [hydrated, setHydrated] = useState(false);

  const readyRef = useRef(false);
  // Mirror of `state` for use inside the memoized event handler (which doesn't
  // re-capture state). Lets turn_end pick the right context-token formula by
  // provider without re-subscribing the SSE listener on every state change.
  const stateRef = useRef<AgentState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // NOTE: the build-session event machine's private refs (streaming bubble id,
  // rAF buffer, per-run accumulators, sub-agent / compaction group ids) now live
  // inside the useAgentEvents hook. Only the cross-cutting refs that App's render
  // + other handlers also touch (stateRef above, the plan refs + stickToBottom
  // below) stay here and are passed into the hook.

  // Whether the transcript is "pinned" to the bottom. Auto-scroll only runs
  // while pinned. The user scrolling up un-pins it — so they can read freely
  // even while the agent keeps streaming — and scrolling back to the bottom
  // re-pins. Default true so a fresh transcript follows the newest output.
  const stickToBottomRef = useRef(true);

  // Pin to the bottom. Images (screenshots / attachments) load asynchronously
  // and grow the content after this fires, so it's also called from each image's
  // onLoad to keep the newest content visible.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, []);

  // Same as scrollToBottom, but a no-op while the user has scrolled up to read.
  const maybeScrollToBottom = useCallback(() => {
    if (stickToBottomRef.current) scrollToBottom();
  }, [scrollToBottom]);

  // Track the user's scroll intent. Any real scroll that lands more than a
  // small threshold above the bottom un-pins; returning to (near) the bottom
  // re-pins. Our own programmatic scrollToBottom lands at the bottom, so it
  // simply keeps the pin set — no need to distinguish it from a user scroll.
  const onTranscriptScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= 48;
  }, []);

  const insertDroppedFolderPaths = useCallback((paths: string[]): void => {
    if (paths.length === 0) return;
    const text = paths.join(" ");
    setInput((prev) => {
      if (!prev.trim()) return text;
      return `${prev}${/\s$/.test(prev) ? "" : " "}${text}`;
    });
    setEnhancement(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const showXpChip = useCallback((label: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    playSound("xp");
    setXpChips((chips) => [...chips.slice(-2), { id, label }]);
    window.setTimeout(() => {
      setXpChips((chips) => chips.filter((chip) => chip.id !== id));
    }, 1700);
  }, []);

  useEffect(() => {
    if (!progress) return;
    const previous = lastProgressXpRef.current;
    lastProgressXpRef.current = progress.xp;
    if (previous == null) return;
    const gained = progress.xp - previous;
    // Chip + sound only in the window whose run earned the XP — other windows
    // still receive the frame (badge/percent update) but stay quiet.
    if (gained > 0 && progress.origin) showXpChip(`+${gained} XP`);
  }, [progress, showXpChip]);

  useEffect(() => {
    if (!levelUp || !levelUpNonce) return;
    toast(`Rank up! → ${levelUp.rankName}`, "success", 5200);
    // Rank-up visuals show everywhere; the sound only plays in the earning window.
    if (levelUpOrigin) playSound("levelUp");
    setRankCelebrateNonce(levelUpNonce);
    const clearRank = window.setTimeout(() => setRankCelebrateNonce(null), 2400);

    const crossedTier = Math.floor((levelUp.from - 1) / 5) !== Math.floor((levelUp.to - 1) / 5);
    let clearConfetti = 0;
    if (crossedTier) {
      setConfettiNonce(levelUpNonce);
      clearConfetti = window.setTimeout(() => setConfettiNonce(null), 1900);
    }

    return () => {
      window.clearTimeout(clearRank);
      if (clearConfetti) window.clearTimeout(clearConfetti);
    };
  }, [levelUp, levelUpNonce, levelUpOrigin]);

  // Re-pin to the bottom before every paint — but only while pinned. The live
  // tool panel + activity bar (.liveregion) grow/shrink below the transcript as
  // tools run and finish; since the transcript is a flexible sibling, that
  // growth steals height from it and would leave the newest content (often the
  // just-sent user prompt) scrolled under the fold. Keying this layout effect on
  // the live-region's height inputs (tool feed, run state, done status) AND
  // `items` re-pins synchronously after layout but before paint, so the prompt
  // is never hidden. useLayoutEffect (not a ResizeObserver) avoids the post-paint
  // flash and the RO's unreliable timing relative to the flex re-layout. The
  // stick-to-bottom gate keeps it from yanking the view away while the user is
  // scrolled up reading mid-stream.
  useLayoutEffect(() => {
    maybeScrollToBottom();
  }, [items, liveToolFeed, running, doneStatus, queuedCount, maybeScrollToBottom]);

  // Settle the scroll position after a session hydrates. The single layout-effect
  // scroll above runs the instant `items` is set, but the transcript keeps
  // growing afterward — web fonts swap in (FOUT reflows text taller), code blocks
  // and markdown finish laying out — which leaves the view pinned a little above
  // the true bottom. Re-pin across the next two frames and once fonts are ready,
  // gated on stick-to-bottom so it never yanks the view if the user scrolled up.
  useEffect(() => {
    if (!hydrated) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      maybeScrollToBottom();
      raf2 = requestAnimationFrame(maybeScrollToBottom);
    });
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) maybeScrollToBottom();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [hydrated, hydrateNonce, maybeScrollToBottom]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const inputPlaceholder = running
    ? RUNNING_INPUT_PLACEHOLDERS[placeholderIndex % RUNNING_INPUT_PLACEHOLDERS.length]
    : INPUT_PLACEHOLDERS[placeholderIndex % INPUT_PLACEHOLDERS.length];
  const setAnimatedPlaceholder = useCallback((text: string) => {
    displayPlaceholderRef.current = text;
    setDisplayPlaceholder(text);
  }, []);
  useEffect(() => {
    if (input.length > 0) return;
    const id = window.setInterval(() => {
      setPlaceholderIndex((i) => i + 1);
    }, INPUT_PLACEHOLDER_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [input.length]);
  useEffect(() => {
    if (input.length > 0) {
      setAnimatedPlaceholder(inputPlaceholder);
      return;
    }
    if (displayPlaceholderRef.current === inputPlaceholder) return;

    let frame = 0;
    const id = window.setInterval(() => {
      frame += 1;
      const text =
        frame >= PLACEHOLDER_SHUFFLE_FRAMES
          ? inputPlaceholder
          : shufflePlaceholderFrame(inputPlaceholder, frame);
      setAnimatedPlaceholder(text);
      if (frame >= PLACEHOLDER_SHUFFLE_FRAMES) window.clearInterval(id);
    }, PLACEHOLDER_SHUFFLE_FRAME_MS);
    return () => window.clearInterval(id);
  }, [input.length, inputPlaceholder, setAnimatedPlaceholder]);

  // Stop the browser from navigating to / opening a file dropped anywhere
  // (which would replace the whole UI with the raw file). The active chat view
  // handles files as attachments; native Tauri drop events add folder paths to
  // the draft because browser File objects cannot represent directories well.
  useEffect(() => {
    const prevent = (e: DragEvent): void => {
      // Only files — don't interfere with text selection drags.
      if (hasDraggedFiles(e.dataTransfer)) e.preventDefault();
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed) return;
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          if (canHandleWindowFileDrop()) setIsFileDragOver(true);
          return;
        }
        if (payload.type === "leave") {
          setIsFileDragOver(false);
          return;
        }
        setIsFileDragOver(false);
        if (!canHandleWindowFileDrop() || payload.paths.length === 0) return;
        void getDroppedPathInfo(payload.paths).then((infos) => {
          if (disposed) return;
          insertDroppedFolderPaths(infos.filter((info) => info.isDir).map((info) => info.path));
          const filePaths = infos.filter((info) => !info.isDir).map((info) => info.path);
          if (filePaths.length > 0) void addNativeDroppedFiles(filePaths);
        });
      })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [insertDroppedFolderPaths]);

  // Keep the native window title aligned with the visible title-bar context.
  useEffect(() => {
    const fallbackTitle = workspaceMode === "chat" ? "GG Chat" : "GG Coder";
    const title =
      !needsProject && !showPicker
        ? formatWorkspaceTitle(
            state?.cwd,
            state?.gitBranch,
            fallbackTitle,
            state?.gitDirtyFileCount,
          )
        : fallbackTitle;
    setWindowTitle(title);
  }, [
    needsProject,
    showPicker,
    state?.cwd,
    state?.gitBranch,
    state?.gitDirtyFileCount,
    workspaceMode,
  ]);

  // Auto-grow the chat textarea to fit its content (up to a CSS max-height,
  // after which it scrolls). Runs whenever the input value changes.
  //
  // useLayoutEffect (not useEffect) so the height is recomputed BEFORE the
  // browser paints. This matters most when the enhance animation tears down and
  // hands its multi-line text back to the textarea: with a post-paint effect the
  // textarea would flash at its default height for one frame, then resize — a
  // visible layout shift. Sizing pre-paint makes the handoff seamless.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = parseFloat(getComputedStyle(el).maxHeight) || Infinity;
    // Toggle scrolling only when content truly overflows the cap. Otherwise keep
    // overflow hidden: under CSS zoom > 1, scrollHeight rounds down to an integer
    // of unzoomed px, leaving the content a hair taller than the set height —
    // `auto` would then flash a phantom grey scrollbar inside a single-line input.
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    // Also re-measure when the enhance animation overlay is removed: during the
    // animation the textarea is position:absolute (stretched to the overlay's
    // height), so a measurement taken then is wrong. Re-running once enhanceAnim
    // clears sizes the now-in-flow textarea to its real content height.
  }, [input, enhanceAnim]);

  // Keyboard shortcuts for multi-window navigation.
  //   Cmd/Ctrl+N         → new project window
  //   Cmd/Ctrl+`          → cycle forward through windows (reading order)
  //   Cmd/Ctrl+Shift+`    → cycle backward
  //   Cmd/Ctrl+Shift+A    → auto-arrange all windows into a clean grid
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      // New window: Cmd/Ctrl + N (no Shift/Alt).
      if (e.key.toLowerCase() === "n" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        void newWindow();
        return;
      }
      // Cycle windows: Cmd/Ctrl + Backquote (Shift = backward).
      // Use e.code (physical key) — Shift turns ` into ~, but code stays stable.
      if (e.code === "Backquote" && !e.altKey) {
        e.preventDefault();
        void focusWindowByOffset(e.shiftKey ? -1 : 1);
        return;
      }
      // Auto-arrange all windows: Cmd/Ctrl + Shift + A.
      if (e.shiftKey && (e.key === "a" || e.key === "A") && !e.altKey) {
        e.preventDefault();
        void arrangeAllWindows();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Track whether THIS window holds OS focus (for the prominent input border).
  // The webview's own focus/blur events are instant — no IPC round-trip.
  const [windowFocused, setWindowFocused] = useState(true);

  // Position in the multi-window reading order (e.g. window 2 of 4), plus
  // whether this window is the focused one. Driven by the Rust `window-order`
  // broadcast so the label updates automatically when windows move/close.
  const [windowIndex, setWindowIndex] = useState<number | null>(null);
  const [windowTotal, setWindowTotal] = useState(1);
  const [isThisFocused, setIsThisFocused] = useState(true);

  // Focus the chat input whenever this window gains focus (or clicked anywhere),
  // so switching between project windows lands the cursor in the input without
  // a second click. Skips when the user is selecting text or focused elsewhere
  // intentionally (e.g. a menu button).
  useEffect(() => {
    const focusInput = (): void => {
      const active = document.activeElement;
      if (active && active !== document.body && active.tagName === "BUTTON") return;
      if (window.getSelection()?.toString()) return;
      // A modal/overlay owns keyboard focus while open — stealing it back to the
      // chat input means the user can't type in the modal's fields. Bail when one
      // is present (every modal renders inside `.modal-backdrop`).
      if (document.querySelector(".modal-backdrop")) return;
      // Don't yank focus out of another editable field (a different input,
      // textarea, or contenteditable) the user is intentionally typing in.
      if (
        active instanceof HTMLElement &&
        active !== inputRef.current &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
      ) {
        return;
      }
      inputRef.current?.focus();
    };
    const onFocus = (): void => {
      setWindowFocused(true);
      focusInput();
    };
    const onBlur = (): void => setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("mouseup", focusInput);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("mouseup", focusInput);
    };
  }, []);

  // Subscribe to the reading-order broadcast from Rust so each window knows its
  // position (e.g. "1/4") and whether it's focused. Updates automatically when
  // windows are arranged, moved (debounced), created, closed, or focused.
  useEffect(() => {
    let un: (() => void) | undefined;
    void onWindowOrder((e) => {
      const idx = e.order.indexOf(windowLabel);
      setWindowIndex(idx >= 0 ? idx + 1 : null);
      setWindowTotal(e.order.length);
      setIsThisFocused(e.focused === windowLabel);
    }).then((fn) => {
      un = fn;
    });
    return () => un?.();
  }, []);

  // Global UI click sound — plays only when an actual interactive element is
  // clicked (buttons, links, role=button, options, labels), never bare
  // background/text. Capture phase so it fires even when a handler stops
  // propagation; left button only.
  useEffect(() => {
    const INTERACTIVE = "button, a, [role='button'], [role='option'], label, summary, select";
    const onClick = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      const target = e.target as Element | null;
      const el = target?.closest?.(INTERACTIVE);
      if (!el) return;
      if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return;
      // The autopilot toggle plays its own dedicated sound (only when turning
      // on) instead of the generic click, so skip it here to avoid a double cue.
      if (el.closest("[data-suppress-click-sound]")) return;
      playSound("click");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // Build-session SSE handling + assistant-streaming helpers live in the
  // useAgentEvents hook (mirrors useKenMentor). It owns the event machine's
  // private refs + the streaming helpers; App keeps owning the build-session
  // state (its render + other handlers use it) and passes the setters +
  // cross-cutting refs in. App consumes `handleEvent` (for the SSE subscription)
  // and the two helpers it still calls directly (`pushItem`, `endStreamingText`).
  const { handleEvent, pushItem, endStreamingText } = useAgentEvents({
    setItems,
    nextId,
    handleKenEvent,
    handleAutopilotEvent,
    setState,
    setTasks,
    setProjectTasks,
    setStatus,
    setRunning,
    setLiveToolFeed,
    setTokens,
    setContextTokens,
    setDoneStatus,
    setIsThinking,
    setThinkingStartTs,
    setThinkingAccumMs,
    setPlanTotal,
    setPlanDone,
    setPlanReview,
    setQueuedCount,
    setAttachments,
    setCommands,
    stateRef,
    planDoneRef,
    planTotalRef,
    planReviewPathRef,
    pendingPlanTotalRef,
    stickToBottomRef,
  });

  // Run the connect/ready flow against the current sidecar and hydrate state,
  // models, and commands. Re-invoked after a project switch respawns the
  // sidecar (its port changes, so we re-wait for readiness).
  const hydrate = useCallback(async (): Promise<void> => {
    readyRef.current = false;
    setHydrated(false);
    setStatus("connecting to agent\u2026");
    try {
      await waitForReady();
      readyRef.current = true;
      const st = await getState().catch(() => null);
      if (st) {
        setState(st);
        setRunning(st.running);
        setStatus(st.runState === "cancelling" ? "cancelling..." : "ready");
      }
      const available = await listModels();
      if (available.length > 0) setModels(available);
      const cmds = await listCommands();
      if (cmds.length > 0) setCommands(cmds);
      // Project task list for the Tasks modal + nav button.
      setProjectTasks(await listTasks());
      // Hydrate the transcript when resuming an existing session — the webview
      // only sees live SSE events, so past messages must be fetched explicitly.
      const history = await listHistory();
      if (history.length > 0) {
        // A freshly hydrated session lands at the bottom (newest message).
        stickToBottomRef.current = true;
        // Seed ↑/↓ recall from the resumed prompts (chronological), so history
        // works after reopening a session — not just within the live one. App-
        // button prompts (shimmer labels) weren't typed by the user, so skip
        // them; everything else the user actually entered is included.
        promptHistoryRef.current = history
          .filter((h) => h.role === "user" && !(!h.command && recoverPromptLabel(h.text)))
          .map((h) => {
            const parsed = !h.command ? parseReferencedFiles(h.text) : null;
            return (parsed ? parsed.text : h.text).trim();
          })
          .filter((t, i, a) => t.length > 0 && a[i - 1] !== t);
        setItems(
          history.map((h): Item => {
            // Tool-produced images (screenshots, generate_image) — reconstructed
            // from persisted ImageContent blocks, downsampled by the sidecar.
            if (h.toolImages && h.toolImages.length > 0)
              return {
                kind: "images",
                id: nextId(),
                images: h.toolImages.map((img) => ({ src: img.src, path: img.path })),
              };
            // Sub-agent delegation group — reconstructed from persisted tool_call
            // + tool_result pairing. toolUseCount/activities aren't persisted, so
            // the resumed feed shows agent name + status only.
            if (h.subagentGroup && h.subagentGroup.length > 0)
              return {
                kind: "subagent_group",
                id: nextId(),
                agents: h.subagentGroup.map((a, i) => ({
                  toolCallId: `history-${i}`,
                  agentName: a.agentName,
                  status: a.status,
                  activities: [],
                  toolUseCount: a.toolUseCount,
                  tokenUsage: { input: 0, output: 0 },
                })),
              };
            if (h.hook) return { kind: "hook", id: nextId(), hook: h.hook };
            // A resumed compacted session shows the quiet compaction notice in
            // place of the raw summary body (counts aren't persisted).
            if (h.compacted)
              return {
                kind: "compaction",
                id: nextId(),
                status: "done",
                originalCount: h.compactionCounts?.originalCount,
                newCount: h.compactionCounts?.newCount,
              };
            // Persisted display-only markers: plan-mode banner, task header,
            // error rows, and the video-capability info row — all rendered
            // identically to their live counterparts.
            if (h.plan) return { kind: "plan", id: nextId(), reason: h.plan.reason };
            if (h.task) return { kind: "task", id: nextId(), title: h.task.title };
            if (h.error) {
              const prefix =
                h.error.scope === "ken_error"
                  ? "Ken: "
                  : h.error.scope === "autopilot_error"
                    ? "Autopilot: "
                    : "";
              return {
                kind: "error",
                id: nextId(),
                headline: `${prefix}${h.error.headline}`,
                message: h.error.message,
                guidance: h.error.guidance,
              };
            }
            if (h.infoKind === "video_warning")
              return { kind: "info", id: nextId(), text: VIDEO_CAPABILITY_WARNING };
            // Ken "Send to GG Coder" prompts: restore the shimmer label, not the
            // full prompt body (matches live).
            if (h.kenSent && h.role === "user")
              return { kind: "user", id: nextId(), text: h.text, kenSent: true };
            // Persisted Ken (mentor) turns: his reply restores as a Ken bubble,
            // the `@Ken` question as a Ken-tinted user bubble (matches live).
            if (h.ken && h.role === "assistant") return { kind: "ken", id: nextId(), text: h.text };
            if (h.ken && h.role === "user")
              return { kind: "user", id: nextId(), text: h.text, ken: true };
            // Persisted autopilot verdict marker: render identically to the
            // live item so a resumed session never shows the raw verdict text
            // (e.g. "ALL_CLEAR") the model actually replied with.
            if (h.autopilot)
              return {
                kind: "autopilot",
                id: nextId(),
                phase: h.autopilot.phase,
                reason: h.autopilot.reason,
                body: h.autopilot.body,
                copySeed: h.autopilot.copySeed,
              };
            if (h.role !== "user") return { kind: h.role, id: nextId(), text: h.text };
            // App-button prompts (e.g. "Initialize Git") were shown live as a
            // friendly shimmer label, not the expanded body. The label is
            // webview-only, so recover it from the restored prompt text. Slash
            // commands are already collapsed to `/name` by the sidecar (h.command).
            const label = !h.command ? recoverPromptLabel(h.text) : null;
            // Recover @-referenced files appended to the prompt so resumed
            // sessions show the same file chips (and clean text) as when sent.
            const parsed = !h.command && label === null ? parseReferencedFiles(h.text) : null;
            return {
              kind: "user",
              id: nextId(),
              text: parsed ? parsed.text : h.text,
              command: h.command || label !== null,
              ...(label !== null ? { label } : {}),
              images: h.images && h.images.length > 0 ? h.images : undefined,
              ...(parsed && parsed.files.length > 0 ? { files: parsed.files } : {}),
              ...(h.enhancements && h.enhancements.length > 0
                ? { enhancements: h.enhancements }
                : {}),
            };
          }),
        );
      }
    } catch (err) {
      setStatus(`agent failed to start: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Reveal the footer + chrome now that everything we know about the
      // session is in hand — one fade-in, no staggered reflow.
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    const unsub = subscribe(handleEvent);
    return () => unsub();
  }, [handleEvent]);

  // Boot-time workspace restore: if Rust reopened THIS window from the saved
  // workspace (after a restart / update), its sidecar is already spawned at the
  // restored project + session. Skip the picker and hydrate straight in, exactly
  // like a completed project choice. Consume-once on the Rust side, so this runs
  // a single time on mount. Always flips `restoreChecked` so the entry render is
  // unblocked whether or not this was a restored window.
  useEffect(() => {
    // No cancelled-guard: the Rust target is consume-once, so whichever call
    // receives it MUST act on it (a dev StrictMode double-mount would otherwise
    // consume it on the first run and drop it, stranding the window on the
    // picker). React 19 makes a setState after unmount a safe no-op.
    void restoreTarget()
      .then((target) => {
        if (target) {
          setWorkspaceMode(target.mode);
          onProjectChosen();
        }
      })
      .finally(() => setRestoreChecked(true));
    // Mount-only: onProjectChosen reads stable setters; restoreTarget is consumed once.
  }, []);

  useEffect(() => {
    // Only the main window auto-connects to its default project. Secondary
    // (project-*) windows show the picker first and connect on selection.
    // hydrateNonce forces a re-run when re-selecting a session in an already-
    // connected window (needsProject stays false there).
    if (!needsProject) void hydrate();
  }, [needsProject, hydrate, hydrateNonce]);

  // Open the Tasks modal, refreshing the list from the sidecar first so it
  // reflects any tasks the agent just added.
  const openTasks = useCallback(() => {
    setShowTasks(true);
    void listTasks().then(setProjectTasks);
  }, []);

  // Run a single task: the sidecar opens a fresh session and streams progress
  // back (session_reset → task_start → run_start/…/run_end). Close the modal so
  // the transcript is visible while it runs.
  const handleRunTask = useCallback((id: string) => {
    setShowTasks(false);
    void runTask(id);
  }, []);

  // Run every pending task sequentially (a fresh session each), in order.
  const handleRunAllTasks = useCallback(() => {
    setShowTasks(false);
    void runAllTasks();
  }, []);

  const handleDeleteTask = useCallback((id: string) => {
    void deleteTask(id).then(setProjectTasks);
  }, []);

  // Per-project notes: load from localStorage whenever the active project (cwd)
  // changes, and write back on every edit. Keyed by cwd so each project keeps
  // its own notebook; windows pointed at the same project share one.
  const notesKey = state?.cwd ? `gg-notes:${state.cwd}` : null;
  useEffect(() => {
    if (!notesKey) {
      setNotes("");
      return;
    }
    try {
      setNotes(localStorage.getItem(notesKey) ?? "");
    } catch {
      setNotes("");
    }
  }, [notesKey]);

  const handleNotesChange = useCallback(
    (value: string) => {
      setNotes(value);
      if (!notesKey) return;
      try {
        localStorage.setItem(notesKey, value);
      } catch {
        // Storage full/unavailable — keep the in-memory value for this session.
      }
    },
    [notesKey],
  );

  // Pin Ken to a model (or null → clear the pin, follow GG Coder). The
  // sidecar's ken_model_change broadcast updates state; the .then is just a
  // faster local echo of the same payload.
  function onSelectKenModel(modelId: string | null): void {
    if (state && modelId !== null && state.kenModelOverride && modelId === state.kenModel) return;
    if (state && modelId === null && !state.kenModelOverride) return;
    void switchKenModel(modelId).then((res) => {
      if (res) {
        setState((s) =>
          s
            ? {
                ...s,
                kenProvider: res.kenProvider,
                kenModel: res.kenModel,
                kenModelOverride: res.kenModelOverride,
              }
            : s,
        );
      }
    });
  }

  function onSelectModel(modelId: string): void {
    if (state && modelId === state.model) return;
    void switchModel(modelId).then((res) => {
      if (res) {
        // Sakana Fugu easter egg: blow the fugu horn when a Fugu model is picked.
        if (res.model.startsWith("fugu")) playSound("fugu");
        setState((s) =>
          s
            ? {
                ...s,
                provider: res.provider,
                model: res.model,
                thinkingLevel: res.thinkingLevel,
                supportedThinkingLevels: res.supportedThinkingLevels,
              }
            : s,
        );
      }
    });
  }

  // Context-window usage percentage for the footer meter. 0 (hidden) until we
  // have both a window size and a real token reading from a completed turn.
  const contextPct =
    state?.contextWindow && contextTokens > 0
      ? Math.min(100, Math.round((contextTokens / state.contextWindow) * 100))
      : 0;

  // Workflow commands matching the current `/prefix` (only while the input is a
  // single `/token` with no space yet). Empty when not in slash mode.
  const slashQuery =
    input.startsWith("/") && !input.includes(" ") ? input.slice(1).toLowerCase() : null;
  // Commit lives in the top-right button, not the slash menu.
  const COMMIT_NAMES = ["commit", "setup-commit"];
  const menuCommands = commands.filter((c) => !COMMIT_NAMES.includes(c.name));
  const slashMatches =
    slashQuery !== null
      ? menuCommands.filter(
          (c) =>
            c.name.toLowerCase().startsWith(slashQuery) ||
            c.aliases.some((a) => a.toLowerCase().startsWith(slashQuery)),
        )
      : [];
  const slashOpen = slashMatches.length > 0;
  // Clamp so a shrinking match list never points past the end.
  const clampedSlashIndex = slashMatches.length > 0 ? slashIndex % slashMatches.length : 0;

  // `@Ken` is the mentor-agent address, not a file mention. When the input leads
  // with it (case-insensitive, word-boundary so `@kennedy.ts` still picks files),
  // Ken is "active": the file picker is suppressed and the input is tinted in
  // Ken's color with a shimmering marker, so it's obvious the message goes to Ken.
  const kenActive = workspaceMode === "code" && /^@ken\b/i.test(input.trimStart());
  // Split the input for the `@Ken` highlight overlay: any leading whitespace,
  // the literal `@Ken` token (preserving the user's casing), then the rest. Only
  // the token shimmers; lead+rest render in the normal input color.
  const kenInputParts = (() => {
    const m = /^(\s*)(@ken)/i.exec(input);
    if (!m) return null;
    return { lead: m[1], token: m[2], rest: input.slice(m[1].length + m[2].length) };
  })();
  // `@`-mention picker: open whenever a mention token is active and the search
  // returned at least one file. Clamp the highlighted row to the result count.
  // Never open while `@Ken` is active — that token addresses Ken, not a file.
  const mentionOpen = mention !== null && fileMatches.length > 0 && !kenActive;
  const clampedFileIndex = fileMatches.length > 0 ? fileIndex % fileMatches.length : 0;
  // Footer background-tasks indicator only shows while something is actually
  // running (exited tasks shouldn't keep the bar item around).
  const runningTaskCount = tasks.filter((t) => t.exitCode === null).length;

  // True when `text` is a known workflow command invocation (first token).
  function isWorkflowCommand(text: string): boolean {
    if (!text.startsWith("/")) return false;
    const name = text.slice(1).split(" ")[0]?.toLowerCase() ?? "";
    return commands.some(
      (c) => c.name.toLowerCase() === name || c.aliases.some((a) => a.toLowerCase() === name),
    );
  }

  // Top-right commit affordance: once a project-local `/commit` exists it shows
  // `/commit`; until then it offers `/setup-commit` to generate one. Only shown
  // when at least one of the two is available from the sidecar.
  const hasCommit = commands.some((c) => c.name === "commit");
  const hasSetupCommit = commands.some((c) => c.name === "setup-commit");
  const commitCommand = hasCommit ? "commit" : hasSetupCommit ? "setup-commit" : null;
  // Until the project is a git repo, setting up commits is pointless — offer
  // "Initialize Git" first (modal collects visibility + repo name, then drives
  // the agent). isGitRepo can be undefined on older sidecars / before hydrate;
  // only treat an explicit `false` as "not a repo".
  const needsGitInit = state?.isGitRepo === false;
  // Default repo name = the project folder name.
  const defaultRepoName = (state?.cwd ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";

  function pickSlashCommand(cmd: SlashCommand): void {
    // Fill the input with the command; the user can add args or press Enter.
    setInput(`/${cmd.name} `);
    setSlashIndex(0);
  }

  // Detect an active `@`-mention token at the caret: a `@` that starts at a word
  // boundary with no whitespace between it and the caret. Returns the query text
  // after `@` and the `@`'s index, or null when not in a mention.
  function detectMention(text: string, caret: number): { query: string; start: number } | null {
    const before = text.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at < 0) return null;
    // Must start at the line start or after whitespace.
    const prev = at > 0 ? before[at - 1] : " ";
    if (prev !== undefined && !/\s/.test(prev)) return null;
    const query = before.slice(at + 1);
    // A space ends the token — no mention once the path is followed by a space.
    if (/\s/.test(query)) return null;
    return { query, start: at };
  }

  // Sync the mention picker to the current input + caret on every change.
  function updateMention(text: string, caret: number): void {
    setMention(detectMention(text, caret));
  }

  // Debounced file search whenever the active mention query changes. Skipped when
  // `@Ken` is active so typing `@ken` never spawns a file lookup or picker.
  useEffect(() => {
    if (mention === null || kenActive) {
      setFileMatches([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void searchFiles(mention.query).then((files) => {
        if (!cancelled) {
          setFileMatches(files);
          setFileIndex(0);
        }
      });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mention, kenActive]);

  // Pick a file: drop the typed `@query` from the input, add the file as a chip
  // (deduped), and restore the caret where the token was. The path lives in chip
  // state, never in the textarea text.
  function pickMentionFile(file: FileHit): void {
    if (mention === null) return;
    const el = inputRef.current;
    const caret = el?.selectionStart ?? input.length;
    const head = input.slice(0, mention.start);
    const tail = input.slice(caret);
    const next = head + tail;
    setInput(next);
    setMentionedPaths((prev) => (prev.includes(file.path) ? prev : [...prev, file.path]));
    setMention(null);
    setFileMatches([]);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(head.length, head.length);
    });
  }

  // Drop a referenced-file chip.
  function removeMentionChip(p: string): void {
    setMentionedPaths((prev) => prev.filter((x) => x !== p));
  }

  // Submit arbitrary text as if typed + entered. Shared by the input and the
  // top-right commit button. `label` shows a friendly shimmer phrase in the
  // transcript while the full `text` is still sent to the agent.
  function submitText(text: string, label?: string): void {
    const trimmed = text.trim();
    if (!trimmed || !readyRef.current || running) return;
    // A user send always re-pins to the bottom — they want to see their message.
    stickToBottomRef.current = true;
    pushItem({
      kind: "user",
      id: nextId(),
      text: trimmed,
      command: label !== undefined || isWorkflowCommand(trimmed),
      ...(label !== undefined ? { label } : {}),
    });
    setInput("");
    setSlashIndex(0);
    endStreamingText();
    void sendPrompt(trimmed);
  }

  // Click handler for the "Send to GG Coder" button on Ken's recommended prompts.
  // Pushes a shimmering "Sent to GG Coder" user bubble (the full prompt body went
  // to GG Coder, but the transcript shows the short Ken-colored label, like a
  // slash command shows `/name`), then sends the prompt to the build session.
  const sendKenRecommendedPrompt = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !readyRef.current) return;
      stickToBottomRef.current = true;
      pushItem({ kind: "user", id: nextId(), text: trimmed, kenSent: true });
      endStreamingText();
      void sendPrompt(trimmed, [], { kenSent: true }).catch(() => {});
    },
    [pushItem, endStreamingText],
  );

  // Record a sent prompt for ↑/↓ recall (skips consecutive duplicates, capped).
  function recordHistory(text: string): void {
    const h = promptHistoryRef.current;
    if (text && h[h.length - 1] !== text) h.push(text);
    if (h.length > 200) h.shift();
    setHistoryIndex(null);
    historyDraftRef.current = "";
  }

  // Replace the input with a recalled history entry and park the caret at the end.
  function applyHistory(text: string): void {
    setInput(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.selectionStart = el.selectionEnd = el.value.length;
    });
  }

  // Walk prompt history with ↑ (dir -1, older) / ↓ (dir +1, newer). Returns true
  // when it consumed the key. Only triggers when the caret is on the first line
  // (↑) or last line (↓) so multi-line editing still moves the cursor normally.
  function navigateHistory(dir: -1 | 1, el: HTMLTextAreaElement): boolean {
    const hist = promptHistoryRef.current;
    if (hist.length === 0) return false;
    const collapsed = el.selectionStart === el.selectionEnd;
    const caret = el.selectionStart ?? 0;
    if (dir === -1) {
      const onFirstLine = collapsed && !el.value.slice(0, caret).includes("\n");
      if (!onFirstLine) return false;
      if (historyIndex === null) {
        historyDraftRef.current = el.value;
        const idx = hist.length - 1;
        setHistoryIndex(idx);
        applyHistory(hist[idx]);
      } else if (historyIndex > 0) {
        const idx = historyIndex - 1;
        setHistoryIndex(idx);
        applyHistory(hist[idx]);
      }
      return true; // consume even at the oldest entry
    }
    if (historyIndex === null) return false; // not navigating — let ↓ move the caret
    const onLastLine = collapsed && !el.value.slice(caret).includes("\n");
    if (!onLastLine) return false;
    if (historyIndex < hist.length - 1) {
      const idx = historyIndex + 1;
      setHistoryIndex(idx);
      applyHistory(hist[idx]);
    } else {
      setHistoryIndex(null);
      applyHistory(historyDraftRef.current);
    }
    return true;
  }

  // Apply a finished enhancement to the input: fill the textarea with the plain
  // text, stash the highlighted segments (drives the inline highlight overlay +
  // sent bubble), and park the caret at the end.
  function applyEnhanceResult(r: { enhanced: string; segments: PromptSegment[] }): void {
    setInput(r.enhanced);
    setEnhancement({ plain: r.enhanced, segments: r.segments });
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    });
  }

  // Run the prompt enhancer: rewrite the current draft via the active model into
  // a tighter, terminology-correct prompt. The result plays in over the input as
  // a Matrix dissolve→decode animation (unless reduced-motion), then fills it.
  async function runEnhance(): Promise<void> {
    const draft = input.trim();
    if (!draft || enhancing) return;
    setEnhanceHintVisible(false);
    setEnhancing(true);

    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced) {
      try {
        applyEnhanceResult(await enhancePrompt(draft));
      } catch {
        toast("Couldn't enhance the prompt", "error");
      } finally {
        setEnhancing(false);
      }
      return;
    }

    // Start the dissolve immediately (newText null), then flip to decode when the
    // enhancer returns. applyEnhanceResult + cleanup run in the animation's
    // onDone so the text never pops in before the decode settles.
    setEnhanceAnim({ oldText: draft, newText: null });
    try {
      const r = await enhancePrompt(draft);
      pendingEnhanceRef.current = r;
      setEnhanceAnim((a) => (a ? { ...a, newText: r.enhanced } : null));
    } catch {
      toast("Couldn't enhance the prompt", "error");
      setEnhanceAnim(null);
      setEnhancing(false);
    }
  }

  // The dissolve→decode animation finished: hand off to the real input WITHOUT a
  // flash. The decoded text lives in the .enh-diss overlay (on top); the textarea
  // sits hidden beneath it (.input-anim). If we removed the overlay and filled
  // the textarea in the same commit, you'd see the overlay text vanish and the
  // textarea text reflow/resize a frame later. So: fill the textarea FIRST (still
  // hidden under the overlay) and let useLayoutEffect size it, THEN drop the
  // overlay on the next frame — the sized text is already in place underneath.
  function onEnhanceAnimDone(): void {
    const r = pendingEnhanceRef.current;
    pendingEnhanceRef.current = null;
    if (r) {
      setInput(r.enhanced);
      setEnhancement({ plain: r.enhanced, segments: r.segments });
    }
    requestAnimationFrame(() => {
      setEnhanceAnim(null);
      setEnhancing(false);
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    });
  }

  // Show the corner "Enhance" pill whenever the input holds text — it stays put
  // (no debounce) and only hides when the box is empty. Shows even while the agent
  // is running, so a queued follow-up draft can be enhanced too: enhancePrompt is
  // a standalone one-shot call, independent of the agent loop. Still skipped mid-
  // enhance, with a menu open, or when the draft is already the current
  // enhancement (nothing left to improve).
  useEffect(() => {
    if (enhancing || !hydrated) return setEnhanceHintVisible(false);
    if (input.trim().length === 0) return setEnhanceHintVisible(false);
    if (slashOpen || mentionOpen) return setEnhanceHintVisible(false);
    if (enhancement && enhancement.plain === input) return setEnhanceHintVisible(false);
    setEnhanceHintVisible(true);
  }, [input, enhancing, hydrated, slashOpen, mentionOpen, enhancement]);

  // Submit the current input together with any staged attachments. Images are
  // echoed inline in the user's bubble; all media is sent to the agent.
  function submit(): void {
    const trimmed = input.trim();
    if (!readyRef.current) return;
    if (!trimmed && attachments.length === 0 && mentionedPaths.length === 0) return;

    // `@Ken <prompt>` (case-insensitive, optional colon) routes to Ken Kai, the
    // read-only mentor agent — NOT GG Coder. Ken runs concurrently with any
    // build run; his reply streams into a magenta bubble via ken_* events.
    const kenMatch = workspaceMode === "code" ? /^@ken\b:?\s*/i.exec(trimmed) : null;
    if (kenMatch) {
      const question = trimmed.slice(kenMatch[0].length).trim();
      if (!question) return;
      recordHistory(trimmed);
      stickToBottomRef.current = true;
      pushItem({ kind: "user", id: nextId(), text: trimmed, ken: true });
      setInput("");
      setSlashIndex(0);
      setMention(null);
      setMentionedPaths([]);
      setEnhancement(null);
      void sendKenPrompt(question);
      return;
    }

    recordHistory(trimmed);
    // A user send always re-pins to the bottom — they want to see their message.
    stickToBottomRef.current = true;
    // Referenced files are appended to the prompt as a small block so the agent
    // knows which paths to read; they aren't shown in the user's bubble text.
    const prompt =
      mentionedPaths.length > 0 ? appendReferencedFiles(trimmed, mentionedPaths) : trimmed;
    // Carry the enhancer's highlighted segments into the sent bubble ONLY when
    // the message is the unedited enhanced text (the bubble shows `trimmed`).
    const sentEnhancements =
      enhancement && enhancement.plain === trimmed ? enhancement.segments : undefined;
    // While a run is in flight, the message is QUEUED as steering (the sidecar
    // injects it mid-loop). Attachments queue too — they're persisted and ride
    // the same native-block path when the queue drains. Queued rows render
    // dimmed until run_end clears the flag.
    if (running) {
      const queuedWire = attachments.map(toWire);
      const queuedImgs = attachments.filter((a) => a.previewUrl).map((a) => a.previewUrl!);
      pushItem({
        kind: "user",
        id: nextId(),
        text: trimmed,
        command: isWorkflowCommand(trimmed),
        images: queuedImgs.length > 0 ? queuedImgs : undefined,
        files: mentionedPaths.length > 0 ? mentionedPaths : undefined,
        enhancements: sentEnhancements,
        queued: true,
      });
      setInput("");
      setAttachments([]);
      setSlashIndex(0);
      setMention(null);
      setMentionedPaths([]);
      setEnhancement(null);
      void sendPrompt(
        prompt,
        queuedWire,
        sentEnhancements ? { enhancements: sentEnhancements } : undefined,
      );
      return;
    }
    const wire = attachments.map(toWire);
    const imgPreviews = attachments.filter((a) => a.previewUrl).map((a) => a.previewUrl!);
    pushItem({
      kind: "user",
      id: nextId(),
      text: trimmed,
      command: isWorkflowCommand(trimmed),
      images: imgPreviews.length > 0 ? imgPreviews : undefined,
      files: mentionedPaths.length > 0 ? mentionedPaths : undefined,
      enhancements: sentEnhancements,
    });
    // Warn the user when a video attachment is sent to a model without native
    // video analysis — the agent can still use ffmpeg to extract frames/audio,
    // but can't watch the clip directly.
    if (wire.some((a) => a.kind === "video") && !(state?.supportsVideo ?? false)) {
      pushItem({
        kind: "info",
        id: nextId(),
        text: VIDEO_CAPABILITY_WARNING,
      });
    }
    setInput("");
    setAttachments([]);
    setSlashIndex(0);
    setMention(null);
    setMentionedPaths([]);
    setEnhancement(null);
    endStreamingText();
    void sendPrompt(
      prompt,
      wire,
      sentEnhancements ? { enhancements: sentEnhancements } : undefined,
    );
  }

  // ── Attachment intake (paste / attach button / whole-window drag-drop) ──
  async function addFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files);
    const pendings = await Promise.all(list.map((f) => fileToPending(f).catch(() => null)));
    const ok = pendings.filter((p): p is PendingAttachment => p !== null);
    if (ok.length > 0) setAttachments((prev) => [...prev, ...ok]);
  }

  // Native Tauri drop events hand us absolute paths, not browser File objects
  // (macOS/Linux keep the native drag-drop handler enabled so folder drops can
  // report a path at all — see build_app_window). Non-directory paths are read
  // here and staged exactly like a picked/pasted file.
  async function addNativeDroppedFiles(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const results = await Promise.all(paths.map((p) => readDroppedFileAttachment(p)));
    const ok = results
      .filter((a): a is Attachment => a !== null)
      .map((a) => attachmentToPending(a));
    if (ok.length > 0) setAttachments((prev) => [...prev, ...ok]);
  }

  function handleWindowDragEnter(e: React.DragEvent<HTMLDivElement>): void {
    if (!hasDraggedFiles(e.dataTransfer) || !canHandleWindowFileDrop()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setIsFileDragOver(true);
  }

  function handleWindowDragOver(e: React.DragEvent<HTMLDivElement>): void {
    if (!hasDraggedFiles(e.dataTransfer) || !canHandleWindowFileDrop()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setIsFileDragOver(true);
  }

  function handleWindowDragLeave(e: React.DragEvent<HTMLDivElement>): void {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    const nextTarget = e.relatedTarget;
    if (nextTarget instanceof Node && e.currentTarget.contains(nextTarget)) return;
    setIsFileDragOver(false);
  }

  function handleWindowDrop(e: React.DragEvent<HTMLDivElement>): void {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    setIsFileDragOver(false);
    if (!canHandleWindowFileDrop()) return;
    const files = filesForAttachment(e.dataTransfer);
    if (files.length > 0) void addFiles(files);
  }

  function removeAttachment(id: number): void {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  // ── Plan review actions (mirror the ggcoder CLI plan overlay) ──
  // Each closes the modal, drops a short info line, and drives the agent with
  // the corresponding instruction via the existing prompt path.
  function runPlanPrompt(prompt: string, info: string): void {
    setPlanReview(null);
    if (!readyRef.current || running) return;
    pushItem({ kind: "info", id: nextId(), text: info });
    endStreamingText();
    void sendPrompt(prompt);
  }

  async function acceptPlan(): Promise<void> {
    // Capture the approved plan's step count BEFORE the IPC — accepting starts a
    // fresh session on the sidecar, whose session_reset broadcast nulls
    // planReview (and clears the transcript + counters) here.
    const nextPlanTotal = planReview ? countPlanSteps(planReview) : 0;
    // Stash a fallback for older sidecars. The current sidecar puts its canonical
    // live-file count directly on session_reset, which wins over this snapshot.
    pendingPlanTotalRef.current = nextPlanTotal;
    // Accept the plan: the sidecar wipes the planning conversation into a FRESH
    // session (so the build doesn't carry all the plan-mode research), bakes the
    // approved plan into the new system prompt, and broadcasts authoritative
    // progress before this request resolves. Do not re-seed from stale modal
    // content after the await: the plan file may already have changed.
    await acceptPlanIPC(planReviewPathRef.current);
    runPlanPrompt(
      "The plan has been approved. Implement it now, following each step in order.",
      "\u2713 Plan accepted. Implementing.",
    );
  }

  function sendPlanFeedback(feedback: string): void {
    runPlanPrompt(
      `The plan was not approved. Feedback from the user:\n\n${feedback}\n\n` +
        "Revise the plan based on this feedback, then call exit_plan again for review.",
      "\u270e Feedback sent. Revising the plan.",
    );
  }

  function rejectPlan(): void {
    runPlanPrompt(
      "The plan was rejected and dismissed. Do not implement it. Wait for new instructions.",
      "\u2715 Plan rejected.",
    );
  }

  // Start a fresh session on this window's project. Clears the transcript only
  // after the sidecar confirms (it emits `session_reset`, handled below).
  async function startNewSession(): Promise<void> {
    if (newSessionBusy || running) return;
    setNewSessionBusy(true);
    try {
      await newSession();
      setConfirmNewSession(false);
    } catch {
      // Surface nothing extra — agent.ts logged it; keep the modal open.
    } finally {
      setNewSessionBusy(false);
    }
  }

  // Re-point this window at a freshly chosen project: clear the old transcript
  // and force a re-hydrate against the new sidecar. Bumping the nonce re-runs
  // the hydrate effect even when needsProject is already false (switching
  // sessions from the reopened picker), which flipping the boolean alone won't.
  function onProjectChosen(): void {
    stickToBottomRef.current = true;
    setItems([]);
    setLiveToolFeed([]);
    setState(null);
    setTasks([]);
    setContextTokens(0);
    setPlanReview(null);
    planTotalRef.current = 0;
    planDoneRef.current = new Set();
    setPlanTotal(0);
    setPlanDone(new Set());
    setAttachments([]);
    setQueuedCount(0);
    setHydrated(false);
    setNeedsProject(false);
    setHydrateNonce((n) => n + 1);
  }

  // Hold the entry render until the restore check resolves, so a window reopened
  // from the saved workspace jumps straight into its project instead of briefly
  // flashing the home/picker screen.
  if (needsProject && !restoreChecked) {
    return <div className="app" style={{ background: theme.background }} />;
  }

  if (needsProject) {
    return (
      <div className="app" style={{ background: theme.background }}>
        {entryView === "home" ? (
          <HomeScreen
            onProjects={() => {
              setWorkspaceMode("code");
              setEntryView("projects");
            }}
            onChat={() => {
              setWorkspaceMode("chat");
              setEntryView("chats");
            }}
            onLogin={() => setEntryView("login")}
          />
        ) : entryView === "login" ? (
          <LoginScreen onClose={() => setEntryView("home")} />
        ) : entryView === "chats" ? (
          <ChatPicker onChosen={onProjectChosen} onClose={() => setEntryView("home")} />
        ) : (
          <ProjectPicker
            onChosen={onProjectChosen}
            // Every window can return to the mode-neutral home screen.
            onClose={() => setEntryView("home")}
          />
        )}
        <Toaster />
      </div>
    );
  }

  // Picker reopened over an already-open workspace. Back from the picker returns
  // to the home screen; choosing a session resets and re-hydrates this window.
  if (showPicker) {
    const pickerProps = {
      onChosen: () => {
        setShowPicker(false);
        onProjectChosen();
      },
      onClose: () => {
        setShowPicker(false);
        setNeedsProject(true);
        setEntryView("home" as const);
      },
    };
    return (
      <div className="app" style={{ background: theme.background }}>
        {workspaceMode === "chat" ? (
          <ChatPicker initialAgent={state?.chatAgent ?? "general"} {...pickerProps} />
        ) : (
          <ProjectPicker initialProjectPath={state?.cwd ?? null} {...pickerProps} />
        )}
      </div>
    );
  }

  return (
    <div
      className={`app${isFileDragOver ? " app-file-dragover" : ""}${windowFocused ? " window-focused" : ""}`}
      style={{ background: theme.background }}
      onDragEnter={handleWindowDragEnter}
      onDragOver={handleWindowDragOver}
      onDragLeave={handleWindowDragLeave}
      onDrop={handleWindowDrop}
    >
      {confettiNonce && <Confetti key={confettiNonce} />}

      <WorkspaceHeader
        workspaceMode={workspaceMode}
        cwd={state?.cwd}
        gitBranch={state?.gitBranch}
        gitDirtyFileCount={state?.gitDirtyFileCount}
        navHidden={navHidden}
        onToggleNav={toggleNav}
        stripExtras={
          <>
            <TitleUsageMeter currentProvider={state?.provider ?? ""} />
            {windowTotal > 1 && windowIndex !== null && (
              <span
                className={`window-index${isThisFocused ? "" : " dim"}`}
                data-tauri-drag-region
                title={`Window ${windowIndex} of ${windowTotal} · ⌘\` to cycle`}
              >
                {windowIndex}/{windowTotal}
              </span>
            )}
          </>
        }
      >
        <BackButton
          label={workspaceMode === "chat" ? "Back to chats" : "Back to this project's sessions"}
          onClick={() => setShowPicker(true)}
        />
        <div className="rank-badge-wrap">
          <RankBadge
            snapshot={progress}
            celebrateNonce={rankCelebrateNonce}
            onClick={() => setShowScorecard(true)}
          />
          <div className="rank-xp-chip-layer" aria-hidden="true">
            {xpChips.map((chip) => (
              <span className="rank-xp-chip" key={chip.id}>
                {chip.label}
              </span>
            ))}
          </div>
        </div>
        {workspaceMode === "chat" ? (
          <span className="picker-head-actions">
            <button
              className="btn btn-primary btn-sm"
              disabled={running}
              title="Start a new chat"
              onClick={() => setConfirmNewSession(true)}
            >
              {"+ New"}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              title="View and curate chat memories and Jiwa"
              onClick={() => setShowMemories(true)}
            >
              Brain
            </button>
            <RadioButton />
            <WindowLayoutButton />
          </span>
        ) : (
          <>
            <span className="picker-head-actions">
              <AutopilotToggle
                checked={state?.autopilot ?? false}
                disabled={running || autopilotReviewing}
                onChange={(next) => {
                  setState((s) => (s ? { ...s, autopilot: next } : s));
                  void setAutopilot(next);
                  setKenPowerBanner(next ? "on" : "off");
                  // Dedicated cues for turning autopilot on/off (not the generic
                  // click, suppressed via data-suppress-click-sound).
                  playSound(next ? "autopilotOn" : "autopilotOff");
                }}
              />
              <button
                className="btn btn-primary btn-sm"
                disabled={running}
                title="Start a new session for this project"
                onClick={() => setConfirmNewSession(true)}
              >
                {"+ New"}
              </button>
              <button
                className="btn btn-sm btn-ghost"
                title="Open your notes for this project"
                onClick={() => setShowNotes(true)}
              >
                Notes
              </button>
              <button
                className="btn btn-sm btn-ghost"
                title="View and run this project's tasks"
                onClick={openTasks}
              >
                {projectTasks.some((t) => t.status !== "done")
                  ? `Tasks (${projectTasks.filter((t) => t.status !== "done").length})`
                  : "Tasks"}
              </button>
              <RadioButton />
              {/* <GazeButton /> */}
              <WindowLayoutButton
                onArrange={() => {
                  setNavHiddenPersisted(true);
                  setToolsHiddenPersisted(true);
                }}
              />
              {needsGitInit ? (
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={running}
                  title="Initialize git + create a GitHub repository"
                  onClick={() => setShowInitGit(true)}
                >
                  {"Initialize Git"}
                </button>
              ) : (
                commitCommand && (
                  <button
                    className={`btn btn-sm ${hasCommit ? "btn-success" : "btn-ghost"}`}
                    disabled={running}
                    title={hasCommit ? "Run /commit" : "Generate a /commit command"}
                    onClick={() =>
                      submitText(
                        `/${commitCommand}`,
                        hasCommit ? "Committing\u2026" : "Setting up commits\u2026",
                      )
                    }
                  >
                    {`/${commitCommand}`}
                  </button>
                )
              )}
            </span>
          </>
        )}
      </WorkspaceHeader>

      {/* Non-scrolling frame the same size as the chat viewport. The banner
          lives HERE, not inside `.transcript` — `.transcript` scrolls, and an
          absolutely positioned child of a scrolling container is pinned to the
          top of the scrolled CONTENT, not the visible viewport, so in an
          existing session scrolled down it rendered far above what's on
          screen. Anchoring to this non-scrolling sibling keeps it pinned to
          what the user is actually looking at, at any scroll position. */}
      <div className="transcript-frame">
        {workspaceMode === "code" && kenPowerBanner && (
          <KenPowerBanner mode={kenPowerBanner} onDone={() => setKenPowerBanner(null)} />
        )}
        <div className="transcript" ref={scrollRef} onScroll={onTranscriptScroll}>
          {!hydrated && items.length === 0 ? (
            <TranscriptSkeleton />
          ) : (
            <>
              {items.length === 0 &&
                (status === "ready" ? (
                  <WakeScreen chat={workspaceMode === "chat"} />
                ) : (
                  <div className="line transcript-reveal" style={{ color: theme.textDim }}>
                    {`\u273b ${status}`}
                  </div>
                ))}
              <PromptSendProvider value={sendKenRecommendedPrompt}>
                {items.map((it) => (
                  <TranscriptRow key={it.id} item={it} onImageLoad={maybeScrollToBottom} />
                ))}
              </PromptSendProvider>
            </>
          )}
        </div>
      </div>

      <div className="liveregion">
        {workspaceMode === "code" && autopilotReviewing && (
          <AutopilotReviewBar onCancel={requestCancel} />
        )}
        {workspaceMode === "code" && kenRunning && (
          <KenActivityBar
            runStartTs={kenRunStartTs}
            tokens={kenTokens}
            isThinking={kenIsThinking}
            thinkingStartTs={kenThinkingStartTs}
            thinkingAccumMs={kenThinkingAccumMs}
            onCancel={() => void cancelKen()}
          />
        )}
        {!toolsHidden && <LiveToolPanel entries={liveToolFeed} />}
        {/* Ken's bar (chat OR autopilot review) REPLACES the main bar while the
            build is idle — otherwise the idle "Ready for work" line stacks under
            Ken's spinner. When the build is also running, both bars show. */}
        {(workspaceMode === "chat" || running || (!kenRunning && !autopilotReviewing)) && (
          <ActivityBar
            running={running}
            cancelling={cancelling}
            tokens={tokens}
            doneStatus={doneStatus}
            isThinking={isThinking}
            thinkingStartTs={thinkingStartTs}
            thinkingAccumMs={thinkingAccumMs}
            planTotal={workspaceMode === "chat" ? 0 : planTotal}
            planDone={workspaceMode === "chat" ? 0 : Math.min(planDone.size, planTotal)}
            onCancel={requestCancel}
            toolsHidden={toolsHidden}
            hasToolFeed={liveToolFeed.length > 0}
            onToggleTools={toggleTools}
          />
        )}
      </div>

      <div className={`inputwrap${isFileDragOver ? " dragover" : ""}`}>
        {slashOpen && (
          <SlashMenu
            commands={slashMatches}
            activeIndex={clampedSlashIndex}
            onSelect={pickSlashCommand}
            onHover={setSlashIndex}
          />
        )}
        {mentionOpen && (
          <FileMentionMenu
            files={fileMatches}
            activeIndex={clampedFileIndex}
            isRecent={mention?.query === ""}
            onSelect={pickMentionFile}
            onHover={setFileIndex}
          />
        )}
        <AttachmentBar attachments={attachments} onRemove={removeAttachment} />
        <ReferencedFiles paths={mentionedPaths} onRemove={removeMentionChip} />
        {queuedCount > 0 && (
          <div className="queued-bar">
            <span className="queued-dot" />
            {`${queuedCount} message${queuedCount === 1 ? "" : "s"} queued · will send after this run`}
          </div>
        )}
        <div className="inputrow">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,video/*"
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            className="attach-btn"
            title="Attach files"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={16} />
          </button>
          <span className="prompt" style={{ color: theme.primary }}>
            {">"}
          </span>
          <div className="input-stack">
            {enhanceAnim && (
              <EnhanceDissolve
                oldText={enhanceAnim.oldText}
                newText={enhanceAnim.newText}
                onDone={onEnhanceAnimDone}
              />
            )}
            {/* `@Ken` active: a textarea can't color just one token, so we mirror
                the input in an aligned overlay where the leading `@Ken` shimmers
                in Ken's color. The textarea text below is made transparent (caret
                stays visible) so only this styled copy shows. Metrics match
                `.input` 1:1 so wrapping/caret line up. */}
            {kenActive && kenInputParts && (
              <div className="ken-input-highlight" aria-hidden="true">
                {kenInputParts.lead}
                <ShimmerText base={theme.ken} bright="#ffffff">
                  {kenInputParts.token}
                </ShimmerText>
                {kenInputParts.rest}
              </div>
            )}
            <textarea
              ref={inputRef}
              className={`input${enhanceAnim ? " input-anim" : ""}${kenActive ? " input-ken" : ""}`}
              rows={1}
              // Lock the input while the dissolve→decode animation plays: the caret
              // is invisible, so typing would be silently discarded and Enter would
              // submit the un-enhanced draft mid-animation.
              readOnly={enhanceAnim !== null}
              value={input}
              placeholder={workspaceMode === "chat" ? "Ask anything\u2026" : displayPlaceholder}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
                if (files.length > 0) {
                  e.preventDefault();
                  void addFiles(files);
                }
              }}
              onChange={(e) => {
                setInput(e.target.value);
                setSlashIndex(0);
                // Typing exits history-recall mode so ↑/↓ start fresh next time.
                if (historyIndex !== null) setHistoryIndex(null);
                // Drop the enhancement the instant the text diverges from it, so
                // the highlighted preview/bubble never misalign with edited text.
                if (enhancement && e.target.value !== enhancement.plain) setEnhancement(null);
                updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onClick={(e) => {
                const el = e.currentTarget;
                updateMention(el.value, el.selectionStart ?? el.value.length);
              }}
              onKeyUp={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  const el = e.currentTarget;
                  updateMention(el.value, el.selectionStart ?? el.value.length);
                }
              }}
              onKeyDown={(e) => {
                // While the dissolve→decode animation plays the input is locked;
                // swallow keys so Enter can't submit the un-enhanced draft.
                if (enhanceAnim) {
                  e.preventDefault();
                  return;
                }
                if (mentionOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                  e.preventDefault();
                  const delta = e.key === "ArrowDown" ? 1 : -1;
                  setFileIndex((i) => (i + delta + fileMatches.length) % fileMatches.length);
                } else if (mentionOpen && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
                  e.preventDefault();
                  const file = fileMatches[clampedFileIndex];
                  if (file) pickMentionFile(file);
                } else if (mentionOpen && e.key === "Escape") {
                  e.preventDefault();
                  setMention(null);
                } else if (slashOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                  e.preventDefault();
                  const delta = e.key === "ArrowDown" ? 1 : -1;
                  setSlashIndex((i) => (i + delta + slashMatches.length) % slashMatches.length);
                } else if (slashOpen && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
                  e.preventDefault();
                  const cmd = slashMatches[clampedSlashIndex];
                  if (cmd) pickSlashCommand(cmd);
                } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                  // Menus are closed here (handled above), so arrows recall sent
                  // prompts shell-style — unless the caret is mid-text in a
                  // multi-line draft, where navigateHistory declines and the
                  // cursor moves normally.
                  if (navigateHistory(e.key === "ArrowUp" ? -1 : 1, e.currentTarget)) {
                    e.preventDefault();
                  }
                } else if (e.key === "Enter" && !e.shiftKey) {
                  // Enter sends; Shift+Enter inserts a newline (textarea default).
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  // Cancel the build if it's running; otherwise cancel Ken so the
                  // "esc to cancel" on his bar actually works.
                  if (slashOpen) setInput("");
                  else if (running && !cancelling) requestCancel();
                  else if (kenRunning) void cancelKen();
                }
              }}
              autoFocus
            />
          </div>
        </div>
        {!enhanceAnim && (
          // Pill pinned to the center of the input box (.inputwrap) top border,
          // overlapping it. Decoupled from text flow, so it never overlaps text,
          // drifts, or shifts the caret/height; centered (not in a corner) to
          // stay clear of the status row's "esc to cancel". Always mounted (so it
          // can transition both ways); the `visible` class fades/slides it in
          // when there's text and out when there isn't.
          <button
            className={`enhance-pill${enhanceHintVisible ? " visible" : ""}${enhancing ? " enhancing" : ""}`}
            title="Enhance prompt — clearer wording + correct terms"
            disabled={enhancing || !enhanceHintVisible}
            aria-hidden={!enhanceHintVisible}
            onClick={() => void runEnhance()}
          >
            {enhancing ? "Enhancing…" : "Enhance?"}
          </button>
        )}
      </div>

      <div
        className={`footer${workspaceMode === "chat" ? " footer-chat" : ""}`}
        style={{ color: theme.footerText }}
      >
        {!hydrated ? (
          <FooterSkeleton />
        ) : (
          <>
            {workspaceMode === "chat" ? (
              <span
                className="footer-left footer-reveal"
                style={{ color: theme.textDim, fontFamily: "var(--mono)" }}
              >
                {state?.chatAgent === "therapist"
                  ? "Therapist Agent"
                  : state?.chatAgent === "research"
                    ? "Research Agent"
                    : "General Agent"}
              </span>
            ) : (
              <span className="footer-left footer-reveal" style={{ fontFamily: "var(--mono)" }}>
                {runningTaskCount > 0 && <BackgroundTasksButton tasks={tasks} />}
                {state?.planMode && (
                  <>
                    {runningTaskCount > 0 && <FooterSep />}
                    <span className="footer-plan">
                      <ShimmerText base={theme.secondary} bright="#ddd6fe">
                        {"\u25C6 plan mode"}
                      </ShimmerText>
                    </span>
                  </>
                )}
              </span>
            )}
            <span className="footer-right footer-reveal">
              {contextPct > 0 && (
                <>
                  <ContextMeter pct={contextPct} />
                  <FooterSep />
                </>
              )}
              {(state?.supportedThinkingLevels?.length ?? 0) > 0 &&
                (() => {
                  const level = state?.thinkingLevel ?? null;
                  const label = level ? `Thinking ${level}` : "Thinking off";
                  const maxPower = level === "xhigh" || level === "max";
                  return (
                    <>
                      <button
                        className="thinking-toggle"
                        style={{
                          color: thinkingColor(level),
                          fontWeight: level === "high" ? 600 : 400,
                        }}
                        title="Cycle reasoning level"
                        onClick={() => void cycleThinking()}
                      >
                        {maxPower ? (
                          <ShimmerText base={MAX_POWER_COLOR} bright={MAX_POWER_SHIMMER}>
                            {label}
                          </ShimmerText>
                        ) : (
                          label
                        )}
                      </button>
                      <FooterSep />
                    </>
                  );
                })()}
              <span className="model-anchor">
                <span className="model-label" style={{ color: theme.text }}>
                  GG
                </span>
                <ModelSelect
                  models={models}
                  currentModel={state?.model ?? ""}
                  onSelect={onSelectModel}
                  disabled={running}
                  title={workspaceMode === "chat" ? "Switch GG's model" : "Switch GG Coder's model"}
                />
              </span>
              {workspaceMode === "code" && (
                <>
                  <FooterSep />
                  <span className="model-anchor">
                    <span className="model-label" style={{ color: theme.ken }}>
                      Ken
                    </span>
                    <ModelSelect
                      models={models}
                      currentModel={state?.kenModel ?? state?.model ?? ""}
                      onSelect={(id) => onSelectKenModel(id)}
                      color={theme.ken}
                      title={
                        state?.kenModelOverride
                          ? "Ken is pinned to his own model — click to change"
                          : "Ken follows GG Coder's model — click to pin one"
                      }
                      onSelectFollow={() => onSelectKenModel(null)}
                      followActive={!state?.kenModelOverride}
                    />
                  </span>
                </>
              )}
            </span>
          </>
        )}
      </div>

      {appUpdate.phase === "available" && (
        <button
          className="update-banner"
          title={`Update to ${appUpdate.version} — installs and restarts the app`}
          onClick={() => void appUpdate.install()}
        >
          <span className="update-banner-dot" />
          {"Ken just updated GG Coder!"}
          <Badge>Install</Badge>
        </button>
      )}
      {appUpdate.phase === "installing" && (
        // Same .update-banner box (padding/font) as the available state, so
        // banner → progress bar swaps content with zero layout shift. The fill
        // is absolutely positioned; only the centered percentage is in flow.
        <div
          className="update-banner update-banner-busy update-banner-progress"
          role="progressbar"
          aria-valuenow={appUpdate.progress ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Downloading update"
        >
          <span className="update-banner-fill" style={{ width: `${appUpdate.progress ?? 0}%` }} />
          <span className="update-banner-pct">{`${appUpdate.progress ?? 0}%`}</span>
        </div>
      )}

      {workspaceMode === "code" && showInitGit && (
        <InitGitModal
          defaultName={defaultRepoName}
          onClose={() => setShowInitGit(false)}
          onInitialize={(prompt) => {
            setShowInitGit(false);
            submitText(prompt, "Initializing Git\u2026");
          }}
        />
      )}

      {confirmNewSession && (
        <ConfirmModal
          title={workspaceMode === "chat" ? "New Chat" : "New Session"}
          message={
            workspaceMode === "chat"
              ? "This will create a new chat. The current conversation will be cleared. Are you sure?"
              : "This will create a new session for this project. The current conversation will be cleared. Are you sure?"
          }
          confirmLabel={workspaceMode === "chat" ? "New Chat" : "New Session"}
          busy={newSessionBusy}
          onConfirm={() => void startNewSession()}
          onClose={() => setConfirmNewSession(false)}
        />
      )}

      {workspaceMode === "code" && planReview !== null && (
        <PlanReviewModal
          content={planReview}
          // Autopilot Ken reviews submitted plans himself; the indicator tells
          // the user, but manual Accept/Reject stays live and always wins.
          kenReviewing={autopilotReviewing}
          onAccept={acceptPlan}
          onFeedback={sendPlanFeedback}
          onReject={rejectPlan}
        />
      )}

      {workspaceMode === "chat" && showMemories && (
        <MemoryModal onClose={() => setShowMemories(false)} />
      )}

      {workspaceMode === "code" && showNotes && (
        <NotesModal
          value={notes}
          onChange={handleNotesChange}
          onClose={() => setShowNotes(false)}
        />
      )}

      {showScorecard && progress && (
        <ScorecardModal snapshot={progress} onClose={() => setShowScorecard(false)} />
      )}

      {workspaceMode === "code" && showTasks && (
        <TasksModal
          tasks={projectTasks}
          running={running}
          onRun={handleRunTask}
          onRunAll={handleRunAllTasks}
          onDelete={handleDeleteTask}
          onClose={() => setShowTasks(false)}
        />
      )}
    </div>
  );
}

// ── Row renderers ──────────────────────────────────────────
// Memoized per row: the streaming run rebuilds the `items` array on every
// `text_delta`, but `appendAssistant` returns the SAME object reference for
// every non-streaming row, and `onImageLoad` is a stable useCallback. So a
// default shallow `memo` re-renders ONLY the row whose `item` reference changed
// (the one actively streaming) — the rest bail out, keeping per-token cost O(1)
// instead of O(transcript length).
const TranscriptRow = memo(function TranscriptRow({
  item,
  onImageLoad,
}: {
  item: Item;
  onImageLoad?: () => void;
}): React.ReactElement | null {
  switch (item.kind) {
    case "user":
      if (item.kenSent) {
        // Sent from a Ken "Send to GG Coder" button: show a shimmering "Sent to GG
        // Coder" in Ken's color (like a slash command shows `/name`), not the
        // full prompt body. The full body still went to GG Coder.
        return (
          <div className="user-msg command labelled user-ken-sent">
            <span className="command-shimmer" style={{ color: theme.ken }}>
              Sent to GG Coder
            </span>
          </div>
        );
      }
      if (item.command) {
        // Workflow command: show just the short `/name` (or a friendly `label`
        // phrase) with a highlight + shimmer sweep. The full expanded prompt
        // was sent to the agent. Labels read as prose, so drop the mono font.
        return (
          <div className={`user-msg command${item.label ? " labelled" : ""}`}>
            <span className="command-shimmer" style={{ color: theme.commandColor }}>
              {item.label ?? item.text}
            </span>
          </div>
        );
      }
      return (
        <div className={`user-msg${item.queued ? " queued" : ""}${item.ken ? " user-ken" : ""}`}>
          {item.queued && <span className="queued-pill">queued</span>}
          {item.images && item.images.length > 0 && (
            <div className="user-img-row">
              {item.images.map((src, i) => (
                <img key={i} className="user-img" src={src} alt="attachment" onLoad={onImageLoad} />
              ))}
            </div>
          )}
          {item.enhancements && item.enhancements.some((s) => s.kind === "term") ? (
            <EnhancedSegments segments={item.enhancements} />
          ) : (
            item.text
          )}
          {item.files && item.files.length > 0 && (
            <div className="user-files-row">
              {item.files.map((p) => (
                <span key={p} className="user-file-chip" title={p}>
                  <AtSign size={11} style={{ color: theme.accent }} />
                  <span style={{ color: theme.code }}>{p}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      );
    case "assistant": {
      // Split out [DONE:n] plan-step markers so each renders as a "✓ Step n"
      // completion row instead of leaking the raw marker into the prose.
      const segments = hasDoneMarker(item.text)
        ? segmentDoneMarkers(item.text)
        : [{ kind: "text" as const, text: item.text }];
      return (
        <>
          {segments.map((seg, i) =>
            seg.kind === "done" ? (
              <div key={i} className="plan-step-done">
                <span className="plan-step-check" aria-hidden="true">
                  {"\u2713"}
                </span>
                <span className="plan-step-label">{`Step ${seg.stepNum} completed`}</span>
              </div>
            ) : (
              <div key={i} className="assistant-msg">
                <span className="assistant-dot" style={{ color: theme.primary }}>
                  {DOT}
                </span>
                <div className="assistant-text">
                  <Markdown>{seg.text}</Markdown>
                </div>
              </div>
            ),
          )}
        </>
      );
    }
    case "ken":
      // Ken Kai's reply: the whole bubble is tinted in Ken's color (dot + all
      // text), which is the ONLY differentiator from a normal GG Coder reply.
      // No badge, no byline. The Markdown component special-cases ```prompt
      // fences into a "Send to GG Coder" button.
      return (
        <div className="assistant-msg ken-msg">
          <span className="assistant-dot" style={{ color: theme.ken }}>
            {DOT}
          </span>
          <div className="assistant-text">
            <Markdown>{item.text}</Markdown>
          </div>
        </div>
      );
    case "autopilot": {
      // Autopilot Ken's verdict, rendered like a normal @Ken reply (Ken-tinted
      // dot + text) rather than its own marker style. The text is his verdict as
      // prose: for a PROMPT he shows what he sent GG Coder back to do; the
      // terminal verdicts read as short Ken one-liners. `done` rotates through
      // several casual Ken lines (picked deterministically off the item's
      // stable id, so it never flickers on re-render) instead of always
      // repeating the exact same sentence turn after turn.
      const copy: Record<Extract<Item, { kind: "autopilot" }>["phase"], string> = {
        prompted: item.body?.trim()
          ? `Sending GG Coder back in:\n\n${item.body.trim()}`
          : "Sending GG Coder back in for another pass.",
        done: allClearCopy(item.copySeed, item.id),
        human: item.reason?.trim() ? item.reason.trim() : "Need you to weigh in on this one.",
        capped: "Paused autopilot after 3 rounds. Take a look before I keep going.",
        plan_approved: "Plan looks solid. Approved it — implementation is underway.",
      };
      return (
        <div className="assistant-msg ken-msg">
          <span className="assistant-dot" style={{ color: theme.ken }}>
            {DOT}
          </span>
          <div className="assistant-text">
            <Markdown>{copy[item.phase]}</Markdown>
          </div>
        </div>
      );
    }
    case "info":
      return (
        <div className="line info" style={{ color: theme.textDim }}>
          {item.text}
        </div>
      );
    case "error": {
      // Structured errors (see gg-ai's formatError) always answer "is this me or
      // them" and, for usage-limit stops, when it resets — mirrors the CLI's
      // ErrorRow instead of dumping the raw provider string. `text` is the
      // legacy fallback for items that only ever carried a flat string.
      const headline = item.headline ?? item.text ?? "";
      const showMessage = item.message && item.message !== headline;
      return (
        <div className="line error">
          <div style={{ color: theme.error, fontWeight: 600 }}>{headline}</div>
          {showMessage && <div style={{ color: theme.textDim }}>{item.message}</div>}
          {item.guidance && <div style={{ color: theme.textDim }}>{item.guidance}</div>}
        </div>
      );
    }
    case "hook": {
      // Mirrors the TUI IdealHookMessage: assistant-style dot + a shimmering
      // tone-colored one-liner so the self-correction is obvious.
      const { text, color } = HOOK_PRESENTATION[item.hook];
      return (
        <div className="assistant-msg">
          <span className="assistant-dot" style={{ color }}>
            {DOT}
          </span>
          <div className="assistant-text">
            <ShimmerText base={color} bright="#ffffff">
              {text}
            </ShimmerText>
          </div>
        </div>
      );
    }
    case "images":
      return (
        <div className="img-grid">
          {item.images.map((img, i) => {
            const openImage = (): void => {
              if (img.path) void openProjectPath(img.path);
            };
            return (
              <figure
                key={img.path ?? i}
                className={`img-card${img.path ? " img-card-clickable" : ""}`}
                role={img.path ? "button" : undefined}
                tabIndex={img.path ? 0 : undefined}
                title={img.path ? `Open ${img.path}` : undefined}
                onClick={openImage}
                onKeyDown={(e) => {
                  if (!img.path || (e.key !== "Enter" && e.key !== " ")) return;
                  e.preventDefault();
                  openImage();
                }}
              >
                <img
                  className="img-thumb"
                  src={img.src}
                  alt={img.path ?? "image"}
                  onLoad={onImageLoad}
                />
                {img.path && (
                  <figcaption className="img-cap" title={img.path}>
                    {img.path.split("/").filter(Boolean).pop()}
                  </figcaption>
                )}
              </figure>
            );
          })}
        </div>
      );
    case "generating_image":
      return (
        <div className="img-grid">
          <div className="img-gen-placeholder">
            <Skeleton width={200} height={200} radius={12} />
            <span className="img-gen-label">
              {item.prompt.length > 60 ? item.prompt.slice(0, 57) + "\u2026" : item.prompt}
            </span>
          </div>
        </div>
      );
    case "plan":
      return <PlanModeLogo reason={item.reason} />;
    case "task":
      return (
        <div className="line task-row">
          <span className="task-row-glyph" style={{ color: theme.primary }}>
            {"\u25B8 "}
          </span>
          <span style={{ color: theme.textMuted }}>{"Task: "}</span>
          <span style={{ color: theme.text, fontWeight: 600 }}>{item.title}</span>
        </div>
      );
    case "subagent_group":
      return <SubAgentFeed agents={item.agents} aborted={item.aborted} />;
    case "compaction":
      return (
        <CompactionNotice
          status={item.status}
          originalCount={item.originalCount}
          newCount={item.newCount}
        />
      );
    default:
      return null;
  }
});

export default App;
