import React from "react";
import type { DOMElement } from "ink";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { ContextWindowOptions } from "../../core/model-registry.js";
import type { TaskRecord } from "../../core/tasks-store.js";
import type { SlashCommandInfo } from "./SlashCommandMenu.js";
import type { ImageAttachment } from "../../utils/image.js";
import type { CompletedItem } from "../app-items.js";
import type { FooterStatusLayoutDecision } from "./BackgroundTasksBar.js";
import type { ThemeName, useTheme } from "../theme/theme.js";
import { ChatControls, ChatLayout } from "./ChatLayout.js";
import { ChatFooterPane } from "./ChatFooterPane.js";
import { ChatInputStack } from "./ChatInputStack.js";
import { ChatLivePane } from "./ChatLivePane.js";
import { TranscriptViewport } from "./TranscriptViewport.js";
import { QueueIndicator } from "./QueueIndicator.js";
import { InputArea, type PasteInfo } from "./InputArea.js";
import { FooterStatusRow } from "./FooterStatusRow.js";
import type { LiveToolEntry } from "./LiveToolPanel.js";
import type { ActivityPhase, RetryInfo } from "../hooks/useAgentLoop.js";
import type { BackgroundProcess } from "../../core/process-manager.js";

interface ChatInputControls {
  onSubmit: (value: string, images: ImageAttachment[], paste?: PasteInfo) => void;
  onAbort: () => void;
  injectText?: { text: string; nonce: number } | null;
  inputActive: boolean;
  onDownAtEnd: () => void;
  onShiftTab: () => void;
  onToggleTasks: () => void;
  onToggleSkills: () => void;
  onTogglePixel: () => void;
  onToggleMarkdown: () => void;
  cwd: string;
  commands: SlashCommandInfo[];
  /** Fullscreen alt-screen: route mouse-wheel to the transcript scroll. */
  mouseScroll?: boolean;
  onScroll?: (deltaLines: number) => void;
}

interface TaskPickerControls {
  open: boolean;
  tasks: readonly TaskRecord[];
  onClose: () => void;
  onStart: (task: TaskRecord) => void;
  onRunAll: (task?: TaskRecord) => void;
  onDelete: (task: TaskRecord) => void;
}

interface ChatScreenProps {
  columns: number;
  liveItems: CompletedItem[];
  renderItem: (item: CompletedItem, index: number, items: CompletedItem[]) => React.ReactNode;
  isRunning: boolean;
  visibleStreamingText: string;
  streamingThinking: string;
  thinkingMs: number;
  reserveStreamingSpacing: boolean;
  renderMarkdown: boolean;
  measuredLiveAreaRows: number;
  /**
   * Fullscreen alt-screen viewport mode. When true, the transcript is rendered
   * inside Ink (history + liveItems + streaming) as a bounded, app-scrolled
   * region, and the controls below it are pinned to the bottom of a full-height
   * frame. When false, the legacy scrollback `ChatLivePane` tail is used.
   */
  fullscreen?: boolean;
  rows: number;
  transcriptLines: readonly string[];
  viewportRows: number;
  assistantMarginTop: number;
  streamingContinuation: boolean;
  controlsRef: (node: DOMElement | null) => void;
  hiddenQueuedCount: number;
  queueIndicatorMarginTop: number;
  theme: ReturnType<typeof useTheme>;
  statusSlotVisible: boolean;
  activityVisible: boolean;
  stallStatusVisible: boolean;
  liveToolFeed: readonly LiveToolEntry[];
  doneStatus: { verb: string; durationMs: number } | null;
  activityPhase: ActivityPhase;
  elapsedMs: number;
  runStartRef: React.RefObject<number>;
  isThinking: boolean;
  thinkingLevel?: ThinkingLevel;
  tokenEstimate: number;
  charCountRef: React.RefObject<number>;
  realTokensAccumRef: React.RefObject<number>;
  lastUserMessage?: string;
  activeToolNames: string[];
  retryInfo?: RetryInfo | null;
  planDone: number;
  planTotal: number;
  formatDuration: (durationMs: number) => string;
  inputControls: ChatInputControls;
  taskPicker: TaskPickerControls;
  overlay: string | null;
  onModelSelect: (modelId: string) => void;
  onModelCancel: () => void;
  loggedInProviders: Provider[];
  currentModel: string;
  currentProvider: Provider;
  onThemeSelect: (themeName: ThemeName) => void;
  onThemeCancel: () => void;
  currentTheme: string;
  contextUsed: number;
  contextWindowOptions?: ContextWindowOptions;
  displayedCwd: string;
  gitBranch?: string | null;
  planMode: boolean;
  exitPending: boolean;
  footerStatusLayout: FooterStatusLayoutDecision;
  backgroundTasks: BackgroundProcess[];
  taskBarFocused: boolean;
  taskBarExpanded: boolean;
  selectedTaskIndex: number;
  onTaskBarExpand: () => void;
  onTaskBarCollapse: () => void;
  onTaskKill: (id: string) => void;
  onTaskBarExit: () => void;
  onTaskNavigate: (index: number) => void;
}

export function ChatScreen({
  columns,
  liveItems,
  renderItem,
  isRunning,
  visibleStreamingText,
  streamingThinking,
  thinkingMs,
  reserveStreamingSpacing,
  renderMarkdown,
  measuredLiveAreaRows,
  fullscreen,
  rows,
  transcriptLines,
  viewportRows,
  assistantMarginTop,
  streamingContinuation,
  controlsRef,
  hiddenQueuedCount,
  queueIndicatorMarginTop,
  theme,
  statusSlotVisible,
  activityVisible,
  stallStatusVisible,
  liveToolFeed,
  doneStatus,
  activityPhase,
  elapsedMs,
  runStartRef,
  isThinking,
  thinkingLevel,
  tokenEstimate,
  charCountRef,
  realTokensAccumRef,
  lastUserMessage,
  activeToolNames,
  retryInfo,
  planDone,
  planTotal,
  formatDuration,
  inputControls,
  taskPicker,
  overlay,
  onModelSelect,
  onModelCancel,
  loggedInProviders,
  currentModel,
  currentProvider,
  onThemeSelect,
  onThemeCancel,
  currentTheme,
  contextUsed,
  contextWindowOptions,
  displayedCwd,
  gitBranch,
  planMode,
  exitPending,
  footerStatusLayout,
  backgroundTasks,
  taskBarFocused,
  taskBarExpanded,
  selectedTaskIndex,
  onTaskBarExpand,
  onTaskBarCollapse,
  onTaskKill,
  onTaskBarExit,
  onTaskNavigate,
}: ChatScreenProps) {
  return (
    <ChatLayout columns={columns} rows={fullscreen ? rows : undefined}>
      {fullscreen ? (
        <TranscriptViewport lines={transcriptLines} columns={columns} viewportRows={viewportRows} />
      ) : (
        <ChatLivePane
          liveItems={liveItems}
          renderItem={renderItem}
          isRunning={isRunning}
          visibleStreamingText={visibleStreamingText}
          streamingThinking={streamingThinking}
          thinkingMs={thinkingMs}
          reserveStreamingSpacing={reserveStreamingSpacing}
          renderMarkdown={renderMarkdown}
          measuredLiveAreaRows={measuredLiveAreaRows}
          assistantMarginTop={assistantMarginTop}
          streamingContinuation={streamingContinuation}
        />
      )}

      <ChatControls controlsRef={controlsRef}>
        <QueueIndicator
          hiddenQueuedCount={hiddenQueuedCount}
          marginTop={queueIndicatorMarginTop}
          theme={theme}
        />

        <ChatInputStack
          columns={columns}
          theme={theme}
          statusSlotVisible={statusSlotVisible}
          activityVisible={activityVisible}
          stallStatusVisible={stallStatusVisible}
          liveToolFeed={liveToolFeed}
          doneStatus={doneStatus}
          activityPhase={activityPhase}
          elapsedMs={elapsedMs}
          runStartRef={runStartRef}
          thinkingMs={thinkingMs}
          isThinking={isThinking}
          thinkingLevel={thinkingLevel}
          tokenEstimate={tokenEstimate}
          charCountRef={charCountRef}
          realTokensAccumRef={realTokensAccumRef}
          lastUserMessage={lastUserMessage}
          activeToolNames={activeToolNames}
          retryInfo={retryInfo}
          planDone={planDone}
          planTotal={planTotal}
          renderMarkdown={renderMarkdown}
          formatDuration={formatDuration}
        />
        <InputArea
          onSubmit={inputControls.onSubmit}
          onAbort={inputControls.onAbort}
          injectText={inputControls.injectText}
          disabled={isRunning}
          isActive={inputControls.inputActive}
          onDownAtEnd={inputControls.onDownAtEnd}
          onShiftTab={inputControls.onShiftTab}
          onToggleTasks={inputControls.onToggleTasks}
          taskPickerOpen={taskPicker.open}
          tasks={taskPicker.tasks}
          onCloseTaskPicker={taskPicker.onClose}
          onStartTask={taskPicker.onStart}
          onRunAllTasks={taskPicker.onRunAll}
          onDeleteTask={taskPicker.onDelete}
          onToggleSkills={inputControls.onToggleSkills}
          onTogglePixel={inputControls.onTogglePixel}
          onToggleMarkdown={inputControls.onToggleMarkdown}
          cwd={inputControls.cwd}
          commands={inputControls.commands}
          mouseScroll={inputControls.mouseScroll}
          onScroll={inputControls.onScroll}
        />
        <ChatFooterPane
          overlay={overlay}
          onModelSelect={onModelSelect}
          onModelCancel={onModelCancel}
          loggedInProviders={loggedInProviders}
          currentModel={currentModel}
          currentProvider={currentProvider}
          onThemeSelect={onThemeSelect}
          onThemeCancel={onThemeCancel}
          currentTheme={currentTheme}
          contextUsed={contextUsed}
          contextWindowOptions={contextWindowOptions}
          displayedCwd={displayedCwd}
          gitBranch={gitBranch}
          thinkingLevel={thinkingLevel}
          planMode={planMode}
          exitPending={exitPending}
          renderMarkdown={renderMarkdown}
        />
        <FooterStatusRow
          columns={columns}
          layout={footerStatusLayout}
          tasks={backgroundTasks}
          focused={taskBarFocused}
          expanded={taskBarExpanded}
          selectedIndex={selectedTaskIndex}
          onExpand={onTaskBarExpand}
          onCollapse={onTaskBarCollapse}
          onKill={onTaskKill}
          onExit={onTaskBarExit}
          onNavigate={onTaskNavigate}
          theme={theme}
        />
      </ChatControls>
    </ChatLayout>
  );
}
