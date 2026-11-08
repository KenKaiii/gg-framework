import { theme } from "./theme";
import {
  cycleThinking,
  workspaceProductName,
  type WorkspaceMode,
  type AgentState,
  type BackgroundTask,
  type ModelOption,
} from "./agent";
import { ModelSelect } from "./ModelSelect";
import { RunningSchedulesButton } from "./RunningSchedulesButton";
import type { Routine } from "./useRoutines";
import { ContextMeter } from "./ContextMeter";
import { BackgroundTasksButton } from "./BackgroundTasksButton";
import { ShimmerText } from "./ShimmerText";
import { FooterSkeleton } from "./Skeleton";

// Vertical divider between footer segments (mirrors the TUI's ` \u2502 ` in
// border color). Rendered between adjacent groups, never leading/trailing.
function FooterSep(): React.ReactElement {
  return (
    <span className="footer-sep" style={{ color: theme.border }}>
      {"\u2502"}
    </span>
  );
}

// Thinking-tier color, mirroring the ggcoder TUI footer's getThinkingColor:
// warmer/more saturated as the tier rises; xhigh/max are "max power" hot pink.
const MAX_POWER_COLOR = "#db2777";

const MAX_POWER_SHIMMER = "#f472b6";

function thinkingColor(level: string | null | undefined): string {
  if (!level) return theme.textDim;
  if (level === "low") return theme.textMuted;
  if (level === "medium") return theme.accent;
  if (level === "high") return theme.warning;
  return MAX_POWER_COLOR; // xhigh / max
}

export function AppFooter({
  workspaceMode,
  hydrated,
  phoneHeader,
  state,
  runningTaskCount,
  tasks,
  schedules,
  stopSchedule,
  contextPct,
  running,
  models,
  onSelectModel,
  onSelectKenModel,
  kenRunning,
  autopilotReviewing,
}: {
  workspaceMode: WorkspaceMode;
  hydrated: boolean;
  phoneHeader: boolean;
  state: AgentState | null;
  runningTaskCount: number;
  tasks: BackgroundTask[];
  schedules: readonly Routine[];
  stopSchedule: (id: string) => void;
  contextPct: number;
  running: boolean;
  models: ModelOption[];
  onSelectModel: (modelId: string, options?: { confirmPaid?: boolean }) => void;
  onSelectKenModel: (modelId: string | null) => void;
  kenRunning: boolean;
  autopilotReviewing: boolean;
}) {
  return (
    <div
      className={`footer${workspaceMode !== "code" ? " footer-chat" : ""}`}
      style={{ color: theme.footerText }}
    >
      {!hydrated ? (
        <FooterSkeleton />
      ) : (
        <>
          {workspaceMode === "motion" ? (
            <span className="footer-left footer-reveal" style={{ color: theme.textDim }}>
              Motion Agent
            </span>
          ) : workspaceMode === "chat" ? (
            // On the iPhone the controls take the whole line, and the agent's
            // name was clipped to "Gene".
            !phoneHeader && (
              <span className="footer-left footer-reveal" style={{ color: theme.textDim }}>
                {state?.chatAgent === "therapist"
                  ? "Therapist Agent"
                  : state?.chatAgent === "research"
                    ? "Research Agent"
                    : "General Agent"}
              </span>
            )
          ) : (
            <span className="footer-left footer-reveal">
              {runningTaskCount > 0 && <BackgroundTasksButton tasks={tasks} />}
              {schedules.length > 0 && (
                <>
                  {runningTaskCount > 0 && <FooterSep />}
                  <RunningSchedulesButton schedules={schedules} onStop={stopSchedule} />
                </>
              )}
              {state?.planMode && (
                <>
                  {(runningTaskCount > 0 || schedules.length > 0) && <FooterSep />}
                  <span className="footer-plan">
                    <ShimmerText base={theme.secondary} bright="#ddd6fe">
                      {"\u25C6 plan mode"}
                    </ShimmerText>
                  </span>
                </>
              )}
            </span>
          )}
          <span className="footer-right footer-reveal">
            {contextPct > 0 && (
              <>
                <ContextMeter pct={contextPct} />
                <FooterSep />
              </>
            )}
            {(state?.supportedThinkingLevels?.length ?? 0) > 0 &&
              (() => {
                const level = state?.thinkingLevel ?? null;
                const label = level ? `Thinking ${level}` : "Thinking off";
                const maxPower = level === "xhigh" || level === "max";
                // Reasoning level is baked into the request the run is already
                // streaming, so a mid-turn cycle changes nothing about it and
                // silently disagrees with what the footer shows. Lock it like
                // the model pickers, and say why rather than going inert.
                const locked = running;
                return (
                  <>
                    <button
                      className="thinking-toggle"
                      style={{
                        color: locked ? theme.textDim : thinkingColor(level),
                        fontWeight: level === "high" ? 600 : 400,
                      }}
                      title={
                        locked
                          ? "Can't change reasoning level while the agent is running — cancel the run or wait for it to finish"
                          : "Cycle reasoning level"
                      }
                      disabled={locked}
                      onClick={() => void cycleThinking()}
                    >
                      {maxPower && !locked ? (
                        <ShimmerText base={MAX_POWER_COLOR} bright={MAX_POWER_SHIMMER}>
                          {label}
                        </ShimmerText>
                      ) : (
                        label
                      )}
                    </button>
                    <FooterSep />
                  </>
                );
              })()}
            <span className="model-anchor">
              <span className="model-label" style={{ color: theme.text }}>
                Kleio
              </span>
              <ModelSelect
                models={models}
                currentModel={state?.model ?? ""}
                onSelect={onSelectModel}
                offerPaid
                compact={phoneHeader}
                disabled={running}
                title={`Switch ${workspaceMode === "chat" ? "Kleio" : workspaceProductName(workspaceMode)}'s model`}
              />
            </span>
            {workspaceMode === "code" && (
              <>
                <FooterSep />
                <span className="model-anchor">
                  <span className="model-label" style={{ color: theme.ken }}>
                    Helper
                  </span>
                  <ModelSelect
                    models={models}
                    currentModel={state?.kenModel ?? state?.model ?? ""}
                    onSelect={(id) => onSelectKenModel(id)}
                    compact={phoneHeader}
                    color={theme.ken}
                    // Ken's pin retargets BOTH his sessions (chat + the
                    // autopilot reviewer), so it has to stay locked while
                    // either is mid-turn — same rule the GG picker follows,
                    // and the sidecar now answers 409 to match.
                    disabled={running || kenRunning || autopilotReviewing}
                    title={
                      state?.kenModelOverride
                        ? "Helper is pinned to its own model. Click to change it"
                        : "Helper follows Kleio's model. Click to pin one"
                    }
                    onSelectFollow={() => onSelectKenModel(null)}
                    followActive={!state?.kenModelOverride}
                  />
                </span>
              </>
            )}
          </span>
        </>
      )}
    </div>
  );
}
