// The live preview chat: gg-app's real Deck, ActivityBar, Composer and
// transcript rows, in a cross-origin iframe on the previewed page. It talks to
// the preview's own session through the frame server (shims/invoke.ts), and to
// the page only through the postMessage protocol (../protocol.ts).
import "../../src/App.css";
import "../../src/Deck.css";
import "../../src/Trophies.css";
import "./live.css";
import {
  StrictMode,
  type DragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { ChatCircleDotsIcon, CursorClickIcon, MinusIcon } from "@phosphor-icons/react";
import { Deck, type DeckPanelId } from "../../src/Deck";
import { ActivityBar } from "../../src/ActivityBar";
import { Composer } from "../../src/Composer";
import type { LiveToolEntry } from "../../src/LiveToolPanel";
import { PromptSendProvider } from "../../src/Markdown";
import { TranscriptRow } from "../../src/TranscriptRow";
import type { Item } from "../../src/transcript-item";
import { useAgentEvents } from "../../src/useAgentEvents";
import { createLiveTextStore, LiveTextContext } from "../../src/live-text";
import { createEntranceLifetime } from "../../src/transcript-motion";
import { INITIAL_ACTIVITY, reduceTaskActivity, type TaskActivity } from "../../src/task-activity";
import { usePromptEnhance } from "../../src/usePromptEnhance";
import { WorkspaceHeader } from "../../src/WorkspaceHeader";
import { glowPlacement, glowStateFor, glowVars } from "../../src/window-glow";
import {
  cancel,
  getState,
  listModels,
  sendPrompt,
  switchModel,
  type AgentState,
  type ModelOption,
  type SidecarEvent,
} from "../../src/agent";
import {
  attachmentBytes,
  MAX_ATTACHMENT_BYTES,
  toWire,
  type PendingAttachment,
} from "../../src/attachments";
import { useAttachments } from "../../src/useAttachments";
import type { DraftEnhancement } from "../../src/PromptEnhancement";
import { chipName, toDevUrl, type PickedElement } from "../protocol";
import { createParentBridge } from "./bridge";
import { streamEvents } from "./events";
import { LIVE_HEADER } from "./shims/invoke";

interface FrameConfig {
  devUrl: string;
  proxyOrigins: string[];
}

const bridge = createParentBridge();
const UI_KEY = "gg-live-ui";
const DRAFT_KEY = "gg-live-draft";

const readJson = <T,>(storage: Storage, key: string, fallback: T): T => {
  try {
    return (JSON.parse(storage.getItem(key) || "null") as T | null) ?? fallback;
  } catch {
    return fallback;
  }
};

function LiveApp() {
  // ── Session state, as gg-app's App keeps it ──
  const [config, setConfig] = useState<FrameConfig | null>(null);
  const [state, setState] = useState<AgentState | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsFailed, setModelsFailed] = useState(false);
  const [panel, setPanel] = useState<DeckPanelId | null>(null);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [tokens, setTokens] = useState(0);
  const [doneStatus, setDoneStatus] = useState<string | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingStartTs, setThinkingStartTs] = useState<number | null>(null);
  const [thinkingAccumMs, setThinkingAccumMs] = useState(0);
  const [liveToolFeed, setLiveToolFeed] = useState<LiveToolEntry[]>([]);
  const [contextTokens, setContextTokens] = useState(0);
  const [activity, setActivity] = useState<TaskActivity>(INITIAL_ACTIVITY);
  const [toolsHidden, setToolsHidden] = useState(false);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  const refreshState = useCallback(() => {
    getState()
      .then(setState)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshState();
    listModels()
      .then((m) => (m ? setModels(m) : setModelsFailed(true)))
      .catch(() => setModelsFailed(true));
  }, [refreshState]);

  // ── Session events through gg-app's own useAgentEvents ──
  const [items, setItems] = useState<Item[]>([]);
  const idRef = useRef(0);
  const nextId = useCallback(() => ++idRef.current, []);
  const [liveText] = useState(createLiveTextStore);
  const noopSet = useCallback(() => {}, []) as never;
  const refs = {
    planDoneRef: useRef(new Set<number>()),
    planTotalRef: useRef(0),
    planReviewPathRef: useRef<string | null>(null),
    pendingPlanTotalRef: useRef<number | null>(null),
    stickToBottomRef: useRef(true),
  };
  const { handleEvent } = useAgentEvents({
    setItems,
    nextId,
    liveText,
    stateRef,
    handleKenEvent: () => false,
    handleAutopilotEvent: () => false,
    handleActivityEvent: (e) => setActivity((a) => reduceTaskActivity(a, e, Date.now())),
    setState,
    setRunning,
    setLiveToolFeed,
    setTokens,
    setContextTokens,
    setDoneStatus,
    setIsThinking,
    setThinkingStartTs,
    setThinkingAccumMs,
    setModels,
    setTasks: noopSet,
    setProjectTasks: noopSet,
    setStatus: noopSet,
    setPlanTotal: noopSet,
    setPlanDone: noopSet,
    setPlanReview: noopSet,
    setQueuedCount: noopSet,
    setQueuedMessages: noopSet,
    setAttachments: noopSet,
    setCommands: noopSet,
    ...refs,
    onRunEnd: () => {
      setCancelling(false);
      refreshState();
    },
  });
  // A message sent mid-run waits in the queue; its bubble says so until the agent takes it.
  const awaitingDrain = useRef(false);
  const markQueued = (queued: boolean) =>
    setItems((prev) => {
      let i = prev.length - 1;
      while (i >= 0 && prev[i].kind !== "user") i--;
      return i < 0 ? prev : prev.map((it, j) => (j === i ? ({ ...it, queued } as Item) : it));
    });
  const onEvent = useRef<(e: SidecarEvent) => void>(() => {});
  useLayoutEffect(() => {
    onEvent.current = (e) => {
      const d = (e.data ?? {}) as Record<string, unknown>;
      handleEvent(e);
      if (e.type === "live_preview_prompt" && d.queued === true) {
        awaitingDrain.current = true;
        markQueued(true);
      } else if (e.type === "run_start") {
        setRunStartedAt(Date.now());
        if (awaitingDrain.current) {
          awaitingDrain.current = false;
          markQueued(false);
        }
      } else if (e.type === "queued" && d.count === 0 && awaitingDrain.current) {
        awaitingDrain.current = false;
        markQueued(false);
      }
    };
  });
  useEffect(
    () =>
      streamEvents(
        (e) => onEvent.current(e),
        // Every connection replays the session from the start: rebuild, don't append.
        () => {
          setItems([]);
          awaitingDrain.current = false;
        },
      ),
    [],
  );

  // ── Open/minimised, remembered across page loads ──
  // The page's memory (in the hash) wins: it survives where the frame's storage may not.
  const [open, setOpen] = useState<boolean>(() => {
    const fromPage = /^#open=([01])$/.exec(location.hash)?.[1];
    return fromPage ? fromPage === "1" : readJson(sessionStorage, UI_KEY, { open: true }).open;
  });

  // ── The page: its address, viewport and picked element ──
  const [pageUrl, setPageUrl] = useState("");
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [pickMissing, setPickMissing] = useState(false);
  const [picking, setPicking] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const focusInput = () =>
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  useEffect(() => {
    const off = bridge.onMessage((msg) => {
      switch (msg.type) {
        case "gg-live:hello":
        case "gg-live:viewport": {
          const root = document.documentElement.style;
          root.setProperty("--host-vw", `${msg.viewport.width}px`);
          root.setProperty("--host-vh", `${msg.viewport.height}px`);
          if (msg.type === "gg-live:hello") setPageUrl(msg.url);
          break;
        }
        case "gg-live:url":
          setPageUrl(msg.url);
          break;
        case "gg-live:picked":
          setPicked(msg.element);
          setPickMissing(msg.missing);
          break;
        case "gg-live:picking":
          setPicking(msg.on);
          break;
        case "gg-live:focus":
          // Sent after a new pick: bring the chat up to ask about it.
          setOpen(true);
          focusInput();
          break;
      }
    });
    fetch("/api/config", { headers: { [LIVE_HEADER]: "1" }, credentials: "omit" })
      .then((r) => (r.ok ? (r.json() as Promise<FrameConfig>) : Promise.reject(r.status)))
      .then((c) => {
        setConfig(c);
        bridge.setOrigins(c.proxyOrigins);
        bridge.post({ type: "gg-live:ready" });
      })
      .catch(() => {});
    return off;
  }, []);

  useEffect(() => {
    sessionStorage.setItem(UI_KEY, JSON.stringify({ open }));
    bridge.post({ type: "gg-live:open", open });
  }, [open, config]);

  // Mirror our size onto the iframe's clip, so it shows (and takes clicks on) the chat only.
  const rootRef = useRef<HTMLDivElement>(null);
  const sizing = useRef<{ makeRoom: () => void; settle: () => void } | null>(null);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let last = "";
    const report = () => {
      const width = Math.ceil(el.offsetWidth);
      const height = Math.ceil(el.offsetHeight);
      const key = `${width}x${height}`;
      if (key === last) return;
      last = key;
      bridge.post({ type: "gg-live:size", width, height });
    };
    sizing.current = {
      // Room for the tallest deck panel, capped at the page's viewport.
      makeRoom: () => {
        const vh = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue("--host-vh"),
        );
        const height = Math.min(vh > 0 ? vh : 800, Math.ceil(el.offsetHeight) + 560);
        last = "";
        bridge.post({ type: "gg-live:size", width: Math.ceil(el.offsetWidth), height });
      },
      settle: () => {
        last = "";
        report();
      },
    };
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => {
      ro.disconnect();
      sizing.current = null;
    };
  }, [config]);

  // The page moves the iframe's clip a frame or two after we ask. Opening a panel first asks
  // for room and draws the panel once the clip has it, so the panel fades in whole like in
  // the app instead of popping in cut off. Closing needs no wait: the spare room is empty.
  const changePanel = useCallback((next: DeckPanelId | null) => {
    if (next === null || !sizing.current) {
      setPanel(next);
      return;
    }
    sizing.current.makeRoom();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setPanel(next);
        requestAnimationFrame(() => sizing.current?.settle());
      }),
    );
  }, []);

  // ── Composer state ──
  const [input, setInputRaw] = useState(() => readJson(sessionStorage, DRAFT_KEY, ""));
  const setInput: typeof setInputRaw = (v) =>
    setInputRaw((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      try {
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify(next));
      } catch {
        /* the draft just won't survive a reload */
      }
      return next;
    });
  const [caret, setCaret] = useState(0);
  const [sendCount, setSendCount] = useState(0);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceHintVisible, setEnhanceHintVisible] = useState(false);
  const [enhanceAnim, setEnhanceAnim] = useState<{
    oldText: string;
    newText: string | null;
  } | null>(null);
  const [enhancement, setEnhancement] = useState<DraftEnhancement | null>(null);
  const pendingEnhanceRef = useRef(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastKeystrokeAtRef = useRef(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
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
    hydrated: true,
    slashOpen: false,
    mentionOpen: false,
    scheduleDraft: false,
  } as Parameters<typeof usePromptEnhance>[0]);

  // Pasted files, plus the picked element shown as one more chip.
  const pasted = useAttachments();
  const PICK_CHIP_ID = -1;
  const attachments: PendingAttachment[] = picked
    ? [
        {
          id: PICK_CHIP_ID,
          kind: "file",
          name: chipName(picked) + (pickMissing ? " · not on this page" : ""),
          mediaType: "text/html",
          data: "",
        },
        ...pasted.attachments,
      ]
    : pasted.attachments;

  const [sendError, setSendError] = useState<string | null>(null);
  const submit = () => {
    const text = input.trim();
    const files = pasted.attachments;
    if ((!text && files.length === 0) || !config || pasted.attachmentsLoading) return;
    const wire = files.map(toWire);
    const totalBytes = attachmentBytes(wire);
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      const mb = (bytes: number): number => Math.ceil(bytes / (1024 * 1024));
      setSendError(
        `Attachments are too big to send (${mb(totalBytes)} MB). The limit is ${mb(MAX_ATTACHMENT_BYTES)} MB per message.`,
      );
      return;
    }
    const element =
      picked && !pickMissing
        ? { selector: picked.selector, html: picked.html, tag: picked.tag, text: picked.text }
        : null;
    const url = toDevUrl(pageUrl || config.devUrl, config.devUrl, config.proxyOrigins);
    setSendError(null);
    void sendPrompt(text, wire, { livePreview: { url, element } }).catch((err: unknown) => {
      setSendError(typeof err === "string" ? err : String(err));
      setInput(text);
      pasted.setAttachments((now) => [...files, ...now]);
    });
    setInput("");
    pasted.clearAttachments();
    setEnhancement(null);
    setSendCount((n) => n + 1);
  };
  // A prompt suggested in a reply (Markdown's "send" links) goes out like a typed one.
  const sendFromReply = (text: string): Promise<boolean> => {
    if (!config) return Promise.resolve(false);
    const url = toDevUrl(pageUrl || config.devUrl, config.devUrl, config.proxyOrigins);
    return sendPrompt(text, [], { livePreview: { url, element: null } }).then(
      () => true,
      () => false,
    );
  };
  const requestCancel = () => {
    setCancelling(true);
    void cancel().catch(() => setCancelling(false));
  };
  const onSelectModel = (modelId: string) => {
    void switchModel(modelId).then(() => {
      refreshState();
      setPanel(null);
    });
  };
  const togglePicking = () => {
    const next = !picking;
    setPicking(next);
    bridge.post({ type: "gg-live:picking", on: next });
  };
  // Esc in the chat: with an element picked, drops it and goes back to picking another; in pick
  // mode, leaves it. An open deck menu closes first. It never hides the chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (picking) {
        e.preventDefault();
        e.stopPropagation();
        setPicking(false);
        bridge.post({ type: "gg-live:picking", on: false });
      } else if (picked && panel === null) {
        e.preventDefault();
        e.stopPropagation();
        setPicked(null);
        bridge.post({ type: "gg-live:clear-pick" });
        setPicking(true);
        bridge.post({ type: "gg-live:picking", on: true });
      }
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [picking, picked, panel]);

  // The app's ambient glow: idle, working, then done until the next run starts.
  const [hasFinishedRun, setHasFinishedRun] = useState(false);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      setHasFinishedRun(false);
    } else if (wasRunning.current) {
      wasRunning.current = false;
      setHasFinishedRun(true);
    }
  }, [running]);
  const glowStyle = useMemo(
    () => glowVars(glowPlacement(state?.cwd ?? "live-preview")),
    [state?.cwd],
  );

  const contextPct =
    state?.contextWindow && contextTokens > 0
      ? Math.min(100, Math.round((contextTokens / state.contextWindow) * 100))
      : 0;

  const threadRef = useRef<HTMLDivElement>(null);
  const scrollToBottom = useCallback(() => {
    const t = threadRef.current;
    if (t) t.scrollTop = t.scrollHeight;
  }, []);
  useEffect(scrollToBottom, [items, toolsHidden, scrollToBottom]);
  const chatView = useMemo(() => ({ visible: true }), []);
  const entrances = useMemo(() => createEntranceLifetime(0), []);
  const row = (it: Item) => (
    <TranscriptRow
      key={it.id}
      item={it}
      view={chatView}
      animateIn
      consumeEntrance={entrances.consume}
      onContentGrow={scrollToBottom}
    />
  );

  // Files dropped anywhere on the chat attach, as in the app; a stray drop must not open the file.
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    pasted.setIsFileDragOver(true);
  };
  const onDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) pasted.setIsFileDragOver(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    pasted.setIsFileDragOver(false);
    if (open && e.dataTransfer.files.length > 0) void pasted.addFiles(e.dataTransfer.files);
  };

  const noop = () => {};
  return (
    <div
      className="lp-root"
      ref={rootRef}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {!open && (
        <button
          type="button"
          className="pill"
          aria-label={running ? "Open GG Coder chat (working)" : "Open GG Coder chat"}
          onClick={() => {
            setOpen(true);
            focusInput();
          }}
        >
          {running ? (
            <span className="pill-live" aria-hidden />
          ) : (
            <ChatCircleDotsIcon size={16} aria-hidden />
          )}
          <span>{running ? "GG Coder is working" : "Ask GG Coder"}</span>
        </button>
      )}
      <section
        className="app lp-window"
        aria-label="GG Coder"
        hidden={!open}
        data-glow={glowStateFor(running, hasFinishedRun)}
        style={glowStyle}
      >
        {/* The app's own title bar: the project's name and colour, centred, over a frost. */}
        <WorkspaceHeader
          workspaceMode="code"
          cwd={state?.cwd}
          gitBranch={state?.gitBranch}
          openable={false}
          trailing={
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label="Minimise GG Coder chat"
              title="Minimise"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (picking) togglePicking();
                setOpen(false);
              }}
            >
              <MinusIcon size={14} weight="bold" aria-hidden />
            </button>
          }
        />
        {/* Always there, so the window keeps its size from the first message on. */}
        {!toolsHidden && (
          <div className="thread" ref={threadRef} aria-live="polite">
            {items.length === 0 && <p className="lp-empty">Pick an element, or just ask.</p>}
            <PromptSendProvider value={sendFromReply}>
              <LiveTextContext.Provider value={liveText}>{items.map(row)}</LiveTextContext.Provider>
            </PromptSendProvider>
          </div>
        )}
        <div className="lp-dock">
          {sendError && (
            <p className="lp-note" role="alert">
              {sendError}
            </p>
          )}
          <Deck
            state={state}
            hydrated={state !== null}
            showGit
            panel={panel}
            onPanelChange={changePanel}
            status={
              <ActivityBar
                running={running}
                runStartedAt={runStartedAt}
                activity={activity}
                cancelling={cancelling}
                tokens={tokens}
                doneStatus={doneStatus}
                isThinking={isThinking}
                thinkingStartTs={thinkingStartTs}
                thinkingAccumMs={thinkingAccumMs}
                toolsHidden={toolsHidden}
                hasToolFeed={liveToolFeed.length > 0 || items.length > 0}
                onToggleTools={() => setToolsHidden((h) => !h)}
              />
            }
            composer={
              <Composer
                workspaceMode="code"
                composerRef={composerRef}
                isFileDragOver={pasted.isFileDragOver}
                scheduleInvalid={false}
                scheduleDraft={false}
                running={running}
                kenRunning={false}
                autopilotReviewing={false}
                cancelling={cancelling}
                sendDisabled={
                  (!input.trim() && pasted.attachments.length === 0) ||
                  !config ||
                  pasted.attachmentsLoading
                }
                input={input}
                setInput={setInput}
                caret={caret}
                setCaret={setCaret}
                fillScheduleInterval={noop}
                slashOpen={false}
                slashMatches={[]}
                clampedSlashIndex={0}
                pickSlashCommand={noop}
                setSlashIndex={noop}
                mentionOpen={false}
                fileMatches={[]}
                clampedFileIndex={0}
                mention={null}
                setMention={noop}
                pickMentionFile={noop}
                setFileIndex={noop}
                updateMention={noop}
                attachments={attachments}
                attachmentsLoading={pasted.attachmentsLoading}
                removeAttachment={(id) => {
                  if (id !== PICK_CHIP_ID) {
                    pasted.removeAttachment(id);
                    return;
                  }
                  setPicked(null);
                  bridge.post({ type: "gg-live:clear-pick" });
                  focusInput();
                }}
                addFiles={pasted.addFiles}
                fileInputRef={fileInputRef}
                mentionedPaths={[]}
                removeMentionChip={noop}
                sendCount={sendCount}
                enhanceAnim={enhanceAnim}
                onEnhanceAnimDone={onEnhanceAnimDone}
                enhancement={enhancement}
                setEnhancement={setEnhancement}
                enhancing={enhancing}
                enhanceHintVisible={enhanceHintVisible}
                runEnhance={runEnhance}
                kenActive={false}
                shellMode={false}
                shellMenu={null}
                kenInputParts={null}
                attachInput={(el) => {
                  inputRef.current = el;
                }}
                displayPlaceholder={picked ? "Ask GG Coder about this element…" : "Ask GG Coder…"}
                lastKeystrokeAtRef={lastKeystrokeAtRef}
                historyIndex={historyIndex}
                setHistoryIndex={setHistoryIndex}
                navigateHistory={() => false}
                submit={submit}
                requestCancel={requestCancel}
                leadAction={
                  <button
                    type="button"
                    className="icon-circle pick-toggle"
                    aria-pressed={picking}
                    aria-label={picking ? "Stop picking" : "Pick an element on the page"}
                    title={
                      picking
                        ? "Picking: click elements on the page. Esc or click here to stop"
                        : "Pick an element"
                    }
                    // Keep focus in the text box, so Esc never leaves a focus ring on this button.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={togglePicking}
                  >
                    <CursorClickIcon size={15} />
                  </button>
                }
              />
            }
            menu={null}
            running={running}
            contextPct={contextPct}
            models={models}
            modelsFailed={modelsFailed}
            onSelectModel={onSelectModel}
            second={null}
            tasks={[]}
            schedules={[]}
            onStopSchedule={noop}
            projectHealth={null}
            usageExtras={null}
            progress={null}
            trophies={null}
            tools={{}}
          />
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LiveApp />
  </StrictMode>,
);
