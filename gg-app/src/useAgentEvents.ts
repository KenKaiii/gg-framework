import { useCallback, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { theme } from "./theme";
import {
  listCommands,
  type SidecarEvent,
  type SubAgentStatePayload,
  type AgentState,
  type BackgroundTask,
  type ProjectTask,
  type SlashCommand,
} from "./agent";
import { formatTokenCount } from "./ActivityBar";
import { type LiveToolEntry, LIVE_TOOL_PANEL_ROWS } from "./LiveToolPanel";
import { type SubAgentLine } from "./SubAgentFeed";
import { playSound } from "./sounds";
import { findCompletedSteps, countPlanSteps } from "./plan-steps";
import type { PendingAttachment } from "./attachments";
import type { Item } from "./App";

/**
 * Build-session SSE event handling + assistant-streaming helpers, extracted from
 * App.tsx (mirrors `useKenMentor`). This owns the event machine's PRIVATE refs
 * (the streaming bubble id, rAF buffer, per-run accumulators, sub-agent/compaction
 * group ids) and the streaming helpers, and exposes `handleEvent` for the SSE
 * subscription plus the two helpers App still calls directly (`pushItem`,
 * `endStreamingText`).
 *
 * The build session's React state is genuinely shared with App's render and its
 * other handlers (hydrate, submit, onProjectChosen, plan accept), so rather than
 * relocating all of it, App keeps owning that state and passes the setters +
 * cross-cutting refs in via `deps` (the same pattern `useKenMentor` uses for
 * `setItems`/`nextId`). The handler logic is byte-for-byte the original — only
 * the previously in-scope identifiers now arrive through `deps`.
 */

/** Tool detail image preview (screenshot / read), mirrors the sidecar shape. */
export interface ImagePreview {
  base64: string;
  mediaType: string;
  path?: string;
}

// Hook kind → notice copy + tone color, mirroring the TUI's app-items.ts.
export type HookKind = "ideal" | "loop_break" | "regrounding";
export const HOOK_PRESENTATION: Record<HookKind, { text: string; color: string }> = {
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

/**
 * App-owned state + cross-cutting refs the build-event handler closes over.
 * App keeps owning these (its render and other handlers also use them); the hook
 * just receives them. Setters are the React dispatchers; refs are the live
 * mirrors the memoized handler reads without re-subscribing.
 */
export interface AgentEventsDeps {
  setItems: Dispatch<SetStateAction<Item[]>>;
  nextId: () => number;
  /** Ken (mentor) event delegate — consulted first; ken events early-return. */
  handleKenEvent: (e: SidecarEvent) => boolean;
  /** Autopilot event delegate — consulted first; autopilot events early-return. */
  handleAutopilotEvent: (e: SidecarEvent) => boolean;

  setState: Dispatch<SetStateAction<AgentState | null>>;
  setTasks: Dispatch<SetStateAction<BackgroundTask[]>>;
  setProjectTasks: Dispatch<SetStateAction<ProjectTask[]>>;
  setStatus: Dispatch<SetStateAction<string>>;
  setRunning: Dispatch<SetStateAction<boolean>>;
  setLiveToolFeed: Dispatch<SetStateAction<LiveToolEntry[]>>;
  setTokens: Dispatch<SetStateAction<number>>;
  setContextTokens: Dispatch<SetStateAction<number>>;
  setDoneStatus: Dispatch<SetStateAction<string | null>>;
  setIsThinking: Dispatch<SetStateAction<boolean>>;
  setThinkingStartTs: Dispatch<SetStateAction<number | null>>;
  setThinkingAccumMs: Dispatch<SetStateAction<number>>;
  setPlanTotal: Dispatch<SetStateAction<number>>;
  setPlanDone: Dispatch<SetStateAction<Set<number>>>;
  setPlanReview: Dispatch<SetStateAction<string | null>>;
  setQueuedCount: Dispatch<SetStateAction<number>>;
  setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  setCommands: Dispatch<SetStateAction<SlashCommand[]>>;

  stateRef: MutableRefObject<AgentState | null>;
  planDoneRef: MutableRefObject<Set<number>>;
  planTotalRef: MutableRefObject<number>;
  planReviewPathRef: MutableRefObject<string | null>;
  pendingPlanTotalRef: MutableRefObject<number | null>;
  stickToBottomRef: MutableRefObject<boolean>;
}

export interface AgentEvents {
  /** Handle one SSE frame (ken events delegate out, everything else handled here). */
  handleEvent: (e: SidecarEvent) => void;
  /** Append a finished transcript item (used by App's submit/etc. too). */
  pushItem: (item: Item) => void;
  /** Flush buffered assistant text + end the streaming section (used by App too). */
  endStreamingText: () => void;
}

export function useAgentEvents(deps: AgentEventsDeps): AgentEvents {
  const {
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
  } = deps;

  // ── Event-machine private refs (used nowhere outside this hook) ──
  const streamingIdRef = useRef<number | null>(null);
  const pendingChunksRef = useRef<string>("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Transcript id of the active sub-agent group for this run (null until the
  // first subagent spawns). The per-agent map keeps late async lifecycle events
  // attached to their original transcript group after a newer run starts.
  const subagentGroupIdRef = useRef<number | null>(null);
  const subagentGroupByAgentRef = useRef<Map<string, number>>(new Map());
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
  // Submitted plan content retained until approval. Current sidecars provide the
  // canonical live-file count on session_reset; this content supplies the fallback
  // count when connected to an older sidecar.
  const planReviewContentRef = useRef<string | null>(null);

  // Streaming deltas arrive faster than React can usefully render each one.
  // We buffer chunks in a ref and flush every 100ms — imperceptible for prose
  // but roughly halves streaming render CPU vs per-frame flushing, since the
  // Markdown re-render dominates and CPU scales with flush count
  // (bench/RESULTS.md, bench B). First token still paints immediately.
  const STREAM_FLUSH_MS = 100;
  const flushChunks = useCallback(() => {
    flushTimerRef.current = null;
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
  }, [setItems]);

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
        // Subsequent tokens: buffer and flush on the 100ms timer
        pendingChunksRef.current += text;
        if (flushTimerRef.current === null) {
          flushTimerRef.current = setTimeout(flushChunks, STREAM_FLUSH_MS);
        }
      }
    },
    [flushChunks, nextId, setItems],
  );

  // Flush any pending buffered text and end the current streaming section.
  // Called whenever streaming transitions to tool calls, a new prompt, etc.
  // Without this, the last few buffered tokens (waiting for the timer) would be lost.
  const endStreamingText = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
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
  }, [setItems]);

  const pushItem = useCallback(
    (item: Item) => {
      setItems((prev) => [...prev, item]);
    },
    [setItems],
  );

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
  }, [setThinkingAccumMs, setThinkingStartTs, setIsThinking]);

  const handleEvent = useCallback(
    (e: SidecarEvent) => {
      // Ken (mentor) events are owned by the useKenMentor hook; delegate and
      // early-return so they never touch the build-session handling below.
      if (handleKenEvent(e)) return;
      // Autopilot (auto-review) events are owned by the useAutopilot hook; same
      // early-return so they never touch the build-session handling below.
      if (handleAutopilotEvent(e)) return;
      const d = e.data as Record<string, unknown>;
      switch (e.type) {
        case "ready": {
          const readyState = d as unknown as AgentState;
          setState(readyState);
          setRunning(readyState.running);
          setTasks((d.tasks as BackgroundTask[] | undefined) ?? []);
          setStatus(readyState.runState === "cancelling" ? "cancelling..." : "ready");
          break;
        }
        case "run_start":
          setRunning(true);
          setState((previous) =>
            previous ? { ...previous, running: true, runState: "running" } : previous,
          );
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
        case "subagent_state": {
          const snapshot = d as unknown as SubAgentStatePayload;
          const status: SubAgentLine["status"] =
            snapshot.state === "starting"
              ? "starting"
              : snapshot.state === "running"
                ? "running"
                : snapshot.state === "completed"
                  ? "idle"
                  : snapshot.state === "interrupted"
                    ? "interrupted"
                    : snapshot.state === "closed" && !snapshot.error
                      ? "done"
                      : "error";
          const activity = snapshot.current_activity;
          const updateAgent = (agent: SubAgentLine): SubAgentLine => {
            const last = agent.activities[agent.activities.length - 1];
            return {
              ...agent,
              status,
              toolUseCount: snapshot.tool_use_count,
              tokenUsage: snapshot.token_usage,
              durationMs: snapshot.elapsed_ms,
              activities:
                activity && activity !== last
                  ? [...agent.activities, activity].slice(-12)
                  : agent.activities,
            };
          };
          const mappedGroupId = subagentGroupByAgentRef.current.get(snapshot.agent_id);
          const activeGroupId = subagentGroupIdRef.current;
          const shouldCreateGroup = mappedGroupId === undefined && activeGroupId === null;
          const groupId = mappedGroupId ?? activeGroupId ?? nextId();
          if (mappedGroupId === undefined) {
            subagentGroupByAgentRef.current.set(snapshot.agent_id, groupId);
            if (shouldCreateGroup) subagentGroupIdRef.current = groupId;
          }
          if (shouldCreateGroup) {
            pushItem({
              kind: "subagent_group",
              id: groupId,
              agents: [
                {
                  toolCallId: snapshot.agent_id,
                  agentName: snapshot.task_name,
                  status,
                  async: true,
                  activities: activity ? [activity] : [],
                  toolUseCount: snapshot.tool_use_count,
                  tokenUsage: snapshot.token_usage,
                  durationMs: snapshot.elapsed_ms,
                },
              ],
            });
          } else {
            setItems((previous) =>
              previous.map((item) => {
                if (item.kind !== "subagent_group" || item.id !== groupId) return item;
                const found = item.agents.some((agent) => agent.toolCallId === snapshot.agent_id);
                return {
                  ...item,
                  agents: found
                    ? item.agents.map((agent) =>
                        agent.toolCallId === snapshot.agent_id ? updateAgent(agent) : agent,
                      )
                    : [
                        ...item.agents,
                        {
                          toolCallId: snapshot.agent_id,
                          agentName: snapshot.task_name,
                          status,
                          async: true,
                          activities: activity ? [activity] : [],
                          toolUseCount: snapshot.tool_use_count,
                          tokenUsage: snapshot.token_usage,
                          durationMs: snapshot.elapsed_ms,
                        },
                      ],
                };
              }),
            );
          }
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
                tokenUsage?: SubAgentLine["tokenUsage"];
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
              | { durationMs?: number; tokenUsage?: SubAgentLine["tokenUsage"] }
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
        case "run_cancelling":
          setRunning(true);
          setState((previous) =>
            previous ? { ...previous, running: true, runState: "cancelling" } : previous,
          );
          setStatus("cancelling...");
          break;
        case "cancel_failed":
          setRunning(true);
          setState((previous) =>
            previous ? { ...previous, running: true, runState: "running" } : previous,
          );
          setStatus("cancellation failed; agent still running");
          break;
        case "error": {
          // Structured payload from the sidecar's broadcastError (headline always
          // present; message/guidance may be omitted for terse capability errors).
          // Fall back to a flat string for any older-shaped frame.
          const headline = typeof d.headline === "string" ? d.headline : undefined;
          pushItem(
            headline
              ? {
                  kind: "error",
                  id: nextId(),
                  headline,
                  message: typeof d.message === "string" ? d.message : undefined,
                  guidance: typeof d.guidance === "string" ? d.guidance : undefined,
                }
              : { kind: "error", id: nextId(), text: `error: ${String(d.message ?? "unknown")}` },
          );
          break;
        }
        case "run_end": {
          setRunning(false);
          setState((previous) =>
            previous ? { ...previous, running: false, runState: "idle" } : previous,
          );
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
                        a.status === "running" && !a.async
                          ? { ...a, status: d.cancelled ? ("error" as const) : ("done" as const) }
                          : a,
                      ),
                    }
                  : it,
              ),
            );
          }
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
        case "chat_agent_change":
          setState((s) => (s ? { ...s, ...(d as Partial<AgentState>) } : s));
          break;
        // Ken's effective model changed — either his pin was set/cleared or he
        // followed a GG Coder switch. Payload keys (kenProvider/kenModel/
        // kenModelOverride) match AgentState, so a spread is enough.
        case "ken_model_change":
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
        case "plan_progress": {
          // The sidecar reads the live approved-plan file, so this snapshot
          // stays accurate even if implementation expands or rewrites `## Steps`.
          // It is authoritative over the approval-time count and local streamed
          // marker detection, both of which can be stale between tool calls.
          const total =
            typeof d.total === "number" && Number.isFinite(d.total)
              ? Math.max(0, Math.floor(d.total))
              : 0;
          const completed = new Set(
            Array.isArray(d.completed)
              ? d.completed.filter(
                  (step): step is number =>
                    typeof step === "number" &&
                    Number.isInteger(step) &&
                    step >= 1 &&
                    step <= total,
                )
              : [],
          );
          planTotalRef.current = total;
          planDoneRef.current = completed;
          setPlanTotal(total);
          setPlanDone(completed);
          break;
        }
        case "plan_exit": {
          setState((s) => (s ? { ...s, planMode: false } : s));
          // Always stash the submitted plan: autopilot needs the content to
          // seed the plan-progress widget if Ken approves it, and manual accept
          // needs the path when autopilot is off.
          planReviewPathRef.current = typeof d.planPath === "string" ? d.planPath : null;
          const content = String(d.content ?? "");
          planReviewContentRef.current = content;
          // Autopilot owns plan review when enabled. Showing the human overlay
          // during the few seconds before Ken accepts/rejects is just visual
          // noise, and users generally cannot act in time anyway. Non-autopilot
          // stays unchanged: the modal opens for manual Accept/Feedback/Reject.
          if (stateRef.current?.autopilot) {
            setPlanReview(null);
          } else {
            setPlanReview(content);
          }
          break;
        }
        case "autopilot_plan_accepted":
          // Keep an approval-time fallback for older sidecars, close the review
          // modal, and render the approved marker. Current sidecars override this
          // fallback with the canonical live-file count on session_reset.
          pendingPlanTotalRef.current = planReviewContentRef.current
            ? countPlanSteps(planReviewContentRef.current)
            : 0;
          planReviewContentRef.current = null;
          setPlanReview(null);
          endStreamingText();
          pushItem({ kind: "autopilot", id: nextId(), phase: "plan_approved" });
          break;
        case "autopilot_prompted":
          // Autopilot-only plan revision path: Ken rejected/refined the plan and
          // the sidecar injected a revision prompt into GG Coder. Close the
          // stale human review modal so autopilot visibly continues. In
          // non-autopilot mode this frame never exists, so the normal modal +
          // manual Accept/Feedback/Reject flow stays unchanged.
          planReviewContentRef.current = null;
          planReviewPathRef.current = null;
          setPlanReview(null);
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
          setPlanReview(null);
          planReviewContentRef.current = null;
          {
            // On an accept-driven reset, restore the approved plan's step count
            // instead of zeroing it (the widget tracks the implementation run).
            const eventTotal =
              typeof d.planTotal === "number" && Number.isFinite(d.planTotal)
                ? Math.max(0, Math.floor(d.planTotal))
                : null;
            const carriedTotal = eventTotal ?? pendingPlanTotalRef.current ?? 0;
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
          subagentGroupByAgentRef.current.clear();
          break;
        case "extras":
          // Context window / git status refresh (model switch, run end).
          setState((s) =>
            s
              ? {
                  ...s,
                  contextWindow: (d.contextWindow as number | undefined) ?? s.contextWindow,
                  gitBranch: (d.gitBranch as string | null | undefined) ?? s.gitBranch,
                  isGitRepo: (d.isGitRepo as boolean | undefined) ?? s.isGitRepo,
                  gitDirtyFileCount:
                    (d.gitDirtyFileCount as number | undefined) ?? s.gitDirtyFileCount,
                }
              : s,
          );
          setTasks((d.tasks as BackgroundTask[] | undefined) ?? []);
          break;

        // Ken (mentor) events (`ken_*`) are handled by the useKenMentor hook via
        // the early-return guard at the top of this handler.
      }
    },
    [
      handleKenEvent,
      handleAutopilotEvent,
      appendAssistant,
      pushItem,
      finalizeThinking,
      endStreamingText,
      nextId,
      setItems,
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
    ],
  );

  return { handleEvent, pushItem, endStreamingText };
}
