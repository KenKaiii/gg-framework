import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  getGitOverview,
  killTask,
  openUrl,
  type ChangedFile,
  type GitHubItem,
  type GitOverview,
  type AgentState,
  type BackgroundTask,
  type GitHubCI,
  type ModelOption,
  type ProgressSnapshot,
  type TrophySnapshot,
} from "./agent";
import type { ActiveSchedule } from "./RunningSchedulesButton";
import { RunningSchedulesButton } from "./RunningSchedulesButton";
import { CIIndicator } from "./CIIndicator";
import { PanelHead } from "./DeckPanelHead";
import { useDeckEscape } from "./deck-escape";
import { EmbeddedModal } from "./modal-embed";
import { Icon } from "./icons";
import { modelDisplayName } from "./model-name";
import { ModelPanel, type SecondAgent } from "./ModelPanel";
import {
  PROJECT_HEALTH_TIER_LABELS,
  projectHealthTier,
  type ProjectHealth,
} from "./project-health";
import { ThinkingDots, thinkingLabel } from "./thinking-display";
import { useSubscriptionUsage } from "./TitleUsageMeter";
import { compactResetLabel, fullResetLabel } from "./usage-display";
import { toast } from "./toast";
import { TrophiesPanel } from "./TrophiesPanel";
import { useRadio, type Radio } from "./useRadio";
import { pluralize } from "./workspace-title";

/** Matches the sidecar's fetch limit (utils/git-overview.ts). */
const GITHUB_ITEM_LIMIT = 20;

/**
 * What can take the message box's place. One at a time. "bg" is background
 * processes; "todo" is the project's task list; "brain" is chat memory.
 */
export type DeckPanelId =
  | "model"
  | "git"
  | "usage"
  | "bg"
  | "radio"
  | "more"
  | "notes"
  | "todo"
  | "brain"
  | "checklist"
  | "health"
  | "scorecard"
  | "goal"
  | "trophies";

/** A tool that used to be a pop-up dialog, now shown in the deck. */
export interface DeckTool {
  title: string;
  meta?: ReactNode;
  body: ReactNode;
}
export type DeckToolId = "notes" | "todo" | "brain" | "checklist" | "health" | "scorecard" | "goal";

export interface DeckProps {
  state: AgentState | null;
  hydrated: boolean;
  /** Code windows read out git; chat, motion and goals don't. */
  showGit: boolean;
  panel: DeckPanelId | null;
  onPanelChange: (panel: DeckPanelId | null) => void;
  /** The status line (ActivityBar). */
  status: ReactNode;
  /** The message box (Composer). Kept mounted, hidden, while a panel is open. */
  composer: ReactNode;
  /** The ⋯ keypad's keys. */
  menu: ReactNode;
  running: boolean;
  contextPct: number;
  models: readonly ModelOption[];
  modelsFailed: boolean;
  onSelectModel: (modelId: string) => void;
  /** Ken (code) or the critters (Goal); null in chat and motion. */
  second: SecondAgent | null;
  tasks: BackgroundTask[];
  schedules: readonly ActiveSchedule[];
  onStopSchedule: (id: string) => void;
  projectHealth: ProjectHealth | null;
  onReviewHealth?: (prompt: string, label: string) => boolean;
  /** The window number, shown in the usage panel. */
  usageExtras: ReactNode;
  /** Level and rank, for the usage panel's level row (it opens Scorecard). */
  progress: ProgressSnapshot | null;
  /** Every trophy, for the trophies key and its panel; null until loaded. */
  trophies: TrophySnapshot | null;
  /** Notes, Tasks and Brain: undefined where the workspace has no such tool. */
  tools: Partial<Record<DeckToolId, DeckTool>>;
}

/**
 * The deck: the one block at the bottom of a workspace window. Top to bottom:
 * the status line and the message box, or whatever panel replaced them, then
 * the readout rail. A readout (or a tool from ⋯) opens IN PLACE of the message
 * box rather than floating above the chat, so a tiny window never loses its
 * conversation to a pop-over. The draft survives: the composer stays mounted,
 * just hidden.
 *
 * Switching is instant in layout: the deck takes its new height in the same
 * frame, so every row is already where it ends up and only opacity changes.
 * (An eased height pinned to the rail made the panel's top edge travel up
 * ~50px on open: the "slide".)
 */
export function Deck(props: DeckProps): React.ReactElement {
  const { panel, onPanelChange, state } = props;
  const radio = useRadio();
  const deckRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Another window may have started or stopped the (app-wide) radio.
  useEffect(() => {
    const refresh = radio.refresh;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [radio.refresh]);

  useDeckEscape(panel !== null, () => onPanelChange(null));

  // Closing a panel hands focus back to the key that opened it from the
  // keyboard, or else to the message box. A mouse click never focused the key
  // (WebKit), so landing there after Escape would strand focus on a button:
  // the next Escape could no longer stop a run.
  const wasOpen = useRef(false);
  const refreshRadio = radio.refresh;
  useEffect(() => {
    if (panel) {
      wasOpen.current = true;
      if (panel === "radio") refreshRadio();
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const opener = openerRef.current;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    else
      deckRef.current
        ?.querySelector<HTMLTextAreaElement>("[data-composer-input]")
        ?.focus({ preventScroll: true });
  }, [panel, refreshRadio]);

  function toggle(id: DeckPanelId, event: React.MouseEvent<HTMLElement>): void {
    // A click from the keyboard (Enter/Space) has no click count.
    openerRef.current = event.detail === 0 ? event.currentTarget : null;
    onPanelChange(panel === id ? null : id);
  }

  const planMode = state?.planMode === true;

  return (
    <div
      ref={deckRef}
      className="deck"
      data-panel={panel ?? undefined}
      data-plan-mode={planMode || undefined}
    >
      {panel && (
        <div
          key={panel}
          className="deck-panel-host"
          data-tool={isTool(panel) || undefined}
          role="region"
          aria-label={PANEL_NAMES[panel]}
        >
          <PanelBody {...props} panel={panel} radio={radio} />
        </div>
      )}
      {/* While a panel has the deck, the status line and message box step
          aside, but stay laid out at their full width, just invisible and
          inert. Nothing inside re-measures, remounts or replays an entrance
          on the way back (the cache notice, the draft's height), so returning
          is a fade, never a jump. */}
      <div className="deck-main" data-away={panel !== null || undefined} inert={panel !== null}>
        <div className="deck-status">
          {props.status}
          {planMode && (
            <span className="deck-flag" title="Plan mode: GG reads and plans, and edits nothing">
              Plan mode
            </span>
          )}
        </div>
        <div className="deck-compose">{props.composer}</div>
      </div>
      <Rail {...props} radio={radio} toggle={toggle} />
    </div>
  );
}

const PANEL_NAMES: Readonly<Record<DeckPanelId, string>> = {
  model: "Model and thinking",
  git: "Git",
  usage: "Usage",
  bg: "Background tasks",
  radio: "Radio",
  more: "More",
  notes: "Notes",
  todo: "Tasks",
  brain: "Brain",
  checklist: "Checklist",
  health: "Project Health",
  scorecard: "Scorecard",
  goal: "Goal settings",
  trophies: "Trophies",
};

function Rail({
  state,
  hydrated,
  showGit,
  panel,
  contextPct,
  models,
  second,
  tasks,
  schedules,
  onStopSchedule,
  radio,
  toggle,
}: DeckProps & {
  radio: Radio;
  toggle: (id: DeckPanelId, event: React.MouseEvent<HTMLElement>) => void;
}): React.ReactElement {
  const key = (id: DeckPanelId) => ({
    "aria-expanded": panel === id,
    onClick: (event: React.MouseEvent<HTMLElement>) => toggle(id, event),
  });
  const branch = state?.gitBranch ?? null;
  const dirty = state?.gitDirtyFileCount ?? 0;
  const runningTasks = tasks.filter((t) => t.exitCode === null).length;
  const levels = state?.supportedThinkingLevels ?? [];
  const modelName = modelDisplayName(models, state?.model);
  // A model that spends real money (Claude fast mode) says so on the rail, not
  // just in the picker, for as long as it's active.
  const modelBilling = models.find((model) => model.id === state?.model)?.billing;
  const paid = modelBilling?.paid === true;
  const hot = contextPct >= 80;

  return (
    <div className="deck-rail" aria-label="Readouts">
      {showGit && branch && (
        <button
          type="button"
          className="key rail-key branch-key"
          title={`${branch}${dirty ? ` · ${pluralize(dirty, "uncommitted file", "uncommitted files")}` : " · clean"}`}
          aria-label={`Branch ${branch}${dirty ? `, ${dirty} uncommitted` : ", clean"}`}
          {...key("git")}
        >
          <Icon name="git-branch" size={15} />
          <span className="rail-label">{branch}</span>
        </button>
      )}
      {runningTasks > 0 && (
        <button
          type="button"
          className="key rail-key"
          title={pluralize(runningTasks, "background task running", "background tasks running")}
          aria-label={pluralize(
            runningTasks,
            "background task running",
            "background tasks running",
          )}
          {...key("bg")}
        >
          <Icon name="terminal" size={15} />
          <span className="well">{runningTasks}</span>
        </button>
      )}
      {schedules.length > 0 && (
        <RunningSchedulesButton schedules={schedules} onStop={onStopSchedule} />
      )}
      {hydrated && (
        <button
          type="button"
          className="key rail-key ctx-key"
          // Trophies live in the panel this key opens, so an unlock files in here.
          data-trophy-key=""
          data-hot={hot || undefined}
          title={`Context used: ${contextPct}%`}
          aria-label={`Context ${contextPct}% used. Usage`}
          {...key("usage")}
        >
          <span
            className="cbar"
            aria-hidden="true"
            style={{ "--p": contextPct } as React.CSSProperties}
          />
          <span className="well">{contextPct}%</span>
        </button>
      )}
      {radio.current !== null && (
        <button
          type="button"
          className="key rail-key onair-key"
          title={`Radio: ${radio.stations.find((s) => s.id === radio.current)?.name ?? "playing"}`}
          aria-label="Radio playing. Open the player"
          {...key("radio")}
        >
          <span className="eq" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="rail-label">On air</span>
        </button>
      )}
      <button
        type="button"
        className="key rail-key more-key"
        title="More: new session, notes, tasks, radio and more"
        aria-label="More"
        {...key("more")}
      >
        <Icon name="more-horiz" size={16} />
      </button>
      <span className="deck-spacer" />
      <button
        type="button"
        className="key rail-key model-key"
        title={`${state?.model ? modelName : "Model"}${levels.length ? ` · thinking ${thinkingLabel(state?.thinkingLevel).toLowerCase()}` : ""}${modelBilling ? ` · ${modelBilling.detail}` : ""}${second ? ` · ${second.name}: ${second.following ? `follows ${second.followLabel}` : modelDisplayName(models, second.model)}` : ""}`}
        aria-label={`Model ${modelName}${levels.length ? `, thinking ${thinkingLabel(state?.thinkingLevel)}` : ""}${paid ? `, ${modelBilling?.label}` : ""}. Change`}
        data-paid={paid || undefined}
        {...key("model")}
      >
        <ThinkingDots levels={levels} level={state?.thinkingLevel} />
        <span className="well trunc">{modelName}</span>
        {paid && (
          <span className="rail-label model-cost" aria-hidden="true">
            paid
          </span>
        )}
      </button>
    </div>
  );
}

function PanelBody(
  props: DeckProps & { panel: DeckPanelId; radio: Radio },
): React.ReactElement | null {
  const close = (): void => props.onPanelChange(null);
  switch (props.panel) {
    case "model":
      return (
        <ModelPanel
          state={props.state}
          models={props.models}
          modelsFailed={props.modelsFailed}
          running={props.running}
          onSelectModel={props.onSelectModel}
          second={props.second}
          onClose={close}
        />
      );
    case "git":
      return <GitPanel state={props.state} onClose={close} />;
    case "usage":
      return (
        <UsagePanel
          state={props.state}
          contextPct={props.contextPct}
          projectHealth={props.projectHealth}
          onOpenHealth={() => props.onPanelChange("health")}
          progress={props.progress}
          onOpenScorecard={() => props.onPanelChange("scorecard")}
          trophies={props.trophies}
          onOpenTrophies={() => props.onPanelChange("trophies")}
          extras={props.usageExtras}
          onClose={close}
        />
      );
    case "trophies":
      return <TrophiesPanel snapshot={props.trophies} onClose={close} />;
    case "bg":
      return <TasksPanel tasks={props.tasks} onEmpty={close} onClose={close} />;
    case "radio":
      return <RadioPanel radio={props.radio} onClose={close} />;
    case "more":
      return (
        <div className="deck-panel">
          <PanelHead title="More" onClose={close} />
          <div className="deck-pad" role="group" aria-label="More">
            {props.menu}
          </div>
        </div>
      );
    case "notes":
    case "todo":
    case "brain":
    case "checklist":
    case "health":
    case "scorecard":
    case "goal": {
      const tool = props.tools[props.panel];
      return tool ? <ToolPanel tool={tool} onClose={close} /> : null;
    }
  }
}

function isTool(panel: DeckPanelId): panel is DeckToolId {
  return (
    panel === "notes" ||
    panel === "todo" ||
    panel === "brain" ||
    panel === "checklist" ||
    panel === "health" ||
    panel === "scorecard" ||
    panel === "goal"
  );
}

/**
 * Notes, Tasks, Brain or the Checklist, in the message box's place. The
 * tool's own `<Modal>` renders as a plain section here (see modal-embed).
 * A tool with a text field (Notes) takes focus there so typing starts at
 * once; any other takes it on the panel itself, so a click never leaves a
 * focus ring on its first button.
 */
function ToolPanel({ tool, onClose }: { tool: DeckTool; onClose: () => void }): React.ReactElement {
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const field = body?.querySelector<HTMLElement>(
      "textarea, input[type='text'], input:not([type])",
    );
    (field ?? body)?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="deck-panel tool-panel">
      <PanelHead title={tool.title} meta={tool.meta} onClose={onClose} />
      <div ref={bodyRef} className="tool-body" tabIndex={-1}>
        <EmbeddedModal>{tool.body}</EmbeddedModal>
      </div>
    </div>
  );
}

type GitTab = "changes" | "pulls" | "issues";

/**
 * The Git panel (the branch key): the working tree's changed files with line
 * counts, and the repo's open pull requests and issues, each a tab, plus a
 * key to open the repo on GitHub. It loads when opened; GitHub lists are
 * missing (not empty) when `gh` can't be asked.
 */
function GitPanel({
  state,
  onClose,
}: {
  state: AgentState | null;
  onClose: () => void;
}): React.ReactElement {
  const branch = state?.gitBranch ?? null;
  const dirty = state?.gitDirtyFileCount ?? 0;
  const repo = state?.gitHubRepoUrl ?? null;
  const ci: GitHubCI | null = state?.gitHubCI ?? null;
  const [tab, setTab] = useState<GitTab>("changes");
  const [data, setData] = useState<GitOverview | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getGitOverview()
      .then((overview) => {
        if (!cancelled) setData(overview);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const counts: Record<GitTab, number | null> = {
    changes: data ? data.changes.length : dirty,
    pulls: data?.pulls?.length ?? state?.gitHubPRs ?? null,
    issues: data?.issues?.length ?? state?.gitHubIssues ?? null,
  };
  const tabs: ReadonlyArray<{ id: GitTab; label: string }> = repo
    ? [
        { id: "changes", label: "Changes" },
        { id: "pulls", label: "Pull requests" },
        { id: "issues", label: "Issues" },
      ]
    : [{ id: "changes", label: "Changes" }];

  return (
    <div className="deck-panel tool-panel git-panel">
      <PanelHead
        title={branch ?? "Git"}
        meta={dirty > 0 ? pluralize(dirty, "uncommitted file", "uncommitted files") : "Clean"}
        onClose={onClose}
      />
      <div className="deck-prow git-tabs">
        <div className="key-group goal-view-switch" role="tablist" aria-label="Git">
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              className="key key-sm"
              aria-selected={tab === id}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
              {counts[id] !== null && <span className="tab-n">{counts[id]}</span>}
            </button>
          ))}
        </div>
        <span className="deck-spacer" />
        <CIIndicator ci={ci} />
        {repo && (
          <button type="button" className="key key-sm" onClick={() => void openUrl(repo)}>
            Open on GitHub
          </button>
        )}
      </div>
      <div className="tool-body git-body" role="tabpanel" tabIndex={-1}>
        {failed ? (
          <p className="deck-note">Couldn&apos;t read this project&apos;s git status.</p>
        ) : !data ? (
          <p className="deck-note">Loading&hellip;</p>
        ) : tab === "changes" ? (
          <ChangesList files={data.changes} />
        ) : (
          <GitHubList
            items={tab === "pulls" ? data.pulls : data.issues}
            kind={tab === "pulls" ? "pull requests" : "issues"}
            more={repo ? `${repo}/${tab === "pulls" ? "pulls" : "issues"}` : null}
          />
        )}
      </div>
    </div>
  );
}

const STATUS_WORD: Readonly<Record<ChangedFile["status"], string>> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
};

function ChangesList({ files }: { files: ChangedFile[] }): React.ReactElement {
  if (files.length === 0) return <p className="deck-note">Nothing to commit.</p>;
  return (
    <ul className="git-list">
      {files.map((file) => {
        const slash = file.path.lastIndexOf("/");
        return (
          <li key={file.path} className="git-row" title={file.path}>
            <span className="git-st" data-st={file.status} title={STATUS_WORD[file.status]}>
              {file.status}
            </span>
            <span className="git-path trunc">
              {slash >= 0 && <span className="git-dir">{file.path.slice(0, slash + 1)}</span>}
              {file.path.slice(slash + 1)}
            </span>
            <span className="git-delta">
              {file.added === null && file.removed === null ? (
                <span className="git-bin">{file.status === "A" ? "new" : "binary"}</span>
              ) : (
                <>
                  {!!file.added && <span className="git-add">+{file.added}</span>}
                  {!!file.removed && <span className="git-del">&minus;{file.removed}</span>}
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function GitHubList({
  items,
  kind,
  more,
}: {
  items: GitHubItem[] | null;
  kind: string;
  more: string | null;
}): React.ReactElement {
  if (items === null) {
    return (
      <p className="deck-note">
        Couldn&apos;t ask GitHub. Sign in with <code>gh auth login</code> to see {kind} here.
      </p>
    );
  }
  if (items.length === 0) return <p className="deck-note">No open {kind}.</p>;
  return (
    <ul className="git-list">
      {items.map((item) => (
        <li key={item.number}>
          <button
            type="button"
            className="git-row git-link"
            title={`Open #${item.number} on GitHub`}
            onClick={() => void openUrl(item.url)}
          >
            <span className="git-num">#{item.number}</span>
            <span className="git-title trunc">{item.title}</span>
            <span className="git-meta">
              {item.draft ? "Draft · " : ""}
              {item.author}
            </span>
          </button>
        </li>
      ))}
      {more && items.length >= GITHUB_ITEM_LIMIT && (
        <li>
          <button
            type="button"
            className="git-row git-link git-more"
            onClick={() => void openUrl(more)}
          >
            See all {kind} on GitHub
          </button>
        </li>
      )}
    </ul>
  );
}

/** A labelled bar with its value beside it, never on top of it. */
function Meter({
  label,
  percent,
  value,
  detail,
  title,
  hot = false,
}: {
  label: string;
  percent: number;
  value: string;
  detail?: string;
  title?: string;
  hot?: boolean;
}): React.ReactElement {
  const p = Math.min(100, Math.max(0, percent));
  return (
    <div className="meter" data-hot={hot || undefined} title={title}>
      <span className="meter-k">{label}</span>
      <span
        className="cbar wide"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(p)}
        aria-valuetext={`${value}${detail ? `, ${detail}` : ""}`}
        style={{ "--p": p } as React.CSSProperties}
      />
      <span className="meter-v">{value}</span>
      {detail && <span className="meter-d">{detail}</span>}
    </div>
  );
}

function UsagePanel({
  state,
  contextPct,
  projectHealth,
  onOpenHealth,
  progress,
  onOpenScorecard,
  trophies,
  onOpenTrophies,
  extras,
  onClose,
}: {
  state: AgentState | null;
  contextPct: number;
  projectHealth: ProjectHealth | null;
  onOpenHealth: () => void;
  progress: ProgressSnapshot | null;
  onOpenScorecard: () => void;
  trophies: TrophySnapshot | null;
  onOpenTrophies: () => void;
  extras: ReactNode;
  onClose: () => void;
}): React.ReactElement {
  const { snapshot, now } = useSubscriptionUsage(state?.provider ?? "");
  const five = snapshot?.windows.find((w) => w.kind === "current");
  const week = snapshot?.windows.find((w) => w.kind === "weekly");
  const stale = snapshot?.stale ? " · last known" : "";
  return (
    <div className="deck-panel">
      <PanelHead title="Usage" onClose={onClose} />
      <div className="deck-prow usage-row">
        <Meter
          label="Context"
          percent={contextPct}
          value={`${contextPct}%`}
          hot={contextPct >= 80}
          title={`Context window: ${contextPct}% used`}
        />
        {five && (
          <Meter
            label={five.label.replace(/-hour$/i, "h")}
            percent={five.usedPercent}
            value={`${Math.round(five.usedPercent)}%`}
            detail={compactResetLabel(five.resetsAt, now)}
            hot={five.usedPercent >= 80}
            title={`${snapshot?.displayName} ${five.label}: ${Math.round(five.usedPercent)}% used · ${fullResetLabel(five.resetsAt, now)}${stale}`}
          />
        )}
        {week && (
          <Meter
            label="Week"
            percent={week.usedPercent}
            value={`${Math.round(week.usedPercent)}%`}
            detail={compactResetLabel(week.resetsAt, now)}
            hot={week.usedPercent >= 80}
            title={`${snapshot?.displayName} weekly: ${Math.round(week.usedPercent)}% used · ${fullResetLabel(week.resetsAt, now)}${stale}`}
          />
        )}
      </div>
      {projectHealth && (
        <div className="deck-prow">
          <button
            type="button"
            className="meter meter-link"
            data-tier={projectHealthTier(projectHealth.score)}
            title="Open the Project Health breakdown"
            onClick={onOpenHealth}
          >
            <span className="meter-k">Project Health</span>
            <span
              className="cbar wide"
              aria-hidden="true"
              style={{ "--p": projectHealth.score } as React.CSSProperties}
            />
            <span className="meter-v">{projectHealth.score}%</span>
            <span className="meter-d">
              {PROJECT_HEALTH_TIER_LABELS[projectHealthTier(projectHealth.score)]}
            </span>
          </button>
        </div>
      )}
      {progress && (
        <div className="deck-prow level-row">
          {trophies && (
            <button
              type="button"
              className="key key-sm trophy-key"
              aria-label={`Trophies, ${trophies.earned} of ${trophies.total} earned`}
              title={`Trophies: ${trophies.earned} of ${trophies.total} earned`}
              onClick={onOpenTrophies}
            >
              <Icon name="trophy" size={13} />
              <span className="well">{trophies.earned}</span>
            </button>
          )}
          <button
            type="button"
            className="key key-sm level-key"
            aria-label={`Level ${progress.level}, ${progress.rankName}. Open your scorecard`}
            title={`${progress.rankName}: level ${progress.level} · ${progress.xpIntoLevel}/${progress.xpForLevel} XP to the next. Open your scorecard`}
            onClick={onOpenScorecard}
          >
            <span className="well">{progress.level}</span>
            <span className={`level-name rank-fx-${progress.effectId}`}>{progress.rankName}</span>
          </button>
          <Meter
            label="Next level"
            percent={
              progress.xpForLevel > 0 ? (progress.xpIntoLevel / progress.xpForLevel) * 100 : 0
            }
            value={`${progress.xpIntoLevel}/${progress.xpForLevel} XP`}
          />
          <span className="deck-spacer" />
          {extras}
        </div>
      )}
      {!progress && extras && <div className="deck-prow">{extras}</div>}
    </div>
  );
}

function formatRunFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}

/** The clock, ticking each second while `live`. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

function TasksPanel({
  tasks,
  onEmpty,
  onClose,
}: {
  tasks: BackgroundTask[];
  onEmpty: () => void;
  onClose: () => void;
}): React.ReactElement {
  const running = tasks.filter((t) => t.exitCode === null);
  const finished = tasks.length - running.length;
  useEffect(() => {
    if (tasks.length === 0) onEmpty();
  }, [tasks.length, onEmpty]);
  const stop = (task: BackgroundTask): void => {
    void killTask(task.id).then((res) => {
      if (!res.ok) toast(`Couldn't stop the task: ${res.error}`, "error");
    });
  };
  const now = useNow(running.length > 0);
  return (
    <div className="deck-panel">
      <PanelHead
        title="Background tasks"
        meta={`${running.length} running${finished > 0 ? ` \u00b7 ${finished} finished` : ""}`}
        onClose={onClose}
      />
      {running.length > 1 && (
        <div className="deck-prow deck-actions">
          <span className="deck-spacer" />
          <button type="button" className="key key-sm" onClick={() => running.forEach(stop)}>
            Stop all
          </button>
        </div>
      )}
      <ul className="deck-list deck-rows">
        {tasks.map((task) => {
          const live = task.exitCode === null;
          const first = task.command.split("\n")[0] ?? task.command;
          return (
            <li key={task.id} className="deck-row">
              <span className="row-main code" title={task.command}>
                {first}
              </span>
              <span className={`row-end${!live && task.exitCode !== 0 ? " bad" : ""}`}>
                {live
                  ? formatRunFor(now - task.startedAt)
                  : task.exitCode === 0
                    ? "Finished"
                    : `Exit ${task.exitCode}`}
              </span>
              {live ? (
                <button
                  type="button"
                  className="key key-sm"
                  aria-label={`Stop ${first}`}
                  onClick={() => stop(task)}
                >
                  Stop
                </button>
              ) : (
                <span />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RadioPanel({ radio, onClose }: { radio: Radio; onClose: () => void }): React.ReactElement {
  const { stations, selected, current, volume, busy, error } = radio;
  const point = stations.find((s) => s.id === (current ?? selected));
  const at = stations.findIndex((s) => s.id === (current ?? selected));
  const step = (delta: number): void => {
    if (stations.length === 0) return;
    const next = stations[(Math.max(0, at) + delta + stations.length) % stations.length];
    if (next) radio.changeStation(next.id);
  };
  return (
    <div className="deck-panel">
      <PanelHead title="Radio" meta={current !== null ? "Playing" : undefined} onClose={onClose} />
      <div className="deck-list radio-list" role="listbox" aria-label="Stations">
        {stations.length === 0 && <p className="deck-note">Loading stations{"\u2026"}</p>}
        {stations.map((station) => (
          <div
            key={station.id}
            className="deck-option"
            role="option"
            tabIndex={-1}
            aria-selected={station.id === selected}
            data-current={station.id === current || undefined}
            onClick={() => radio.changeStation(station.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                radio.changeStation(station.id);
              }
            }}
          >
            <span className="opt-name">{station.name}</span>
            <span className="opt-sub">{station.description}</span>
          </div>
        ))}
      </div>
      <div className="deck-prow player">
        <button
          type="button"
          className="key key-icon primary"
          disabled={busy || !selected}
          aria-label={current === null ? "Play" : "Pause"}
          onClick={radio.togglePlayback}
        >
          <Icon name={current === null ? "play" : "pause"} size={15} />
        </button>
        <div className="now">
          <b className="trunc">{point?.name ?? "Radio"}</b>
          <span className="trunc">{current === null ? "Paused" : (point?.description ?? "")}</span>
        </div>
        <button
          type="button"
          className="key key-icon"
          aria-label="Previous station"
          onClick={() => step(-1)}
        >
          <Icon name="skip-prev" size={13} />
        </button>
        <button
          type="button"
          className="key key-icon"
          aria-label="Next station"
          onClick={() => step(1)}
        >
          <Icon name="skip-next" size={13} />
        </button>
        <label className="vol">
          <Icon name={volume === 0 ? "sound-off" : "sound-high"} size={15} />
          <input
            type="range"
            min={0}
            max={100}
            value={volume}
            aria-label="Radio volume"
            style={{ "--v": `${volume}%` } as React.CSSProperties}
            onChange={(event) => radio.updateVolume(Number(event.target.value))}
            onPointerUp={radio.saveVolume}
            onPointerCancel={radio.saveVolume}
            onKeyUp={radio.saveVolume}
            onBlur={radio.saveVolume}
          />
          <span className="vol-v">{volume}%</span>
        </label>
      </div>
      {error && (
        <p className="deck-note" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
