import { useLayoutEffect, memo } from "react";
import { theme } from "./theme";
import { openProjectPath } from "./agent";
import { HOOK_PRESENTATION } from "./useAgentEvents";
import { useSmoothText } from "./useSmoothText";
import { SubAgentFeed } from "./SubAgentFeed";
import { CompactionNotice } from "./CompactionNotice";
import { ShimmerText } from "./ShimmerText";
import { PlanModeLogo } from "./PlanModeLogo";
import { AskBand } from "./AskBand";
import { useOpenFromHost, WorkspaceFileCards } from "./kleio/WorkspaceFiles";
import { HistoryImage } from "./historyImages";
import { Markdown } from "./Markdown";
import { Skeleton } from "./Skeleton";
import { hasDoneMarker, segmentDoneMarkers } from "./plan-steps";
import { AtIcon } from "@phosphor-icons/react";
import { EnhancedSegments } from "./PromptEnhancement";
import { basename } from "./tool-format";
import type { Item } from "./transcript-item";

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
const DOT = "\u23FA";

/**
 * Assistant prose while it streams: the text is revealed at a steady rate
 * (rather than in whatever bursts the network delivered) and each new word
 * fades in as it lands.
 *
 * `onGrow` re-pins the transcript to the bottom. The reveal adds height
 * BETWEEN item updates, which the transcript's `items`-keyed scroll effect
 * cannot see, so without this the tail of a reply drifts under the fold.
 */
function StreamingMarkdown({
  text,
  onGrow,
}: {
  text: string;
  onGrow?: () => void;
}): React.ReactElement {
  const { text: revealed, animating } = useSmoothText(text);
  useLayoutEffect(() => {
    onGrow?.();
  }, [revealed, onGrow]);
  return <Markdown animate={animating}>{revealed}</Markdown>;
}

// ── Row renderers ──────────────────────────────────────────
// Memoized per row: the streaming run rebuilds the `items` array on every
// `text_delta`, but `appendAssistant` returns the SAME object reference for
// every non-streaming row, and `onContentGrow` is a stable useCallback. So a
// default shallow `memo` re-renders ONLY the row whose `item` reference changed
// (the one actively streaming) — the rest bail out, keeping per-token cost O(1)
// instead of O(transcript length).
export const TranscriptRow = memo(function TranscriptRow({
  item,
  animateIn = false,
  onContentGrow,
  onAskAnswer,
  onAskType,
}: {
  item: Item;
  /** Arrived live (not restored from history): rise into place once. */
  animateIn?: boolean;
  onContentGrow?: () => void;
  onAskAnswer?: (
    itemId: number,
    promptId: string,
    delta: Record<string, string | string[]>,
  ) => void;
  onAskType?: (itemId: number, promptId: string, questionId: string, seed?: string) => void;
}): React.ReactElement | null {
  const row = (
    <TranscriptRowBody
      item={item}
      onContentGrow={onContentGrow}
      onAskAnswer={onAskAnswer}
      onAskType={onAskType}
    />
  );
  if (!animateIn) return row;
  // One wrapper per live row carries the entrance so none of the ~20 row
  // shapes below needs to know about it. `data-kind` picks the direction:
  // your own message rises from the composer, everything else settles in.
  return (
    <div className="row-enter" data-kind={item.kind}>
      {row}
    </div>
  );
});

function TranscriptRowBody({
  item,
  onContentGrow,
  onAskAnswer,
  onAskType,
}: {
  item: Item;
  onContentGrow?: () => void;
  /** Record answers for an `ask_user` band (App settles the tool call). */
  onAskAnswer?: (
    itemId: number,
    promptId: string,
    delta: Record<string, string | string[]>,
  ) => void;
  /** Answer this question by typing in the composer instead of clicking. */
  onAskType?: (itemId: number, promptId: string, questionId: string, seed?: string) => void;
}): React.ReactElement | null {
  const openFromHost = useOpenFromHost();
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
          {/* Kept mounted through the promotion beat so it can collapse
              smoothly; unmounting it outright shrinks the bubble in a single
              frame and shunts the whole transcript. Hidden from screen readers
              as soon as the message stops actually being queued, since the
              remaining frames are decoration. */}
          {(item.queued || item.promoted) && (
            <span className="queued-pill" aria-hidden={item.promoted}>
              queued
            </span>
          )}
          {item.images && item.images.length > 0 && (
            <div className="user-img-row">
              {item.images.map((src, i) => (
                <img
                  key={i}
                  className="user-img"
                  src={src}
                  alt="attachment"
                  onLoad={onContentGrow}
                />
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
                  <AtIcon size={11} style={{ color: theme.accent }} />
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
      // Output cards (when paired to a Mac mini) sit once under the reply's
      // last stretch of prose, covering every link in the whole reply.
      const cardsAt = segments.map((s) => s.kind).lastIndexOf("text");
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
                  <StreamingMarkdown text={seg.text} onGrow={onContentGrow} />
                  {i === cardsAt && <WorkspaceFileCards text={item.text} />}
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
            <StreamingMarkdown text={item.text} onGrow={onContentGrow} />
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
          ? `Sending Kleio back in:\n\n${item.body.trim()}`
          : "Sending Kleio back in for another pass.",
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
      const { text: defaultText, color } = HOOK_PRESENTATION[item.hook];
      const text =
        item.verificationReason === "check_review"
          ? "Hook engaged. Reviewing changes to tests and checks."
          : item.verificationReason === "recheck"
            ? "Hook engaged. Re-checking the changes made after verification."
            : defaultText;
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
            // Connected to a host, the path is on the host: open it from there.
            const openImage = (): void => {
              if (!img.path || openFromHost(img.path)) return;
              void openProjectPath(img.path);
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
                <HistoryImage image={img} alt={img.path ?? "image"} onLoad={onContentGrow} />
                {img.path && (
                  <figcaption className="img-cap" title={img.path}>
                    {basename(img.path)}
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
    case "ask":
      return (
        <AskBand
          prompt={item.prompt}
          answers={item.answers}
          sent={item.sent}
          cancelled={item.cancelled}
          onAnswer={(delta) => onAskAnswer?.(item.id, item.prompt.id, delta)}
          onTypeInstead={(questionId, seed) =>
            onAskType?.(item.id, item.prompt.id, questionId, seed)
          }
        />
      );
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
