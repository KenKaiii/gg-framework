import { memo, useLayoutEffect, useRef, useState } from "react";
import { AtIcon, FileTextIcon, FilmStripIcon, XIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import { ChatErrorNotice } from "./ChatErrorNotice";
import { openImageDataUrl, openProjectPath } from "./agent";
import { enterTranscriptRow } from "./transcript-motion";
import { useLiveText } from "./live-text";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { HookNotice } from "./HookNotice";
import { SubAgentFeed } from "./SubAgentFeed";
import { CompactionNotice } from "./CompactionNotice";
import { PlanModeLogo } from "./PlanModeLogo";
import { KenFace } from "./KenFace";
import { PlanDecisionNotice } from "./PlanDecisionNotice";
import { SecurityNotice } from "./SecurityNotice";
import { AskBand } from "./AskBand";
import { ShellBlock } from "./ShellBlock";
import type { ShellActions } from "./useShellRuns";
import { Markdown } from "./Markdown";
import { ImageGenCard } from "./image-gen/ImageGenCard";
import { ImageCard } from "./ImageCard";
import { segmentDoneMarkers, hasDoneMarker } from "./plan-steps";
import { PLAN_STEP_TICK } from "./plan-step-tick";
import { hidePartialKenLine, stripKenLine } from "./goal-ken-talk";
import { EnhancedSegments } from "./PromptEnhancement";
import { basename } from "./tool-format";
import type { Item } from "./transcript-item";

// Autopilot Ken's "all clear" line, rotated so the auto-review loop doesn't
// repeat the exact same sentence every time GG Coder's work checks out.
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

// BLACK_CIRCLE — ⏺ on mac (matches the TUI figure).

/**
 * A GG Coder reply. While it streams, its text comes from the live-text store
 * (`useLiveText`), so new chunks re-render this row alone, not the App.
 */
function AssistantReply({
  id,
  text: stored,
  onGrow,
}: {
  id: number;
  text: string;
  onGrow?: () => void;
}): React.ReactElement {
  const { text: raw, streaming } = useLiveText(id, stored);
  // GG Goals' spoken line for the farm (`[ken:face] …`) never shows in the
  // chat, not even half-streamed (see goal-ken-talk).
  const text = streaming ? hidePartialKenLine(raw) : stripKenLine(raw);
  // Split out [DONE:n] plan-step markers so each renders as a "✓ Step n"
  // completion row instead of leaking the raw marker into the prose.
  const segments = hasDoneMarker(text)
    ? segmentDoneMarkers(text)
    : [{ kind: "text" as const, text }];
  // Step rows that arrive mid-stream dissolve in; ones already in the reply
  // when it mounted (restored history) don't.
  const [mountedSegments] = useState(segments.length);
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "done" ? (
          <div key={i} className={`plan-step-done${i >= mountedSegments ? " dissolve-in" : ""}`}>
            <img className="plan-step-check" src={PLAN_STEP_TICK} alt="" draggable={false} />
            <span className="plan-step-label">{`Step ${seg.stepNum} completed`}</span>
          </div>
        ) : (
          <div key={i} className="assistant-msg">
            <div className="assistant-text">
              <StreamingMarkdown text={seg.text} streaming={streaming} onGrow={onGrow} />
            </div>
          </div>
        ),
      )}
    </>
  );
}

/** Ken's face and name on their own row above his reply (the face talks while he types). */
function KenByline({ talking = false }: { talking?: boolean }): React.ReactElement {
  return (
    <div className="ken-byline">
      <KenFace mood="chat" talking={talking} />
      <span className="ken-byline-name">Ken</span>
    </div>
  );
}

/**
 * Ken Kai's reply: his byline (face and name) on its own row above the text.
 * The Markdown component special-cases ```prompt fences into a "Send to GG
 * Coder" button. Streams through the live-text store like `AssistantReply`.
 */
function KenReply({
  id,
  text: stored,
  talking,
  onGrow,
}: {
  id: number;
  text: string;
  talking: boolean;
  onGrow?: () => void;
}): React.ReactElement {
  const { text, streaming } = useLiveText(id, stored);
  return (
    <div className="assistant-msg ken-msg" data-talking={talking || undefined}>
      <KenByline talking={talking} />
      <div className="assistant-text">
        <StreamingMarkdown text={text} streaming={streaming} onGrow={onGrow} />
      </div>
    </div>
  );
}

// ── Row renderers ──────────────────────────────────────────
// Memoized per row. While a reply streams, its text grows in the live-text
// store (live-text.ts) and only that row re-renders, via `useLiveText`; `items`
// changes when rows are added, finished or removed. Those updates keep the SAME
// object reference for every untouched row, and `onContentGrow` is a stable
// useCallback, so a default shallow `memo` re-renders only the rows whose
// `item` actually changed and the rest bail out.
export const TranscriptRow = memo(function TranscriptRow({
  item,
  view,
  animateIn = false,
  consumeEntrance,
  kenTalking = false,
  errorActive = false,
  errorModelPicker,
  onContentGrow,
  queueId,
  onCancelQueued,
  onAskAnswer,
  onAskType,
  shellActions,
}: {
  item: Item;
  view: { readonly visible: boolean };
  /** Live rows keep their wrapper, but consume entrance eligibility once. */
  animateIn?: boolean;
  consumeEntrance: (id: number) => boolean;
  /** This is the Ken reply currently streaming in, so his face talks. */
  kenTalking?: boolean;
  errorActive?: boolean;
  errorModelPicker?: React.ReactNode;
  onContentGrow?: () => void;
  queueId?: string;
  onCancelQueued?: (id: string) => void;
  onAskAnswer?: (
    itemId: number,
    promptId: string,
    delta: Record<string, string | string[]>,
  ) => void;
  onAskType?: (itemId: number, promptId: string, questionId: string, seed?: string) => void;
  shellActions?: ShellActions;
}): React.ReactElement | null {
  const entranceRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!view.visible || !animateIn) return;
    const el = entranceRef.current;
    if (!consumeEntrance(item.id)) {
      // Also covers rows first mounted while Activity was hidden: their word
      // effects have no earlier cleanup from which to recognize a reactivation.
      for (const word of el?.querySelectorAll(".md-word") ?? []) {
        for (const animation of word.getAnimations?.() ?? []) animation.cancel();
      }
      return;
    }
    if (el) return enterTranscriptRow(el);
  }, [animateIn, consumeEntrance, item.id, view]);
  const row = (
    <TranscriptRowBody
      item={item}
      kenTalking={kenTalking}
      errorActive={errorActive}
      errorModelPicker={errorModelPicker}
      onContentGrow={onContentGrow}
      queueId={queueId}
      onCancelQueued={onCancelQueued}
      onAskAnswer={onAskAnswer}
      onAskType={onAskType}
      shellActions={shellActions}
    />
  );
  if (!animateIn) return row;
  // Keep a stable direct child for transcript anchoring after playback ends.
  return (
    <div ref={entranceRef} data-kind={item.kind}>
      {row}
    </div>
  );
});

function TranscriptRowBody({
  item,
  kenTalking = false,
  errorActive = false,
  errorModelPicker,
  onContentGrow,
  queueId,
  onCancelQueued,
  onAskAnswer,
  onAskType,
  shellActions,
}: {
  item: Item;
  /** This is the Ken reply currently streaming in, so his face talks. */
  kenTalking?: boolean;
  errorActive?: boolean;
  errorModelPicker?: React.ReactNode;
  onContentGrow?: () => void;
  /** The sidecar queue entry this queued bubble is, while it can still be cancelled. */
  queueId?: string;
  onCancelQueued?: (id: string) => void;
  /** Record answers for an `ask_user` band (App settles the tool call). */
  onAskAnswer?: (
    itemId: number,
    promptId: string,
    delta: Record<string, string | string[]>,
  ) => void;
  /** Answer this question by typing in the composer instead of clicking. */
  onAskType?: (itemId: number, promptId: string, questionId: string, seed?: string) => void;
  /** Run, cancel or stop the user's own `!` commands. */
  shellActions?: ShellActions;
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
        <div
          className={`user-msg${item.queued ? " queued" : ""}${
            item.promoted ? " promoted" : ""
          }${item.ken ? " user-ken" : ""}`}
        >
          {/* Kept mounted through the promotion beat so it can fade out. Hidden
              from screen readers as soon as the message stops actually being
              queued, since the remaining frames are decoration. */}
          {(item.queued || item.promoted) && (
            <span
              className="queued-tag"
              aria-hidden={item.promoted}
              title="Sends at the agent's next turn"
            >
              <span className="queued-pill">queued</span>
              {item.queued && queueId !== undefined && onCancelQueued && (
                <button
                  type="button"
                  className="queued-cancel"
                  title="Cancel this queued message"
                  aria-label="Cancel queued message"
                  onClick={() => onCancelQueued(queueId)}
                >
                  <XIcon size={12} weight="bold" aria-hidden="true" />
                </button>
              )}
            </span>
          )}
          {item.images && item.images.length > 0 && (
            <div className="user-img-row">
              {item.images.map((src, i) => (
                <button
                  key={i}
                  type="button"
                  className="user-img-open"
                  aria-label="Open attached image"
                  title="Open in image viewer"
                  onClick={() => void openImageDataUrl(src)}
                >
                  <img className="user-img" src={src} alt="" onLoad={onContentGrow} />
                </button>
              ))}
            </div>
          )}
          {item.enhancements && item.enhancements.some((s) => s.kind === "term") ? (
            <EnhancedSegments segments={item.enhancements} />
          ) : (
            item.text
          )}
          {((item.attachments && item.attachments.length > 0) ||
            (item.files && item.files.length > 0)) && (
            <div className="user-files-row">
              {item.attachments?.map((a, i) => (
                <span key={`attachment-${i}`} className="user-file-chip" title={a.name}>
                  {a.kind === "video" ? (
                    <FilmStripIcon size={11} aria-hidden style={{ color: theme.textMuted }} />
                  ) : (
                    <FileTextIcon size={11} aria-hidden style={{ color: theme.textMuted }} />
                  )}
                  <span>{a.name}</span>
                </span>
              ))}
              {item.files?.map((p) => (
                <span key={p} className="user-file-chip" title={p}>
                  <AtIcon size={11} style={{ color: theme.accent }} />
                  <span style={{ color: theme.code }}>{p}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      );
    case "assistant":
      return <AssistantReply id={item.id} text={item.text} onGrow={onContentGrow} />;
    case "ken":
      return <KenReply id={item.id} text={item.text} talking={kenTalking} onGrow={onContentGrow} />;
    case "autopilot": {
      // Autopilot Ken's verdict, rendered like a normal @Ken reply (his face +
      // teal-framed text) rather than its own marker style. The text is his verdict as
      // prose: for a PROMPT he shows what he sent GG Coder back to do; the
      // terminal verdicts read as short Ken one-liners. `done` rotates through
      // several casual Ken lines (picked deterministically off the item's
      // stable id, so it never flickers on re-render) instead of always
      // repeating the exact same sentence turn after turn.
      const copy: Record<Extract<Item, { kind: "autopilot" }>["phase"], string> = {
        prompted: item.body?.trim()
          ? `Sending GG Coder back in:\n\n${item.body.trim()}`
          : "Sending GG Coder back in for another pass.",
        done: [allClearCopy(item.copySeed, item.id), item.reason?.trim()]
          .filter(Boolean)
          .join("\n\n"),
        human: item.reason?.trim() ? item.reason.trim() : "Need you to weigh in on this one.",
        capped: "Paused autopilot after 3 rounds. Take a look before I keep going.",
        plan_approved: [
          "Plan looks solid. Approved it — implementation is underway.",
          item.reason?.trim(),
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
      return (
        <div className="assistant-msg ken-msg">
          <KenByline />
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
    case "error":
      return (
        <ChatErrorNotice
          error={item}
          active={errorActive}
          modelPicker={errorModelPicker}
          onContentGrow={onContentGrow}
        />
      );
    case "hook":
      return (
        <HookNotice
          hook={item.hook}
          variantKey={`hook-${item.id}`}
          verificationReason={item.verificationReason}
        />
      );
    case "images":
      return (
        <div className="img-grid">
          {item.images.map((img, i) => {
            const path = img.path;
            return (
              <ImageCard
                key={path ?? i}
                src={img.src}
                alt={path ?? "image"}
                path={path}
                caption={path ? basename(path) : undefined}
                title={path ? `Open ${path}` : undefined}
                onOpen={path ? () => void openProjectPath(path) : undefined}
                onLoad={onContentGrow}
              />
            );
          })}
        </div>
      );
    case "generating_image":
      return (
        <div className="img-grid">
          <ImageGenCard prompt={item.prompt} gif={item.gif} startedAt={item.startedAt} />
        </div>
      );
    case "plan":
      return <PlanModeLogo reason={item.reason} />;
    case "plan_decision":
      return <PlanDecisionNotice decision={item.decision} variantKey={String(item.id)} />;
    case "ask":
      return (
        <AskBand
          prompt={item.prompt}
          answers={item.answers}
          sent={item.sent}
          answeredLive={item.answeredLive}
          cancelled={item.cancelled}
          deferred={item.deferred}
          onAnswer={(delta) => onAskAnswer?.(item.id, item.prompt.id, delta)}
          onTypeInstead={(questionId, seed) =>
            onAskType?.(item.id, item.prompt.id, questionId, seed)
          }
        />
      );
    case "task":
      return (
        <div className="line task-row">
          <span style={{ color: theme.textMuted }}>{"Task: "}</span>
          <span style={{ color: theme.text, fontWeight: 600 }}>{item.title}</span>
        </div>
      );
    case "subagent_group":
      return <SubAgentFeed agents={item.agents} aborted={item.aborted} />;
    case "shell":
      return <ShellBlock item={item} actions={shellActions} onGrow={onContentGrow} />;
    case "security":
      return (
        <SecurityNotice
          rule={item.rule}
          target={item.target}
          count={item.count}
          variantKey={String(item.id)}
        />
      );
    case "compaction":
      return (
        <CompactionNotice
          status={item.status}
          variantKey={`compaction-${item.id}`}
          originalCount={item.originalCount}
          newCount={item.newCount}
        />
      );
    default:
      return null;
  }
}
