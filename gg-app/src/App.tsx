import { useState, useRef, useEffect, useLayoutEffect, useCallback, memo } from "react";
import { theme } from "./theme";
import {
  waitForReady,
  getState,
  sendPrompt,
  cancel,
  newSession,
  cycleThinking,
  listModels,
  switchModel,
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
  type SidecarEvent,
  type AgentState,
  type ModelOption,
  type SlashCommand,
  type BackgroundTask,
  type ProjectTask,
  type FileHit,
  searchFiles,
  enhancePrompt,
  type PromptSegment,
} from "./agent";
import { ActivityBar, formatTokenCount } from "./ActivityBar";
import { LiveToolPanel, type LiveToolEntry, LIVE_TOOL_PANEL_ROWS } from "./LiveToolPanel";
import { SubAgentFeed, type SubAgentLine } from "./SubAgentFeed";
import { CompactionNotice } from "./CompactionNotice";
import { ModelMenu } from "./ModelMenu";
import { SlashMenu } from "./SlashMenu";
import { FileMentionMenu } from "./FileMentionMenu";
import { ReferencedFiles, appendReferencedFiles, parseReferencedFiles } from "./ReferencedFiles";
import { ContextMeter } from "./ContextMeter";
import { BackgroundTasksButton } from "./BackgroundTasksButton";
import { TasksModal } from "./TasksModal";
import { NotesModal } from "./NotesModal";
import { ShimmerText } from "./ShimmerText";
import { WakeScreen } from "./WakeScreen";
import { ConfirmModal } from "./ConfirmModal";
import { InitGitModal } from "./InitGitModal";
import { PlanModeLogo } from "./PlanModeLogo";
import { PlanReviewModal } from "./PlanReviewModal";
import { WindowLayoutButton } from "./WindowLayoutButton";
// Experimental gaze focus — disabled for now (see main.tsx).
// import { GazeButton } from "./GazeButton";
import { RadioButton } from "./RadioButton";
import { ProjectPicker } from "./ProjectPicker";
import { BackButton } from "./BackButton";
import { HomeScreen } from "./HomeScreen";
import { Toaster } from "./Toaster";
import { LoginScreen } from "./LoginScreen";
import { Markdown } from "./Markdown";
import { FooterSkeleton, TranscriptSkeleton, Skeleton } from "./Skeleton";
import { useAppUpdate } from "./update";
import { recoverPromptLabel } from "./prompt-labels";
import { playSound } from "./sounds";
import {
  segmentDoneMarkers,
  hasDoneMarker,
  countPlanSteps,
  findCompletedSteps,
} from "./plan-steps";
import { Paperclip, AtSign } from "lucide-react";
import { AttachmentBar } from "./AttachmentBar";
import { EnhancedSegments } from "./PromptEnhancement";
import { EnhanceDissolve } from "./EnhanceDissolve";
import { toast } from "./toast";
import { fileToPending, toWire, type PendingAttachment } from "./attachments";
import "./App.css";

// ── Transcript model ───────────────────────────────────────
// Tool activity lives in the pinned LiveToolPanel, never in the transcript.
type Item =
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
    }
  | { kind: "assistant"; id: number; text: string }
  | { kind: "info"; id: number; text: string }
  | { kind: "error"; id: number; text: string }
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
    };

export interface TranscriptImage {
  /** data: URL (base64) ready to drop into <img src>. */
  src: string;
  /** Source file path, shown as a caption + used as a stable key. */
  path?: string;
}

/** Tool detail image preview (screenshot / read), mirrors the sidecar shape. */
interface ImagePreview {
  base64: string;
  mediaType: string;
  path?: string;
}

// Hook kind → notice copy + tone color, mirroring the TUI's app-items.ts.
type HookKind = "ideal" | "loop_break" | "regrounding";
const HOOK_PRESENTATION: Record<HookKind, { text: string; color: string }> = {
  ideal: {
    text: "Hook engaged. Running an ideal review before finalizing.",
    color: theme.secondary,
  },
  loop_break: {
    text: "Hook engaged. Breaking a stuck loop and rethinking the approach.",
    color: theme.warning,
  },
  regrounding: {
    text: "Hook engaged. Re-grounding on the original request after compaction.",
    color: theme.primary,
  },
};

let idSeq = 0;
const nextId = (): number => ++idSeq;

// Last path segment of a cwd (the project folder name), mirroring the TUI footer
// which shows only the current directory rather than the full path.
function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

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

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

// Port of packages/ggcoder/src/ui/duration-summary.ts, adapted to the sidecar's
// underscore tool names. Picks a contextual done-verb from which tools ran.
function pickDoneVerb(toolsUsed: ReadonlySet<string>): string {
  const has = (name: string): boolean => toolsUsed.has(name);
  const writing = has("edit") || has("write");
  const reading = has("read") || has("grep") || has("find") || has("ls");

  if (has("subagent") && writing) return "Orchestrated changes in";
  if (has("subagent")) return "Delegated work in";
  if (has("web_fetch") && writing) return "Researched & coded in";
  if (has("web_fetch") && reading) return "Researched in";
  if (has("web_fetch")) return "Fetched the web in";
  if (has("bash") && writing) return "Built & ran in";
  if (has("edit") && has("write")) return "Crafted code in";
  if (has("edit") && has("bash")) return "Refactored & tested in";
  if (has("edit")) return "Refactored in";
  if (has("write") && has("bash")) return "Wrote & ran in";
  if (has("write")) return "Wrote code in";
  if (has("bash") && has("grep")) return "Hacked away in";
  if (has("bash") && reading) return "Ran & investigated in";
  if (has("bash")) return "Executed commands in";
  if (has("grep") && has("read")) return "Investigated in";
  if (has("grep") && has("find")) return "Scoured the codebase in";
  if (has("grep")) return "Searched in";
  if (has("read") && has("find")) return "Explored in";
  if (has("read")) return "Studied the code in";
  if (has("find") || has("ls")) return "Browsed files in";

  const phrases = [
    "Brewed up a response in",
    "Cooked up an answer in",
    "Worked out a reply in",
    "Conjured a response in",
    "Pondered for",
    "Reasoned for",
  ];
  return phrases[Math.floor(Math.random() * phrases.length)] ?? "Worked in";
}

function hasDraggedFiles(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}

function App(): React.ReactElement {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
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
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("connecting to agent\u2026");
  const [liveToolFeed, setLiveToolFeed] = useState<LiveToolEntry[]>([]);
  const [tokens, setTokens] = useState(0);
  const [doneStatus, setDoneStatus] = useState<string | null>(null);
  // LLM-generated session title shown in the titlebar ("GG Coder" until set).
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
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
  // Plan step count to (re)apply right after an accept-driven session_reset.
  // Accepting a plan starts a fresh session whose session_reset clears the
  // counters; this carries the approved plan's step total across that reset so
  // the Plan Steps widget doesn't get stuck at 0. Null when no accept is pending.
  const pendingPlanTotalRef = useRef<number | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingStartTs, setThinkingStartTs] = useState<number | null>(null);
  const [thinkingAccumMs, setThinkingAccumMs] = useState(0);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
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
  const [notes, setNotes] = useState("");
  // Every window picks a project before connecting — on app load and on each new
  // window. The picker re-points this window's agent at the chosen cwd/session.
  const [needsProject, setNeedsProject] = useState(true);
  // False until the boot-time workspace-restore check resolves. Gates the entry
  // render so a window reopened from the saved workspace (after a restart /
  // update) never flashes the picker before jumping into its restored project.
  const [restoreChecked, setRestoreChecked] = useState(false);
  // Entry-screen routing while no project is open: the home landing, the
  // project chooser, or the provider login hub. Secondary windows (opened via
  // the Windows button) skip the home screen and land on "Choose a project".
  const [entryView, setEntryView] = useState<"home" | "projects" | "login">(
    isSecondaryWindow ? "projects" : "home",
  );
  // Re-open the project/session picker over an already-open project (to switch
  // sessions). Distinct from `needsProject` so cancelling returns to the
  // current session instead of forcing a fresh selection.
  const [showPicker, setShowPicker] = useState(false);
  // Bumped on each project/session choice to force re-hydration (see
  // onProjectChosen) even when needsProject doesn't change.
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
  const streamingIdRef = useRef<number | null>(null);
  // Transcript id of the active sub-agent group for this run (null until the
  // first subagent spawns). Lets later parallel agents join the same in-chat
  // feed instead of each opening a fresh block.
  const subagentGroupIdRef = useRef<number | null>(null);
  // Transcript id of the in-flight compaction notice, so compaction_end can
  // flip the same row from shimmer → summary instead of pushing a new line.
  const compactionIdRef = useRef<number | null>(null);
  const runStartRef = useRef<number>(0);
  const toolsUsedRef = useRef<Set<string>>(new Set());
  const tokensRef = useRef<number>(0);
  // Accumulated assistant text this run, for detecting [DONE:n] plan-step
  // markers that may split across deltas.
  const assistantTextRef = useRef<string>("");
  // Thinking spans: start timestamp of the active span (or null), plus the sum
  // of completed spans this run. Refs are the source of truth; state mirrors
  // them for render. Finalizing a span happens outside setState updaters.
  const thinkingStartRef = useRef<number | null>(null);
  const thinkingAccumRef = useRef<number>(0);

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

  // Stop the browser from navigating to / opening a file dropped anywhere
  // (which would replace the whole UI with the raw file). The active chat view
  // handles those drops as attachments; entry/picker screens just suppress the
  // default behavior.
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

  // Drive the native OS title bar (macOS / Windows / Linux all honor setTitle):
  // the generated session title when actively working in a project, else
  // "GG Coder" (home/picker/login screens, and while the session picker is open).
  useEffect(() => {
    const inProject = !needsProject && !showPicker;
    setWindowTitle(inProject && sessionTitle ? sessionTitle : "GG Coder");
  }, [needsProject, showPicker, sessionTitle]);

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
      playSound("click");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // Side effects (nextId, ref mutation) happen outside the updater — updaters
  // must stay pure since React may invoke them more than once.
  //
  // Throttled via requestAnimationFrame: text_delta events arrive at 50-100/sec.
  // Without throttling, each triggers a full React re-render + markdown re-parse.
  // We buffer chunks in a ref and flush once per animation frame (~16ms),
  // reducing re-renders by 5-10× with no visible difference.
  const pendingChunksRef = useRef<string>("");
  const rafIdRef = useRef<number | null>(null);

  const flushChunks = useCallback(() => {
    rafIdRef.current = null;
    const chunk = pendingChunksRef.current;
    if (!chunk) return;
    pendingChunksRef.current = "";
    const current = streamingIdRef.current;
    if (current === null) return; // streaming ended while waiting
    setItems((prev) =>
      prev.map((it) =>
        it.kind === "assistant" && it.id === current ? { ...it, text: it.text + chunk } : it,
      ),
    );
  }, []);

  const appendAssistant = useCallback(
    (text: string) => {
      const current = streamingIdRef.current;
      if (current === null) {
        // First token of a new assistant turn: create immediately (no delay
        // on first paint — the user should see the bubble appear right away).
        const id = nextId();
        streamingIdRef.current = id;
        setItems((prev) => [...prev, { kind: "assistant", id, text }]);
      } else {
        // Subsequent tokens: buffer and flush via rAF
        pendingChunksRef.current += text;
        if (rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(flushChunks);
        }
      }
    },
    [flushChunks],
  );

  // Flush any pending buffered text and end the current streaming section.
  // Called whenever streaming transitions to tool calls, a new prompt, etc.
  // Without this, the last few buffered tokens (waiting for rAF) would be lost.
  const endStreamingText = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (pendingChunksRef.current) {
      const chunk = pendingChunksRef.current;
      pendingChunksRef.current = "";
      const current = streamingIdRef.current;
      if (current !== null) {
        setItems((prev) =>
          prev.map((it) =>
            it.kind === "assistant" && it.id === current ? { ...it, text: it.text + chunk } : it,
          ),
        );
      }
    }
    streamingIdRef.current = null;
  }, []);

  const pushItem = useCallback((item: Item) => {
    setItems((prev) => [...prev, item]);
  }, []);

  // End the active thinking span (if any), folding its duration into the
  // accumulator. Called when text/tools begin or the run ends. Side effects on
  // refs happen here, outside any setState updater, keeping updaters pure.
  const finalizeThinking = useCallback(() => {
    const start = thinkingStartRef.current;
    if (start !== null) {
      thinkingAccumRef.current += Date.now() - start;
      thinkingStartRef.current = null;
      setThinkingAccumMs(thinkingAccumRef.current);
      setThinkingStartTs(null);
    }
    setIsThinking(false);
  }, []);

  const handleEvent = useCallback(
    (e: SidecarEvent) => {
      const d = e.data as Record<string, unknown>;
      switch (e.type) {
        case "ready":
          setState(d as unknown as AgentState);
          setTasks((d.tasks as BackgroundTask[] | undefined) ?? []);
          setStatus("ready");
          break;
        case "run_start":
          setRunning(true);
          endStreamingText();
          subagentGroupIdRef.current = null;
          compactionIdRef.current = null;
          runStartRef.current = Date.now();
          toolsUsedRef.current = new Set();
          tokensRef.current = 0;
          assistantTextRef.current = "";
          thinkingStartRef.current = null;
          thinkingAccumRef.current = 0;
          setLiveToolFeed([]);
          setTokens(0);
          setDoneStatus(null);
          setIsThinking(false);
          setThinkingStartTs(null);
          setThinkingAccumMs(0);
          setStatus("thinking\u2026");
          break;
        case "thinking_delta": {
          if (thinkingStartRef.current === null) {
            const now = Date.now();
            thinkingStartRef.current = now;
            setThinkingStartTs(now);
            setIsThinking(true);
          }
          break;
        }
        case "text_delta": {
          finalizeThinking();
          const chunk = String(d.text ?? "");
          appendAssistant(chunk);
          // Track plan-step completion for the activity bar. Accumulate the
          // run's assistant text (markers can split across deltas) and union in
          // any [DONE:n] step numbers seen so far.
          assistantTextRef.current += chunk;
          const done = findCompletedSteps(assistantTextRef.current);
          if (done.length > 0) {
            const next = new Set(planDoneRef.current);
            for (const n of done) {
              if (n >= 1 && n <= planTotalRef.current) next.add(n);
            }
            if (next.size !== planDoneRef.current.size) {
              planDoneRef.current = next;
              setPlanDone(next);
            }
          }
          break;
        }
        case "server_tool_call": {
          // Native server tools (e.g. Anthropic web_search) stream text both
          // before and after them within the SAME turn. End the current
          // assistant bubble so the post-tool text starts a fresh paragraph
          // instead of gluing onto the pre-tool text ("…command.Let me pull…").
          finalizeThinking();
          endStreamingText();
          assistantTextRef.current = "";
          break;
        }
        case "tool_call_start": {
          finalizeThinking();
          endStreamingText();
          const toolCallId = String(d.toolCallId ?? "");
          const name = String(d.name ?? "tool");
          const args = (d.args as Record<string, unknown>) ?? {};
          toolsUsedRef.current.add(name);
          // Tools live ONLY in the pinned panel, never in the transcript. Keep a
          // bounded tail so memory stays flat across long sessions; the panel
          // itself renders just the last LIVE_TOOL_PANEL_ROWS.
          setLiveToolFeed((prev) =>
            [...prev, { toolCallId, name, args, status: "running" as const }].slice(
              -(LIVE_TOOL_PANEL_ROWS * 2),
            ),
          );
          // Sub-agents also get a persistent, live feed in the transcript so the
          // user can watch parallel delegations by name + what each is doing.
          if (name === "subagent") {
            const newAgent: SubAgentLine = {
              toolCallId,
              agentName: typeof args.agent === "string" ? args.agent : undefined,
              status: "running",
              activities: [],
              toolUseCount: 0,
              tokenUsage: { input: 0, output: 0 },
            };
            const groupId = subagentGroupIdRef.current;
            if (groupId !== null) {
              setItems((prev) =>
                prev.map((it) =>
                  it.kind === "subagent_group" && it.id === groupId
                    ? { ...it, agents: [...it.agents, newAgent] }
                    : it,
                ),
              );
            } else {
              const id = nextId();
              subagentGroupIdRef.current = id;
              endStreamingText();
              pushItem({ kind: "subagent_group", id, agents: [newAgent] });
            }
          }
          // Image generation: show a shimmering square placeholder while the
          // tool runs. It gets replaced by the real image on tool_call_end.
          if (name === "generate_image") {
            const prompt = typeof args.prompt === "string" ? args.prompt : "generating image…";
            endStreamingText();
            pushItem({ kind: "generating_image", id: nextId(), prompt });
          }
          break;
        }
        case "tool_call_update": {
          // Live progress from a running sub-agent (toolUseCount + the tool it's
          // currently running). Append distinct activities into its feed.
          const id = String(d.toolCallId ?? "");
          const update = d.update as
            | {
                toolUseCount?: number;
                currentActivity?: string;
                tokenUsage?: { input: number; output: number };
              }
            | undefined;
          const groupId = subagentGroupIdRef.current;
          if (!update || groupId === null) break;
          const activity = update.currentActivity;
          setItems((prev) =>
            prev.map((it) => {
              if (it.kind !== "subagent_group" || it.id !== groupId) return it;
              return {
                ...it,
                agents: it.agents.map((a) => {
                  if (a.toolCallId !== id) return a;
                  const last = a.activities[a.activities.length - 1];
                  const activities =
                    activity && activity !== last ? [...a.activities, activity] : a.activities;
                  return {
                    ...a,
                    toolUseCount: update.toolUseCount ?? a.toolUseCount,
                    tokenUsage: update.tokenUsage ?? a.tokenUsage,
                    activities: activities.slice(-12),
                  };
                }),
              };
            }),
          );
          break;
        }
        case "tool_call_end": {
          const id = String(d.toolCallId ?? "");
          const isError = Boolean(d.isError);
          const result = typeof d.result === "string" ? d.result : undefined;
          const details = d.details;
          // Finalize a sub-agent's in-chat row: flip status + record duration.
          const groupId = subagentGroupIdRef.current;
          if (groupId !== null) {
            const endDetails = details as
              | { durationMs?: number; tokenUsage?: { input: number; output: number } }
              | undefined;
            const durationMs = endDetails?.durationMs;
            const finalTokens = endDetails?.tokenUsage;
            setItems((prev) =>
              prev.map((it) => {
                // Only the active group, and only when the ended tool is actually
                // one of its agents (tool_call_end carries no name to filter on).
                if (it.kind !== "subagent_group" || it.id !== groupId) return it;
                if (!it.agents.some((a) => a.toolCallId === id)) return it;
                return {
                  ...it,
                  agents: it.agents.map((a) =>
                    a.toolCallId === id
                      ? {
                          ...a,
                          status: isError ? ("error" as const) : ("done" as const),
                          durationMs: durationMs ?? a.durationMs,
                          tokenUsage: finalTokens ?? a.tokenUsage,
                        }
                      : a,
                  ),
                };
              }),
            );
          }
          // Update the entry in place to its done state — it stays in the pinned
          // panel (mirrors ggcoder), it does NOT move into the transcript.
          setLiveToolFeed((prev) =>
            prev.map((entry) =>
              entry.toolCallId === id
                ? { ...entry, status: "done" as const, isError, result, details }
                : entry,
            ),
          );
          // Remove any generating_image placeholders — the tool has finished
          // (success or failure). If it produced images, they're pushed below.
          setItems((prev) => prev.filter((it) => it.kind !== "generating_image"));
          // Surface any image previews (screenshot / read of an image) inline in
          // the transcript — the tool panel is text-only.
          const previews = (details as { imagePreviews?: ImagePreview[] } | undefined)
            ?.imagePreviews;
          if (Array.isArray(previews) && previews.length > 0) {
            endStreamingText();
            pushItem({
              kind: "images",
              id: nextId(),
              images: previews.map((p) => ({
                src: `data:${p.mediaType};base64,${p.base64}`,
                path: p.path,
              })),
            });
          }
          break;
        }
        case "turn_end": {
          const usage = d.usage as
            | {
                inputTokens?: number;
                outputTokens?: number;
                cacheRead?: number;
                cacheWrite?: number;
              }
            | undefined;
          if (usage && typeof usage.outputTokens === "number") {
            tokensRef.current += usage.outputTokens;
            setTokens(tokensRef.current);
          }
          // Context-window usage (footer meter). Mirrors ggcoder: Anthropic has
          // separate input/output limits so only the input side counts; every
          // other provider shares one window, so add the output too.
          if (usage) {
            const inputContext =
              (usage.inputTokens ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
            const isAnthropic = stateRef.current?.provider === "anthropic";
            setContextTokens(inputContext + (isAnthropic ? 0 : (usage.outputTokens ?? 0)));
          }
          break;
        }
        case "agent_done": {
          const usage = d.totalUsage as { outputTokens?: number } | undefined;
          if (usage && typeof usage.outputTokens === "number") {
            // Authoritative final total — set rather than add to avoid
            // double-counting the per-turn accumulation above.
            if (usage.outputTokens > tokensRef.current) {
              tokensRef.current = usage.outputTokens;
              setTokens(tokensRef.current);
            }
          }
          break;
        }
        case "compaction_start": {
          const id = nextId();
          compactionIdRef.current = id;
          endStreamingText();
          pushItem({ kind: "compaction", id, status: "running" });
          break;
        }
        case "compaction_end": {
          const originalCount = typeof d.originalCount === "number" ? d.originalCount : undefined;
          const newCount = typeof d.newCount === "number" ? d.newCount : undefined;
          const id = compactionIdRef.current;
          compactionIdRef.current = null;
          setItems((prev) =>
            prev.map((it) =>
              it.kind === "compaction" && it.id === id
                ? { ...it, status: "done" as const, originalCount, newCount }
                : it,
            ),
          );
          break;
        }
        case "error":
          pushItem({
            kind: "error",
            id: nextId(),
            text: `error: ${String(d.message ?? "unknown")}`,
          });
          break;
        case "run_end": {
          setRunning(false);
          endStreamingText();
          finalizeThinking();
          // The queue drained into this run — un-dim any messages that were
          // waiting, since the agent has now consumed them.
          setItems((prev) =>
            prev.map((it) => (it.kind === "user" && it.queued ? { ...it, queued: false } : it)),
          );
          // Exit the tool panel (mirrors ggcoder).
          setLiveToolFeed([]);
          // Safety: clear any lingering image-generation placeholders in case
          // tool_call_end didn't fire (e.g. hard cancel mid-fetch).
          setItems((prev) => prev.filter((it) => it.kind !== "generating_image"));
          // Mark any still-running sub-agents in this run's group as aborted.
          const saGroupId = subagentGroupIdRef.current;
          if (saGroupId !== null) {
            setItems((prev) =>
              prev.map((it) =>
                it.kind === "subagent_group" && it.id === saGroupId
                  ? {
                      ...it,
                      aborted: d.cancelled ? true : it.aborted,
                      agents: it.agents.map((a) =>
                        a.status === "running"
                          ? { ...a, status: d.cancelled ? ("error" as const) : ("done" as const) }
                          : a,
                      ),
                    }
                  : it,
              ),
            );
          }
          subagentGroupIdRef.current = null;
          if (d.cancelled) {
            setDoneStatus(null);
            setStatus("cancelled");
          } else {
            const elapsedMs = runStartRef.current ? Date.now() - runStartRef.current : 0;
            const verb = pickDoneVerb(toolsUsedRef.current);
            const parts = [`${verb} ${formatElapsed(elapsedMs)}`];
            if (tokensRef.current > 0) {
              parts.push(`\u2193 ${formatTokenCount(tokensRef.current)} tokens`);
            }
            setDoneStatus(parts.join(" \u2022 "));
            setStatus("ready");
            const completedPlan =
              planTotalRef.current > 0 &&
              Array.from({ length: planTotalRef.current }, (_, i) => i + 1).every((step) =>
                planDoneRef.current.has(step),
              );
            if (completedPlan) {
              planTotalRef.current = 0;
              planDoneRef.current = new Set();
              setPlanTotal(0);
              setPlanDone(new Set());
            }
            playSound("done");
            // A run may have created/removed `.gg/commands/*.md` (e.g.
            // /setup-commit writing commit.md). Refresh so the top-right
            // commit button flips /setup-commit → /commit without a restart.
            void listCommands().then((cmds) => {
              if (cmds.length > 0) setCommands(cmds);
            });
          }
          break;
        }
        case "model_change":
          setState((s) => (s ? { ...s, ...(d as Partial<AgentState>) } : s));
          break;
        case "thinking_change":
          setState((s) =>
            s
              ? {
                  ...s,
                  thinkingLevel: (d.thinkingLevel as string | null) ?? null,
                  supportedThinkingLevels: (d.supportedThinkingLevels as string[]) ?? [],
                }
              : s,
          );
          break;
        case "plan_enter":
          setState((s) => (s ? { ...s, planMode: true } : s));
          pushItem({ kind: "plan", id: nextId(), reason: String(d.reason ?? "") });
          break;
        case "plan_exit":
          setState((s) => (s ? { ...s, planMode: false } : s));
          // Open the review modal (Accept / Feedback / Reject) with the plan, and
          // stash its path so accept can bake it into the system prompt.
          planReviewPathRef.current = typeof d.planPath === "string" ? d.planPath : null;
          setPlanReview(String(d.content ?? ""));
          break;
        case "tasks":
          setTasks((d.tasks as BackgroundTask[] | undefined) ?? []);
          break;
        case "tasks_list":
          // Project task list refresh (run-all advance, status flips).
          setProjectTasks((d.tasks as ProjectTask[] | undefined) ?? []);
          break;
        case "task_start":
          // A task run just opened a fresh session; show its title at the top of
          // the (already-cleared) transcript so the user sees what's running.
          pushItem({ kind: "task", id: nextId(), title: String(d.title ?? "") });
          break;
        case "tasks_run_done":
          // Run-all sweep finished — nothing to render; the modal reflects it.
          break;
        case "queued":
          setQueuedCount(Number(d.count ?? 0));
          break;
        case "hook": {
          const kind = String(d.kind ?? "ideal") as HookKind;
          if (kind in HOOK_PRESENTATION) {
            endStreamingText();
            pushItem({ kind: "hook", id: nextId(), hook: kind });
          }
          break;
        }
        case "session_reset":
          // Sidecar started a fresh session — clear the transcript + counters.
          stickToBottomRef.current = true;
          setItems([]);
          setLiveToolFeed([]);
          setTokens(0);
          setDoneStatus(null);
          setContextTokens(0);
          setSessionTitle(null);
          setPlanReview(null);
          {
            // On an accept-driven reset, restore the approved plan's step count
            // instead of zeroing it (the widget tracks the implementation run).
            const carriedTotal = pendingPlanTotalRef.current ?? 0;
            pendingPlanTotalRef.current = null;
            planTotalRef.current = carriedTotal;
            planDoneRef.current = new Set();
            setPlanTotal(carriedTotal);
            setPlanDone(new Set());
          }
          setAttachments([]);
          setQueuedCount(0);
          endStreamingText();
          subagentGroupIdRef.current = null;
          break;
        case "session_title":
          setSessionTitle(String(d.title ?? "") || null);
          break;
        case "extras":
          // Context window / git branch refresh (model switch, run end).
          setState((s) =>
            s
              ? {
                  ...s,
                  contextWindow: (d.contextWindow as number | undefined) ?? s.contextWindow,
                  gitBranch: (d.gitBranch as string | null | undefined) ?? s.gitBranch,
                  isGitRepo: (d.isGitRepo as boolean | undefined) ?? s.isGitRepo,
                }
              : s,
          );
          setTasks((d.tasks as BackgroundTask[] | undefined) ?? []);
          break;
      }
    },
    [appendAssistant, pushItem, finalizeThinking, endStreamingText],
  );

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
        setStatus("ready");
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
            if (h.compacted) return { kind: "compaction", id: nextId(), status: "done" };
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
        if (target) onProjectChosen();
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

  function onSelectModel(modelId: string): void {
    setModelMenuOpen(false);
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

  // `@`-mention picker: open whenever a mention token is active and the search
  // returned at least one file. Clamp the highlighted row to the result count.
  const mentionOpen = mention !== null && fileMatches.length > 0;
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

  // Debounced file search whenever the active mention query changes.
  useEffect(() => {
    if (mention === null) {
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
  }, [mention]);

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

  // Reveal the floating "Enhance" pill ~1s after the user stops typing, for a
  // non-trivial sendable draft. Every keystroke resets `input`, which re-runs
  // this and hides the pill immediately, so it only surfaces on a real pause.
  // Skipped while running/enhancing, with a menu open, or when the draft is
  // already the current enhancement (nothing left to improve).
  useEffect(() => {
    setEnhanceHintVisible(false);
    if (running || enhancing || !hydrated) return;
    if (input.trim().length < 8) return;
    if (slashOpen || mentionOpen) return;
    if (enhancement && enhancement.plain === input) return;
    const t = setTimeout(() => setEnhanceHintVisible(true), 1000);
    return () => clearTimeout(t);
  }, [input, running, enhancing, hydrated, slashOpen, mentionOpen, enhancement]);

  // Submit the current input together with any staged attachments. Images are
  // echoed inline in the user's bubble; all media is sent to the agent.
  function submit(): void {
    const trimmed = input.trim();
    if (!readyRef.current) return;
    if (!trimmed && attachments.length === 0 && mentionedPaths.length === 0) return;
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
      void sendPrompt(prompt, queuedWire);
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
        text: "This model can't watch video directly. The agent can still extract frames or audio with ffmpeg if needed — switch to a video-capable model (Gemini, Kimi, MiniMax) for native video analysis.",
      });
    }
    setInput("");
    setAttachments([]);
    setSlashIndex(0);
    setMention(null);
    setMentionedPaths([]);
    setEnhancement(null);
    endStreamingText();
    void sendPrompt(prompt, wire);
  }

  // ── Attachment intake (paste / attach button / whole-window drag-drop) ──
  async function addFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files);
    const pendings = await Promise.all(list.map((f) => fileToPending(f).catch(() => null)));
    const ok = pendings.filter((p): p is PendingAttachment => p !== null);
    if (ok.length > 0) setAttachments((prev) => [...prev, ...ok]);
  }

  function canHandleWindowFileDrop(): boolean {
    return !document.querySelector(".modal-backdrop");
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
    if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
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
    // Stash it so the accept-driven session_reset restores the count instead of
    // zeroing it (session_reset arrives over SSE — a different channel than the
    // acceptPlanIPC response — so it may land before OR after the await resolves).
    pendingPlanTotalRef.current = nextPlanTotal;
    // Accept the plan: the sidecar wipes the planning conversation into a FRESH
    // session (so the build doesn't carry all the plan-mode research) and bakes
    // the approved plan into the new system prompt, so the model emits `[DONE:n]`
    // markers the Plan Steps widget reads.
    await acceptPlanIPC(planReviewPathRef.current);
    // Fallback seed for the case session_reset hasn't been processed yet (it
    // consumes pendingPlanTotalRef, so whichever runs second is a no-op).
    planTotalRef.current = nextPlanTotal;
    planDoneRef.current = new Set();
    setPlanTotal(nextPlanTotal);
    setPlanDone(new Set());
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
    setSessionTitle(null);
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
            onProjects={() => setEntryView("projects")}
            onLogin={() => setEntryView("login")}
          />
        ) : entryView === "login" ? (
          <LoginScreen onClose={() => setEntryView("home")} />
        ) : (
          <ProjectPicker
            onChosen={onProjectChosen}
            // Every window can return to the home screen (it shows global
            // settings/auth, nothing window-specific) — secondary windows just
            // default to opening on the picker.
            onClose={() => setEntryView("home")}
          />
        )}
        <Toaster />
      </div>
    );
  }

  // Picker reopened over an already-open project (to switch sessions). Deep-links
  // to the current project's session list. From the session list, back returns
  // to the project list; from the top-level project list, back goes to the home
  // screen (not the open session).
  if (showPicker) {
    return (
      <div className="app" style={{ background: theme.background }}>
        <ProjectPicker
          initialProjectPath={state?.cwd ?? null}
          onChosen={() => {
            setShowPicker(false);
            onProjectChosen();
          }}
          onClose={() => {
            setShowPicker(false);
            // Back from the over-a-project picker returns to the home screen for
            // every window (the entry picker now offers a back-to-home button,
            // so secondary windows are no longer stranded there).
            setNeedsProject(true);
            setEntryView("home");
          }}
        />
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
      <div className="chat-head">
        {/* Top strip — the macOS traffic-light row. Holds the window title (where
            the native title used to sit) and the show/hide toggle. Always
            present, so collapsing the nav below never moves the title up into
            the traffic lights. */}
        <div className="chat-head-strip" data-tauri-drag-region>
          {/* The title fills the strip (flex:1), so it must carry the drag
              attribute itself — Tauri only drags when the element directly under
              the cursor has it, and a bare child would otherwise block dragging
              across the whole bar. */}
          <span className="chat-head-title" data-tauri-drag-region>
            {sessionTitle ?? "GG Coder"}
          </span>
          {windowTotal > 1 && windowIndex !== null && (
            <span
              className={`window-index${isThisFocused ? "" : " dim"}`}
              data-tauri-drag-region
              title={`Window ${windowIndex} of ${windowTotal} · ⌘\` to cycle`}
            >
              {windowIndex}/{windowTotal}
            </span>
          )}
          <button
            className="nav-toggle"
            title={navHidden ? "Show nav buttons" : "Hide nav buttons"}
            aria-label={navHidden ? "Show nav buttons" : "Hide nav buttons"}
            onClick={toggleNav}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ display: "block" }}
            >
              <polyline points={navHidden ? "6 9 12 15 18 9" : "6 15 12 9 18 15"} />
            </svg>
          </button>
        </div>

        {/* Nav row — the action buttons. Collapsed away by the toggle. */}
        {!navHidden && (
          <div className="chat-head-nav" data-tauri-drag-region>
            <BackButton
              label="Back to this project's sessions"
              onClick={() => setShowPicker(true)}
            />
            <span className="picker-head-actions">
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
          </div>
        )}
      </div>

      <div className="transcript" ref={scrollRef} onScroll={onTranscriptScroll}>
        {!hydrated && items.length === 0 ? (
          <TranscriptSkeleton />
        ) : (
          <>
            {items.length === 0 &&
              (status === "ready" ? (
                <WakeScreen />
              ) : (
                <div className="line transcript-reveal" style={{ color: theme.textDim }}>
                  {`\u273b ${status}`}
                </div>
              ))}
            {items.map((it) => (
              <TranscriptRow key={it.id} item={it} onImageLoad={maybeScrollToBottom} />
            ))}
          </>
        )}
      </div>

      <div className="liveregion">
        {!toolsHidden && <LiveToolPanel entries={liveToolFeed} />}
        <ActivityBar
          running={running}
          tokens={tokens}
          doneStatus={doneStatus}
          isThinking={isThinking}
          thinkingStartTs={thinkingStartTs}
          thinkingAccumMs={thinkingAccumMs}
          planTotal={planTotal}
          planDone={Math.min(planDone.size, planTotal)}
          onCancel={() => void cancel()}
          toolsHidden={toolsHidden}
          hasToolFeed={liveToolFeed.length > 0}
          onToggleTools={toggleTools}
        />
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
            <textarea
              ref={inputRef}
              className={`input${enhanceAnim ? " input-anim" : ""}${
                enhanceHintVisible ? " input-dimmed" : ""
              }`}
              rows={1}
              // Lock the input while the dissolve→decode animation plays: the caret
              // is invisible, so typing would be silently discarded and Enter would
              // submit the un-enhanced draft mid-animation.
              readOnly={enhanceAnim !== null}
              value={input}
              placeholder={
                running
                  ? "Agent is working \u2014 queue a follow-up…"
                  : "Type your message, / for commands, @ to add files"
              }
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
                  if (slashOpen) setInput("");
                  else if (running) void cancel();
                }
              }}
              autoFocus
            />
          </div>
          {enhanceHintVisible && (
            <button
              className={`enhance-pill${enhancing ? " enhancing" : ""}`}
              title="Enhance prompt — clearer wording + correct terms"
              disabled={enhancing}
              onClick={() => void runEnhance()}
            >
              {enhancing ? "Enhancing…" : "Enhance?"}
            </button>
          )}
        </div>
      </div>

      <div className="footer" style={{ color: theme.footerText }}>
        {!hydrated ? (
          <FooterSkeleton />
        ) : (
          <>
            <span className="footer-left footer-reveal" style={{ fontFamily: "var(--mono)" }}>
              {state?.cwd && (
                <span className="footer-cwd" style={{ color: theme.textDim }}>
                  {basename(state.cwd)}
                </span>
              )}
              {state?.gitBranch && (
                <>
                  {state?.cwd && <FooterSep />}
                  <span style={{ color: theme.secondary }}>{`\u2387 ${state.gitBranch}`}</span>
                </>
              )}
              {runningTaskCount > 0 && (
                <>
                  {(state?.cwd || state?.gitBranch) && <FooterSep />}
                  <BackgroundTasksButton tasks={tasks} />
                </>
              )}
              {state?.planMode && (
                <>
                  {(state?.cwd || state?.gitBranch || runningTaskCount > 0) && <FooterSep />}
                  <span className="footer-plan">
                    <ShimmerText base={theme.secondary} bright="#ddd6fe">
                      {"\u25C6 plan mode"}
                    </ShimmerText>
                  </span>
                </>
              )}
            </span>
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
                {modelMenuOpen && models.length > 0 && (
                  <ModelMenu
                    models={models}
                    currentModel={state?.model ?? ""}
                    onSelect={onSelectModel}
                    onClose={() => setModelMenuOpen(false)}
                  />
                )}
                <button
                  className="model-button"
                  style={{ color: theme.text }}
                  disabled={running || models.length === 0}
                  title="Switch model"
                  onClick={() => setModelMenuOpen((o) => !o)}
                >
                  {state?.model ?? "\u2026"}
                </button>
              </span>
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
          {`Ken just pushed a new update (${appUpdate.version}) — click here to install`}
        </button>
      )}
      {appUpdate.phase === "installing" && (
        <div className="update-banner update-banner-busy">
          <span className="update-banner-dot" />
          {"Installing update\u2026 the app will restart automatically."}
        </div>
      )}

      {showInitGit && (
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
          title="New Session"
          message="This will create a new session for this project. The current conversation will be cleared. Are you sure?"
          confirmLabel="New Session"
          busy={newSessionBusy}
          onConfirm={() => void startNewSession()}
          onClose={() => setConfirmNewSession(false)}
        />
      )}

      {planReview !== null && (
        <PlanReviewModal
          content={planReview}
          onAccept={acceptPlan}
          onFeedback={sendPlanFeedback}
          onReject={rejectPlan}
        />
      )}

      {showNotes && (
        <NotesModal
          value={notes}
          onChange={handleNotesChange}
          onClose={() => setShowNotes(false)}
        />
      )}

      {showTasks && (
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
        <div className={`user-msg${item.queued ? " queued" : ""}`}>
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
    case "info":
      return (
        <div className="line info" style={{ color: theme.textDim }}>
          {item.text}
        </div>
      );
    case "error":
      return (
        <div className="line error" style={{ color: theme.error }}>
          {item.text}
        </div>
      );
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
