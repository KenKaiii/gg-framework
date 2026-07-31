import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { Modal } from "./Modal";
import { NotesCurrentFocus } from "./NotesCurrentFocus";
import { NotesHandoff } from "./NotesHandoff";
import { NotesReferences } from "./NotesReferences";
import { NotesRoadmap, NotesRoadmapArchive } from "./NotesRoadmap";
import { NotesTaskList } from "./NotesTaskList";
import type { NotesReferenceInput } from "./notes-reference";
import type { OpenReferenceUrl } from "./notes-open-source";
import type { NotesPhaseInput } from "./useProjectNotes";
import type {
  NotesPhase,
  NotesPhaseStatus,
  NotesReference,
  NotesReferenceOperationResult,
  NotesReminderMutationResult,
  NotesRoadmapMutationResult,
  NotesSessionLink,
  NotesTask,
  PhaseStartResult,
} from "./notes-types";

type NotesTab = "overview" | "roadmap" | "reference" | "archive";

const NOTES_TABS: ReadonlyArray<{ id: NotesTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "roadmap", label: "Roadmap" },
  { id: "reference", label: "Reference" },
  { id: "archive", label: "Archive" },
];

interface Props {
  value: string;
  onChange(value: string): void;
  currentFocus: string;
  tasks: NotesTask[];
  phases: NotesPhase[];
  references: NotesReference[];
  handoff: string;
  handoffUpdatedAt: string | null;
  handoffUnread: boolean;
  activePhaseCount: number;
  activeReminderCount: number;
  authorityReady: boolean;
  initialRoadmapPhaseId?: string | null;
  persistenceStatus: React.ReactNode;
  onChangeCurrentFocus(value: string): void;
  onCreateTask(text: string): void;
  onEditTask(id: string, text: string): void;
  onToggleTask(id: string): void;
  onMoveTask(id: string, direction: "up" | "down"): void;
  onArchiveTask(id: string): void;
  onRestoreTask(id: string): void;
  onCreatePhase(input: NotesPhaseInput): void;
  onEditPhase(id: string, input: NotesPhaseInput): void;
  onMovePhase(id: string, direction: "up" | "down"): void;
  onChangePhaseStatus(id: string, status: NotesPhaseStatus): void;
  onArchivePhase(id: string): void;
  onRestorePhase(id: string): void;
  onCreateReference(
    input: NotesReferenceInput,
    phaseIds: readonly string[],
  ): Promise<NotesReferenceOperationResult>;
  onEditReference(id: string, input: NotesReferenceInput): Promise<NotesReferenceOperationResult>;
  onDeleteReference(id: string): Promise<NotesReferenceOperationResult>;
  onLinkReferenceToPhase(
    referenceId: string,
    phaseId: string,
  ): Promise<NotesReferenceOperationResult>;
  onUnlinkReferenceFromPhase(
    referenceId: string,
    phaseId: string,
  ): Promise<NotesReferenceOperationResult>;
  onAcceptReferenceProposal(
    phaseId: string,
    proposalId: string,
  ): Promise<NotesRoadmapMutationResult>;
  onRejectReferenceProposal(
    phaseId: string,
    proposalId: string,
  ): Promise<NotesRoadmapMutationResult>;
  onResumeAutomaticStatus(phaseId: string): Promise<NotesRoadmapMutationResult>;
  onResumeAutomaticReferences(phaseId: string): Promise<NotesRoadmapMutationResult>;
  onScheduleReminder(
    phaseId: string,
    input: { dueAt: string; note: string },
  ): Promise<NotesReminderMutationResult>;
  onSnoozeReminder(
    phaseId: string,
    dueAt: string,
    expectedOccurrenceKey: string,
  ): Promise<NotesReminderMutationResult>;
  onDismissReminder(
    phaseId: string,
    expectedOccurrenceKey: string,
  ): Promise<NotesReminderMutationResult>;
  openSource?: OpenReferenceUrl;
  onStartPhase(phaseId: string): Promise<PhaseStartResult>;
  onResumePhase(phaseId: string, link: NotesSessionLink): Promise<void>;
  phaseStartUnavailableReason: string | null;
  phaseActionDisabled: boolean;
  onPhaseActionSuccess(): void;
  onChangeHandoff(text: string): void;
  onHandoffPresented(text: string, updatedAt: string): void;
  onClose(): void;
}

function activeCountLabel(count: number, noun: string): string {
  return `active ${noun}${count === 1 ? "" : "s"}`;
}

function countLabel(count: number, noun: string): string {
  return `${count} ${activeCountLabel(count, noun)}`;
}

export function NotesModal({
  value,
  onChange,
  currentFocus,
  tasks,
  phases,
  references,
  handoff,
  handoffUpdatedAt,
  handoffUnread,
  activePhaseCount,
  activeReminderCount,
  authorityReady,
  initialRoadmapPhaseId = null,
  persistenceStatus,
  onChangeCurrentFocus,
  onCreateTask,
  onEditTask,
  onToggleTask,
  onMoveTask,
  onArchiveTask,
  onRestoreTask,
  onCreatePhase,
  onEditPhase,
  onMovePhase,
  onChangePhaseStatus,
  onArchivePhase,
  onRestorePhase,
  onCreateReference,
  onEditReference,
  onDeleteReference,
  onLinkReferenceToPhase,
  onUnlinkReferenceFromPhase,
  onAcceptReferenceProposal,
  onRejectReferenceProposal,
  onResumeAutomaticStatus,
  onResumeAutomaticReferences,
  onScheduleReminder,
  onSnoozeReminder,
  onDismissReminder,
  openSource,
  onStartPhase,
  onResumePhase,
  phaseStartUnavailableReason,
  phaseActionDisabled,
  onPhaseActionSuccess,
  onChangeHandoff,
  onHandoffPresented,
  onClose,
}: Props): React.ReactElement {
  const currentFocusInputRef = useRef<HTMLInputElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<Record<NotesTab, HTMLButtonElement | null>>({
    overview: null,
    roadmap: null,
    reference: null,
    archive: null,
  });
  const [activeTab, setActiveTab] = useState<NotesTab>(
    initialRoadmapPhaseId ? "roadmap" : "overview",
  );
  const [showArchived, setShowArchived] = useState(false);
  const [referenceCreateRequest, setReferenceCreateRequest] = useState(0);
  const archivedTasks = tasks.filter((task) => task.archivedAt !== null);
  const hasRoadmapSummary = activePhaseCount > 0 || activeReminderCount > 0;

  const selectTab = useCallback((tab: NotesTab, focus = false): void => {
    setActiveTab(tab);
    if (focus) tabRefs.current[tab]?.focus();
  }, []);

  const onTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, tab: NotesTab): void => {
      const currentIndex = NOTES_TABS.findIndex((item) => item.id === tab);
      let nextIndex: number | null = null;
      if (event.key === "ArrowLeft") {
        nextIndex = (currentIndex - 1 + NOTES_TABS.length) % NOTES_TABS.length;
      } else if (event.key === "ArrowRight") {
        nextIndex = (currentIndex + 1) % NOTES_TABS.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = NOTES_TABS.length - 1;
      }
      if (nextIndex === null) return;
      event.preventDefault();
      selectTab(NOTES_TABS[nextIndex]!.id, true);
    },
    [selectTab],
  );

  return (
    <Modal title="Your notes" onClose={onClose} className="notes-modal">
      <div className="notes-shell">
        <div className="notes-shell-status">{persistenceStatus}</div>
        <div className="notes-tabs-scroll">
          <div
            className="notes-tabs"
            role="tablist"
            aria-label="Notes sections"
            aria-orientation="horizontal"
          >
            {NOTES_TABS.map((tab) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  ref={(element) => {
                    tabRefs.current[tab.id] = element;
                  }}
                  id={`notes-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`notes-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => selectTab(tab.id)}
                  onKeyDown={(event) => onTabKeyDown(event, tab.id)}
                >
                  <span>{tab.label}</span>
                  {tab.id === "roadmap" && activePhaseCount > 0 && (
                    <span className="notes-tab-count" aria-hidden="true">
                      {activePhaseCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="notes-panels">
          <div
            id="notes-panel-overview"
            className="notes-panel"
            role="tabpanel"
            aria-labelledby="notes-tab-overview"
            hidden={activeTab !== "overview"}
          >
            <div className="notes-panel-rail">
              {hasRoadmapSummary && (
                <aside className="notes-roadmap-summary" aria-label="Roadmap summary">
                  <strong>Roadmap</strong>
                  {activePhaseCount > 0 && <span>{countLabel(activePhaseCount, "phase")}</span>}
                  {activeReminderCount > 0 && (
                    <span>{countLabel(activeReminderCount, "reminder")}</span>
                  )}
                </aside>
              )}

              <section className="notes-section" aria-labelledby="notes-now-heading">
                <h2 id="notes-now-heading">Now</h2>
                <NotesCurrentFocus
                  value={currentFocus}
                  inputRef={currentFocusInputRef}
                  onChange={onChangeCurrentFocus}
                />
              </section>

              <section className="notes-section" aria-labelledby="notes-next-heading">
                <h2 id="notes-next-heading">Next</h2>
                <NotesTaskList
                  tasks={tasks}
                  addInputRef={addInputRef}
                  onCreateTask={onCreateTask}
                  onEditTask={onEditTask}
                  onToggleTask={onToggleTask}
                  onMoveTask={onMoveTask}
                  onArchiveTask={onArchiveTask}
                />
              </section>

              <section className="notes-section" aria-labelledby="notes-handoff-heading">
                <h2 id="notes-handoff-heading">Handoff</h2>
                <NotesHandoff
                  value={handoff}
                  updatedAt={handoffUpdatedAt}
                  unread={handoffUnread}
                  visible={activeTab === "overview"}
                  onChange={onChangeHandoff}
                  onPresented={onHandoffPresented}
                />
              </section>
            </div>
          </div>

          <div
            id="notes-panel-roadmap"
            className="notes-panel"
            role="tabpanel"
            aria-labelledby="notes-tab-roadmap"
            hidden={activeTab !== "roadmap"}
          >
            <div className="notes-panel-rail notes-roadmap-rail">
              <section
                className="notes-section notes-roadmap-section"
                aria-labelledby="notes-roadmap-heading"
              >
                <NotesRoadmap
                  phases={phases}
                  references={references}
                  authorityReady={authorityReady}
                  initialSelectedPhaseId={initialRoadmapPhaseId}
                  onCreatePhase={onCreatePhase}
                  onEditPhase={onEditPhase}
                  onMovePhase={onMovePhase}
                  onChangePhaseStatus={onChangePhaseStatus}
                  onArchivePhase={onArchivePhase}
                  onLinkReferenceToPhase={onLinkReferenceToPhase}
                  onUnlinkReferenceFromPhase={onUnlinkReferenceFromPhase}
                  onAcceptReferenceProposal={onAcceptReferenceProposal}
                  onRejectReferenceProposal={onRejectReferenceProposal}
                  onResumeAutomaticStatus={onResumeAutomaticStatus}
                  onResumeAutomaticReferences={onResumeAutomaticReferences}
                  onScheduleReminder={onScheduleReminder}
                  onSnoozeReminder={onSnoozeReminder}
                  onDismissReminder={onDismissReminder}
                  onStartPhase={onStartPhase}
                  onResumePhase={onResumePhase}
                  startUnavailableReason={phaseStartUnavailableReason}
                  actionDisabled={phaseActionDisabled}
                  onActionSuccess={onPhaseActionSuccess}
                  onCreateReference={() => {
                    selectTab("reference");
                    setReferenceCreateRequest((request) => request + 1);
                  }}
                />
              </section>
            </div>
          </div>

          <div
            id="notes-panel-reference"
            className="notes-panel"
            role="tabpanel"
            aria-labelledby="notes-tab-reference"
            hidden={activeTab !== "reference"}
          >
            <div className="notes-panel-rail">
              <section
                className="notes-section notes-reference-section"
                aria-labelledby="notes-reference-heading"
              >
                <h2 id="notes-reference-heading">Reference</h2>
                <div className="notes-field">
                  <label htmlFor="notes-reference">Reference notes</label>
                  <textarea
                    id="notes-reference"
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    spellCheck={true}
                  />
                </div>
                <NotesReferences
                  references={references}
                  phases={phases}
                  onCreateReference={onCreateReference}
                  onEditReference={onEditReference}
                  onDeleteReference={onDeleteReference}
                  onLinkReferenceToPhase={onLinkReferenceToPhase}
                  onUnlinkReferenceFromPhase={onUnlinkReferenceFromPhase}
                  openSource={openSource}
                  createRequest={referenceCreateRequest}
                />
              </section>
            </div>
          </div>

          <div
            id="notes-panel-archive"
            className="notes-panel"
            role="tabpanel"
            aria-labelledby="notes-tab-archive"
            hidden={activeTab !== "archive"}
          >
            <div className="notes-panel-rail">
              <section
                className="notes-section notes-archive"
                aria-labelledby="notes-archive-heading"
              >
                <h2 id="notes-archive-heading">Done / Archive</h2>
                <NotesRoadmapArchive phases={phases} onRestorePhase={onRestorePhase} />
                <h3 className="notes-archive-task-heading">Notes tasks</h3>
                <button
                  type="button"
                  className="notes-archive-toggle"
                  aria-expanded={showArchived}
                  aria-controls="notes-archive-list"
                  onClick={() => setShowArchived((visible) => !visible)}
                >
                  {showArchived ? "Hide" : "Show"} archived tasks ({archivedTasks.length})
                </button>
                <div id="notes-archive-list" className="notes-task-list" hidden={!showArchived}>
                  {showArchived && (
                    <>
                      {archivedTasks.length === 0 && (
                        <p className="notes-empty">No archived tasks.</p>
                      )}
                      {archivedTasks.map((task) => (
                        <div className="notes-task-row notes-archived-task" key={task.id}>
                          <span>{task.text}</span>
                          <div className="notes-task-actions">
                            <button
                              type="button"
                              aria-label={`Restore task: ${task.text}`}
                              onClick={() => onRestoreTask(task.id)}
                            >
                              Restore
                            </button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
