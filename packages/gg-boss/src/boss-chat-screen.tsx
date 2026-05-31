import React from "react";
import type { DOMElement } from "ink";
import { ChatControls, ChatInputStack, ChatLayout, InputArea } from "@kenkaiiii/ggcoder/ui";
import { BossFooter } from "./boss-footer.js";
import { BossModelSelector } from "./boss-model-selector.js";
import { BossTasksOverlay } from "./boss-tasks-overlay.js";
import { BossWorkerStatusRow } from "./boss-worker-status-row.js";
import { RadioPicker } from "./radio-picker.js";
import type { GGBoss } from "./orchestrator.js";
import type { BossOverlay, BossUiState, WorkerView } from "./boss-store.js";
import type { BOSS_SLASH_COMMANDS } from "./slash-commands.js";
import type { RADIO_STATIONS } from "./radio.js";
import type { useTheme } from "@kenkaiiii/ggcoder/ui/theme";

interface BossChatScreenProps {
  boss: GGBoss;
  columns: number;
  state: BossUiState;
  overlay: BossOverlay | null;
  controlsRef?: (node: DOMElement | null) => void;
  livePane: React.ReactNode;
  theme: ReturnType<typeof useTheme>;
  statusSlotVisible: boolean;
  activityVisible: boolean;
  stallStatusVisible: boolean;
  doneStatus: { verb: string; durationMs: number } | null;
  elapsedMs: number;
  runStartRef: React.RefObject<number>;
  charCountRef: React.RefObject<number>;
  realTokensAccumRef: React.RefObject<number>;
  lastUserMessage?: string;
  activeToolNames: string[];
  inputActive: boolean;
  isRunning: boolean;
  onSubmit: (value: string) => void;
  onAbort: () => void;
  onTab: () => void;
  onShiftTab: () => void;
  commands: typeof BOSS_SLASH_COMMANDS;
  scopeBadge: React.ReactNode;
  onCloseOverlay: () => void;
  onModelSelect: (value: string) => void;
  currentRadio: string | null;
  onRadioSelect: (value: string) => void;
  bossModel: string;
  workerModel: string;
  updatePending: boolean;
  currentRadioStationId: string | null;
  radioStations: typeof RADIO_STATIONS;
  workers: WorkerView[];
  pendingMessages: number;
  formatDuration: (durationMs: number) => string;
}

export function BossChatScreen({
  boss,
  columns,
  state,
  overlay,
  controlsRef = () => {},
  livePane,
  theme,
  statusSlotVisible,
  activityVisible,
  stallStatusVisible,
  doneStatus,
  elapsedMs,
  runStartRef,
  charCountRef,
  realTokensAccumRef,
  lastUserMessage,
  activeToolNames,
  inputActive,
  isRunning,
  onSubmit,
  onAbort,
  onTab,
  onShiftTab,
  commands,
  scopeBadge,
  onCloseOverlay,
  onModelSelect,
  currentRadio,
  onRadioSelect,
  bossModel,
  workerModel,
  updatePending,
  currentRadioStationId,
  workers,
  pendingMessages,
  formatDuration,
}: BossChatScreenProps): React.ReactElement {
  if (overlay === "tasks") {
    return (
      <ChatLayout columns={columns}>
        <BossTasksOverlay boss={boss} workers={workers} onClose={onCloseOverlay} />
      </ChatLayout>
    );
  }

  return (
    <ChatLayout columns={columns}>
      {livePane}

      <ChatControls controlsRef={controlsRef}>
        <ChatInputStack
          columns={columns}
          theme={theme}
          statusSlotVisible={statusSlotVisible}
          activityVisible={activityVisible}
          stallStatusVisible={stallStatusVisible}
          liveToolFeed={[]}
          doneStatus={doneStatus}
          activityPhase={state.activityPhase}
          elapsedMs={elapsedMs}
          runStartRef={runStartRef}
          thinkingMs={state.streaming?.thinkingMs ?? 0}
          isThinking={state.activityPhase === "thinking"}
          thinkingLevel={state.bossThinkingLevel}
          tokenEstimate={state.bossInputTokens}
          charCountRef={charCountRef}
          realTokensAccumRef={realTokensAccumRef}
          lastUserMessage={lastUserMessage}
          activeToolNames={activeToolNames}
          retryInfo={state.retryInfo}
          planDone={0}
          planTotal={0}
          renderMarkdown
          formatDuration={formatDuration}
        />

        <InputArea
          onSubmit={onSubmit}
          onAbort={onAbort}
          disabled={isRunning}
          isActive={inputActive}
          cwd={process.cwd()}
          commands={commands}
          scopeBadge={scopeBadge}
          disableMouseTracking
          onTab={onTab}
          onShiftTab={onShiftTab}
        />

        {overlay === "model-boss" || overlay === "model-workers" ? (
          <BossModelSelector
            onSelect={onModelSelect}
            onCancel={onCloseOverlay}
            currentModel={overlay === "model-boss" ? state.bossModel : state.workerModel}
            currentProvider={overlay === "model-boss" ? state.bossProvider : state.workerProvider}
          />
        ) : overlay === "radio" ? (
          <RadioPicker
            currentStationId={currentRadio}
            onCancel={onCloseOverlay}
            onSelect={onRadioSelect}
          />
        ) : (
          <>
            <BossFooter
              bossModel={bossModel}
              workerModel={workerModel}
              tokensIn={state.bossInputTokens}
              exitPending={state.exitPending}
              bossThinkingLevel={state.bossThinkingLevel}
              updatePending={updatePending}
              currentRadioStationId={currentRadioStationId}
              scope={state.scope}
            />
            {!state.exitPending && (
              <BossWorkerStatusRow workers={workers} pendingMessages={pendingMessages} />
            )}
          </>
        )}
      </ChatControls>
    </ChatLayout>
  );
}
