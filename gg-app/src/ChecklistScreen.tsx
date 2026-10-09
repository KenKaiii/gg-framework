import { useState } from "react";
import {
  CheckCircleIcon,
  CircleIcon,
  ClockClockwiseIcon,
  HourglassIcon,
  ListChecksIcon,
  MinusCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import type { ChecklistEntry, ChecklistSnapshot } from "./agent";
import { SettingsTabBar, type SettingsTab } from "./SettingsTabBar";
import "./ChecklistScreen.css";

export type ChecklistLoad =
  { kind: "loading" } | { kind: "error" } | { kind: "ready"; snapshot: ChecklistSnapshot };
export interface ChecklistNotice {
  id: string;
  /** Record revision present when this notice was created. */
  checkedAt: string | null;
  message: string;
}
interface ChecklistScreenProps {
  load: ChecklistLoad;
  running: boolean;
  activeId: string | null;
  notice: ChecklistNotice | null;
  onRun: (item: ChecklistEntry) => void;
  onRetry: () => void;
}

type Filter = "all" | "review" | "findings";
const PANEL_ID = "checklist-panel";
const TABS: readonly SettingsTab<Filter>[] = [
  { id: "all", label: "All checks", icon: ListChecksIcon },
  { id: "review", label: "Needs review", icon: ClockClockwiseIcon },
  { id: "findings", label: "Findings", icon: WarningCircleIcon },
];
const STATUS_ICONS = {
  "not-run": CircleIcon,
  "not-applicable": MinusCircleIcon,
  due: ClockClockwiseIcon,
  passed: CheckCircleIcon,
  "needs-work": WarningCircleIcon,
  checking: HourglassIcon,
};

function checkedDate(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
function statusText(item: ChecklistEntry): string {
  if (item.status === "not-applicable") return "Not applicable";
  if (item.status === "due")
    return `Review due${item.result === "issues" ? " · Findings reported" : ""}`;
  if (item.result === "issues") {
    const count = `${item.findings.length || "Some"} finding${item.findings.length === 1 ? "" : "s"} reported`;
    return item.changedSinceCheck ? `${count} · Code changed since, check again` : count;
  }
  if (item.checkedAt) {
    const accepted = item.accepted?.length ?? 0;
    return `Checked ${checkedDate(item.checkedAt)}${accepted > 0 ? ` · ${accepted} accepted as is` : ""}`;
  }
  return item.detection ? `${item.detection.summary} · Not reviewed` : "Not reviewed";
}

/** One compact collection, with purpose hints handled by the shared TooltipLayer. */
export function ChecklistScreen({
  load,
  running,
  activeId,
  notice,
  onRun,
  onRetry,
}: ChecklistScreenProps): React.ReactElement {
  const [filter, setFilter] = useState<Filter>("all");
  const [switched, setSwitched] = useState(false);
  function selectFilter(id: Filter): void {
    setSwitched(true);
    setFilter(id);
  }
  const groups = new Map<string, ChecklistEntry[]>();
  if (load.kind === "ready") {
    for (const item of load.snapshot.items) {
      if (filter === "findings" && item.result !== "issues") continue;
      if (filter === "review" && (item.status === "passed" || item.status === "not-applicable"))
        continue;
      const rows = groups.get(item.group) ?? [];
      rows.push(item);
      groups.set(item.group, rows);
    }
  }
  const empty = load.kind === "ready" && groups.size === 0;
  return (
    <section className="checklist-screen" aria-label="Project checklist">
      <h1 className="checklist-accessible-title">Project checklist</h1>
      <SettingsTabBar
        tabs={TABS}
        selected={filter}
        onSelect={selectFilter}
        panelId={PANEL_ID}
        label="Checklist views"
        tabIdPrefix="checklist-tab"
      />
      <div
        className="settings-scroll checklist-scroll"
        id={PANEL_ID}
        role="tabpanel"
        aria-labelledby={`checklist-tab-${filter}`}
        tabIndex={0}
        key={filter}
      >
        <div
          className={`settings-page checklist-page${switched ? " is-switching" : ""}${empty ? " is-empty" : ""}`}
        >
          <div className="settings-panel">
            {load.kind === "loading" && (
              <p className="checklist-note" role="status">
                Reading project setup…
              </p>
            )}
            {load.kind === "error" && (
              <div className="checklist-note" role="alert">
                <p>Couldn't read the checklist.</p>
                <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry}>
                  Try again
                </button>
              </div>
            )}
            {load.kind === "ready" && (
              <>
                {Boolean(load.snapshot.detectionWarnings?.length) && (
                  <details className="checklist-warning">
                    <summary>Some setup could not be inspected</summary>
                    <ul>
                      {load.snapshot.detectionWarnings?.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {empty && (
                  <p className="checklist-empty" role="status">
                    {filter === "findings" ? "No recorded findings." : "No checks in this view."}
                  </p>
                )}
                {[...groups].map(([group, items]) => (
                  <section
                    className="settings-card checklist-section"
                    key={group}
                    aria-label={group}
                  >
                    <div className="checklist-section-heading">
                      <h2>{group}</h2>
                      <span>
                        {items.length} {items.length === 1 ? "check" : "checks"}
                      </span>
                    </div>
                    {items.map((item) => {
                      const checking = activeId === item.id;
                      const message = notice?.id === item.id ? notice.message : null;
                      const state = checking ? "checking" : message ? "needs-work" : item.status;
                      const StatusIcon = STATUS_ICONS[state];
                      return (
                        <div className="checklist-entry" data-state={state} key={item.id}>
                          <div className="checklist-entry-row">
                            <div
                              className="checklist-entry-info"
                              role="group"
                              aria-label={item.title}
                              tabIndex={0}
                              title={item.description}
                              onPointerDown={(event) => event.currentTarget.blur()}
                            >
                              <StatusIcon
                                className="checklist-entry-icon"
                                size={24}
                                weight={state === "passed" ? "fill" : "regular"}
                                aria-hidden="true"
                              />
                              <span className="checklist-entry-copy">
                                <span className="checklist-entry-title">{item.title}</span>{" "}
                                <span className="checklist-entry-status" aria-live="polite">
                                  {checking ? "Checking…" : (message ?? statusText(item))}
                                </span>
                              </span>
                            </div>
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost checklist-check"
                              aria-label={`Check ${item.title}`}
                              aria-disabled={running || item.runPrompt === null}
                              title={
                                running
                                  ? "The agent is busy"
                                  : item.id === "agent-setup"
                                    ? "Run /init to create or update project instructions"
                                    : "Check and report, then choose what to fix"
                              }
                              onClick={() => {
                                if (running || item.runPrompt === null) return;
                                onRun(item);
                              }}
                            >
                              {checking ? "Checking…" : "Check"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </section>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
