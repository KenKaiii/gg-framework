import { canonicalProjectKey } from "@kenkaiiii/gg-core/project-notes";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, AlertTriangle, Database, HardDrive } from "lucide-react";
import { NotesModal } from "./NotesModal";
import { RoadmapReminderAlert } from "./RoadmapReminderAlert";
import type { OpenReferenceUrl } from "./notes-open-source";
import { NotesStatusBadge, notesStatusLabel } from "./NotesStatusBadge";
import {
  getActiveNotesPhaseCount,
  getActiveNotesReminderCount,
  getDueNotesReminderCount,
  getUnfinishedNotesTaskCount,
  isNotesHandoffUnread,
} from "./notes-status";
import {
  reminderMutationResultMessage,
  RoadmapReminderDeliveryHost,
  type InAppReminderDelivery,
} from "./roadmap-reminders";
import { useProjectNotes, type UseProjectNotesResult } from "./useProjectNotes";
import type {
  NotesClient,
  NotesPromptSaveInput,
  NotesPromptSaveResult,
  NotesReminderMutationResult,
  NotesSessionLink,
  PhaseStartResult,
} from "./notes-types";
import { isRoadmapReminderDueEvent } from "./notes-types";
import type { KenPromptSaveDestination } from "./ken-prompt-actions";

interface Props {
  cwd: string | null;
  client: NotesClient;
  openSource?: OpenReferenceUrl;
  onStartPhase?(phaseId: string): Promise<PhaseStartResult>;
  onResumePhase?(phaseId: string, link: NotesSessionLink): Promise<void>;
  phaseStartUnavailableReason?: string | null;
  phaseActionDisabled?: boolean;
  paneFocused?: boolean;
  windowFocused?: boolean;
}

interface NotesPersistenceStatus {
  tone: "project" | "local" | "warning" | "error";
  title: string;
  detail: string;
}

export interface ProjectNotesPromptActions {
  listDestinations(): KenPromptSaveDestination[];
  savePrompt(input: NotesPromptSaveInput): Promise<NotesPromptSaveResult>;
}

export const ProjectNotes = forwardRef<ProjectNotesPromptActions, Props>(function ProjectNotes(
  {
    cwd,
    client,
    openSource,
    onStartPhase = async () => {
      throw new Error("Phase actions are unavailable in this view.");
    },
    onResumePhase = async () => {
      throw new Error("Phase actions are unavailable in this view.");
    },
    phaseStartUnavailableReason = null,
    phaseActionDisabled = false,
    paneFocused = true,
    windowFocused = true,
  },
  ref,
): React.ReactElement {
  const [showNotes, setShowNotes] = useState(false);
  const [modalProjectIdentity, setModalProjectIdentity] = useState<string | null>(null);
  const [roadmapTargetPhaseId, setRoadmapTargetPhaseId] = useState<string | null>(null);
  const [reminderQueue, setReminderQueue] = useState<InAppReminderDelivery[]>([]);
  const [reminderPending, setReminderPending] = useState(false);
  const [reminderError, setReminderError] = useState<string | null>(null);
  const deliveryHostRef = useRef<RoadmapReminderDeliveryHost | null>(null);
  const authorityReadyRef = useRef(false);
  const focusRef = useRef(true);
  const activeProjectIdentity = cwd ? canonicalProjectKey(cwd) : null;
  const {
    value,
    onChange,
    document: notesDocument,
    authorityReady,
    changeCurrentFocus,
    createTask,
    editTask,
    toggleTask,
    moveTask,
    archiveTask,
    restoreTask,
    createPhase,
    editPhase,
    movePhase,
    changePhaseStatus,
    archivePhase,
    restorePhase,
    savePrompt,
    createReference,
    editReference,
    deleteReference,
    linkReferenceToPhase,
    unlinkReferenceFromPhase,
    acceptReferenceProposal,
    rejectReferenceProposal,
    resumeAutomaticStatus,
    resumeAutomaticReferences,
    schedulePhaseReminder,
    snoozePhaseReminder,
    dismissPhaseReminder,
    changeHandoff,
    markHandoffPresented,
    diagnostics,
  } = useProjectNotes(cwd, { client });
  const status = {
    unfinishedCount: getUnfinishedNotesTaskCount(notesDocument),
    dueReminderCount: getDueNotesReminderCount(notesDocument),
    handoffUnread: isNotesHandoffUnread(notesDocument),
  };
  const activePhaseCount = getActiveNotesPhaseCount(notesDocument);
  const activeReminderCount = getActiveNotesReminderCount(notesDocument);

  useEffect(() => {
    setShowNotes(false);
    setRoadmapTargetPhaseId(null);
    setReminderQueue([]);
    setReminderError(null);
  }, [activeProjectIdentity]);

  useEffect(() => {
    authorityReadyRef.current = authorityReady;
    focusRef.current = paneFocused && windowFocused;
  }, [authorityReady, paneFocused, windowFocused]);

  useEffect(() => {
    setReminderQueue((current) => {
      if (current.length === 0) return current;
      return current.flatMap((delivery) => {
        const phase = notesDocument.phases.find((candidate) => candidate.id === delivery.phase.id);
        if (
          !phase ||
          phase.archivedAt !== null ||
          phase.status === "done" ||
          phase.status === "cancelled" ||
          phase.reminder === null ||
          phase.reminder.occurrenceKey !== delivery.reminder.occurrenceKey
        ) {
          return [];
        }
        return [
          {
            ...delivery,
            phase: { id: phase.id, title: phase.title, session: phase.session },
            reminder: {
              id: phase.reminder.id,
              occurrenceKey: phase.reminder.occurrenceKey,
              dueAt: phase.reminder.dueAt,
              note: phase.reminder.note,
            },
          },
        ];
      });
    });
  }, [notesDocument]);

  useEffect(() => {
    if (!activeProjectIdentity) return;
    const host = new RoadmapReminderDeliveryHost(client, (delivery) => {
      setReminderQueue((current) =>
        current.some((item) => item.reminder.occurrenceKey === delivery.reminder.occurrenceKey)
          ? current
          : [...current, delivery],
      );
    });
    deliveryHostRef.current = host;
    const unsubscribe = client.subscribe((event) => {
      if (authorityReadyRef.current && isRoadmapReminderDueEvent(event)) {
        void host.drain(focusRef.current);
      }
    });
    return () => {
      unsubscribe();
      host.dispose();
      if (deliveryHostRef.current === host) deliveryHostRef.current = null;
    };
  }, [activeProjectIdentity, client]);

  useEffect(() => {
    if (!authorityReady) return;
    void deliveryHostRef.current?.drain(paneFocused && windowFocused);
  }, [authorityReady, paneFocused, windowFocused]);

  useImperativeHandle(
    ref,
    () => ({
      listDestinations: () =>
        notesDocument.phases
          .filter((phase) => phase.archivedAt === null)
          .sort((left, right) => left.order - right.order)
          .map((phase) => ({
            phaseId: phase.id,
            title: phase.title,
            sourcePrompt: phase.sourcePrompt,
          })),
      savePrompt,
    }),
    [notesDocument.phases, savePrompt],
  );

  const activeReminder = reminderQueue[0] ?? null;
  const removeActiveReminder = (): void => {
    if (!activeReminder) return;
    setReminderQueue((current) =>
      current.filter(
        (item) => item.reminder.occurrenceKey !== activeReminder.reminder.occurrenceKey,
      ),
    );
    setReminderError(null);
  };
  const runReminderMutation = async (
    mutation: () => Promise<NotesReminderMutationResult>,
    unexpectedFailureMessage: string,
  ): Promise<void> => {
    if (!activeReminder || reminderPending) return;
    setReminderPending(true);
    setReminderError(null);
    try {
      const result = await mutation();
      if (result.status === "committed") {
        removeActiveReminder();
      } else {
        setReminderError(reminderMutationResultMessage(result));
      }
    } catch (error) {
      setReminderError(
        error instanceof Error && error.message ? error.message : unexpectedFailureMessage,
      );
    } finally {
      setReminderPending(false);
    }
  };

  const resumeActiveReminder = async (): Promise<void> => {
    const resumeLink = activeReminder?.phase.session;
    if (!activeReminder || !resumeLink || reminderPending) return;
    const delivery = activeReminder;
    setReminderPending(true);
    setReminderError(null);
    try {
      try {
        await onResumePhase(delivery.phase.id, resumeLink);
      } catch (error) {
        const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
        setReminderError(`Couldn’t resume this phase.${detail}`);
        return;
      }

      try {
        const cleanupResult = await dismissPhaseReminder(
          delivery.phase.id,
          delivery.reminder.occurrenceKey,
        );
        if (cleanupResult.status === "committed") {
          removeActiveReminder();
        } else {
          setReminderError(reminderMutationResultMessage(cleanupResult, "resume-cleanup"));
        }
      } catch (error) {
        const detail =
          error instanceof Error && error.message ? error.message : "Try dismissing it again.";
        setReminderError(`The phase resumed, but reminder cleanup did not complete. ${detail}`);
      }
    } finally {
      setReminderPending(false);
    }
  };

  return (
    <>
      <button
        className="btn btn-sm btn-ghost"
        title={notesStatusLabel(status)}
        aria-label={notesStatusLabel(status)}
        disabled={cwd === null}
        onClick={() => {
          setModalProjectIdentity(activeProjectIdentity);
          setRoadmapTargetPhaseId(null);
          setShowNotes(true);
        }}
      >
        <NotesStatusBadge {...status} />
      </button>
      {activeReminder &&
        createPortal(
          <div className="roadmap-reminder-alert-layer">
            <RoadmapReminderAlert
              delivery={activeReminder}
              pending={reminderPending || phaseActionDisabled}
              error={reminderError}
              onPrimary={() => {
                if (activeReminder.phase.session) {
                  void resumeActiveReminder();
                } else {
                  setModalProjectIdentity(activeProjectIdentity);
                  setRoadmapTargetPhaseId(activeReminder.phase.id);
                  setShowNotes(true);
                  removeActiveReminder();
                }
              }}
              onSnooze={() => {
                void runReminderMutation(
                  () =>
                    snoozePhaseReminder(
                      activeReminder.phase.id,
                      new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
                      activeReminder.reminder.occurrenceKey,
                    ),
                  "Couldn’t snooze this reminder. Try again.",
                );
              }}
              onDismiss={() => {
                void runReminderMutation(
                  () =>
                    dismissPhaseReminder(
                      activeReminder.phase.id,
                      activeReminder.reminder.occurrenceKey,
                    ),
                  "Couldn’t dismiss this reminder. Try again.",
                );
              }}
            />
          </div>,
          document.body,
        )}
      {showNotes &&
        modalProjectIdentity === activeProjectIdentity &&
        createPortal(
          <NotesModal
            value={value}
            onChange={onChange}
            currentFocus={notesDocument.currentFocus}
            tasks={notesDocument.tasks}
            phases={notesDocument.phases}
            references={notesDocument.references}
            handoff={notesDocument.handoff.text}
            handoffUpdatedAt={notesDocument.handoff.updatedAt}
            handoffUnread={status.handoffUnread}
            activePhaseCount={activePhaseCount}
            activeReminderCount={activeReminderCount}
            authorityReady={authorityReady}
            initialRoadmapPhaseId={roadmapTargetPhaseId}
            persistenceStatus={<NotesPersistenceStatus {...notesPersistenceStatus(diagnostics)} />}
            onChangeCurrentFocus={changeCurrentFocus}
            onCreateTask={createTask}
            onEditTask={editTask}
            onToggleTask={toggleTask}
            onMoveTask={moveTask}
            onArchiveTask={archiveTask}
            onRestoreTask={restoreTask}
            onCreatePhase={createPhase}
            onEditPhase={editPhase}
            onMovePhase={movePhase}
            onChangePhaseStatus={changePhaseStatus}
            onArchivePhase={archivePhase}
            onRestorePhase={restorePhase}
            onCreateReference={createReference}
            onEditReference={editReference}
            onDeleteReference={deleteReference}
            onLinkReferenceToPhase={linkReferenceToPhase}
            onUnlinkReferenceFromPhase={unlinkReferenceFromPhase}
            onAcceptReferenceProposal={acceptReferenceProposal}
            onRejectReferenceProposal={rejectReferenceProposal}
            onResumeAutomaticStatus={resumeAutomaticStatus}
            onResumeAutomaticReferences={resumeAutomaticReferences}
            onScheduleReminder={schedulePhaseReminder}
            onSnoozeReminder={snoozePhaseReminder}
            onDismissReminder={dismissPhaseReminder}
            openSource={openSource}
            onStartPhase={onStartPhase}
            onResumePhase={onResumePhase}
            phaseStartUnavailableReason={phaseStartUnavailableReason}
            phaseActionDisabled={phaseActionDisabled}
            onPhaseActionSuccess={() => setShowNotes(false)}
            onChangeHandoff={changeHandoff}
            onHandoffPresented={markHandoffPresented}
            onClose={() => setShowNotes(false)}
          />,
          document.body,
        )}
    </>
  );
});

function notesPersistenceStatus(
  diagnostics: UseProjectNotesResult["diagnostics"],
): NotesPersistenceStatus {
  const authority = diagnostics.authority;
  const fallback = authority.some((item) => item.kind === "fallback-storage");
  const browserWriteFailed =
    diagnostics.save?.v3.ok === false ||
    diagnostics.load?.diagnostics.some((item) => item.kind === "storage-write") === true;
  const browserMirrorFailed = diagnostics.save?.legacy.ok === false;

  if (browserWriteFailed) {
    return {
      tone: "error",
      title: "Local save failed",
      detail:
        "Your latest edits are still visible but may be lost when this app closes. Free space, then edit again to retry.",
    };
  }
  if (authority.some((item) => item.kind === "save-failed")) {
    return {
      tone: "error",
      title: "Changes aren’t saved",
      detail:
        "Your latest edits are still visible. Edit again to retry, and copy important Notes before closing this app.",
    };
  }
  if (browserMirrorFailed) {
    return {
      tone: "warning",
      title: "Local backup is out of date",
      detail: "Notes are saved in this app, but the compatibility copy could not be updated.",
    };
  }
  if (authority.some((item) => item.kind === "sidecar-corrupt")) {
    return {
      tone: "error",
      title: "Project Notes are unreadable",
      detail: fallback
        ? "Editing is using a local fallback. Copy important Notes, then repair or restore project storage before reopening this project."
        : "Copy important Notes before reopening this project or repairing project storage.",
    };
  }
  if (authority.some((item) => item.kind === "migration-refused")) {
    return {
      tone: "warning",
      title: "Local Notes need recovery",
      detail:
        "They could not be safely moved to project storage. Copy important Notes before resetting local app data or retrying.",
    };
  }
  if (authority.some((item) => item.kind === "migration-failed")) {
    return {
      tone: "warning",
      title: "Couldn’t move Notes to project storage",
      detail:
        "Editing is using a local fallback. Keep this app’s data, then reopen the project to retry.",
    };
  }
  if (fallback) {
    return {
      tone: "local",
      title: "Local fallback",
      detail:
        "Editing is available, but Notes are stored only in this app on this device. Reopen the project to retry project storage.",
    };
  }
  return {
    tone: "project",
    title: "Project storage",
    detail: "This project is the authoritative Notes store.",
  };
}

export function NotesPersistenceStatus({
  tone,
  title,
  detail,
}: NotesPersistenceStatus): React.ReactElement {
  const Icon =
    tone === "project"
      ? Database
      : tone === "local"
        ? HardDrive
        : tone === "warning"
          ? AlertTriangle
          : AlertCircle;
  const urgent = tone === "error";

  return (
    <div
      className={`notes-persistence notes-persistence-${tone}`}
      role={urgent ? "alert" : "status"}
      aria-label="Notes storage status"
      aria-live={urgent ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <Icon className="notes-persistence-icon" size={16} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}
