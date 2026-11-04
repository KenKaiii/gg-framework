import { useState } from "react";
import { ClockClockwiseIcon, ListChecksIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { ChecklistEntry, ChecklistSnapshot } from "../agent";
import { SettingsTabBar, type SettingsTab } from "../SettingsTabBar";
import "./placeholder.css";

export type ChecklistLoad =
  { kind: "loading" } | { kind: "error" } | { kind: "ready"; snapshot: ChecklistSnapshot };
export interface ChecklistNotice {
  id: string;
  /** Record revision present when this notice was created. */
  checkedAt: string | null;
  message: string;
}
interface ChecklistViewProps {
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
  if (item.checkedAt) return `Checked ${checkedDate(item.checkedAt)}`;
  return item.detection ? `${item.detection.summary} · Not reviewed` : "Not reviewed";
}

/**
 * The project health checklist as a workspace view. Each item's purpose is its
 * hover/focus hint (the shared TooltipLayer); Check reports first and fixes only
 * what the user then picks, except Agent setup, which runs /init.
 * `data-hides-composer` keeps the hidden chat box from taking the cursor back
 * while this view is open.
 */
export function ChecklistView({
  load,
  running,
  activeId,
  notice,
  onRun,
  onRetry,
}: ChecklistViewProps): React.ReactElement {
  const [filter, setFilter] = useState<Filter>("all");
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
    <section
      className="placeholder-checklist"
      aria-label="Project checklist"
      data-hides-composer=""
    >
      <h1>Project checklist</h1>
      <SettingsTabBar
        tabs={TABS}
        selected={filter}
        onSelect={setFilter}
        panelId={PANEL_ID}
        label="Checklist views"
        tabIdPrefix="checklist-tab"
      />
      <div
        className="placeholder-scroll"
        id={PANEL_ID}
        role="tabpanel"
        aria-labelledby={`checklist-tab-${filter}`}
        tabIndex={0}
        key={filter}
      >
        {load.kind === "loading" && <p role="status">Reading project setup…</p>}
        {load.kind === "error" && (
          <div role="alert">
            <p>Couldn't read the checklist.</p>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}
        {load.kind === "ready" && (
          <>
            {Boolean(load.snapshot.detectionWarnings?.length) && (
              <details>
                <summary>Some setup could not be inspected</summary>
                <ul>
                  {load.snapshot.detectionWarnings?.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </details>
            )}
            {empty && (
              <p role="status">
                {filter === "findings" ? "No recorded findings." : "No checks in this view."}
              </p>
            )}
            {[...groups].map(([group, items]) => (
              <section key={group} aria-label={group}>
                <h2>{group}</h2>
                <p className="placeholder-muted">
                  {items.length} {items.length === 1 ? "check" : "checks"}
                </p>
                {items.map((item) => {
                  const checking = activeId === item.id;
                  const message = notice?.id === item.id ? notice.message : null;
                  const attention = item.result === "issues" || item.status === "due";
                  return (
                    <div className="placeholder-row" key={item.id}>
                      <div
                        role="group"
                        aria-label={item.title}
                        tabIndex={0}
                        title={item.description}
                        // A click should not leave the hint pinned open by focus.
                        onPointerDown={(event) => event.currentTarget.blur()}
                      >
                        <span>{item.title}</span>{" "}
                        <span
                          className={attention ? "placeholder-attention" : "placeholder-muted"}
                          aria-live="polite"
                        >
                          {checking ? "Checking…" : (message ?? statusText(item))}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
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
                  );
                })}
              </section>
            ))}
          </>
        )}
      </div>
    </section>
  );
}
