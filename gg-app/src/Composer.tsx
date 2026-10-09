import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { ArrowUpIcon, PaperclipIcon, SquareIcon } from "@phosphor-icons/react";
import {
  cancelKen,
  openImageDataUrl,
  prewarmCache,
  sendPrompt,
  type AgentState,
  type FileHit,
  type PromptSegment,
  type QueuedMessage,
  type SlashCommand,
  type WorkspaceMode,
} from "./agent";
import { ActionMetal } from "./ActionMetal";
import { AttachmentBar } from "./AttachmentBar";
import type { PendingAttachment } from "./attachments";
import { CacheExpiryNotice } from "./CacheExpiryNotice";
import { EnhanceDissolve } from "./EnhanceDissolve";
import { FileMentionMenu } from "./FileMentionMenu";
import { FloatingSurface } from "./FloatingSurface";
import { QueuedBar } from "./QueuedBar";
import { ReferencedFiles } from "./ReferencedFiles";
import { ScheduleHint } from "./ScheduleHint";
import { ShimmerText } from "./ShimmerText";
import { SlashMenu } from "./SlashMenu";
import { theme } from "./theme";
import { toast } from "./toast";
import { WorkingBeam } from "./WorkingBeam";

export interface ComposerProps {
  workspaceMode: WorkspaceMode;
  state: AgentState | null;
  composerRef: RefObject<HTMLDivElement | null>;
  isFileDragOver: boolean;
  scheduleInvalid: boolean;
  scheduleDraft: boolean;
  running: boolean;
  kenRunning: boolean;
  autopilotReviewing: boolean;
  cancelling: boolean;
  sendDisabled: boolean;
  windowFocused: boolean;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  caret: number;
  setCaret: Dispatch<SetStateAction<number>>;
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
  setMention: Dispatch<SetStateAction<{ query: string; start: number } | null>>;
  pickMentionFile: (file: FileHit) => void;
  setFileIndex: Dispatch<SetStateAction<number>>;
  updateMention: (text: string, caret: number) => void;
  attachments: PendingAttachment[];
  attachmentsLoading: boolean;
  removeAttachment: (id: number) => void;
  addFiles: (files: FileList | File[]) => Promise<void>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  mentionedPaths: string[];
  removeMentionChip: (p: string) => void;
  visibleQueuedMessages: readonly QueuedMessage[];
  handleCancelQueued: (id: string) => void;
  enhanceAnim: { oldText: string; newText: string | null } | null;
  onEnhanceAnimDone: () => void;
  enhancement: { plain: string; segments: PromptSegment[] } | null;
  setEnhancement: Dispatch<SetStateAction<{ plain: string; segments: PromptSegment[] } | null>>;
  enhancing: boolean;
  enhanceHintVisible: boolean;
  runEnhance: () => Promise<void>;
  kenActive: boolean;
  kenInputParts: { lead: string; token: string; rest: string } | null;
  attachInput: (el: HTMLTextAreaElement | null) => void;
  displayPlaceholder: string;
  lastKeystrokeAtRef: MutableRefObject<number>;
  historyIndex: number | null;
  setHistoryIndex: Dispatch<SetStateAction<number | null>>;
  navigateHistory: (dir: -1 | 1, el: HTMLTextAreaElement) => boolean;
  submit: () => void;
  requestCancel: () => void;
}

/**
 * The chat composer box: menus, attachment/reference bars, the textarea with
 * its keyboard handling, send/stop and the Enhance pill. State lives in App;
 * this is a pure render of it. Extracted from App.tsx.
 */
export function Composer({
  workspaceMode,
  state,
  composerRef,
  isFileDragOver,
  scheduleInvalid,
  scheduleDraft,
  running,
  kenRunning,
  autopilotReviewing,
  cancelling,
  sendDisabled,
  windowFocused,
  input,
  setInput,
  caret,
  setCaret,
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
  setMention,
  pickMentionFile,
  setFileIndex,
  updateMention,
  attachments,
  attachmentsLoading,
  removeAttachment,
  addFiles,
  fileInputRef,
  mentionedPaths,
  removeMentionChip,
  visibleQueuedMessages,
  handleCancelQueued,
  enhanceAnim,
  onEnhanceAnimDone,
  enhancement,
  setEnhancement,
  enhancing,
  enhanceHintVisible,
  runEnhance,
  kenActive,
  kenInputParts,
  attachInput,
  displayPlaceholder,
  lastKeystrokeAtRef,
  historyIndex,
  setHistoryIndex,
  navigateHistory,
  submit,
  requestCancel,
}: ComposerProps): React.ReactElement {
  return (
    <div
      ref={composerRef}
      className={`inputwrap${isFileDragOver ? " dragover" : ""}${
        scheduleInvalid ? " schedule-invalid" : ""
      }`}
    >
      <WorkingBeam active={running || kenRunning || autopilotReviewing} />
      {scheduleDraft && (
        <ScheduleHint input={input} caret={caret} onPickInterval={fillScheduleInterval} />
      )}
      <FloatingSurface>
        {!scheduleDraft && slashOpen && (
          <SlashMenu
            commands={slashMatches}
            activeIndex={clampedSlashIndex}
            onSelect={pickSlashCommand}
            onHover={setSlashIndex}
          />
        )}
      </FloatingSurface>
      <FloatingSurface>
        {mentionOpen && (
          <FileMentionMenu
            files={fileMatches}
            activeIndex={clampedFileIndex}
            isRecent={mention?.query === ""}
            onSelect={pickMentionFile}
            onHover={setFileIndex}
          />
        )}
      </FloatingSurface>
      <AttachmentBar
        attachments={attachments}
        onRemove={removeAttachment}
        onOpenImage={(src) => void openImageDataUrl(src)}
      />
      <ReferencedFiles paths={mentionedPaths} onRemove={removeMentionChip} />
      <CacheExpiryNotice
        expiry={state?.cacheExpiry}
        running={running}
        onCompact={() =>
          void sendPrompt("/compact").catch(() =>
            toast("Couldn't start compaction. Try again.", "error"),
          )
        }
      />
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
        <div className="input-stack">
          {enhanceAnim && (
            <EnhanceDissolve
              oldText={enhanceAnim.oldText}
              newText={enhanceAnim.newText}
              onDone={onEnhanceAnimDone}
            />
          )}
          {/* `@Ken` active: a textarea can't color just one token, so we mirror
            the input in an aligned overlay where the leading `@Ken` shimmers
            in Ken's color. The textarea text below is made transparent (caret
            stays visible) so only this styled copy shows. Metrics match
            `.input` 1:1 so wrapping/caret line up. */}
          {kenActive && kenInputParts && (
            <div className="ken-input-highlight" aria-hidden="true">
              {kenInputParts.lead}
              <ShimmerText base={theme.ken}>{kenInputParts.token}</ShimmerText>
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
              const now = Date.now();
              if (!running && now - lastKeystrokeAtRef.current > 4 * 60_000) {
                void prewarmCache();
              }
              lastKeystrokeAtRef.current = now;
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
              } else if (e.key === "Enter" && !e.shiftKey) {
                // Enter sends; Shift+Enter inserts a newline (textarea default).
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
            autoFocus
          />
        </div>
        {/* Send doubles as the stop control mid-run, so the primary action
          never moves. It stays on the text's line while the draft fits one
          line, and drops below with the field once the text wraps. */}
        <div className="inputactions-trailing">
          <WorkingBeam active={running} size="sm" />
          <ActionMetal
            active={!running && !cancelling && !sendDisabled}
            windowFocused={windowFocused}
          />
          <button
            className="icon-circle icon-circle-primary"
            title={running ? "Stop the run" : attachmentsLoading ? "Loading attachments…" : "Send"}
            disabled={cancelling || (!running && sendDisabled)}
            onClick={() => {
              if (running) requestCancel();
              else submit();
            }}
          >
            {running ? <SquareIcon size={12} weight="fill" /> : <ArrowUpIcon size={16} />}
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
        <div className={`enhance-pill-host${enhanceHintVisible ? " visible" : ""}`}>
          <ActionMetal
            active={enhanceHintVisible && !enhancing}
            windowFocused={windowFocused}
            variant="button"
          />
          <button
            className={`enhance-pill${enhancing ? " enhancing" : ""}`}
            title="Enhance prompt — clearer wording + correct terms"
            disabled={enhancing || !enhanceHintVisible}
            aria-hidden={!enhanceHintVisible}
            onClick={() => void runEnhance()}
          >
            {enhancing ? "Enhancing…" : "Enhance?"}
          </button>
        </div>
      )}
    </div>
  );
}
