import {
  Activity,
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
} from "react";
import { createChatLayoutMotion } from "./chat-layout-motion";
import { open } from "@tauri-apps/plugin-dialog";
import { theme } from "./theme";
import { assignErrorCritters } from "./ErrorCritter";
import { activeChatErrorId, readChatError } from "./chat-error";
import { withViewTransition } from "./view-transition";
import {
  waitForReady,
  getState,
  sendPrompt,
  sendKenPrompt,
  cancelKen,
  setAutopilot,
  cancel,
  newSession,
  listModels,
  switchModel,
  isSwitchModelError,
  switchKenModel,
  listCommands,
  cancelQueued,
  type PromptMeta,
  type QueuedMessage,
  listHistory,
  listTasks,
  type ChecklistEntry,
  runTask,
  runAllTasks,
  deleteTask,
  newWindow,
  focusWindowByOffset,
  arrangeAllWindows,
  restoreTarget,
  acceptPlan as acceptPlanIPC,
  subscribe,
  isSecondaryWindow,
  windowLabel,
  setWindowTitle,
  workspaceProductName,
  type AgentState,
  type WorkspaceMode,
  type ModelOption,
  type SlashCommand,
  type BackgroundTask,
  type ProjectTask,
  type FileHit,
  searchFiles,
  type PromptSegment,
  answerAskUser,
} from "./agent";
import { answerAskItem, dropSupersededAsks } from "./ask-user";
import { glowPlacement, glowStateFor, glowVars } from "./window-glow";
import { ActivityBar } from "./ActivityBar";
import { autosizeComposer } from "./composer-autosize";
import { createEntranceLifetime, dissolveInVisible } from "./transcript-motion";
import { TranscriptJumpControls } from "./TranscriptJumpControls";
import { createLiveTextStore, LiveTextContext } from "./live-text";
import { KenActivityBar } from "./KenActivityBar";
import { useTaskActivity } from "./useTaskActivity";
import { useKenMentor } from "./useKenMentor";
import { useAutopilot } from "./useAutopilot";
import { useAgentEvents } from "./useAgentEvents";
import { LiveToolPanel, type LiveToolEntry } from "./LiveToolPanel";
import { CritterFloor, type CritterGroup } from "./CritterFloor";
import { ModelSelect, loadModelsInto } from "./ModelSelect";
import {
  describeSchedule,
  isScheduleDraft,
  parseScheduleCommand,
  withInterval,
} from "./scheduleCommand";
import { useSchedules } from "./useSchedules";
import { appendReferencedFiles, parseReferencedFiles } from "./ReferencedFiles";
import { TasksModal } from "./TasksModal";
import { ChecklistScreen } from "./ChecklistScreen";
import { parseProjectHealth } from "./project-health";
import { NotesModal } from "./NotesModal";
import { MemoryModal } from "./MemoryModal";
import { WakeScreen } from "./WakeScreen";
import { MotionStarters } from "./MotionStarters";
import { ConfirmModal } from "./ConfirmModal";
import { InitGitModal } from "./InitGitModal";
import type { PlanDecision } from "./PlanDecisionNotice";
import { KenPowerBanner } from "./KenPowerBanner";
import { ExportChatButton } from "./ExportChatButton";
import { PlanReviewModal } from "./PlanReviewModal";
import { McpElicitModal } from "./McpElicitModal";
import { ProjectPicker } from "./ProjectPicker";
import { ChatPicker } from "./ChatPicker";
import { BackButton } from "./BackButton";
import { Badge } from "./Badge";
import { HomeScreen } from "./HomeScreen";
import { SettingsModal } from "./SettingsModal";
import { initialEntryView, type EntryView } from "./app-entry-view";
import {
  showsQueuedBubble,
  submitDisposition,
  withoutSupersedingMessage,
} from "./submit-disposition";
import { Toaster } from "./Toaster";
import { Confetti } from "./Confetti";
import { ScorecardModal } from "./ScorecardModal";
import { TitleUsageMeter } from "./TitleUsageMeter";
import { useWindowFocused } from "./useWindowFocused";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { formatWorkspaceTitle } from "./workspace-title";
import { useProgress } from "./useProgress";
import { SettingsScreen, type SettingsTabId } from "./SettingsScreen";
import { PromptSendProvider } from "./Markdown";
import { TranscriptSkeleton } from "./Skeleton";
import { recoverPromptLabel } from "./prompt-labels";
import { playSound } from "./sounds";
import { countPlanSteps } from "./plan-steps";
import { toast } from "./toast";
import { toWire, type PendingAttachment } from "./attachments";
import { TranscriptRow } from "./TranscriptRow";
import { nextId, lastIssuedId, type Item } from "./transcript-item";
import { AppFooter } from "./AppFooter";
import { useTranscriptScroll } from "./useTranscriptScroll";
import { useTrayIntents } from "./useTrayIntents";
import { useAttachments } from "./useAttachments";
import { useDragOverlay, useWindowFileDrop } from "./useFileDrop";
import { WorkspaceHeaderActions } from "./WorkspaceHeaderActions";
import { useChecklist } from "./useChecklist";
import { useProjectNotes } from "./useProjectNotes";
import { useChromeToggles } from "./useChromeToggles";
import { useTranscriptExport } from "./useTranscriptExport";
import { useWindowOrder } from "./useWindowOrder";
import { Composer } from "./Composer";
import { usePromptHistory } from "./usePromptHistory";
import { usePromptEnhance } from "./usePromptEnhance";
import "./App.css";
// Liquid glass trial layer (from veditor-app). Delete this line to revert.
import "./glass.css";

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

// Info row shown when a video attachment is sent to a model without native
// video analysis. Shared by the live send path and history restore so the
// resumed transcript matches the live one exactly.
const VIDEO_CAPABILITY_WARNING =
  "This model can't watch video directly. The agent can still extract frames or audio with ffmpeg if needed — switch to a video-capable model (Gemini, Kimi, MiniMax) for native video analysis.";

function shufflePlaceholderFrame(target: string, frame: number): string {
  const revealCount = Math.ceil((target.length * frame) / PLACEHOLDER_SHUFFLE_FRAMES);
  return Array.from(target, (char, index) => {
    if (index < revealCount || /\s|[.,?/@]/.test(char)) return char;
    const pick = Math.floor(Math.random() * PLACEHOLDER_SHUFFLE_CHARS.length);
    return PLACEHOLDER_SHUFFLE_CHARS[pick];
  }).join("");
}

// `/schedule` lives in the webview, not the sidecar's command registry: it
// registers a recurring timer instead of prompting the agent. Declared here so
// the palette can still discover it alongside the real slash commands.
const SCHEDULE_COMMAND: SlashCommand = {
  name: "schedule",
  aliases: ["sched"],
  description: "Run a prompt on a repeating schedule — <prompt> | 15m | [times]",
  source: "built-in",
};

export type { Item, TranscriptImage } from "./transcript-item";

function App(): React.ReactElement {
  const [items, setItems] = useState<Item[]>([]);
  // Text of the reply streaming right now, grown outside `items` so each chunk
  // re-renders only that row (live-text.ts). One store for the window's life.
  const [liveText] = useState(createLiveTextStore);
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
  } = useKenMentor({ setItems, nextId, liveText });
  // Ken's face talks on the reply he is streaming right now: the last row,
  // while his run is live. Only that row's props change, so memo holds.
  const currentErrorId = useMemo(() => activeChatErrorId(items), [items]);
  const errorCritters = useMemo(() => assignErrorCritters(items), [items]);
  const lastItem = items[items.length - 1];
  const talkingKenId = kenRunning && lastItem?.kind === "ken" ? lastItem.id : null;
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
  const {
    attachments,
    setAttachments,
    attachmentsLoading,
    setAttachmentsLoading,
    attachmentReadsRef,
    attachmentGenerationRef,
    clearAttachments,
    stageAttachments,
    isFileDragOver,
    setIsFileDragOver,
    fileInputRef,
    addFiles,
    removeAttachment,
  } = useAttachments();
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
  // Pending queued messages, so each can be cancelled individually. Kept
  // alongside the count because the sidecar is the source of truth for both.
  const [queuedMessages, updateQueuedMessages] = useState<QueuedMessage[]>([]);
  const [state, setState] = useState<AgentState | null>(null);
  // Transient "KEN IS ON"/"KEN IS OFF" takeover banner shown when Autopilot
  // is toggled. Null = not showing; the banner clears itself via `onDone`
  // once its slide-out animation finishes.
  const [kenPowerBanner, setKenPowerBanner] = useState<"on" | "off" | null>(null);
  const [running, setRunning] = useState(false);
  // Last composer keystroke (0 = none since this chat opened). The first
  // keystroke after opening or a >4 min idle pause prewarms the prompt cache.
  const lastKeystrokeAtRef = useRef(0);
  // Whether a run has completed in this window. Drives the ambient glow's
  // "done" state, which PERSISTS until the next run starts — the window really
  // is finished until you ask for something else (see window-glow.ts).
  const [hasFinishedRun, setHasFinishedRun] = useState(false);

  // Stable per window: seeded off the label, so a tiled grid never shows the
  // same glow twice, and a given window keeps its placement across reloads.
  const glowStyle = useMemo(() => glowVars(glowPlacement(windowLabel)), []);
  const glowState = glowStateFor(running, hasFinishedRun);

  // Watching the `running` flag keeps this in one place rather than threaded
  // through every path that can end a run (finish, cancel, error). No timers:
  // the state is durable, so there is nothing to retire.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      setHasFinishedRun(false);
      return;
    }
    if (!wasRunning.current) return;
    wasRunning.current = false;
    setHasFinishedRun(true);
  }, [running]);
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveRegionRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const chatLayout = useMemo(
    () =>
      createChatLayoutMotion(() => ({
        transcript: scrollRef.current,
        surfaces: [liveRegionRef.current, composerRef.current],
      })),
    [],
  );
  const [liveToolFeed, updateLiveToolFeed] = useState<LiveToolEntry[]>([]);
  const setLiveToolFeed = useCallback(
    (update: Parameters<typeof updateLiveToolFeed>[0]) => {
      chatLayout.capture();
      updateLiveToolFeed(update);
    },
    [chatLayout],
  );
  const setQueuedMessages = useCallback(
    (update: Parameters<typeof updateQueuedMessages>[0]) => {
      chatLayout.capture();
      updateQueuedMessages(update);
    },
    [chatLayout],
  );
  const [tokens, setTokens] = useState(0);
  const [doneStatus, setDoneStatus] = useState<string | null>(null);
  // Pending plan awaiting review (the markdown). Non-null opens the review modal.
  const [planReview, setPlanReview] = useState<string | null>(null);
  // Bumped to remount the plan-review box (fresh, undecided) after a refused
  // Accept so the user can decide again.
  const [planReviewAttempt, setPlanReviewAttempt] = useState(0);
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
  // The background model load gave up (every retry failed). The footer
  // pickers say so instead of claiming they are still connecting.
  const [modelsFailed, setModelsFailed] = useState(false);
  // Hydration couldn't reach the agent. Shown in place of the endless
  // "connecting to agent…" line, with a way to try again.
  const [connectError, setConnectError] = useState<string | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  // Caret offset in the composer, tracked so the `/schedule` hint can highlight
  // the slot the user is currently typing in.
  const [caret, setCaret] = useState(0);
  // `/schedule` runtime. Fires each due prompt through the normal send path,
  // skipping any occurrence that comes due mid-run rather than stacking agents.
  // In-memory for the life of the window — see useSchedules.
  const { schedules, addSchedule, stopSchedule } = useSchedules({
    queuedPrompts: useMemo(() => queuedMessages.map((m) => m.text), [queuedMessages]),
    onFire: useCallback((prompt: string) => {
      // keepInput: the user did not press Enter for this — leave whatever they
      // are typing untouched.
      submitTextRef.current(prompt, undefined, { keepInput: true, scheduled: true });
    }, []),
  });
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
  // Checklist is a workspace view; the mounted chat keeps its draft and history.
  const [showChecklist, setShowChecklist] = useState(false);
  // Activity can reconnect memoized effects before external-store subscriptions.
  // A fresh view identity forces rows to read the latest hidden stream first.
  const chatView = useMemo(() => ({ visible: !showChecklist }), [showChecklist]);
  const [showNotes, setShowNotes] = useState(false);
  const [showMemories, setShowMemories] = useState(false);
  // Every window chooses a code or chat workspace before connecting. Mode stays
  // separate from picker visibility so restore and reopened pickers are explicit.
  const [needsProject, setNeedsProject] = useState(true);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("code");
  const rawProjectHealth = state?.projectHealth;
  const projectHealth = useMemo(
    () => (workspaceMode === "code" ? parseProjectHealth(rawProjectHealth) : null),
    [workspaceMode, rawProjectHealth],
  );
  // False until the boot-time workspace-restore check resolves.
  const [restoreChecked, setRestoreChecked] = useState(false);
  // Every window starts from the mode-neutral home screen before choosing Code or Chat.
  const [entryView, setEntryView] = useState<EntryView>(initialEntryView(isSecondaryWindow));
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>("general");
  // Re-open the matching session picker over an already-open workspace.
  const [showPicker, setShowPicker] = useState(false);
  // Bumped on each workspace/session choice to force re-hydration.
  const [hydrateNonce, setHydrateNonce] = useState(0);
  const { activity, handleActivityEvent } = useTaskActivity(hydrateNonce);
  // New-session confirmation modal + in-flight guard.
  const [confirmNewSession, setConfirmNewSession] = useState(false);
  const {
    navHidden,
    setNavHiddenPersisted,
    toggleNav,
    toolsHidden,
    setToolsHiddenPersisted,
    toggleTools,
  } = useChromeToggles(chatLayout);
  const [newSessionBusy, setNewSessionBusy] = useState(false);
  const { exporting, chatHovered, setChatHovered, exportTranscript } = useTranscriptExport();
  const {
    appUpdate,
    showTraySettings,
    homeRefreshSignal,
    setHomeRefreshSignal,
    closeTraySettings,
  } = useTrayIntents({ needsProject, setWorkspaceMode, setEntryView, setShowPicker });
  // Initialize-git modal (shown via the top-right button when not yet a repo).
  const [showInitGit, setShowInitGit] = useState(false);
  // True once the initial hydrate (state + models + commands + history) has
  // settled for the current project/session. Gates the footer + chrome so they
  // reveal fully-formed in one pass instead of popping in piecemeal (cwd, git,
  // thinking, model each arriving separately would reflow the bar mid-load).
  const [hydrated, setHydrated] = useState(false);
  // First transcript id that should animate in. Everything restored by a
  // hydrate gets a lower id, so reopening a session (or switching projects)
  // lands instantly and only rows that arrive live afterwards rise into place.
  // Infinity while hydrating: nothing animates until the history is settled.
  const [liveFromId, setLiveFromId] = useState(Number.POSITIVE_INFINITY);
  const entrances = useMemo(() => createEntranceLifetime(liveFromId), [liveFromId]);
  // Children consume before playback. This parent effect also settles messages
  // received while Activity is hidden, when their own effects cannot run.
  useLayoutEffect(() => {
    const last = items[items.length - 1];
    if (last) entrances.settle(last.id);
  }, [entrances, items, showChecklist]);

  const readyRef = useRef(false);
  // Bumped by every hydrate. Lets work that outlives a hydrate (a project
  // switch, or re-selecting a session) tell whether its result is still wanted.
  const hydrateGenerationRef = useRef(0);
  // Mirror of `state` for use inside the memoized event handler (which doesn't
  // re-capture state). Lets turn_end pick the right context-token formula by
  // provider without re-subscribing the SSE listener on every state change.
  const stateRef = useRef<AgentState | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // NOTE: the build-session event machine's private refs (streaming bubble id,
  // rAF buffer, per-run accumulators, sub-agent / compaction group ids) now live
  // inside the useAgentEvents hook. Only the cross-cutting refs that App's render
  // + other handlers also touch (stateRef above, the plan refs + stickToBottom
  // below) stay here and are passed into the hook.

  const {
    stickToBottomRef,
    lastScrollTopRef,
    scrollToBottom,
    maybeScrollToBottom,
    following,
    windowStart,
    visibleItems,
    firstNewId,
    windowRef,
    askPlace,
    newMarkerRef,
    onTranscriptScroll,
    onTranscriptWheel,
    jumpToLatest,
    jumpToNew,
    jumpToAsk,
  } = useTranscriptScroll({ items, scrollRef, chatLayout });

  const setDragOverActive = useDragOverlay({ isFileDragOver, setIsFileDragOver });

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
  // is never hidden. useLayoutEffect runs before paint, so this pass never
  // flashes; animated chrome growth is caught by the ResizeObserver below. The
  // stick-to-bottom gate keeps it from yanking the view away while the user is
  // scrolled up reading mid-stream.
  useLayoutEffect(() => {
    maybeScrollToBottom();
  }, [items, windowStart, liveToolFeed, running, doneStatus, queuedCount, maybeScrollToBottom]);

  // …and keep re-pinning while the chrome below the transcript ANIMATES its
  // height. The queued-message strip (`.queued-bar`) slides open over 260ms, the
  // attachment / referenced-file bars and the live tool panel do the same; every
  // frame of that animation steals a few more pixels from the transcript AFTER
  // the layout effect above has already run, which is why a just-queued user
  // bubble ends up sliding under the composer while a normal send (no strip, no
  // height animation) looks fine. A ResizeObserver on the transcript viewport
  // fires on each of those frames, so the newest row stays visible for the whole
  // transition. It complements the layout effect rather than replacing it: an RO
  // only fires when the VIEWPORT resizes, so content growth (streaming tokens,
  // images) still needs the effect above. Shrinking the viewport never fires a
  // scroll event (scrollTop stays valid), so the stick-to-bottom pin survives and
  // a user scrolled up reading is still left alone.
  //
  // Attached through a callback ref, not an effect on `scrollRef.current`: the
  // transcript unmounts whenever a picker/home view takes over the window, and a
  // mount-time effect would observe a stale (or null) node after it comes back.
  const transcriptRoRef = useRef<ResizeObserver | null>(null);
  const attachTranscript = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef.current = el;
      if (el) lastScrollTopRef.current = el.scrollTop;
      transcriptRoRef.current?.disconnect();
      transcriptRoRef.current = null;
      if (!el || typeof ResizeObserver === "undefined") return;
      const ro = new ResizeObserver(() => {
        if (chatLayout.resized()) maybeScrollToBottom();
      });
      ro.observe(el);
      transcriptRoRef.current = ro;
    },
    [maybeScrollToBottom, chatLayout, lastScrollTopRef],
  );

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
      // After the first pin, so the rows that dissolve are the ones in view.
      if (scrollRef.current) dissolveInVisible(scrollRef.current);
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

  const windowFocused = useWindowFocused();
  const sendDisabled =
    attachmentsLoading ||
    (!input.trim() && attachments.length === 0 && mentionedPaths.length === 0);
  // Cosmetic work only belongs to a focused, visible, empty code composer.
  const animatePlaceholder =
    windowFocused &&
    !needsProject &&
    !showPicker &&
    !showChecklist &&
    workspaceMode === "code" &&
    input.length === 0;
  const inputPlaceholder = running
    ? RUNNING_INPUT_PLACEHOLDERS[placeholderIndex % RUNNING_INPUT_PLACEHOLDERS.length]
    : INPUT_PLACEHOLDERS[placeholderIndex % INPUT_PLACEHOLDERS.length];
  const setAnimatedPlaceholder = useCallback((text: string) => {
    displayPlaceholderRef.current = text;
    setDisplayPlaceholder(text);
  }, []);
  useEffect(() => {
    if (!animatePlaceholder) return;
    const id = window.setInterval(() => {
      setPlaceholderIndex((i) => i + 1);
    }, INPUT_PLACEHOLDER_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [animatePlaceholder]);
  useEffect(() => {
    if (!animatePlaceholder) {
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
  }, [animatePlaceholder, inputPlaceholder, setAnimatedPlaceholder]);

  const { handleWindowDragEnter, handleWindowDragOver, handleWindowDragLeave, handleWindowDrop } =
    useWindowFileDrop({
      setDragOverActive,
      stageAttachments,
      attachmentGenerationRef,
      insertDroppedFolderPaths,
      addFiles,
    });

  // Keep the native window title aligned with the visible title-bar context.
  useEffect(() => {
    const fallbackTitle = workspaceProductName(workspaceMode);
    const title =
      !needsProject && !showPicker
        ? formatWorkspaceTitle(
            state?.cwd,
            state?.gitBranch,
            fallbackTitle,
            state?.gitDirtyFileCount,
            state?.gitHubIssues ?? null,
            state?.gitHubPRs ?? null,
          )
        : fallbackTitle;
    setWindowTitle(title);
  }, [
    needsProject,
    showPicker,
    state?.cwd,
    state?.gitBranch,
    state?.gitDirtyFileCount,
    state?.gitHubIssues,
    state?.gitHubPRs,
    workspaceMode,
  ]);

  // Auto-grow the chat textarea, keeping the transcript's scroll position
  // intact across the measurement (see composer-autosize.ts for why both
  // halves matter).
  const autosizeInput = useCallback(() => {
    chatLayout.settle();
    autosizeComposer(inputRef.current, scrollRef.current, stickToBottomRef.current);
  }, [chatLayout, stickToBottomRef]);

  // useLayoutEffect (not useEffect) so the height is recomputed BEFORE the
  // browser paints. This matters most when the enhance animation tears down and
  // hands its multi-line text back to the textarea: with a post-paint effect the
  // textarea would flash at its default height for one frame, then resize — a
  // visible layout shift. Sizing pre-paint makes the handoff seamless.
  //
  // enhanceAnim is a dependency because the textarea is position:absolute during
  // the animation (stretched to the overlay's height), so a measurement taken
  // then is wrong; re-running once it clears sizes the now-in-flow textarea.
  useLayoutEffect(() => {
    autosizeInput();
  }, [input, enhanceAnim, autosizeInput]);

  // History anchoring and autosizing have landed. Commit the final scroll
  // position before paint; only the displayed positions move, never scrollTop.
  useLayoutEffect(() => {
    if (showChecklist || needsProject) {
      chatLayout.cancel();
      return;
    }
    if (chatLayout.commit(stickToBottomRef.current, scrollToBottom) && scrollRef.current) {
      lastScrollTopRef.current = scrollRef.current.scrollTop;
    }
  });
  useLayoutEffect(() => () => chatLayout.cancel(), [chatLayout, hydrateNonce]);

  // The height is only recomputed when `input` changes, so anything else that
  // re-wraps the draft leaves it stale until the next keystroke — the input
  // sitting at the wrong height and then settling as you type.
  //
  // Width is the recurring one: Cmd +/- zoom, a window resize, a sibling bar
  // appearing. Stale is worse than a jump here — overflow is pinned hidden below
  // the cap, so re-wrapped lines are clipped rather than scrollable. Only width
  // is acted on; reacting to height would feed our own resize back in as a loop.
  // Attached via a callback ref because the composer unmounts whenever a
  // picker/home view takes over the window.
  //
  // The resize runs on the next frame, not inside the callback: autosizing
  // changes this same textarea's height (and width, via is-multiline), and
  // resizing an observed element from its own callback leaves a notification
  // undelivered, which WebKit reports as "ResizeObserver loop completed with
  // undelivered notifications" on every send.
  const inputRoRef = useRef<{ observer: ResizeObserver; cancel: () => void } | null>(null);
  const attachInput = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inputRef.current = el;
      // Turn off macOS inline predictive text in the composer. WebKit lays the
      // grey suggested words out INSIDE the textarea, so a suggestion that runs
      // past the line end adds a wrapped line to scrollHeight; the next
      // keystroke's autosize grows the box to fit it, and the box drops back the
      // moment the suggestion is dismissed. That is the composer "randomly
      // growing a line and going back" while typing. WKWebView shows these by
      // default and the configuration switch is unreliable, so use the HTML
      // attribute (WebKit 18+). Not in React's DOM types, hence setAttribute.
      el?.setAttribute("writingsuggestions", "false");
      inputRoRef.current?.observer.disconnect();
      inputRoRef.current?.cancel();
      inputRoRef.current = null;
      if (!el || typeof ResizeObserver === "undefined") return;
      let lastWidth = el.clientWidth;
      let frame = 0;
      const ro = new ResizeObserver(() => {
        const width = el.clientWidth;
        if (width === lastWidth) return;
        lastWidth = width;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = 0;
          autosizeInput();
        });
      });
      ro.observe(el);
      inputRoRef.current = { observer: ro, cancel: () => cancelAnimationFrame(frame) };
    },
    [autosizeInput],
  );

  // Re-measure once font metrics are settled: an early draft (a restored one,
  // or fast typing right at launch) can be measured before the final face is
  // resolved, wrapping a line further and leaving the box a line too tall.
  // `ready` specifically: WebKit never dispatches `loadingdone`, so a listener
  // there would be dead code.
  useEffect(() => {
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) autosizeInput();
    });
    return () => {
      cancelled = true;
    };
  }, [autosizeInput]);

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

  const { windowIndex, windowTotal, isThisFocused } = useWindowOrder(inputRef);

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
    handleActivityEvent,
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
    setQueuedMessages,
    setAttachments: clearAttachments,
    setCommands,
    setModels,
    stateRef,
    planDoneRef,
    planTotalRef,
    planReviewPathRef,
    pendingPlanTotalRef,
    stickToBottomRef,
    liveText,
  });

  // Run the connect/ready flow against the current sidecar and hydrate state,
  // models, and commands. Re-invoked after a project switch respawns the
  // sidecar (its port changes, so we re-wait for readiness).
  const hydrate = useCallback(async (): Promise<void> => {
    const generation = ++hydrateGenerationRef.current;
    readyRef.current = false;
    setHydrated(false);
    setLiveFromId(Number.POSITIVE_INFINITY);
    setStatus("connecting to agent\u2026");
    setConnectError(null);
    setModelsFailed(false);
    try {
      await waitForReady();
      readyRef.current = true;
      const st = await getState().catch(() => null);
      if (st) {
        setState(st);
        setRunning(st.running);
        setStatus(st.runState === "cancelling" ? "cancelling..." : "ready");
      } else {
        setConnectError("Couldn't read this session from the agent.");
      }
      // Retries: this is the only unprompted model load, and an empty list
      // disables the picker for the whole session (see loadModelsWithRetry).
      // Deliberately NOT awaited — nothing below needs the list, and blocking on
      // the backoff would hold the transcript behind up to ~4s of retries on
      // exactly the slow-booting machines the retry exists for. The picker
      // fills itself in when an answer arrives, unless this hydrate has since
      // been superseded (project switch) — then the old sidecar's answer is
      // dropped rather than overwriting the new project's picker.
      void loadModelsInto(
        listModels,
        setModels,
        () => hydrateGenerationRef.current !== generation,
      ).then((ok) => {
        if (!ok && hydrateGenerationRef.current === generation) setModelsFailed(true);
      });
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
              return {
                kind: "error",
                id: nextId(),
                ...readChatError({ ...h.error }, h.error.scope, true),
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
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`agent failed to start: ${message}`);
      setConnectError(message);
    } finally {
      // Reveal the footer + chrome now that everything we know about the
      // session is in hand — one fade-in, no staggered reflow.
      setLiveFromId(lastIssuedId() + 1);
      setHydrated(true);
    }
  }, [stickToBottomRef]);

  useEffect(() => {
    const unsub = subscribe(handleEvent);
    return () => unsub();
  }, [handleEvent]);

  // Boot-time/reload workspace recovery: Rust keeps THIS window's active target
  // for its lifetime. A restored app launch and a WebKit content-process reload
  // therefore both hydrate straight back into the existing daemon session.
  useEffect(() => {
    void restoreTarget()
      .then((target) => {
        if (target) {
          setWorkspaceMode(target.mode);
          // No crossfade on boot: there's no previous screen to fade from.
          resetForChosenProject();
        }
      })
      .finally(() => setRestoreChecked(true));
    // Mount-only: the native target remains stable for this window's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const {
    checklistLoad,
    setChecklistLoad,
    checklistRunId,
    setChecklistRunId,
    checklistNotice,
    setChecklistNotice,
    checklistRunRef,
    checklistFetchRef,
    openChecklist,
    refreshChecklist,
  } = useChecklist({ showChecklist, setShowChecklist, inputRef });

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

  const { notes, handleNotesChange } = useProjectNotes(state?.cwd);

  // Pin Ken to a model (or null → clear the pin, follow GG Coder). The
  // sidecar's ken_model_change broadcast updates state; the .then is just a
  // faster local echo of the same payload.
  function onSelectKenModel(modelId: string | null): void {
    if (state && modelId !== null && state.kenModelOverride && modelId === state.kenModel) return;
    if (state && modelId === null && !state.kenModelOverride) return;
    void switchKenModel(modelId).then((res) => {
      if (!res) {
        // Without this the picker just snaps back and the click looks ignored.
        toast("Couldn't switch Ken's model.", "error");
        return;
      }
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
    });
  }

  function onSelectModel(modelId: string): void {
    if (state && modelId === state.model) return;
    void switchModel(modelId).then((res) => {
      if (isSwitchModelError(res)) {
        // The sidecar refuses with a reason worth reading ("Ollama isn't
        // running at …", "has no tool calling"). Show it — otherwise the
        // picker just snaps back with no explanation.
        toast(res.error, "error");
        return;
      }
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
  // `/schedule ` (past the command token) swaps the palette for the argument
  // hint. An invalid draft is blocked from being sent to the agent.
  const scheduleDraft = isScheduleDraft(input);
  const scheduleParse = scheduleDraft ? parseScheduleCommand(input) : null;
  // Drives the composer's invalid affordance; submit() enforces the block.
  const scheduleInvalid = scheduleParse !== null && !scheduleParse.ok;
  // Commit lives in the top-right button, not the slash menu.
  const COMMIT_NAMES = ["commit", "setup-commit"];
  // `/schedule` is handled entirely in the webview (it registers a timer rather
  // than prompting the agent), so the sidecar's registry never lists it. Inject
  // it here or it would be undiscoverable — typing `/sch` would show nothing.
  const menuCommands = [SCHEDULE_COMMAND, ...commands].filter(
    (c) => !COMMIT_NAMES.includes(c.name),
  );
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

  // Top-right commit affordance. `/commit` is built in (it runs the project's
  // checks, reviews, commits and pushes), so every project gets it; the
  // `/setup-commit` fallback only covers an older sidecar that lacks it.
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

  /** Put text in the composer with the caret at the end, ready to finish and send. */
  function fillComposer(text: string): void {
    setInput(text);
    setCaret(text.length);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  }

  /**
   * Fill the interval slot from a preset chip. Replaces an existing interval
   * rather than appending, so clicking `1h` after `15m` swaps it instead of
   * producing a second bar. Keeps focus in the composer so typing continues.
   */
  function fillScheduleInterval(preset: string): void {
    const { text, caret: caretAt } = withInterval(input, preset);
    setInput(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caretAt, caretAt);
      setCaret(caretAt);
    });
  }

  /** Ordered queue events own both pending rows and cancelled transcript bubbles. */
  function handleCancelQueued(id: string): void {
    void cancelQueued(id);
  }

  function pickSlashCommand(cmd: SlashCommand): void {
    if (cmd.name === "add-dir" || cmd.name === "remove-dir") {
      setInput("");
      setSlashIndex(0);
      void pickWorkspaceDirectory(cmd.name);
      return;
    }

    // Fill the input with the command; the user can add args or press Enter.
    const next = `/${cmd.name} `;
    setInput(next);
    setSlashIndex(0);
    // Keep the caret state in sync with the filled text, so an argument hint
    // (e.g. `/schedule`) highlights the right slot instead of a stale offset.
    setCaret(next.length);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function pickWorkspaceDirectory(command: "add-dir" | "remove-dir"): Promise<void> {
    const selected = await open({
      directory: true,
      multiple: false,
      title:
        command === "add-dir"
          ? "Add project folder to workspace"
          : "Remove project folder from workspace",
    });
    if (typeof selected !== "string") return;
    submitText(`/${command} ${selected}`, command === "add-dir" ? "/add-dir" : "/remove-dir");
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

  // Submit arbitrary text as if typed + entered. Shared by the input, the
  // top-right commit button, and the workspace directory picker. `label` shows
  // a friendly shimmer phrase in the transcript while the full `text` is still
  // sent to the agent.
  //
  // `keepInput` is for sends the user did not initiate right now — a scheduled
  // prompt firing on its interval. Those must NOT clear the composer, or a
  // schedule that comes due mid-sentence deletes what the user was typing.
  function submitText(
    text: string,
    label?: string,
    opts?: { keepInput?: boolean; scheduled?: boolean; onError?: (error: unknown) => void },
  ): boolean {
    const trimmed = text.trim();
    // Mid-run this QUEUES as steering, exactly like a typed message (see
    // submit()): the sidecar injects it into the running loop. Dropping it
    // instead would be silent — the folder picker especially, which gives no
    // hint that the directory you just chose went nowhere.
    const disposition = submitDisposition(trimmed, readyRef.current, running);
    if (disposition === "ignore") return false;
    chatLayout.capture();
    // A send that supersedes an open question is consumed the moment it lands
    // (the sidecar releases the parked call), so it must not wear the queued
    // look for the one frame before that, nor open the queued strip below the
    // transcript — see showsQueuedBubble / withoutSupersedingMessage.
    const supersedesQuestion = hasOpenAsk();
    const queued = showsQueuedBubble(disposition, supersedesQuestion);
    if (disposition === "queue" && supersedesQuestion) noteSupersedingSend(trimmed);
    dismissOpenAsks();
    // A user send always re-pins to the bottom — they want to see their message.
    stickToBottomRef.current = true;
    pushItem({
      kind: "user",
      id: nextId(),
      text: trimmed,
      command: label !== undefined || isWorkflowCommand(trimmed),
      ...(label !== undefined ? { label } : {}),
      ...(queued ? { queued: true } : {}),
    });
    if (!opts?.keepInput) {
      setInput("");
      setSlashIndex(0);
    }
    if (disposition !== "queue") endStreamingText();
    // `scheduled` tells the sidecar nobody is watching this run, so an
    // ask_user in it gets the short (autopilot) deadline.
    const sent = sendPrompt(trimmed, [], opts?.scheduled ? { scheduled: true } : undefined);
    if (opts?.onError) void sent.catch(opts.onError);
    else void sent;
    return true;
  }

  // Scheduled prompts fire from a ticker that is set up once, so it can't close
  // over this render's `submitText`. The ref keeps the ticker pointed at the
  // current one without re-creating the interval on every render.
  const submitTextRef = useRef(submitText);
  submitTextRef.current = submitText;

  // Return to chat without consuming the draft. Agent setup runs the existing
  // /init workflow; audits require a recorded result, never an inferred pass.
  function handleRunChecklistItem(item: ChecklistEntry): void {
    const setup = item.id === "agent-setup";
    const prompt = setup ? "/init" : item.runPrompt;
    if (prompt === null || running || checklistRunRef.current || !readyRef.current) return;
    const run = { id: item.id, checkedAt: item.checkedAt, expectsRecord: !setup };
    checklistRunRef.current = run;
    setChecklistRunId(item.id);
    setChecklistNotice(null);
    const failed = (): void => {
      if (checklistRunRef.current !== run) return;
      checklistRunRef.current = null;
      setChecklistRunId(null);
      setChecklistNotice({
        id: item.id,
        checkedAt: item.checkedAt,
        message: setup
          ? "Couldn't start /init. Try again."
          : "Couldn't start this check. Try again.",
      });
    };
    if (
      submitText(prompt, setup ? "/init" : `Checking ${item.title}`, {
        keepInput: true,
        onError: failed,
      })
    ) {
      withViewTransition(() => setShowChecklist(false));
    } else {
      failed();
    }
  }

  // Project Health → agent. The prompt (from the sidecar) has the agent check
  // the findings and ask with ask_user before fixing anything. Like a checklist
  // run it leaves the composer draft alone and returns to the chat.
  function reviewProjectHealth(prompt: string, label: string): boolean {
    if (!submitText(prompt, label, { keepInput: true })) return false;
    if (showChecklist) withViewTransition(() => setShowChecklist(false));
    return true;
  }

  // A question whose answer the user chose to TYPE rather than click. The next
  // composer submit belongs to it, not to a new prompt.
  const typingAskRef = useRef<{ itemId: number; promptId: string; questionId: string } | null>(
    null,
  );

  // Is a question still waiting on the user? Checked at send time only — the
  // transcript can run to thousands of rows, so this must not scan on every
  // keystroke-driven render.
  function hasOpenAsk(): boolean {
    return items.some((it) => it.kind === "ask" && it.sent !== true && it.cancelled !== true);
  }

  // A prompt sent while a question band is open supersedes it: the user chose
  // to say something else entirely. The sidecar releases the parked tool call
  // when that prompt lands, so the band can never be answered again — drop it
  // instead of leaving dead buttons in the transcript.
  const dismissOpenAsks = useCallback(() => {
    setItems(dropSupersededAsks);
    typingAskRef.current = null;
  }, [setItems]);

  // Text of the prompt that superseded a question and is now briefly sitting in
  // the sidecar's steering queue. Kept out of the queued strip until the agent
  // consumes it — see withoutSupersedingMessage.
  const supersedingTextRef = useRef<string | null>(null);
  const [supersedingText, setSupersedingText] = useState<string | null>(null);
  const supersedeClearRef = useRef<number | null>(null);
  const noteSupersedingSend = useCallback((text: string) => {
    supersedingTextRef.current = text;
    setSupersedingText(text);
    // Safety net: if the message never shows up in a queue broadcast at all
    // (the run ended between typing and sending, so it started a fresh turn),
    // nothing would ever clear the filter and a later identical message would
    // be missing from the strip.
    if (supersedeClearRef.current !== null) window.clearTimeout(supersedeClearRef.current);
    supersedeClearRef.current = window.setTimeout(() => {
      supersedingTextRef.current = null;
      setSupersedingText(null);
    }, 5000);
  }, []);
  useEffect(() => {
    const text = supersedingTextRef.current;
    if (text === null) return;
    // Gone from the queue: the agent took it, so stop filtering — otherwise a
    // later identical message would be hidden from the strip forever.
    if (!queuedMessages.some((m) => m.text === text)) {
      supersedingTextRef.current = null;
      setSupersedingText(null);
    }
  }, [queuedMessages]);
  const visibleQueuedMessages = useMemo(
    () => withoutSupersedingMessage(queuedMessages, supersedingText),
    [queuedMessages, supersedingText],
  );
  // Sub-agent groups for the critter floor. Recomputed with `items`, but the
  // floor compares group identities and ignores token-only re-renders.
  const critterGroups = useMemo(
    () =>
      items.filter(
        (item): item is Extract<Item, { kind: "subagent_group" }> & CritterGroup =>
          item.kind === "subagent_group",
      ),
    [items],
  );

  // Click handler for the "Send to GG Coder" button on Ken's recommended prompts.
  // Pushes a shimmering "Sent to GG Coder" user bubble (the full prompt body went
  // to GG Coder, but the transcript shows the short Ken-colored label, like a
  // slash command shows `/name`), then sends the prompt to the build session.
  // A failed send drops the bubble and says so; resolving false lets the
  // prompt block re-enable its button.
  const sendKenRecommendedPrompt = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!trimmed || !readyRef.current) return false;
      stickToBottomRef.current = true;
      dismissOpenAsks();
      const bubbleId = nextId();
      pushItem({ kind: "user", id: bubbleId, text: trimmed, kenSent: true });
      endStreamingText();
      try {
        await sendPrompt(trimmed, [], { kenSent: true });
        return true;
      } catch (error) {
        setItems((prev) => prev.filter((it) => it.id !== bubbleId));
        pushItem({
          kind: "error",
          id: nextId(),
          ...readChatError(
            {
              headline: "Ken's prompt wasn't sent",
              message: error instanceof Error ? error.message : String(error),
              guidance: "Click Send to GG Coder again when the agent is ready.",
              reason: "network",
            },
            "error",
          ),
        });
        return false;
      }
    },
    [pushItem, endStreamingText, dismissOpenAsks, stickToBottomRef],
  );

  // Record answers for an `ask_user` band, and settle the parked tool call once
  // every question in it has one — the band carries no send button, so the last
  // answer IS the send. App owns the merge because an answer can also arrive
  // from the composer, outside the band.
  //
  // The POST is optimistic: a failed one means the question already timed out or
  // the run was cancelled, and re-opening the band would hand the user a button
  // that can no longer reach anyone.
  //
  // The finished answer moves to the end of the conversation (see
  // answerAskItem): it reads as sent the way a typed prompt does, and the chat
  // follows it down even when the question was far up in the scrollback.
  const answerAsk = useCallback(
    (itemId: number, promptId: string, delta: Record<string, string | string[]>) => {
      const result = answerAskItem(
        windowRef.current.items,
        itemId,
        delta,
        (it) => (it.kind === "ask" ? it.prompt.questions : []),
        nextId,
      );
      if (result.completed) {
        // Sending is the user's own action: back to the bottom, like submit.
        stickToBottomRef.current = true;
        void answerAskUser(promptId, "answer", result.completed).catch(() => {});
      }
      setItems(result.items);
    },
    [setItems, stickToBottomRef, windowRef],
  );

  // "Something else" on a question: send the user to the composer they already
  // type in (seeded, when they got here by typing a character) instead of a
  // second input inside the transcript.
  const typeAskInstead = useCallback(
    (itemId: number, promptId: string, questionId: string, seed?: string) => {
      typingAskRef.current = { itemId, promptId, questionId };
      if (seed) setInput((current) => current + seed);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [],
  );

  const { recordHistory, navigateHistory } = usePromptHistory({
    promptHistoryRef,
    historyDraftRef,
    historyIndex,
    setHistoryIndex,
    setInput,
    inputRef,
  });

  const { runEnhance, onEnhanceAnimDone } = usePromptEnhance({
    input,
    setInput,
    inputRef,
    enhancing,
    setEnhancing,
    setEnhanceHintVisible,
    setEnhanceAnim,
    pendingEnhanceRef,
    enhancement,
    setEnhancement,
    hydrated,
    slashOpen,
    mentionOpen,
    scheduleDraft,
  });

  // A send that never reached the agent must not look delivered: drop its
  // bubble, say what happened, and hand the draft back. Anything the user has
  // typed or staged since is never overwritten.
  function restoreFailedSend(
    failed: {
      bubbleId: number;
      draft: string;
      attachments: PendingAttachment[];
      mentionedPaths: string[];
      scope: "error" | "ken_error";
    },
    error: unknown,
  ): void {
    setItems((prev) => prev.filter((it) => it.id !== failed.bubbleId));
    pushItem({
      kind: "error",
      id: nextId(),
      ...readChatError(
        {
          headline: "Your message wasn't sent",
          message: error instanceof Error ? error.message : String(error),
          guidance: "Your draft is back in the message box. Send it again when the agent is ready.",
          reason: "network",
        },
        failed.scope,
      ),
    });
    setInput((cur) => (cur === "" ? failed.draft : cur));
    if (failed.attachments.length > 0)
      setAttachments((cur) => (cur.length === 0 ? failed.attachments : cur));
    if (failed.mentionedPaths.length > 0)
      setMentionedPaths((cur) => (cur.length === 0 ? failed.mentionedPaths : cur));
  }

  // Submit the current input together with any staged attachments. Images are
  // echoed inline in the user's bubble; all media is sent to the agent.
  function submit(): void {
    if (attachmentReadsRef.current > 0) {
      toast("Attachments are still loading. Please wait.");
      return;
    }
    const trimmed = input.trim();
    // "Type instead" on an open question band parks the answer here: the agent's
    // tool call is blocked on it, so this text is the ANSWER, not a new prompt.
    // Queueing it as steering would leave the tool call hanging until it times
    // out, and the model would never see what the user typed. Only composer
    // sends the user typed count — a command or scheduled prompt firing through
    // submitText() must not consume the answer.
    const typed = typingAskRef.current;
    if (typed && trimmed) {
      chatLayout.capture();
      typingAskRef.current = null;
      setInput("");
      setSlashIndex(0);
      answerAsk(typed.itemId, typed.promptId, { [typed.questionId]: trimmed });
      return;
    }
    if (!readyRef.current) return;
    if (!trimmed && attachments.length === 0 && mentionedPaths.length === 0) return;

    // `/schedule` registers a recurring prompt instead of sending anything now.
    // An invalid draft is refused outright — sending it would run the raw command
    // text as a prompt — and the hint above the composer already says why.
    if (isScheduleDraft(input)) {
      const result = parseScheduleCommand(input);
      if (!result.ok) return;
      chatLayout.capture();
      addSchedule(result.value);
      // Confirm in the transcript, otherwise pressing Enter looks like it did
      // nothing: the first run is a whole interval away, so there is no other
      // feedback until then.
      pushItem({
        kind: "user",
        id: nextId(),
        text: trimmed,
        command: true,
        label: `Scheduled · ${describeSchedule(result.value)}`,
      });
      recordHistory(trimmed);
      stickToBottomRef.current = true;
      setInput("");
      setSlashIndex(0);
      return;
    }

    // `@Ken <prompt>` (case-insensitive, optional colon) routes to Ken Kai, the
    // read-only mentor agent — NOT GG Coder. Ken runs concurrently with any
    // build run; his reply streams into a magenta bubble via ken_* events.
    const kenMatch = workspaceMode === "code" ? /^@ken\b:?\s*/i.exec(trimmed) : null;
    if (kenMatch) {
      if (attachments.length > 0) {
        toast("Ken cannot receive attachments. Remove @Ken to send them to GG.", "warning");
        return;
      }
      const question = trimmed.slice(kenMatch[0].length).trim();
      if (!question) return;
      chatLayout.capture();
      recordHistory(trimmed);
      stickToBottomRef.current = true;
      const kenBubbleId = nextId();
      const kenFailed = {
        bubbleId: kenBubbleId,
        draft: input,
        attachments: [],
        mentionedPaths,
        scope: "ken_error" as const,
      };
      pushItem({ kind: "user", id: kenBubbleId, text: trimmed, ken: true });
      setInput("");
      setSlashIndex(0);
      setMention(null);
      setMentionedPaths([]);
      setEnhancement(null);
      void sendKenPrompt(question).catch((e: unknown) => restoreFailedSend(kenFailed, e));
      return;
    }

    chatLayout.capture();
    recordHistory(trimmed);
    // Read BEFORE the dismissal clears the band: a prompt that supersedes a
    // question is consumed as soon as it lands, so it must neither flash the
    // queued look on the way in nor open the queued strip below the transcript
    // (see showsQueuedBubble / withoutSupersedingMessage).
    const supersedesQuestion = hasOpenAsk();
    dismissOpenAsks();
    // A user send always re-pins to the bottom — they want to see their message.
    stickToBottomRef.current = true;
    // Referenced files are appended to the prompt as a small block so the agent
    // knows which paths to read; they aren't shown in the user's bubble text.
    const prompt =
      mentionedPaths.length > 0 ? appendReferencedFiles(trimmed, mentionedPaths) : trimmed;
    const bubbleId = nextId();
    const failed = {
      bubbleId,
      draft: input,
      attachments,
      mentionedPaths,
      scope: "error" as const,
    };
    // Carry the enhancer's highlighted segments into the sent bubble ONLY when
    // the message is the unedited enhanced text (the bubble shows `trimmed`).
    const sentEnhancements =
      enhancement && enhancement.plain === trimmed ? enhancement.segments : undefined;
    // While a run is in flight, the message is QUEUED as steering (the sidecar
    // injects it mid-loop). Attachments queue too — they're persisted and ride
    // the same native-block path when the queue drains. Queued rows render
    // dimmed until run_end clears the flag.
    if (running) {
      if (supersedesQuestion) noteSupersedingSend(prompt);
      const queuedWire = attachments.map(toWire);
      const queuedImgs = attachments.flatMap((a) => (a.previewUrl ? [a.previewUrl] : []));
      pushItem({
        kind: "user",
        id: bubbleId,
        text: trimmed,
        command: isWorkflowCommand(trimmed),
        images: queuedImgs.length > 0 ? queuedImgs : undefined,
        files: mentionedPaths.length > 0 ? mentionedPaths : undefined,
        enhancements: sentEnhancements,
        queued: showsQueuedBubble("queue", supersedesQuestion) ? true : undefined,
      });
      setInput("");
      clearAttachments();
      setSlashIndex(0);
      setMention(null);
      setMentionedPaths([]);
      setEnhancement(null);
      void sendPrompt(
        prompt,
        queuedWire,
        sentEnhancements ? { enhancements: sentEnhancements } : undefined,
      ).catch((e: unknown) => restoreFailedSend(failed, e));
      return;
    }
    const wire = attachments.map(toWire);
    const imgPreviews = attachments.flatMap((a) => (a.previewUrl ? [a.previewUrl] : []));
    pushItem({
      kind: "user",
      id: bubbleId,
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
    clearAttachments();
    setSlashIndex(0);
    setMention(null);
    setMentionedPaths([]);
    setEnhancement(null);
    endStreamingText();
    void sendPrompt(
      prompt,
      wire,
      sentEnhancements ? { enhancements: sentEnhancements } : undefined,
    ).catch((e: unknown) => restoreFailedSend(failed, e));
  }

  // ── Plan review actions (mirror the ggcoder CLI plan overlay) ──
  // Each closes the modal, drops a critter decision row, and drives the agent with
  // the corresponding instruction via the existing prompt path.
  //
  // The decision is always sent: the box only opens once the sidecar says the
  // plan is the user's, and a prompt landing during a run queues server-side.
  // (This used to bail silently on a stale `running` value, closing the box
  // and leaving the plan in limbo.)
  function runPlanPrompt(prompt: string, decision: PlanDecision, meta?: PromptMeta): void {
    setPlanReview(null);
    pushItem({ kind: "plan_decision", id: nextId(), decision });
    endStreamingText();
    void sendPrompt(prompt, [], meta).catch((error: unknown) => {
      reportPlanDecisionFailure("Your plan decision wasn't sent", error);
    });
  }

  function reportPlanDecisionFailure(headline: string, error: unknown): void {
    pushItem({
      kind: "error",
      id: nextId(),
      ...readChatError({
        headline,
        message: error instanceof Error ? error.message : String(error),
        guidance: "The plan is still waiting. Decide again once the agent is ready.",
      }),
    });
  }

  async function acceptPlan(): Promise<void> {
    // Capture the approved plan's step count BEFORE the IPC — accepting starts a
    // fresh session on the sidecar, whose session_reset broadcast nulls
    // planReview (and clears the transcript + counters) here.
    const reviewed = planReview;
    const nextPlanTotal = reviewed ? countPlanSteps(reviewed) : 0;
    // Stash a fallback for older sidecars. The current sidecar puts its canonical
    // live-file count directly on session_reset, which wins over this snapshot.
    pendingPlanTotalRef.current = nextPlanTotal;
    // Accept the plan: the sidecar wipes the planning conversation into a FRESH
    // session (so the build doesn't carry all the plan-mode research), bakes the
    // approved plan into the new system prompt, and broadcasts authoritative
    // progress before this request resolves. Do not re-seed from stale modal
    // content after the await: the plan file may already have changed.
    try {
      await acceptPlanIPC(planReviewPathRef.current);
    } catch (error) {
      // Refused (a run still finishing) or failed: sending "implement it now"
      // would run in the planning session without the approved plan. Say so
      // and re-open the box so Accept can be retried.
      pendingPlanTotalRef.current = null;
      reportPlanDecisionFailure("The plan couldn't be accepted", error);
      setPlanReview(reviewed);
      setPlanReviewAttempt((attempt) => attempt + 1);
      return;
    }
    runPlanPrompt(
      "The plan has been approved. Implement it now, following each step in order.",
      "accepted",
    );
  }

  function sendPlanFeedback(feedback: string): void {
    runPlanPrompt(
      `The plan was not approved. Feedback from the user:\n\n${feedback}\n\n` +
        "Revise the plan based on this feedback, then call exit_plan again for review.",
      "feedback",
      { planRevision: true },
    );
  }

  function rejectPlan(): void {
    runPlanPrompt(
      "The plan was rejected and dismissed. Do not implement it. Wait for new instructions.",
      "rejected",
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
    // Picker → workspace crossfades like every other screen change.
    withViewTransition(resetForChosenProject);
  }
  function resetForChosenProject(): void {
    checklistFetchRef.current++;
    checklistRunRef.current = null;
    setShowChecklist(false);
    setChecklistRunId(null);
    setChecklistNotice(null);
    setChecklistLoad({ kind: "loading" });
    stickToBottomRef.current = true;
    setItems([]);
    // A new project has no previous layout to carry into a transaction.
    updateLiveToolFeed([]);
    setState(null);
    setTasks([]);
    setContextTokens(0);
    // The done line + token tail belong to the run we're navigating away from;
    // leaving them up makes a brand-new session open on someone else's
    // "Brewed up a response in 14s · 800 tokens".
    setTokens(0);
    setDoneStatus(null);
    setPlanReview(null);
    planTotalRef.current = 0;
    planDoneRef.current = new Set();
    setPlanTotal(0);
    setPlanDone(new Set());
    attachmentGenerationRef.current++;
    attachmentReadsRef.current = 0;
    setAttachmentsLoading(false);
    setAttachments([]);
    setQueuedCount(0);
    updateQueuedMessages([]);
    setHydrated(false);
    setNeedsProject(false);
    setHydrateNonce((n) => n + 1);
  }

  // Show explicit recovery feedback while Rust resolves this window's durable
  // target. This branch used to paint only the dark background, which looked
  // indistinguishable from a dead/black webview during a slow recovery.
  if (needsProject && !restoreChecked) {
    return (
      <div className="app app-restoring" style={{ background: theme.background }}>
        <div className="app-restoring-status" role="status" aria-live="polite">
          <span className="app-restoring-dot" aria-hidden="true" />
          Restoring workspace…
        </div>
      </div>
    );
  }

  if (needsProject) {
    return (
      <div
        className={`app${windowFocused ? " window-focused" : ""}`}
        style={{ background: theme.background }}
      >
        {entryView === "home" ? (
          <HomeScreen
            onProjects={() =>
              withViewTransition(() => {
                setWorkspaceMode("code");
                setEntryView("projects");
              })
            }
            onChat={() =>
              withViewTransition(() => {
                setWorkspaceMode("chat");
                setEntryView("chats");
              })
            }
            onMotion={() =>
              withViewTransition(() => {
                setWorkspaceMode("motion");
                setEntryView("motion");
              })
            }
            onSettings={(tab) =>
              withViewTransition(() => {
                setSettingsTab(tab ?? "general");
                setEntryView("settings");
              })
            }
            refreshSignal={homeRefreshSignal}
          />
        ) : entryView === "settings" ? (
          <SettingsScreen
            initialTab={settingsTab}
            onClose={() =>
              withViewTransition(() => {
                setEntryView("home");
                // Settings may have changed the folder or providers.
                setHomeRefreshSignal((n) => n + 1);
              })
            }
          />
        ) : entryView === "chats" ? (
          <ChatPicker
            onChosen={onProjectChosen}
            onClose={() => withViewTransition(() => setEntryView("home"))}
          />
        ) : entryView === "motion" ? (
          <ChatPicker
            mode="motion"
            onChosen={onProjectChosen}
            onClose={() => withViewTransition(() => setEntryView("home"))}
          />
        ) : (
          <ProjectPicker
            onChosen={onProjectChosen}
            // Every window can return to the mode-neutral home screen.
            onClose={() => withViewTransition(() => setEntryView("home"))}
          />
        )}
        {showTraySettings && <SettingsModal onClose={closeTraySettings} />}
        <Toaster />
      </div>
    );
  }

  // Picker reopened over an already-open workspace. Back from the picker returns
  // to the home screen; choosing a session resets and re-hydrates this window.
  if (showPicker) {
    const pickerProps = {
      onChosen: () =>
        withViewTransition(() => {
          setShowPicker(false);
          resetForChosenProject();
        }),
      onClose: () =>
        withViewTransition(() => {
          setShowPicker(false);
          setNeedsProject(true);
          setEntryView("home" as const);
        }),
    };
    return (
      <div
        className={`app${windowFocused ? " window-focused" : ""}`}
        style={{ background: theme.background }}
      >
        {workspaceMode === "chat" ? (
          <ChatPicker initialAgent={state?.chatAgent ?? "general"} {...pickerProps} />
        ) : workspaceMode === "motion" ? (
          <ChatPicker mode="motion" {...pickerProps} />
        ) : (
          <ProjectPicker initialProjectPath={state?.cwd ?? null} {...pickerProps} />
        )}
        {showTraySettings && <SettingsModal onClose={closeTraySettings} />}
        {/* Tray Settings can toast a save failure over the picker. */}
        <Toaster />
      </div>
    );
  }

  return (
    <div
      className={`app${isFileDragOver ? " app-file-dragover" : ""}${windowFocused ? " window-focused" : ""}${workspaceMode === "code" && showChecklist ? " checklist-open" : ""}`}
      data-glow={glowState}
      style={{ background: theme.background, ...glowStyle }}
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
        gitHubIssues={state?.gitHubIssues}
        gitHubPRs={state?.gitHubPRs}
        gitHubRepoUrl={state?.gitHubRepoUrl}
        gitHubCI={state?.gitHubCI}
        projectHealth={projectHealth}
        onReviewHealth={reviewProjectHealth}
        additionalRoots={state?.additionalRoots}
        navHidden={navHidden}
        onToggleNav={() => withViewTransition(toggleNav)}
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
          label={
            showChecklist
              ? "Back to chat"
              : workspaceMode === "chat"
                ? "Back to chats"
                : workspaceMode === "motion"
                  ? "Back to motion sessions"
                  : "Back to this project's sessions"
          }
          onClick={() =>
            withViewTransition(() =>
              showChecklist ? setShowChecklist(false) : setShowPicker(true),
            )
          }
        />
        <WorkspaceHeaderActions
          workspaceMode={workspaceMode}
          progress={progress}
          rankCelebrateNonce={rankCelebrateNonce}
          xpChips={xpChips}
          onOpenScorecard={() => setShowScorecard(true)}
          windowFocused={windowFocused}
          running={running}
          autopilot={state?.autopilot ?? false}
          autopilotReviewing={autopilotReviewing}
          onAutopilotChange={(next) => {
            setState((s) => (s ? { ...s, autopilot: next } : s));
            void setAutopilot(next);
            setKenPowerBanner(next ? "on" : "off");
          }}
          onNewSession={() => setConfirmNewSession(true)}
          onOpenNotes={() => setShowNotes(true)}
          onOpenMemories={() => setShowMemories(true)}
          projectTasks={projectTasks}
          onOpenTasks={openTasks}
          showChecklist={showChecklist}
          onOpenChecklist={openChecklist}
          onArrange={() => {
            setNavHiddenPersisted(true);
            setToolsHiddenPersisted(true);
          }}
          needsGitInit={needsGitInit}
          onInitGit={() => setShowInitGit(true)}
          commitCommand={commitCommand}
          hasCommit={hasCommit}
          onCommit={() =>
            submitText(
              `/${commitCommand}`,
              hasCommit ? "Committing\u2026" : "Setting up commits\u2026",
            )
          }
        />
      </WorkspaceHeader>

      {workspaceMode === "code" && showChecklist && (
        <ChecklistScreen
          load={checklistLoad}
          running={running || checklistRunId !== null}
          activeId={checklistRunId}
          notice={checklistNotice}
          onRun={handleRunChecklistItem}
          onRetry={() => {
            setChecklistLoad({ kind: "loading" });
            void refreshChecklist();
          }}
        />
      )}

      {/* React owns chat visibility rather than a stylesheet override. Activity
          keeps the draft and transcript state, and suspends hidden child effects. */}
      <Activity mode={showChecklist ? "hidden" : "visible"}>
        {/* Non-scrolling frame the same size as the chat viewport. The banner
          lives HERE, not inside `.transcript` — `.transcript` scrolls, and an
          absolutely positioned child of a scrolling container is pinned to the
          top of the scrolled CONTENT, not the visible viewport, so in an
          existing session scrolled down it rendered far above what's on
          screen. Anchoring to this non-scrolling sibling keeps it pinned to
          what the user is actually looking at, at any scroll position. */}
        <div
          className="transcript-frame"
          onMouseEnter={() => setChatHovered(true)}
          onMouseLeave={() => setChatHovered(false)}
        >
          {workspaceMode === "code" && kenPowerBanner && (
            <KenPowerBanner mode={kenPowerBanner} onDone={() => setKenPowerBanner(null)} />
          )}
          <div
            className="transcript"
            ref={attachTranscript}
            onScroll={onTranscriptScroll}
            onWheel={onTranscriptWheel}
          >
            {!hydrated && items.length === 0 ? (
              <TranscriptSkeleton />
            ) : (
              <>
                {items.length === 0 &&
                  (connectError !== null ? (
                    <div className="picker-empty transcript-reveal" role="alert">
                      <span>Couldn't connect to the agent.</span>
                      <span style={{ color: theme.textDim }}>{connectError}</span>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => setHydrateNonce((n) => n + 1)}
                      >
                        Try again
                      </button>
                    </div>
                  ) : status === "ready" ? (
                    <WakeScreen
                      chat={workspaceMode === "chat"}
                      motion={workspaceMode === "motion"}
                    />
                  ) : (
                    <div className="line transcript-reveal" style={{ color: theme.textDim }}>
                      {`\u273b ${status}`}
                    </div>
                  ))}
                <PromptSendProvider value={sendKenRecommendedPrompt}>
                  <LiveTextContext.Provider value={liveText}>
                    {visibleItems.flatMap((it) => {
                      const row = (
                        <TranscriptRow
                          key={it.id}
                          item={it}
                          view={chatView}
                          animateIn={it.id >= liveFromId}
                          consumeEntrance={entrances.consume}
                          kenTalking={it.id === talkingKenId}
                          errorActive={it.id === currentErrorId}
                          errorCritterId={errorCritters.get(it.id)}
                          errorModelPicker={
                            it.kind === "error" && it.id === currentErrorId ? (
                              <ModelSelect
                                models={models}
                                currentModel={
                                  it.scope === "ken_error" || it.scope === "autopilot_error"
                                    ? (state?.kenModel ?? state?.model ?? "")
                                    : (state?.model ?? "")
                                }
                                onSelect={
                                  it.scope === "ken_error" || it.scope === "autopilot_error"
                                    ? onSelectKenModel
                                    : onSelectModel
                                }
                                disabled={running || kenRunning || autopilotReviewing}
                                title={
                                  it.scope === "ken_error" || it.scope === "autopilot_error"
                                    ? "Switch Ken's model"
                                    : "Switch model"
                                }
                                label={
                                  it.reason === "usage_limit" ? "Switch provider" : "Choose model"
                                }
                                color={theme.primary}
                              />
                            ) : undefined
                          }
                          onContentGrow={maybeScrollToBottom}
                          onAskAnswer={answerAsk}
                          onAskType={typeAskInstead}
                        />
                      );
                      // Zero-height landing spot for "You have new chats". A flat
                      // keyed list, so rows never remount when it comes and goes.
                      return it.id === firstNewId
                        ? [
                            <div
                              key="new-marker"
                              ref={newMarkerRef}
                              className="transcript-new-marker"
                              aria-hidden="true"
                            />,
                            row,
                          ]
                        : [row];
                    })}
                  </LiveTextContext.Provider>
                </PromptSendProvider>
              </>
            )}
          </div>
          {items.length > 0 && (
            <ExportChatButton
              visible={chatHovered || exporting}
              busy={exporting}
              onExport={() => void exportTranscript()}
            />
          )}
          {items.length > 0 && (
            <TranscriptJumpControls
              away={!following}
              hasNew={firstNewId !== null}
              askAt={askPlace === "above" || askPlace === "below" ? askPlace : null}
              onScrollToBottom={jumpToLatest}
              onJumpToNew={jumpToNew}
              onJumpToAsk={jumpToAsk}
            />
          )}
        </div>

        {/* Sub-agents walk on top of the pinned region as critters; the lane
          opens (pushing the chat up) only while one is out. */}
        <CritterFloor groups={critterGroups} />
        <div ref={liveRegionRef} className="liveregion">
          {/* Motion's starting points sit just above the activity bar and go away
            once the conversation has its first message. */}
          {workspaceMode === "motion" && hydrated && items.length === 0 && !running && (
            <MotionStarters onPick={fillComposer} />
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
          {/* Automatic review stays in the same task row; manual @Ken keeps its own bar. */}
          {(workspaceMode !== "code" || running || autopilotReviewing || !kenRunning) && (
            <ActivityBar
              running={running}
              activity={activity}
              cancelling={cancelling}
              tokens={tokens}
              doneStatus={doneStatus}
              isThinking={isThinking}
              thinkingStartTs={thinkingStartTs}
              thinkingAccumMs={thinkingAccumMs}
              planTotal={workspaceMode !== "code" ? 0 : planTotal}
              planDone={workspaceMode !== "code" ? 0 : Math.min(planDone.size, planTotal)}
              onCancel={requestCancel}
              toolsHidden={toolsHidden}
              hasToolFeed={liveToolFeed.length > 0}
              onToggleTools={toggleTools}
            />
          )}
        </div>

        <Composer
          workspaceMode={workspaceMode}
          state={state}
          composerRef={composerRef}
          isFileDragOver={isFileDragOver}
          scheduleInvalid={scheduleInvalid}
          scheduleDraft={scheduleDraft}
          running={running}
          kenRunning={kenRunning}
          autopilotReviewing={autopilotReviewing}
          cancelling={cancelling}
          sendDisabled={sendDisabled}
          windowFocused={windowFocused}
          input={input}
          setInput={setInput}
          caret={caret}
          setCaret={setCaret}
          fillScheduleInterval={fillScheduleInterval}
          slashOpen={slashOpen}
          slashMatches={slashMatches}
          clampedSlashIndex={clampedSlashIndex}
          pickSlashCommand={pickSlashCommand}
          setSlashIndex={setSlashIndex}
          mentionOpen={mentionOpen}
          fileMatches={fileMatches}
          clampedFileIndex={clampedFileIndex}
          mention={mention}
          setMention={setMention}
          pickMentionFile={pickMentionFile}
          setFileIndex={setFileIndex}
          updateMention={updateMention}
          attachments={attachments}
          attachmentsLoading={attachmentsLoading}
          removeAttachment={removeAttachment}
          addFiles={addFiles}
          fileInputRef={fileInputRef}
          mentionedPaths={mentionedPaths}
          removeMentionChip={removeMentionChip}
          visibleQueuedMessages={visibleQueuedMessages}
          handleCancelQueued={handleCancelQueued}
          enhanceAnim={enhanceAnim}
          onEnhanceAnimDone={onEnhanceAnimDone}
          enhancement={enhancement}
          setEnhancement={setEnhancement}
          enhancing={enhancing}
          enhanceHintVisible={enhanceHintVisible}
          runEnhance={runEnhance}
          kenActive={kenActive}
          kenInputParts={kenInputParts}
          attachInput={attachInput}
          displayPlaceholder={displayPlaceholder}
          lastKeystrokeAtRef={lastKeystrokeAtRef}
          historyIndex={historyIndex}
          setHistoryIndex={setHistoryIndex}
          navigateHistory={navigateHistory}
          submit={submit}
          requestCancel={requestCancel}
        />

        <AppFooter
          hydrated={hydrated}
          workspaceMode={workspaceMode}
          state={state}
          tasks={tasks}
          schedules={schedules}
          stopSchedule={stopSchedule}
          runningTaskCount={runningTaskCount}
          contextPct={contextPct}
          running={running}
          kenRunning={kenRunning}
          autopilotReviewing={autopilotReviewing}
          models={models}
          modelsFailed={modelsFailed}
          onSelectModel={onSelectModel}
          onSelectKenModel={onSelectKenModel}
        />

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
      </Activity>

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
          // Nothing is cleared: `newSession()` writes a NEW session file and
          // leaves the old one on disk, still listed and re-openable. Saying
          // "will be cleared" made a safe action read as destructive.
          message="Start fresh? This conversation stays saved."
          confirmLabel={workspaceMode === "chat" ? "New Chat" : "New Session"}
          busy={newSessionBusy}
          onConfirm={() => void startNewSession()}
          onClose={() => setConfirmNewSession(false)}
        />
      )}

      {/* Always mounted: an MCP server can ask for input at any moment, in any
          workspace mode, and its tool call stays blocked until we answer. */}
      <McpElicitModal />

      {workspaceMode === "code" && planReview !== null && (
        <PlanReviewModal
          key={planReviewAttempt}
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

      {showNotes && (
        <NotesModal
          value={notes}
          onChange={handleNotesChange}
          onClose={() => setShowNotes(false)}
        />
      )}

      {showScorecard && progress && (
        <ScorecardModal snapshot={progress} onClose={() => setShowScorecard(false)} />
      )}

      {/* Settings reached from the menu-bar tray. Rendered in every view branch
          (Home, picker, workspace) because the tray targets a WINDOW and can't
          know which of the three it is showing. */}
      {showTraySettings && <SettingsModal onClose={closeTraySettings} />}

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
      {/* Workspace toasts (saved transcript, Remote on/off, rank-up) need their
          own host: the one in the Home/Settings branch isn't mounted here. */}
      <Toaster />
    </div>
  );
}

export default App;
