import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp } from "ink";
import {
  ActivityIndicator,
  AssistantMessage,
  Footer,
  InputArea,
  ModelSelector,
  StreamingArea,
  ToolExecution,
  UserMessage,
  deriveFrame,
  useAnimationTick,
} from "@kenkaiiii/ggcoder/ui";
import { useTerminalSize } from "@kenkaiiii/ggcoder/ui/hooks/terminal-size";
import { useAgentLoop } from "@kenkaiiii/ggcoder/ui/hooks/agent-loop";
import { useDoublePress } from "@kenkaiiii/ggcoder/ui/hooks/double-press";
import { useTheme } from "@kenkaiiii/ggcoder/ui/theme";
import type { Message, Provider } from "@kenkaiiii/gg-ai";
import { getMaxThinkingLevel } from "@kenkaiiii/ggcoder/models";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { Banner } from "./components/Banner.js";
import type { LazyHost } from "../core/hosts/lazy.js";
import { saveSession } from "../core/sessions.js";
import { buildEditorHostBlock, spliceHostBlock } from "../system-prompt.js";
import { EDITOR_PROMPT_COMMANDS, getEditorPromptCommand } from "../prompt-commands.js";
import { ggEditorFormatters } from "./tool-formatters.js";

// Editor brand pulse — amber → orange → rose. Distinct from ggcoder's blue/purple.
const THINKING_BORDER_COLORS = ["#fbbf24", "#f97316", "#ec4899", "#f97316", "#fbbf24"];

export interface AppProps {
  /**
   * Provider + model + auth — passed straight to useAgentLoop. Avoids needing
   * a fully-constructed Agent (hook manages its own loop internally).
   */
  provider: Provider;
  model: string;
  apiKey: string;
  accountId?: string;
  /**
   * Resolve fresh OAuth credentials before each turn (and on 401 retry with
   * `forceRefresh: true`). Without this, the static `apiKey` above is reused
   * forever — sessions die when the token expires mid-conversation.
   * Receives the *current* provider, since the user can swap via /model.
   */
  resolveCredentials?: (
    provider: Provider,
    opts?: { forceRefresh?: boolean },
  ) => Promise<{ apiKey: string; accountId?: string }>;
  tools: AgentTool[];
  systemPrompt: string;
  /**
   * Cached host-independent prompt body. Contains a `{HOST_BLOCK}` sentinel
   * that the App splices a fresh host block into whenever the live host
   * changes. Splitting prevents reflowing tens of KB of static workflow
   * recipes every 3s on the polling tick.
   */
  staticPromptBody: string;
  /**
   * Lazy host shared with the CLI. Re-detects on demand (cached 2s) so the
   * polling loop and the agent's tool calls see the same live adapter,
   * instead of each spawning their own.
   */
  host: LazyHost;
  /** Prior messages for resume; empty array for fresh session. */
  priorMessages: Message[];

  hostName: string;
  hostDisplayName: string;
  hostAvailable: boolean;
  hostReason?: string;
  cwd: string;
  /** Package version for the banner. */
  version: string;
  /** Providers the user has credentials for — used by /model selector. */
  loggedInProviders: Provider[];

  /** Persist session for `ggeditor continue` after each completed turn. */
  persistSessions?: boolean;
  onShutdown: () => void;
}

/**
 * Items that go into <Static> — user / assistant / completed-tool only. They
 * are printed once and then become normal terminal scrollback. Running tool
 * calls render OUTSIDE Static (from agentLoop.activeToolCalls) so they don't
 * pollute scrollback while in flight.
 */
type HistoryItem =
  | { id: number; kind: "user"; text: string }
  | {
      id: number;
      kind: "assistant";
      text: string;
      thinking?: string;
      thinkingMs?: number;
    }
  | {
      id: number;
      kind: "tool_done";
      toolCallId: string;
      name: string;
      args: Record<string, unknown>;
      result: string;
      isError: boolean;
      details?: unknown;
    };

// Names are bare (no `/` prefix) — ggcoder's slash menu prepends `/` for
// display. Including a `/` here would render as `//`.
//
// Order is intentional, follows the typical creator session arc:
//   1. Setup       — one-time per channel
//   2. Workflow    — the main verb ("make me a YouTube video")
//   3. QA          — audit before ship; diagnose after under-performance
//   4. Session UI  — model swap, clear scrollback
//   5. Meta        — help, then quit (always last)
//
// Prompt commands (group 1–3) come from `prompt-commands.ts` — looked up by
// name in the same handleSubmit dispatcher. Local UI commands (group 4–5)
// are handled inline because they manipulate React state directly.
function promptCmd(name: string) {
  const c = EDITOR_PROMPT_COMMANDS.find((x) => x.name === name);
  if (!c) throw new Error(`gg-editor: missing prompt command '${name}' — check prompt-commands.ts`);
  return { name: c.name, aliases: c.aliases, description: c.description };
}

const EDITOR_COMMANDS = [
  // 1. Setup (one-time per channel)
  promptCmd("setup-channel"),
  // 2. Workflow (the main verb)
  promptCmd("youtube"),
  // 3. QA — pre-render audit, post-render diagnosis
  promptCmd("audit"),
  promptCmd("diagnose"),
  // 4. Session UI
  { name: "model", aliases: ["m"], description: "switch model" },
  { name: "clear", aliases: [], description: "clear visible history (doesn't reset agent)" },
  // 5. Meta — help next-to-last, quit always last
  { name: "help", aliases: ["?"], description: "show available commands" },
  { name: "quit", aliases: ["exit", "q"], description: "exit cleanly" },
];

export function App(props: AppProps) {
  const { exit } = useApp();
  const theme = useTheme();
  const { columns } = useTerminalSize();
  const animTick = useAnimationTick();

  // The rolling messages array — passed to useAgentLoop as a ref. Seeded
  // with [system, ...priorMessages] for fresh sessions or resumes.
  const messagesRef = useRef<Message[]>([
    { role: "system", content: props.systemPrompt },
    ...props.priorMessages,
  ]);

  // Completed items rendered into <Static> — user / assistant / tool_done.
  // Each item is printed once and then becomes normal terminal scrollback,
  // which is what restores upward scrolling.
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>(() =>
    props.priorMessages.flatMap((m, i) => messageToHistoryItems(m, i)),
  );
  const idCounter = useRef(props.priorMessages.length + 100);
  const lastUserMessageRef = useRef<string>("");
  const [lastUserMessage, setLastUserMessage] = useState<string>("");
  const [exitPending, setExitPending] = useState(false);

  // ── Two-phase flush to <Static> ─────────────────────────────────────
  // Pushing items into Static AND shrinking the streaming/live area in the
  // SAME render cycle confuses Ink's cursor math: it has to clear an N-line
  // tall live area while simultaneously committing M new lines into the
  // scrollback. The result is that the bottom of long final responses gets
  // overwritten and clipped.
  //
  // Fix: queue items in a ref, bump a generation counter to schedule a
  // re-render, and drain the queue from a useEffect. Because the effect
  // fires AFTER React has painted the prior render (which collapsed the
  // live area), Ink's log-update writes the new Static lines into a
  // freshly-cleaned region of the terminal.
  const pendingFlushRef = useRef<HistoryItem[]>([]);
  const [flushGeneration, setFlushGeneration] = useState(0);
  const queueFlush = useCallback((item: HistoryItem) => {
    pendingFlushRef.current.push(item);
    setFlushGeneration((g) => g + 1);
  }, []);

  // Live model + thinking state — swappable via /model and Shift-Tab.
  const [currentProvider, setCurrentProvider] = useState<Provider>(props.provider);
  const [currentModel, setCurrentModel] = useState<string>(props.model);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);

  // Overlay state — currently only the model selector.
  const [overlay, setOverlay] = useState<"model" | null>(null);

  // Live host status — polled every 3s so the banner + footer reflect the
  // user opening/closing Resolve or Premiere mid-session.
  const [hostStatus, setHostStatus] = useState({
    name: props.hostName,
    displayName: props.hostDisplayName,
    available: props.hostAvailable,
    reason: props.hostReason,
  });

  // Live timeline glance — only fetched when host is connected. Cheap
  // bridge call that returns name/fps/duration/clip count.
  const [timelineGlance, setTimelineGlance] = useState<{
    name: string;
    fps: number;
    durationFrames: number;
    clips: number;
    markers: number;
  } | null>(null);

  // Track the currently-installed host name in the system message so we
  // only rebuild + splice when the host identity actually flips. Reading
  // back from messagesRef is unreliable (it's mutated by the agent loop)
  // so we keep our own pointer.
  const installedHostNameRef = useRef<string>(props.hostName);

  useEffect(() => {
    let cancelled = false;
    const host = props.host;
    const tick = async () => {
      try {
        const caps = await host.capabilities();
        if (cancelled) return;
        const liveName = host.name;
        const liveDisplay = host.displayName;
        setHostStatus((prev) => {
          const next = {
            name: liveName,
            displayName: liveDisplay,
            available: caps.isAvailable,
            reason: caps.unavailableReason,
          };
          if (
            prev.name === next.name &&
            prev.available === next.available &&
            prev.reason === next.reason
          ) {
            return prev;
          }
          return next;
        });

        // If the host *identity* changed, rebuild the host block of the
        // system prompt and patch messagesRef.current[0] in place. The
        // static body is reused — only ~150 bytes of host-specific text
        // is regenerated.
        if (installedHostNameRef.current !== liveName) {
          try {
            const hostBlock = await buildEditorHostBlock(host);
            if (cancelled) return;
            const fresh = spliceHostBlock(props.staticPromptBody, hostBlock);
            const sys = messagesRef.current[0];
            if (sys && sys.role === "system") {
              messagesRef.current[0] = { role: "system", content: fresh };
            }
            installedHostNameRef.current = liveName;
          } catch {
            /* ignore — keep the previous prompt rather than crash */
          }
        }

        // Only fetch timeline when host is connected. Cheap (~30ms) but
        // still pointless if nothing's there.
        if (caps.isAvailable && liveName !== "none") {
          try {
            const t = await host.getTimeline();
            if (cancelled) return;
            setTimelineGlance({
              name: t.name,
              fps: t.frameRate,
              durationFrames: t.durationFrames,
              clips: t.clips.length,
              markers: t.markers.length,
            });
          } catch {
            // No project / no timeline open. Clear stale glance.
            if (!cancelled) setTimelineGlance(null);
          }
        } else {
          if (!cancelled) setTimelineGlance(null);
        }
      } catch {
        /* ignore */
      }
    };
    void tick(); // run once immediately
    const interval = setInterval(() => {
      void tick();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [props.host, props.staticPromptBody, props.hostName]);

  const nextId = () => ++idCounter.current;

  // ── useAgentLoop wires streaming, retries, thinking, etc. ───────────
  const agentLoop = useAgentLoop(
    messagesRef,
    {
      provider: currentProvider,
      model: currentModel,
      tools: props.tools,
      maxTokens: 16384,
      apiKey: props.apiKey,
      accountId: props.accountId,
      thinking: thinkingEnabled ? getMaxThinkingLevel(currentModel) : undefined,
      // Pull fresh creds before each turn so OAuth refresh + provider swaps
      // via /model both flow through. Without this, an 8h Anthropic token
      // that expires mid-session takes the whole CLI down.
      resolveCredentials: props.resolveCredentials
        ? (opts) => props.resolveCredentials!(currentProvider, opts)
        : undefined,
    },
    {
      onTurnText: (text, thinking, thinkingMs) => {
        if (text.trim().length === 0) return;
        // Queue for two-phase flush rather than committing to Static this
        // render. Prevents long final responses from being clipped when the
        // live streaming area collapses in the same frame as the Static write.
        queueFlush({
          id: nextId(),
          kind: "assistant",
          text,
          thinking: thinking || undefined,
          thinkingMs: thinkingMs || undefined,
        });
      },
      // Running tool calls are rendered live from agentLoop.activeToolCalls
      // OUTSIDE of <Static>; only the completed result enters scrollback here.
      onToolEnd: (toolCallId, name, result, isError, _durationMs, details, args) => {
        // Use the args passed through from onToolEnd directly. Looking them up
        // via `agentLoop.activeToolCalls` here is racey — by the time onToolEnd
        // fires the call has been pulled from the active list, so most tools
        // would land on `{}` and lose every detail/inline summary.
        queueFlush({
          id: nextId(),
          kind: "tool_done",
          toolCallId,
          name,
          args: args ?? {},
          result,
          isError,
          details,
        });
      },
      onComplete: () => {
        if (!props.persistSessions) return;
        const persisted = messagesRef.current.filter((m) => m.role !== "system");
        void saveSession({
          provider: currentProvider,
          model: currentModel,
          cwd: props.cwd,
          host: props.hostName,
          messages: persisted,
        }).catch(() => {
          /* best effort */
        });
      },
    },
  );

  // Phase 2 of the two-phase flush: after the streaming/live area has
  // collapsed (the previous render cycle), this effect commits the queued
  // items into Static. Running this in a separate effect tick guarantees
  // Ink's log-update doesn't have to clear a tall live area AND write new
  // Static lines in the same frame — which is what was clipping long
  // final responses.
  useEffect(() => {
    if (pendingFlushRef.current.length === 0) return;
    const items = pendingFlushRef.current;
    pendingFlushRef.current = [];
    setHistoryItems((prev) => [...prev, ...items]);
  }, [flushGeneration]);

  const runAgentTurn = useCallback(
    (displayText: string, agentText: string) => {
      lastUserMessageRef.current = displayText;
      setLastUserMessage(displayText);
      setHistoryItems((items) => [...items, { id: nextId(), kind: "user", text: displayText }]);
      void agentLoop.run(agentText).catch((err: unknown) => {
        setHistoryItems((items) => [
          ...items,
          {
            id: nextId(),
            kind: "assistant",
            text: formatAgentError(err),
          },
        ]);
      });
    },
    [agentLoop],
  );

  // ── Slash + submit handling ─────────────────────────────────────────
  const handleSubmit = useCallback(
    (value: string) => {
      // Local slash commands.
      if (value === "/quit" || value === "/exit" || value === "/q") {
        props.onShutdown();
        exit();
        return;
      }
      if (value === "/clear") {
        setHistoryItems([]);
        return;
      }
      if (value === "/help" || value === "/?") {
        const fmt = (c: { name: string; aliases: string[]; description: string }) =>
          `- \`/${c.name}\`${c.aliases.length ? " " + c.aliases.map((a) => `\`/${a}\``).join(" ") : ""} — ${c.description}`;
        const setup = EDITOR_PROMPT_COMMANDS.filter((c) => c.name === "setup-channel").map(fmt);
        const workflow = EDITOR_PROMPT_COMMANDS.filter((c) => c.name === "youtube").map(fmt);
        const qa = EDITOR_PROMPT_COMMANDS.filter((c) => ["audit", "diagnose"].includes(c.name)).map(
          fmt,
        );
        setHistoryItems((items) => [
          ...items,
          {
            id: nextId(),
            kind: "assistant",
            text:
              "**Setup** (one-time per channel)\n\n" +
              setup.join("\n") +
              "\n\n**Workflow**\n\n" +
              workflow.join("\n") +
              "\n\n**Quality checks**\n\n" +
              qa.join("\n") +
              "\n\n**Session**\n\n" +
              "- `/model` `/m` — switch model\n" +
              "- `/clear` — clear visible history (doesn't reset agent)\n" +
              "- `/help` `/?` — this help\n" +
              "- `/quit` `/exit` `/q` — exit\n\n" +
              "**Keys**\n\n" +
              "- `Shift-Tab` toggle thinking\n" +
              "- `ESC` interrupt the agent\n" +
              "- `Ctrl-C` (twice) exit\n\n" +
              "**Resume**\n\n" +
              "- `ggeditor continue` — pick up the most recent session\n",
          },
        ]);
        return;
      }
      if (value === "/model" || value === "/m") {
        setOverlay("model");
        return;
      }

      // Bundled prompt commands — dispatch to the agent loop with the
      // command's prompt as the user message. Mirrors ggcoder's pattern.
      // Args after the command name are appended as "## User Instructions".
      if (value.startsWith("/")) {
        const parts = value.slice(1).split(" ");
        const cmdName = parts[0];
        const cmdArgs = parts.slice(1).join(" ").trim();
        const cmd = getEditorPromptCommand(cmdName);
        if (cmd) {
          const fullPrompt = cmdArgs
            ? `${cmd.prompt}\n\n## User Instructions\n\n${cmdArgs}`
            : cmd.prompt;
          // Show the user's literal /command invocation in scrollback so the
          // history stays a faithful transcript; the expanded prompt itself
          // goes to the agent loop only.
          runAgentTurn(value, fullPrompt);
          return;
        }
      }

      runAgentTurn(value, value);
    },
    [exit, props, runAgentTurn],
  );

  // Double-press exit — first Ctrl+C / ESC sets pending; second within 800ms
  // exits cleanly. Mirrors ggcoder's pattern.
  const handleDoubleExit = useDoublePress(setExitPending, () => {
    props.onShutdown();
    exit();
  });

  // Toggle thinking via Shift-Tab — same binding ggcoder uses.
  const handleToggleThinking = useCallback(() => {
    setThinkingEnabled((prev) => {
      const next = !prev;
      setHistoryItems((items) => [
        ...items,
        {
          id: nextId(),
          kind: "assistant",
          text: next ? "_Thinking enabled._" : "_Thinking disabled._",
        },
      ]);
      return next;
    });
  }, []);

  // Apply a /model selection.
  const handleModelSelect = useCallback((value: string) => {
    setOverlay(null);
    const selection = parseModelSelection(value);
    if (!selection) return;

    import("@kenkaiiii/ggcoder/models").then(({ getModel }) => {
      const info = getModel(selection.model);
      const provider = selection.provider ?? info?.provider;
      if (!provider || (info && info.provider !== provider)) return;
      setCurrentProvider(provider as Provider);
      setCurrentModel(selection.model);
      setHistoryItems((items) => [
        ...items,
        {
          id: nextId(),
          kind: "assistant",
          text: `_Switched to **${info?.name ?? selection.model}**._`,
        },
      ]);
    });
  }, []);

  // ESC / Ctrl+C from InputArea: abort if running, else double-press to exit.
  const handleAbort = useCallback(() => {
    if (agentLoop.isRunning) {
      agentLoop.abort();
    } else {
      handleDoubleExit();
    }
  }, [agentLoop, handleDoubleExit]);

  // SIGINT from outside InputArea (rare — most input events go through Ink's
  // useInput inside InputArea). Still wire it as a safety net.
  useEffect(() => {
    const onSig = () => handleAbort();
    process.on("SIGINT", onSig);
    return () => {
      process.off("SIGINT", onSig);
    };
  }, [handleAbort]);

  // Animated thinking border frame
  const thinkingBorderFrame = useMemo(
    () =>
      agentLoop.activityPhase === "thinking"
        ? deriveFrame(animTick, 1000, THINKING_BORDER_COLORS.length)
        : 0,
    [agentLoop.activityPhase, animTick],
  );

  // Static items: banner + completed history. Each entry is rendered exactly
  // once into the terminal scrollback by Ink. Critical: this is what restores
  // upward scrolling — nothing in <Static> gets re-rendered, so Ink doesn't
  // pin the cursor to the bottom on every state update.
  const staticItems = useMemo(
    () => [
      {
        id: "banner",
        el: <Banner version={props.version} model={currentModel} provider={currentProvider} />,
      },
      ...historyItems.map((item) => ({ id: `h${item.id}`, el: renderItem(item) })),
    ],
    // Banner is static — host connection state lives in the Footer (which
    // polls every few seconds and updates live).
    [historyItems, props.version, currentModel, currentProvider],
  );

  return (
    <Box flexDirection="column">
      <Static items={staticItems}>{(item) => <Box key={item.id}>{item.el}</Box>}</Static>

      {/* Streaming live text + thinking */}
      <StreamingArea
        isRunning={agentLoop.isRunning}
        streamingText={agentLoop.streamingText}
        streamingThinking={agentLoop.streamingThinking}
        showThinking
        thinkingMs={agentLoop.thinkingMs}
      />

      {/* Live tool calls in flight (rendered OUTSIDE Static so they update). */}
      {agentLoop.activeToolCalls.map((tc) => (
        <ToolExecution
          key={tc.toolCallId}
          status="running"
          name={tc.name}
          args={tc.args}
          formatters={ggEditorFormatters}
        />
      ))}

      {/* Pinned activity indicator (the "thinking bar"). */}
      {agentLoop.isRunning && agentLoop.activityPhase !== "idle" ? (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor={
            agentLoop.activityPhase === "thinking"
              ? THINKING_BORDER_COLORS[thinkingBorderFrame]
              : "transparent"
          }
          paddingLeft={1}
          paddingRight={1}
          width={columns}
        >
          <ActivityIndicator
            phase={agentLoop.activityPhase}
            elapsedMs={agentLoop.elapsedMs}
            runStartRef={agentLoop.runStartRef}
            thinkingMs={agentLoop.thinkingMs}
            isThinking={agentLoop.isThinking}
            tokenEstimate={agentLoop.streamedTokenEstimate}
            charCountRef={agentLoop.charCountRef}
            realTokensAccumRef={agentLoop.realTokensAccumRef}
            userMessage={lastUserMessage}
            activeToolNames={agentLoop.activeToolCalls.map((tc) => tc.name)}
            retryInfo={agentLoop.retryInfo}
          />
        </Box>
      ) : agentLoop.stallError ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.warning}>
            {"⚠ Stream interrupted — retries exhausted. Your conversation is preserved."}
          </Text>
        </Box>
      ) : null}

      {/* Input */}
      <InputArea
        onSubmit={(value) => handleSubmit(value)}
        onAbort={handleAbort}
        disabled={agentLoop.isRunning}
        isActive={overlay === null}
        onShiftTab={handleToggleThinking}
        cwd={props.cwd}
        commands={EDITOR_COMMANDS}
      />

      {/* Model picker overlay sits below the input (replacing the Footer)
          while open — matches ggcoder's layout exactly. */}
      {overlay === "model" ? (
        <ModelSelector
          onSelect={handleModelSelect}
          onCancel={() => setOverlay(null)}
          loggedInProviders={props.loggedInProviders}
          currentModel={currentModel}
          currentProvider={currentProvider}
        />
      ) : (
        <Footer
          model={currentModel}
          tokensIn={agentLoop.contextUsed}
          cwd={props.cwd}
          thinkingLevel={thinkingEnabled ? getMaxThinkingLevel(currentModel) : undefined}
          hidePlan
          hideCwd
          hideGitBranch
          exitPending={exitPending}
          statusLabel={composeStatusLabel(hostStatus, timelineGlance)}
          statusColor={composeStatusColor(hostStatus, theme)}
          statusBelow
        />
      )}
    </Box>
  );
}

function composeStatusLabel(
  status: { name: string; displayName: string; available: boolean },
  timeline: {
    name: string;
    fps: number;
    durationFrames: number;
    clips: number;
    markers: number;
  } | null,
): string | undefined {
  if (status.name === "none") return undefined;
  const short = status.name === "resolve" ? "DaVinci Resolve" : "Premiere Pro";
  if (!status.available) return `Disconnected from ${short}`;

  if (!timeline) return `Connected to ${short}`;

  // Compose: "Connected to DaVinci Resolve · Episode 47 (29.97 · 1h24m · 127 clips)"
  const fpsLabel = formatFps(timeline.fps);
  const durLabel = formatDuration(timeline.durationFrames, timeline.fps);
  const clipsLabel = `${timeline.clips} clip${timeline.clips === 1 ? "" : "s"}`;
  return `Connected to ${short} · ${timeline.name} (${fpsLabel} · ${durLabel} · ${clipsLabel})`;
}

function composeStatusColor(
  status: { name: string; available: boolean },
  theme: ReturnType<typeof useTheme>,
): string | undefined {
  if (status.name === "none") return undefined;
  return status.available ? theme.success : theme.warning;
}

function formatFps(fps: number): string {
  // Snap common NTSC values to their named form.
  if (Math.abs(fps - 23.976) < 0.01) return "23.976";
  if (Math.abs(fps - 29.97) < 0.01) return "29.97";
  if (Math.abs(fps - 59.94) < 0.01) return "59.94";
  return fps.toFixed(fps % 1 === 0 ? 0 : 2);
}

function formatDuration(frames: number, fps: number): string {
  if (fps <= 0) return "0s";
  const totalSec = Math.round(frames / fps);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

function renderItem(item: HistoryItem): React.JSX.Element {
  if (item.kind === "user") {
    return <UserMessage key={item.id} text={item.text} />;
  }
  if (item.kind === "assistant") {
    return (
      <AssistantMessage
        key={item.id}
        text={item.text}
        thinking={item.thinking}
        thinkingMs={item.thinkingMs}
        showThinking
      />
    );
  }
  // tool_done
  return (
    <ToolExecution
      key={item.id}
      status="done"
      name={item.name}
      args={item.args}
      result={item.result}
      isError={item.isError}
      details={item.details}
      formatters={ggEditorFormatters}
    />
  );
}

/** Convert a persisted Message into HistoryItems for resume display. */
function messageToHistoryItems(msg: Message, baseId: number): HistoryItem[] {
  const id = baseId * 10 + 1;
  if (msg.role === "user") {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((c): c is { type: "text"; text: string } => "text" in c && c.type === "text")
            .map((c) => c.text)
            .join("\n");
    if (!text) return [];
    return [{ id, kind: "user", text }];
  }
  if (msg.role === "assistant") {
    if (typeof msg.content === "string") {
      return msg.content ? [{ id, kind: "assistant", text: msg.content }] : [];
    }
    const items: HistoryItem[] = [];
    let textBuf = "";
    for (const block of msg.content) {
      if ("text" in block && block.type === "text") {
        textBuf += (textBuf ? "\n" : "") + block.text;
      } else if ("name" in block && block.type === "tool_call") {
        if (textBuf) {
          items.push({ id: id + items.length, kind: "assistant", text: textBuf });
          textBuf = "";
        }
        items.push({
          id: id + items.length,
          kind: "tool_done",
          toolCallId: block.id,
          name: block.name,
          args: block.args ?? {},
          result: "",
          isError: false,
        });
      }
    }
    if (textBuf) items.push({ id: id + items.length, kind: "assistant", text: textBuf });
    return items;
  }
  return [];
}

export function parseModelSelection(
  value: string,
): { provider?: Provider; model: string } | undefined {
  if (!value) return undefined;
  const colonIdx = value.indexOf(":");
  if (colonIdx === -1) return { model: value };
  const provider = value.slice(0, colonIdx);
  const model = value.slice(colonIdx + 1);
  if (!provider || !model) return undefined;
  return { provider: provider as Provider, model };
}

export function formatAgentError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `⚠ Agent request failed: ${message}\n\nYour session is still open. Try /model to switch providers, or run /quit if you want to exit.`;
}
