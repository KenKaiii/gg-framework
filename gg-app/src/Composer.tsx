import { Suspense, type Dispatch, type SetStateAction, type RefObject, lazy } from "react";
import { theme } from "./theme";
import { WorkingBeam } from "./WorkingBeam";
import { ActionMetal } from "./ActionMetal";
import {
  cancelKen,
  type SlashCommand,
  type FileHit,
  type QueuedMessage,
  type CacheExpiryStatus,
  type WorkspaceMode,
  type PromptSegment,
} from "./agent";
import { focusesComposerOnOpen } from "./composer-refocus";
import { returnSends } from "./phone-viewport";
import { SlashMenu } from "./SlashMenu";
import { QueuedBar } from "./QueuedBar";
import { CacheExpiryNotice } from "./placeholder/CacheExpiryNotice";
import { ScheduleHint } from "./ScheduleHint";
import { FileMentionMenu } from "./FileMentionMenu";
import { ReferencedFiles } from "./ReferencedFiles";
import { ShimmerText } from "./ShimmerText";
import { HELPER_MENTION, type HelperTokenParts, type ComposerButtonAction } from "./helper-mention";
import { PaperclipIcon, SquareIcon, ArrowUpIcon } from "@phosphor-icons/react";
import type { UseDictation } from "./useDictation";
import { AttachmentBar } from "./AttachmentBar";
import { EnhanceDissolve } from "./EnhanceDissolve";
import type { PendingAttachment } from "./attachments";

// Dictation in the Chat and Code composer: the recorder, the mic button and
// the status pill load on the iPhone and the Mac only (see DictationSession.tsx).
const DictationSession = lazy(() =>
  import("./DictationSession").then((m) => ({ default: m.DictationSession })),
);

const DictateButton = lazy(() =>
  import("./DictateButton").then((m) => ({ default: m.DictateButton })),
);

const DictationStatus = lazy(() =>
  import("./DictateButton").then((m) => ({ default: m.DictationStatus })),
);

export function Composer({
  isFileDragOver,
  scheduleInvalid,
  running,
  kenRunning,
  autopilotReviewing,
  scheduleDraft,
  input,
  caret,
  fillScheduleInterval,
  slashOpen,
  slashMatches,
  clampedSlashIndex,
  pickSlashCommand,
  setSlashIndex,
  mentionOpen,
  fileMatches,
  clampedFileIndex,
  mention,
  pickMentionFile,
  setFileIndex,
  attachments,
  removeAttachment,
  mentionedPaths,
  removeMentionChip,
  visibleQueuedMessages,
  handleCancelQueued,
  cacheExpiry,
  onCompactFirst,
  fileInputRef,
  addFiles,
  phoneComposer,
  workspaceMode,
  addressHelper,
  enhanceAnim,
  onEnhanceAnimDone,
  kenActive,
  kenInputParts,
  attachInput,
  displayPlaceholder,
  setInput,
  onKeystroke,
  setCaret,
  historyIndex,
  setHistoryIndex,
  enhancement,
  setEnhancement,
  updateMention,
  setMention,
  navigateHistory,
  submit,
  cancelling,
  requestCancel,
  showDictation,
  dictation,
  sendDisabled,
  attachmentsLoading,
  windowFocused,
  composerAction,
  enhanceHintVisible,
  dictating,
  enhancing,
  runEnhance,
  onDictated,
  setDictation,
}: {
  isFileDragOver: boolean;
  scheduleInvalid: boolean;
  running: boolean;
  kenRunning: boolean;
  autopilotReviewing: boolean;
  scheduleDraft: boolean;
  input: string;
  caret: number;
  fillScheduleInterval: (preset: string) => void;
  slashOpen: boolean;
  slashMatches: SlashCommand[];
  clampedSlashIndex: number;
  pickSlashCommand: (cmd: SlashCommand) => void;
  setSlashIndex: Dispatch<SetStateAction<number>>;
  mentionOpen: boolean;
  fileMatches: FileHit[];
  clampedFileIndex: number;
  mention: { query: string; start: number } | null;
  pickMentionFile: (file: FileHit) => void;
  setFileIndex: Dispatch<SetStateAction<number>>;
  attachments: PendingAttachment[];
  removeAttachment: (id: number) => void;
  mentionedPaths: string[];
  removeMentionChip: (p: string) => void;
  visibleQueuedMessages: readonly QueuedMessage[];
  handleCancelQueued: (id: string) => void;
  /** Cold-prompt-cache status for this chat (sidecar /state + `cache_expiry`). */
  cacheExpiry: CacheExpiryStatus | null | undefined;
  /** "Compact first" on the cold-cache notice. */
  onCompactFirst: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  addFiles: (files: FileList | File[]) => Promise<void>;
  phoneComposer: boolean;
  workspaceMode: WorkspaceMode;
  addressHelper: () => void;
  enhanceAnim: { oldText: string; newText: string | null } | null;
  onEnhanceAnimDone: () => void;
  kenActive: boolean;
  kenInputParts: HelperTokenParts | null;
  attachInput: (el: HTMLTextAreaElement | null) => void;
  displayPlaceholder: string;
  setInput: Dispatch<SetStateAction<string>>;
  /** A typed change to the draft (not a programmatic one): prewarms the prompt cache. */
  onKeystroke?: () => void;
  setCaret: Dispatch<SetStateAction<number>>;
  historyIndex: number | null;
  setHistoryIndex: Dispatch<SetStateAction<number | null>>;
  enhancement: { plain: string; segments: PromptSegment[] } | null;
  setEnhancement: Dispatch<SetStateAction<{ plain: string; segments: PromptSegment[] } | null>>;
  updateMention: (text: string, caret: number) => void;
  setMention: Dispatch<SetStateAction<{ query: string; start: number } | null>>;
  navigateHistory: (dir: -1 | 1, el: HTMLTextAreaElement) => boolean;
  submit: () => void;
  cancelling: boolean;
  requestCancel: () => void;
  showDictation: boolean;
  dictation: UseDictation | null;
  sendDisabled: boolean;
  attachmentsLoading: boolean;
  windowFocused: boolean;
  composerAction: ComposerButtonAction;
  enhanceHintVisible: boolean;
  dictating: boolean;
  enhancing: boolean;
  runEnhance: () => Promise<void>;
  onDictated: () => void;
  setDictation: Dispatch<SetStateAction<UseDictation | null>>;
}) {
  return (
    <div
      className={`inputwrap${isFileDragOver ? " dragover" : ""}${
        scheduleInvalid ? " schedule-invalid" : ""
      }`}
    >
      <WorkingBeam active={running || kenRunning || autopilotReviewing} />
      {scheduleDraft ? (
        <ScheduleHint input={input} caret={caret} onPickInterval={fillScheduleInterval} />
      ) : (
        slashOpen && (
          <SlashMenu
            commands={slashMatches}
            activeIndex={clampedSlashIndex}
            onSelect={pickSlashCommand}
            onHover={setSlashIndex}
          />
        )
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
      <CacheExpiryNotice expiry={cacheExpiry} running={running} onCompact={onCompactFirst} />
      <QueuedBar messages={visibleQueuedMessages} onCancel={handleCancelQueued} />
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
          className="icon-circle"
          title="Attach files"
          onClick={() => fileInputRef.current?.click()}
        >
          <PaperclipIcon size={15} />
        </button>
        {phoneComposer && workspaceMode === "code" && (
          <button
            type="button"
            className="icon-circle helper-chip"
            // Keep the keyboard up: without this the tap blurs the draft first.
            onMouseDown={(e) => e.preventDefault()}
            onClick={addressHelper}
          >
            {HELPER_MENTION}
          </button>
        )}
        <div className="input-stack">
          {enhanceAnim && (
            <EnhanceDissolve
              oldText={enhanceAnim.oldText}
              newText={enhanceAnim.newText}
              onDone={onEnhanceAnimDone}
            />
          )}
          {/* Helper token active: a textarea can't color just one token, so we
                mirror the input in an aligned overlay where the leading `@helper`
                (or `@ken`) shimmers in Ken's color. The textarea text below is
                made transparent (caret stays visible) so only this styled copy
                shows. Metrics match `.input` 1:1 so wrapping/caret line up (the
                iPhone's 16px included, see kleio-phone.css). */}
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
            ref={attachInput}
            className={`input${enhanceAnim ? " input-anim" : ""}${kenActive ? " input-ken" : ""}`}
            rows={1}
            // Lock the input while the dissolve→decode animation plays: the caret
            // is invisible, so typing would be silently discarded and Enter would
            // submit the un-enhanced draft mid-animation.
            readOnly={enhanceAnim !== null}
            value={input}
            placeholder={
              workspaceMode === "chat"
                ? "Ask anything\u2026"
                : workspaceMode === "motion"
                  ? "Describe a video, paste a link, or drop a PDF\u2026"
                  : displayPlaceholder
            }
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length > 0) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
            onChange={(e) => {
              onKeystroke?.();
              setInput(e.target.value);
              setSlashIndex(0);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              // Typing exits history-recall mode so ↑/↓ start fresh next time.
              if (historyIndex !== null) setHistoryIndex(null);
              // Drop the enhancement the instant the text diverges from it, so
              // the highlighted preview/bubble never misalign with edited text.
              if (enhancement && e.target.value !== enhancement.plain) setEnhancement(null);
              updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onClick={(e) => {
              const el = e.currentTarget;
              setCaret(el.selectionStart ?? el.value.length);
              updateMention(el.value, el.selectionStart ?? el.value.length);
            }}
            onKeyUp={(e) => {
              const el = e.currentTarget;
              setCaret(el.selectionStart ?? el.value.length);
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
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
              } else if (e.key === "Enter" && !e.shiftKey && returnSends(running)) {
                // Enter sends; Shift+Enter inserts a newline (textarea default).
                // iPhone: the on-screen Return key adds a line, as in Messages,
                // except during a run, where it queues the draft like the send
                // button (a hardware keyboard's Enter always sends).
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
            autoFocus={focusesComposerOnOpen(document)}
          />
        </div>
        {/* Send doubles as the stop control mid-run, so the primary action
              never moves. Mid-run it stays Send for a question to the helper,
              which runs alongside the build, and on the iPhone for any draft,
              which queues; with nothing typed it stops. It stays on the text's
              line while the draft fits one line, and drops below with the field
              once the text wraps. */}
        <div className="inputactions-trailing">
          {showDictation && dictation && (
            // The enhance animation locks the draft, so no dictating into it.
            <Suspense fallback={null}>
              <DictateButton dictation={dictation} disabled={enhanceAnim !== null} />
            </Suspense>
          )}
          <WorkingBeam active={running} size="sm" />
          <ActionMetal
            active={!running && !cancelling && !sendDisabled}
            windowFocused={windowFocused}
          />
          <button
            className="icon-circle icon-circle-primary"
            title={
              composerAction === "stop"
                ? "Stop the run"
                : attachmentsLoading
                  ? "Loading attachments…"
                  : "Send"
            }
            disabled={
              composerAction === "stop" ? cancelling : !running && (cancelling || sendDisabled)
            }
            onClick={() => {
              if (composerAction === "stop") requestCancel();
              else submit();
            }}
          >
            {composerAction === "stop" ? (
              <SquareIcon size={12} weight="fill" />
            ) : (
              <ArrowUpIcon size={16} />
            )}
          </button>
        </div>
      </div>
      {!enhanceAnim && (
        // Pill pinned to the center of the input box (.inputwrap) top border,
        // overlapping it. Decoupled from text flow, so it never overlaps text,
        // drifts, or shifts the caret/height; centered (not in a corner) to
        // stay clear of the status row's "esc to cancel". Always mounted (so it
        // can transition both ways); the `visible` class fades/slides it in
        // when there's text and out when there isn't.
        // Dictation's status pill takes this spot while it is busy.
        <div className={`enhance-pill-host${enhanceHintVisible && !dictating ? " visible" : ""}`}>
          <ActionMetal
            active={enhanceHintVisible && !dictating && !enhancing}
            windowFocused={windowFocused}
            variant="button"
          />
          <button
            className={`enhance-pill${enhancing ? " enhancing" : ""}`}
            title="Enhance prompt — clearer wording + correct terms"
            disabled={enhancing || dictating || !enhanceHintVisible}
            aria-hidden={!enhanceHintVisible || dictating}
            onClick={() => void runEnhance()}
          >
            {enhancing ? "Enhancing…" : "Enhance?"}
          </button>
        </div>
      )}
      {showDictation && (
        <Suspense fallback={null}>
          <DictationSession setDraft={setInput} onDictated={onDictated} onChange={setDictation} />
          {dictation && <DictationStatus dictation={dictation} />}
        </Suspense>
      )}
    </div>
  );
}
