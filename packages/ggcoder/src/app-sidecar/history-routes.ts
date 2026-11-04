import { PROMPT_COMMANDS } from "../core/prompt-commands.js";
import { loadCustomCommands } from "../core/custom-commands.js";
import {
  restoreUserRow,
  normalizeKenTurnsForHistory,
  normalizeAutopilotMarkersForHistory,
  normalizeAppMarkersForHistory,
  replayMessagesInOrder,
  getHistoryMessageVisibility,
  resolveRestoredCommand,
  restoreAssistantTexts,
} from "../core/session-history.js";
import { spawnedTasks } from "../tools/subagent-shared.js";
import { detectHookKind, type HistoryEntryForWire } from "./history.js";
import { restoreAppErrorPayload } from "../app-error.js";
import type { ToolResultContent } from "@kleio/ai";
import type { KenTurnPayload, AppMarkerPayload } from "../core/session-manager.js";
import { appToolImageRefs, appToolImages } from "../utils/image.js";
import { json } from "./http.js";
import type { SessionRouteContext } from "./route-context.js";
import type http from "node:http";

export function handleHistoryRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (method === "GET" && (url === "/history" || url.startsWith("/history?"))) {
    // `?images=refs`: tool images as refs, for an app that loads each as it's
    // scrolled to (`GET /history-images`), not as previews in this answer.
    const imagesByRef = new URLSearchParams(url.slice("/history".length)).get("images") === "refs";
    const listedImages = new Map<string, { data: string; mediaType: string }>();
    // Reconstruct the transcript from persisted messages so resume is 1:1 with
    // the live SSE stream. Walks ALL message types (not just user/assistant):
    // tool result messages carry ImageContent blocks (screenshots,
    // generate_image) that must re-render inline, and assistant tool_call
    // blocks carry sub-agent delegations that must re-appear as group items.
    //
    // The `details` object (imagePreviews with path + downscaled preview) is
    // event-only and never persisted — we reconstruct from the raw
    // ImageContent in the tool result, making the app's preview on the
    // sidecar side and extracting the path from the text block
    // ("Generated image → /path").
    void (async () => {
      const commandCandidates = [...PROMPT_COMMANDS, ...(await loadCustomCommands(ctx.cwd))];
      const messages = ctx.session.getMessages();

      // An Ideal hook is injected immediately after the assistant's candidate
      // no-tool response. That response is review scratch, not a user-visible
      // final answer. Live SSE drops it when the hook event arrives; mark the
      // same assistant message here so resumed history stays identical.
      const hiddenIdealDrafts = new Set<(typeof messages)[number]>();
      for (let i = 0; i < messages.length - 1; i++) {
        const draft = messages[i];
        const hookPrompt = messages[i + 1];
        if (draft?.role !== "assistant" || hookPrompt?.role !== "user") continue;
        const restored = restoreUserRow(hookPrompt.content);
        if (detectHookKind(restored.text) === "ideal") hiddenIdealDrafts.add(draft);
      }

      // Pre-index tool results by toolCallId so we can pair tool calls with
      // their results (for sub-agent status + image extraction).
      const toolResultMap = new Map<string, { content: ToolResultContent; isError: boolean }>();
      for (const msg of messages) {
        if (msg.role !== "tool") continue;
        for (const tr of msg.content) {
          toolResultMap.set(tr.toolCallId, {
            content: tr.content,
            isError: tr.isError ?? false,
          });
        }
      }

      const history: HistoryEntryForWire[] = [];

      // Ken (mentor) turns to interleave: group by the non-system message count
      // they were recorded after, so each lands right after that message. A
      // turn becomes two wire rows: the `@Ken` question (user) + Ken's reply
      // (assistant), both flagged `ken` so the webview tints them.
      // Deduped; stale anchors are clamped to the last message (Ken turns
      // carry real conversation, so they render at the end instead of
      // vanishing).
      const kenByCount = new Map<number, KenTurnPayload[]>();
      for (const turn of normalizeKenTurnsForHistory(
        ctx.session.getKenTurns(),
        messages.filter((m) => m.role !== "system").length,
      )) {
        const list = kenByCount.get(turn.afterMessageCount) ?? [];
        list.push(turn);
        kenByCount.set(turn.afterMessageCount, list);
      }
      const flushKen = (count: number): void => {
        const turns = kenByCount.get(count);
        if (!turns) return;
        kenByCount.delete(count);
        for (const turn of turns) {
          history.push({ role: "user", text: `@Ken ${turn.question}`, ken: true });
          history.push({ role: "assistant", text: turn.reply, ken: true });
        }
      };

      // Autopilot verdict markers to interleave, same anchor scheme as Ken
      // turns — each becomes a single assistant row the webview renders
      // exactly like the live `autopilot` item (never a raw verdict string).
      // Normalization pulls anchors left over from an unrebased compaction
      // back to where the marker was actually written, so stale all-clear
      // bubbles no longer bunch at the bottom of a reopened session.
      const restoredMessageCount = messages.filter((m) => m.role !== "system").length;
      const autopilotByCount = new Map<
        number,
        ReturnType<typeof normalizeAutopilotMarkersForHistory>
      >();
      for (const marker of normalizeAutopilotMarkersForHistory(
        ctx.session.getAutopilotMarkers(),
        restoredMessageCount,
      )) {
        const list = autopilotByCount.get(marker.afterMessageCount) ?? [];
        list.push(marker);
        autopilotByCount.set(marker.afterMessageCount, list);
      }
      const flushAutopilot = (count: number): void => {
        const markers = autopilotByCount.get(count);
        if (!markers) return;
        autopilotByCount.delete(count);
        for (const marker of markers) {
          history.push({
            role: "assistant",
            text: "",
            autopilot: {
              phase: marker.phase,
              ...(marker.reason !== undefined ? { reason: marker.reason } : {}),
              ...(marker.body !== undefined ? { body: marker.body } : {}),
              copySeed: marker.copySeed,
            },
          });
        }
      };

      // App transcript markers (plan banner / task header / error rows /
      // user-bubble hints), same anchor scheme. user_hint markers don't
      // become rows — they decorate the user row at their anchor instead.
      const appMarkersByCount = new Map<number, AppMarkerPayload[]>();
      const userHintByCount = new Map<number, Record<string, unknown>>();
      // Compaction-count markers pair with compacted summary rows in file
      // order (FIFO), not by anchor — the summary user message is what
      // positions the notice.
      const compactionCounts: Array<{ originalCount: number; newCount: number }> = [];
      for (const marker of normalizeAppMarkersForHistory(
        ctx.session.getAppMarkers(),
        restoredMessageCount,
      )) {
        if (marker.kind === "user_hint") {
          userHintByCount.set(marker.afterMessageCount, marker.data);
          continue;
        }
        if (marker.kind === "compaction") {
          const d = marker.data;
          if (typeof d.originalCount === "number" && typeof d.newCount === "number") {
            compactionCounts.push({ originalCount: d.originalCount, newCount: d.newCount });
          }
          continue;
        }
        const list = appMarkersByCount.get(marker.afterMessageCount) ?? [];
        list.push(marker);
        appMarkersByCount.set(marker.afterMessageCount, list);
      }
      const flushAppMarkers = (count: number): void => {
        const markers = appMarkersByCount.get(count);
        if (!markers) return;
        appMarkersByCount.delete(count);
        for (const marker of markers) {
          const d = marker.data;
          if (marker.kind === "plan") {
            history.push({
              role: "assistant",
              text: "",
              plan: { reason: typeof d.reason === "string" ? d.reason : "" },
            });
          } else if (marker.kind === "task") {
            history.push({
              role: "assistant",
              text: "",
              task: { title: typeof d.title === "string" ? d.title : "" },
            });
          } else if (marker.kind === "error" && typeof d.headline === "string") {
            const error = restoreAppErrorPayload(d);
            if (error) history.push({ role: "assistant", text: "", error });
          } else if (marker.kind === "interrupted_run") {
            // Rendered as an error row: the run's tools already changed the
            // repo, so the user needs to see it and decide what to do. We
            // never replay it — that would duplicate those changes.
            history.push({
              role: "assistant",
              text: "",
              error: {
                scope: "interrupted_run",
                headline: "A run was interrupted",
                message:
                  "GG Coder stopped mid-run, so this turn is incomplete. Any files its tools already changed are still on disk.",
                guidance: "Review the working tree, then re-send the request if you still want it.",
              },
            });
          }
        }
      };
      let nonSystemCount = 0;
      // Turns/markers recorded before any build message (anchor 0) render at
      // the top.
      flushKen(0);
      flushAutopilot(0);
      flushAppMarkers(0);

      await replayMessagesInOrder(
        messages,
        async (msg, count) => {
          nonSystemCount = count;
          const visibility = getHistoryMessageVisibility(msg);
          if (visibility === "hidden") return;

          if (msg.role === "tool") {
            // Tool result messages: check for ImageContent blocks (screenshots,
            // generated images) and emit a toolImages entry.
            for (const tr of msg.content) {
              if (typeof tr.content === "string") continue;
              const imageBlocks = tr.content.filter((c) => c.type === "image");
              if (imageBlocks.length === 0) continue;
              // Extract the path from the text block (e.g. "Generated image → /path").
              const textBlock = tr.content.find(
                (c) => c.type === "text" && "text" in c && typeof c.text === "string",
              );
              const textContent = textBlock && textBlock.type === "text" ? textBlock.text : "";
              const pathMatch = textContent.match(/→\s*(\S+)/);
              const imgPath = pathMatch?.[1];

              // The app's preview of each image (WebP, 480 px wide), as the
              // live tool_call_end event carries it, or its ref.
              const blocks = imageBlocks.flatMap((block) =>
                block.type === "image" ? [block] : [],
              );
              const toolImages = imagesByRef
                ? await appToolImageRefs(blocks, imgPath, listedImages)
                : await appToolImages(blocks, imgPath);
              if (toolImages.length > 0) {
                history.push({
                  role: "assistant",
                  text: "",
                  toolImages,
                });
              }
            }
            return;
          }

          // User or assistant message — text/hook/command/compacted extraction,
          // plus sub-agent group detection for assistant tool_calls.
          if (msg.role === "user") {
            // Rebuild the live bubble: strip the steering wrapper, drop
            // attachment/file notes the model saw but the bubble never showed.
            const restored = restoreUserRow(msg.content, msg.provenance);
            const text = restored.text;
            const hook = msg.provenance ? null : detectHookKind(text);
            const compacted =
              visibility === "summary" ||
              (!msg.provenance && !hook && text.startsWith("[Previous conversation summary]"));
            const hint = userHintByCount.get(nonSystemCount);
            // The typed invocation persisted alongside the prompt is
            // authoritative. Reversing the expanded body only works while the
            // template is byte-identical, and templates drift (edited
            // `.gg/commands/*.md`, reworded built-ins, app-vs-CLI phrasing) —
            // after which the resumed session dumped the raw multi-KB body
            // instead of the `/name` chip. Older sessions have no hint, so the
            // body match stays as the fallback.
            const command =
              !hook && !compacted
                ? resolveRestoredCommand(
                    typeof hint?.command === "string" ? hint.command : null,
                    text,
                    commandCandidates,
                  )
                : null;
            // Autopilot injected this turn — live showed only the Ken-tinted
            // marker for it, never a user bubble. Emitting one here would print
            // the injected instruction a second time, unstyled.
            //
            // Pushed background-status updates are skipped for the same reason:
            // the live run rendered no bubble for them, so showing them here
            // would fill a reopened session with machine-facing status lines
            // the user never saw while working.
            if (
              (!msg.provenance || (!restored.autopilotInjected && !restored.notification)) &&
              (text.trim() || restored.images.length > 0)
            ) {
              history.push({
                role: "user",
                text: command ?? text,
                images: restored.images,
                hook,
                command: command !== null,
                compacted,
                // Markers accumulate across continuation files (each rewrite
                // re-persists prior ones) but only the LATEST summary row
                // survives compaction — so consume from the newest end.
                ...(compacted && compactionCounts.length > 0
                  ? { compactionCounts: compactionCounts.pop() }
                  : {}),
                ...(hint?.kenSent === true ? { kenSent: true } : {}),
                ...(Array.isArray(hint?.enhancements) ? { enhancements: hint.enhancements } : {}),
              });
              // Live showed the video-capability warning right after the bubble.
              if (restored.videoWarning) {
                history.push({ role: "assistant", text: "", infoKind: "video_warning" });
              }
            }
          } else if (!hiddenIdealDrafts.has(msg)) {
            // Assistant: one wire row per persisted text block — live streaming
            // splits bubbles at server_tool_call boundaries, and the persisted
            // content keeps those blocks separate. Ideal-review candidate drafts
            // are intentionally omitted to match the live pre-final hook flow.
            for (const blockText of restoreAssistantTexts(msg.content)) {
              history.push({
                role: "assistant",
                text: blockText,
                images: [],
                hook: null,
                command: false,
                compacted: false,
              });
            }
          }

          // Assistant tool_call blocks: detect sub-agent delegations.
          if (msg.role === "assistant" && typeof msg.content !== "string") {
            const subagentCalls = msg.content.filter(
              (
                c,
              ): c is typeof c & {
                type: "tool_call";
                id: string;
                name: string;
                args: Record<string, unknown>;
              } => c.type === "tool_call" && (c.name === "subagent" || c.name === "spawn_agent"),
            );
            if (subagentCalls.length > 0) {
              const agents = subagentCalls.flatMap((c) => {
                const result = toolResultMap.get(c.id);
                // Async workers are intentionally non-resumable; restored rows are historical.
                const status = result?.isError ? ("error" as const) : ("done" as const);
                if (c.name === "spawn_agent") {
                  // One row per child: a batch call starts several.
                  return spawnedTasks(c.args).map((spawn) => ({
                    agentName: spawn.task_name ?? spawn.agent,
                    status,
                    toolUseCount: 0,
                  }));
                }
                return [
                  {
                    agentName: typeof c.args?.agent === "string" ? c.args.agent : undefined,
                    status,
                    toolUseCount: 0,
                  },
                ];
              });
              history.push({
                role: "assistant",
                text: "",
                subagentGroup: agents,
              });
            }
          }
        },
        (count) => {
          // Markers flush after every physical message, including tools and
          // provenance-hidden runtime context.
          flushKen(count);
          flushAutopilot(count);
          flushAppMarkers(count);
        },
      );

      // Flush remaining Ken turns whose anchor is at/after the message count so
      // none are dropped. Autopilot/app markers beyond the restored message
      // count were already filtered above; any remaining marker here is valid.
      for (const count of [...kenByCount.keys()].sort((a, b) => a - b)) flushKen(count);
      for (const count of [...autopilotByCount.keys()].sort((a, b) => a - b)) flushAutopilot(count);
      for (const count of [...appMarkersByCount.keys()].sort((a, b) => a - b))
        flushAppMarkers(count);

      if (imagesByRef) ctx.historyImages = listedImages;
      json(res, 200, { history });
    })();
    return true;
  }

  return false;
}
