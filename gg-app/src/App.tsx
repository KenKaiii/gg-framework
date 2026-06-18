import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
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
import { ShimmerText } from "./ShimmerText";
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
import { FooterSkeleton, TranscriptSkeleton } from "./Skeleton";
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
    }
  | { kind: "assistant"; id: number; text: string }
  | { kind: "info"; id: number; text: string }
  | { kind: "error"; id: number; text: string }
  // Agent self-correction hook notice (ideal review / loop-break / re-grounding),
  // rendered like the TUI: a shimmering tone-colored one-liner.
  | { kind: "hook"; id: number; hook: HookKind }
  // Images produced by a tool (screenshot / read of an image file).
  | { kind: "images"; id: number; images: TranscriptImage[]; caption?: string }
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
  // Staged attachments (paste / attach button / whole-window drag-drop) shown above the input.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  }, [items, liveToolFeed, running, doneStatus, maybeScrollToBottom]);

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
  useEffect(() => {
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
  }, [input]);

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
  const appendAssistant = useCallback((text: string) => {
    const current = streamingIdRef.current;
    if (current === null) {
      const id = nextId();
      streamingIdRef.current = id;
      setItems((prev) => [...prev, { kind: "assistant", id, text }]);
    } else {
      setItems((prev) =>
        prev.map((it) =>
          it.kind === "assistant" && it.id === current ? { ...it, text: it.text + text } : it,
        ),
      );
    }
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
          streamingIdRef.current = null;
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
        case "tool_call_start": {
          finalizeThinking();
          streamingIdRef.current = null;
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
              streamingIdRef.current = null;
              pushItem({ kind: "subagent_group", id, agents: [newAgent] });
            }
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
          // Surface any image previews (screenshot / read of an image) inline in
          // the transcript — the tool panel is text-only.
          const previews = (details as { imagePreviews?: ImagePreview[] } | undefined)
            ?.imagePreviews;
          if (Array.isArray(previews) && previews.length > 0) {
            streamingIdRef.current = null;
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
          streamingIdRef.current = null;
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
          streamingIdRef.current = null;
          finalizeThinking();
          // Final response is in; exit the tool panel (mirrors ggcoder).
          setLiveToolFeed([]);
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
            streamingIdRef.current = null;
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
          planTotalRef.current = 0;
          planDoneRef.current = new Set();
          setPlanTotal(0);
          setPlanDone(new Set());
          setAttachments([]);
          setQueuedCount(0);
          streamingIdRef.current = null;
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
    [appendAssistant, pushItem, finalizeThinking],
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
        setItems(
          history.map((h): Item => {
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

  function onSelectModel(modelId: string): void {
    setModelMenuOpen(false);
    if (state && modelId === state.model) return;
    void switchModel(modelId).then((res) => {
      if (res) {
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
    streamingIdRef.current = null;
    void sendPrompt(trimmed);
  }

  // Submit the current input together with any staged attachments. Images are
  // echoed inline in the user's bubble; all media is sent to the agent.
  function submit(): void {
    const trimmed = input.trim();
    if (!readyRef.current) return;
    if (!trimmed && attachments.length === 0 && mentionedPaths.length === 0) return;
    // A user send always re-pins to the bottom — they want to see their message.
    stickToBottomRef.current = true;
    // Referenced files are appended to the prompt as a small block so the agent
    // knows which paths to read; they aren't shown in the user's bubble text.
    const prompt =
      mentionedPaths.length > 0 ? appendReferencedFiles(trimmed, mentionedPaths) : trimmed;
    // While a run is in flight, a plain text message is QUEUED as steering (the
    // sidecar injects it mid-loop). Attachments can't be queued — block those.
    if (running) {
      if (attachments.length > 0) return;
      pushItem({
        kind: "user",
        id: nextId(),
        text: trimmed,
        command: isWorkflowCommand(trimmed),
        files: mentionedPaths.length > 0 ? mentionedPaths : undefined,
      });
      setInput("");
      setSlashIndex(0);
      setMention(null);
      setMentionedPaths([]);
      void sendPrompt(prompt);
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
    streamingIdRef.current = null;
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
    streamingIdRef.current = null;
    void sendPrompt(prompt);
  }

  async function acceptPlan(): Promise<void> {
    // Start activity-bar progress tracking from the approved plan's step count.
    const nextPlanTotal = planReview ? countPlanSteps(planReview) : 0;
    planTotalRef.current = nextPlanTotal;
    planDoneRef.current = new Set();
    setPlanTotal(nextPlanTotal);
    setPlanDone(new Set());
    // Bake the approved plan into the agent's system prompt FIRST, so it's told
    // to emit `[DONE:n]` markers as it implements — without this the activity
    // bar's Plan Steps widget would never advance past 0. Must complete before
    // the implement prompt runs (the prompt picks up the rebuilt system message).
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
            // Secondary windows start on the picker and have no home screen, so
            // they get no "back" affordance; the main window returns home.
            onClose={isSecondaryWindow ? undefined : () => setEntryView("home")}
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
            // Secondary windows have no home screen — bouncing them "home" lands
            // on a Projects picker whose back button is suppressed (the
            // isSecondaryWindow guard below), stranding the user. The picker is
            // only reachable here from an already-open project, so just close it
            // to return to that project. The main window keeps going home.
            if (!isSecondaryWindow) {
              setNeedsProject(true);
              setEntryView("home");
            }
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
                title="View and run this project's tasks"
                onClick={openTasks}
              >
                {projectTasks.some((t) => t.status !== "done")
                  ? `Tasks (${projectTasks.filter((t) => t.status !== "done").length})`
                  : "Tasks"}
              </button>
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
              <RadioButton />
              {/* <GazeButton /> */}
              <WindowLayoutButton onArrange={() => setNavHiddenPersisted(true)} />
            </span>
          </div>
        )}
      </div>

      <div className="transcript" ref={scrollRef} onScroll={onTranscriptScroll}>
        {!hydrated && items.length === 0 ? (
          <TranscriptSkeleton />
        ) : (
          <>
            {items.length === 0 && (
              <div className="line transcript-reveal" style={{ color: theme.textDim }}>
                {status === "ready"
                  ? "Ready. Type a message below to start coding."
                  : `\u273b ${status}`}
              </div>
            )}
            {items.map((it) => (
              <TranscriptRow key={it.id} item={it} onImageLoad={maybeScrollToBottom} />
            ))}
          </>
        )}
      </div>

      <div className="liveregion">
        <LiveToolPanel entries={liveToolFeed} />
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
          <textarea
            ref={inputRef}
            className="input"
            rows={1}
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
function TranscriptRow({
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
        <div className="user-msg">
          {item.images && item.images.length > 0 && (
            <div className="user-img-row">
              {item.images.map((src, i) => (
                <img key={i} className="user-img" src={src} alt="attachment" onLoad={onImageLoad} />
              ))}
            </div>
          )}
          {item.text}
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
}

export default App;
