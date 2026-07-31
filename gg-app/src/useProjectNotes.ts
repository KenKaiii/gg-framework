import { canonicalProjectKey } from "@kenkaiiii/gg-core/project-notes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canonicalReferenceIdentity, type NotesReferenceInput } from "./notes-reference";
import { isNotesHandoffUnread } from "./notes-status";
import {
  arraysEqual,
  chronologicalTimestamp,
  createNotesPhaseRecord,
  evaluatePromptSave,
  evaluateReferenceOverrideReset,
  evaluateReferenceProposalDecision,
  evaluateReminderDismiss,
  evaluateReminderSchedule,
  evaluateReminderSnooze,
  evaluateStatusOverrideReset,
  linkReferenceToPhases,
  mutationTimestamp,
  normalizeDoneWhen,
  normalizePhaseOrder,
  referenceFieldsEqual,
  updatePhase,
  updateReferenceLink,
  updateTask,
  type ReferenceMutationApplication,
  type ReminderMutationApplication,
  type RoadmapMutationApplication,
} from "./project-notes-mutations";
import {
  isNotesChangeEvent,
  isNotesReadyEvent,
  type NotesAuthorityDiagnostic,
  type NotesClient,
  type NotesDocumentV3,
  type NotesLoadResult,
  type NotesOperationFailureReason,
  type NotesPhaseStatus,
  type NotesPromptSaveInput,
  type NotesPromptSaveResult,
  type NotesReferenceOperationResult,
  type NotesReminderMutationResult,
  type NotesRoadmapMutationResult,
  type NotesSaveResult,
  type NotesValidationError,
  type ProjectNotesSaveOutcome,
  type ProjectNotesSnapshot,
} from "./notes-types";
import {
  createEmptyNotesDocument,
  createNotesRepository,
  type NotesRepository,
} from "./notes-storage";

export interface UseProjectNotesOptions {
  client?: NotesClient;
  storage?: Storage;
  repository?: NotesRepository;
  clock?: () => string;
  idFactory?: () => string;
}

export interface NotesPhaseInput {
  title: string;
  goal: string;
  doneWhen: string[];
}

export interface UseProjectNotesResult {
  value: string;
  onChange(value: string): void;
  document: NotesDocumentV3;
  authorityReady: boolean;
  changeCurrentFocus(value: string): void;
  createTask(text: string): void;
  editTask(id: string, text: string): void;
  toggleTask(id: string): void;
  moveTask(id: string, direction: "up" | "down"): void;
  archiveTask(id: string): void;
  restoreTask(id: string): void;
  createPhase(input: NotesPhaseInput): void;
  editPhase(id: string, input: NotesPhaseInput): void;
  movePhase(id: string, direction: "up" | "down"): void;
  changePhaseStatus(id: string, status: NotesPhaseStatus): void;
  archivePhase(id: string): void;
  restorePhase(id: string): void;
  savePrompt(input: NotesPromptSaveInput): Promise<NotesPromptSaveResult>;
  createReference(
    input: NotesReferenceInput,
    phaseIds: readonly string[],
  ): Promise<NotesReferenceOperationResult>;
  editReference(id: string, input: NotesReferenceInput): Promise<NotesReferenceOperationResult>;
  deleteReference(id: string): Promise<NotesReferenceOperationResult>;
  linkReferenceToPhase(
    referenceId: string,
    phaseId: string,
  ): Promise<NotesReferenceOperationResult>;
  unlinkReferenceFromPhase(
    referenceId: string,
    phaseId: string,
  ): Promise<NotesReferenceOperationResult>;
  acceptReferenceProposal(phaseId: string, proposalId: string): Promise<NotesRoadmapMutationResult>;
  rejectReferenceProposal(phaseId: string, proposalId: string): Promise<NotesRoadmapMutationResult>;
  resumeAutomaticStatus(phaseId: string): Promise<NotesRoadmapMutationResult>;
  resumeAutomaticReferences(phaseId: string): Promise<NotesRoadmapMutationResult>;
  schedulePhaseReminder(
    phaseId: string,
    input: { dueAt: string; note: string },
  ): Promise<NotesReminderMutationResult>;
  snoozePhaseReminder(
    phaseId: string,
    dueAt: string,
    expectedOccurrenceKey?: string,
  ): Promise<NotesReminderMutationResult>;
  dismissPhaseReminder(
    phaseId: string,
    expectedOccurrenceKey?: string,
  ): Promise<NotesReminderMutationResult>;
  changeHandoff(text: string): void;
  markHandoffPresented(expectedText: string, expectedUpdatedAt: string | null): void;
  diagnostics: {
    load: NotesLoadResult | null;
    save: NotesSaveResult | null;
    authority: NotesAuthorityDiagnostic[];
  };
}

type AuthorityMode = "opening" | "sidecar" | "fallback" | "none";
type CoalesceKey = "reference" | "current-focus" | "handoff";

interface NotesMutationEvaluation {
  document: NotesDocumentV3 | null;
  result?: unknown;
}

interface NotesMutation {
  id: number;
  coalesceKey?: CoalesceKey;
  evaluate(document: NotesDocumentV3): NotesMutationEvaluation;
  cachedEvaluation?: {
    base: NotesDocumentV3;
    value: NotesMutationEvaluation;
  };
  settle?(result: unknown): void;
  failure?(reason: NotesOperationFailureReason, error?: NotesValidationError): unknown;
}

const systemClock = (): string => new Date().toISOString();

export function useProjectNotes(
  cwd: string | null,
  options: UseProjectNotesOptions = {},
): UseProjectNotesResult {
  const client = options.client;
  const clock = options.clock ?? systemClock;
  const idFactory = useMemo(
    () => options.idFactory ?? (() => crypto.randomUUID()),
    [options.idFactory],
  );
  const storage = useMemo(() => options.storage ?? browserStorage(), [options.storage]);
  const repository = useMemo(
    () => options.repository ?? createNotesRepository(storage, clock),
    [options.repository, storage, clock],
  );
  const [document, setDocument] = useState<NotesDocumentV3>(() =>
    createEmptyNotesDocument(clock()),
  );
  const [loadDiagnostics, setLoadDiagnostics] = useState<NotesLoadResult | null>(null);
  const [saveDiagnostics, setSaveDiagnostics] = useState<NotesSaveResult | null>(null);
  const [authorityDiagnostics, setAuthorityDiagnostics] = useState<NotesAuthorityDiagnostic[]>([]);
  const [authorityReady, setAuthorityReady] = useState(false);

  const documentRef = useRef(document);
  const activeCwdRef = useRef(cwd);
  const epochRef = useRef(0);
  const modeRef = useRef<AuthorityMode>(cwd === null ? "none" : "opening");
  const authoritativeRef = useRef<ProjectNotesSnapshot | null>(null);
  const queueRef = useRef<NotesMutation[]>([]);
  const inFlightMutationIdRef = useRef<number | null>(null);
  const nextMutationIdRef = useRef(0);
  const processQueueRef = useRef<() => void>(() => undefined);

  const showDocument = useCallback((next: NotesDocumentV3) => {
    documentRef.current = next;
    setDocument(next);
  }, []);

  const addAuthorityDiagnostic = useCallback((diagnostic: NotesAuthorityDiagnostic) => {
    setAuthorityDiagnostics((current) => [...current, diagnostic]);
  }, []);

  const renderSidecarState = useCallback(() => {
    const authoritative = authoritativeRef.current;
    if (!authoritative) return;
    showDocument(replayMutations(authoritative.document, queueRef.current));
  }, [showDocument]);

  const adoptSnapshot = useCallback(
    (
      snapshot: ProjectNotesSnapshot,
      expectedProjectKey: string,
      epoch: number,
      authoritativeResponse = false,
    ): boolean => {
      if (
        epoch !== epochRef.current ||
        activeCwdRef.current === null ||
        snapshot.projectKey !== expectedProjectKey
      ) {
        return false;
      }
      const current = authoritativeRef.current;
      if (!authoritativeResponse && current && snapshot.revision <= current.revision) return false;
      authoritativeRef.current = snapshot;
      modeRef.current = "sidecar";
      setAuthorityReady(true);
      setLoadDiagnostics(null);
      setSaveDiagnostics(null);
      renderSidecarState();
      return true;
    },
    [renderSidecarState],
  );

  const enterFallback = useCallback(
    (
      projectCwd: string,
      loaded: NotesLoadResult,
      diagnostic: NotesAuthorityDiagnostic | null,
      epoch: number,
    ) => {
      if (epoch !== epochRef.current || activeCwdRef.current !== projectCwd) return;
      modeRef.current = "fallback";
      authoritativeRef.current = null;
      setAuthorityReady(false);
      const pending = queueRef.current;
      const appliedOperationResults: Array<{
        mutation: NotesMutation;
        result: unknown;
      }> = [];
      let fallbackDocument = loaded.document;
      let changed = false;
      for (const mutation of pending) {
        const evaluation = evaluateMutation(mutation, fallbackDocument);
        if (evaluation.document === null) {
          if (evaluation.result !== undefined) mutation.settle?.(evaluation.result);
          continue;
        }
        fallbackDocument = evaluation.document;
        changed = true;
        if (evaluation.result !== undefined) {
          appliedOperationResults.push({ mutation, result: evaluation.result });
        }
      }
      queueRef.current = [];
      inFlightMutationIdRef.current = null;
      showDocument(fallbackDocument);
      setLoadDiagnostics(loaded);
      const save = changed ? repository.save(projectCwd, fallbackDocument) : null;
      for (const applied of appliedOperationResults) {
        applied.mutation.settle?.(
          save?.v3.ok === true
            ? applied.result
            : (applied.mutation.failure?.("storage") ?? {
                status: "failed",
                reason: "storage",
              }),
        );
      }
      setSaveDiagnostics(save);
      if (diagnostic) addAuthorityDiagnostic(diagnostic);
      addAuthorityDiagnostic({ kind: "fallback-storage", load: loaded, save });
    },
    [addAuthorityDiagnostic, repository, showDocument],
  );

  useEffect(() => {
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    activeCwdRef.current = cwd;
    settlePendingMutations(queueRef.current, "unavailable");
    queueRef.current = [];
    inFlightMutationIdRef.current = null;
    authoritativeRef.current = null;
    setAuthorityReady(false);
    setAuthorityDiagnostics([]);
    setLoadDiagnostics(null);
    setSaveDiagnostics(null);

    if (cwd === null) {
      modeRef.current = "none";
      showDocument(createEmptyNotesDocument(clock()));
      return;
    }

    const projectCwd = cwd;
    const projectKey = canonicalProjectKey(projectCwd);
    modeRef.current = client ? "opening" : "fallback";
    showDocument(createEmptyNotesDocument(clock()));

    if (!client) {
      const loaded = repository.load(projectCwd);
      enterFallback(projectCwd, loaded, null, epoch);
      return;
    }

    let readGeneration = 0;
    const readAuthoritativeNotes = async (): Promise<void> => {
      const requestGeneration = ++readGeneration;
      try {
        const opened = await client.getNotes();
        if (
          epoch !== epochRef.current ||
          activeCwdRef.current !== projectCwd ||
          modeRef.current === "fallback" ||
          requestGeneration !== readGeneration
        ) {
          return;
        }

        if (opened.status === "ok") {
          if (opened.snapshot.projectKey !== projectKey) {
            const diagnostic: NotesAuthorityDiagnostic = {
              kind: "sidecar-open",
              error: new Error("sidecar returned Notes for a different project"),
            };
            if (authoritativeRef.current && modeRef.current === "sidecar") {
              addAuthorityDiagnostic(diagnostic);
            } else {
              enterFallback(projectCwd, repository.load(projectCwd), diagnostic, epoch);
            }
            return;
          }

          if (
            opened.recoveredFromBackup ||
            !authoritativeRef.current ||
            opened.snapshot.revision > authoritativeRef.current.revision
          ) {
            adoptSnapshot(opened.snapshot, projectKey, epoch, opened.recoveredFromBackup);
          }
          processQueueRef.current();
          return;
        }

        if (authoritativeRef.current && modeRef.current === "sidecar") {
          addAuthorityDiagnostic(
            opened.status === "corrupt"
              ? { kind: "sidecar-corrupt", corruption: opened }
              : {
                  kind: "sidecar-open",
                  error: new Error("authoritative Notes snapshot is missing"),
                },
          );
          processQueueRef.current();
          return;
        }

        const loaded = repository.load(projectCwd);
        if (opened.status === "corrupt") {
          enterFallback(projectCwd, loaded, { kind: "sidecar-corrupt", corruption: opened }, epoch);
          return;
        }
        if (
          loaded.migrationEligibility === "ineligible-unreadable" ||
          loaded.migrationEligibility === "ineligible-invalid-document"
        ) {
          enterFallback(projectCwd, loaded, { kind: "migration-refused", load: loaded }, epoch);
          return;
        }

        try {
          const migrated = await client.migrateNotes(loaded.document);
          if (
            epoch !== epochRef.current ||
            activeCwdRef.current !== projectCwd ||
            requestGeneration !== readGeneration
          ) {
            return;
          }
          if (migrated.status === "ok") {
            if (
              migrated.snapshot.projectKey === projectKey &&
              (!authoritativeRef.current ||
                migrated.snapshot.revision > authoritativeRef.current.revision)
            ) {
              adoptSnapshot(migrated.snapshot, projectKey, epoch);
            }
            processQueueRef.current();
            return;
          }
          if (migrated.status === "corrupt") {
            enterFallback(
              projectCwd,
              loaded,
              { kind: "sidecar-corrupt", corruption: migrated },
              epoch,
            );
            return;
          }
          if (migrated.status === "invalid") {
            enterFallback(
              projectCwd,
              loaded,
              { kind: "migration-failed", error: migrated.error },
              epoch,
            );
          }
        } catch (error) {
          if (authoritativeRef.current && modeRef.current === "sidecar") {
            addAuthorityDiagnostic({ kind: "migration-failed", error });
            processQueueRef.current();
          } else {
            enterFallback(projectCwd, loaded, { kind: "migration-failed", error }, epoch);
          }
        }
      } catch (error) {
        if (
          epoch !== epochRef.current ||
          activeCwdRef.current !== projectCwd ||
          modeRef.current === "fallback" ||
          requestGeneration !== readGeneration
        ) {
          return;
        }
        if (authoritativeRef.current && modeRef.current === "sidecar") {
          addAuthorityDiagnostic({ kind: "sidecar-open", error });
          processQueueRef.current();
        } else {
          enterFallback(
            projectCwd,
            repository.load(projectCwd),
            { kind: "sidecar-open", error },
            epoch,
          );
        }
      }
    };

    const unsubscribe = client.subscribe((event) => {
      if (epoch !== epochRef.current || modeRef.current === "fallback") return;
      if (isNotesReadyEvent(event)) {
        void readAuthoritativeNotes();
        return;
      }
      if (!isNotesChangeEvent(event)) return;
      if (adoptSnapshot(event.data, projectKey, epoch)) processQueueRef.current();
    });

    void readAuthoritativeNotes();

    return () => {
      unsubscribe();
      if (epochRef.current === epoch) {
        epochRef.current += 1;
        settlePendingMutations(queueRef.current, "unavailable");
      }
    };
  }, [
    addAuthorityDiagnostic,
    adoptSnapshot,
    client,
    clock,
    cwd,
    enterFallback,
    repository,
    showDocument,
  ]);

  const processQueue = useCallback(() => {
    const projectCwd = activeCwdRef.current;
    const authoritative = authoritativeRef.current;
    const mutation = queueRef.current[0];
    if (
      !client ||
      projectCwd === null ||
      modeRef.current !== "sidecar" ||
      inFlightMutationIdRef.current !== null ||
      !authoritative ||
      !mutation
    ) {
      return;
    }

    const epoch = epochRef.current;
    const evaluation = evaluateMutation(mutation, authoritative.document);
    if (evaluation.document === null) {
      queueRef.current.shift();
      if (evaluation.result !== undefined) mutation.settle?.(evaluation.result);
      renderSidecarState();
      queueMicrotask(() => processQueueRef.current());
      return;
    }

    inFlightMutationIdRef.current = mutation.id;
    void client
      .saveNotes(authoritative.revision, evaluation.document)
      .then((outcome) => {
        if (
          epoch !== epochRef.current ||
          activeCwdRef.current !== projectCwd ||
          modeRef.current !== "sidecar" ||
          inFlightMutationIdRef.current !== mutation.id
        ) {
          return;
        }
        inFlightMutationIdRef.current = null;
        if (outcome.status === "ok") {
          queueRef.current = queueRef.current.filter((queued) => queued.id !== mutation.id);
          if (
            !authoritativeRef.current ||
            outcome.snapshot.revision > authoritativeRef.current.revision
          ) {
            authoritativeRef.current = outcome.snapshot;
          }
          setSaveDiagnostics(null);
          setAuthorityDiagnostics((current) =>
            current.filter((diagnostic) => diagnostic.kind !== "save-failed"),
          );
          if (evaluation.result !== undefined) mutation.settle?.(evaluation.result);
          renderSidecarState();
          queueMicrotask(() => processQueueRef.current());
          return;
        }
        if (outcome.status === "conflict") {
          mutation.cachedEvaluation = undefined;
          adoptSnapshot(outcome.snapshot, canonicalProjectKey(projectCwd), epoch, true);
          queueMicrotask(() => processQueueRef.current());
          return;
        }
        if (mutation.settle) {
          queueRef.current = queueRef.current.filter((queued) => queued.id !== mutation.id);
          const reason = saveOutcomeFailureReason(outcome);
          const validationError = outcome.status === "invalid" ? outcome.error : undefined;
          mutation.settle(
            mutation.failure?.(reason, validationError) ?? referenceSaveFailure(outcome),
          );
        }
        if (outcome.status === "invalid") {
          addAuthorityDiagnostic({ kind: "save-failed", error: outcome.error });
        } else {
          addAuthorityDiagnostic({
            kind: "save-failed",
            error: new Error(`sidecar Notes save failed: ${outcome.status}`),
          });
        }
        if (mutation.settle) {
          renderSidecarState();
          queueMicrotask(() => processQueueRef.current());
        }
      })
      .catch((error) => {
        if (
          epoch !== epochRef.current ||
          activeCwdRef.current !== projectCwd ||
          inFlightMutationIdRef.current !== mutation.id
        ) {
          return;
        }
        inFlightMutationIdRef.current = null;
        if (mutation.settle) {
          queueRef.current = queueRef.current.filter((queued) => queued.id !== mutation.id);
          mutation.settle(
            mutation.failure?.("unavailable") ?? { status: "failed", reason: "unavailable" },
          );
        }
        addAuthorityDiagnostic({ kind: "save-failed", error });
        if (mutation.settle) {
          renderSidecarState();
          queueMicrotask(() => processQueueRef.current());
        }
      });
  }, [addAuthorityDiagnostic, adoptSnapshot, client, renderSidecarState]);
  useEffect(() => {
    processQueueRef.current = processQueue;
  }, [processQueue]);

  const enqueueMutation = useCallback(
    (mutation: Omit<NotesMutation, "id" | "cachedEvaluation">) => {
      const projectCwd = activeCwdRef.current;
      if (projectCwd === null || modeRef.current === "none") {
        mutation.settle?.(
          mutation.failure?.("unavailable") ?? { status: "failed", reason: "unavailable" },
        );
        return;
      }
      const queued: NotesMutation = { ...mutation, id: ++nextMutationIdRef.current };

      if (modeRef.current === "fallback") {
        const evaluation = evaluateMutation(queued, documentRef.current);
        if (evaluation.document === null) {
          if (evaluation.result !== undefined) queued.settle?.(evaluation.result);
          return;
        }
        showDocument(evaluation.document);
        const save = repository.save(projectCwd, evaluation.document);
        setSaveDiagnostics(save);
        if (evaluation.result !== undefined) {
          queued.settle?.(
            save.v3.ok
              ? evaluation.result
              : (queued.failure?.("storage") ?? { status: "failed", reason: "storage" }),
          );
        }
        return;
      }

      const queue = queueRef.current;
      const tail = queue[queue.length - 1];
      if (
        queued.coalesceKey &&
        tail?.coalesceKey === queued.coalesceKey &&
        tail.id !== inFlightMutationIdRef.current
      ) {
        queue[queue.length - 1] = queued;
      } else {
        queue.push(queued);
      }

      if (authoritativeRef.current) renderSidecarState();
      else {
        const evaluation = evaluateMutation(queued, documentRef.current);
        if (evaluation.document !== null) showDocument(evaluation.document);
      }
      processQueueRef.current();
    },
    [renderSidecarState, repository, showDocument],
  );

  const enqueueReferenceMutation = useCallback(
    (
      evaluate: (document: NotesDocumentV3) => ReferenceMutationApplication,
    ): Promise<NotesReferenceOperationResult> =>
      new Promise((resolve) => {
        enqueueMutation({
          evaluate,
          settle: (result) => resolve(result as NotesReferenceOperationResult),
          failure: (reason) => ({ status: "failed", reason }),
        });
      }),
    [enqueueMutation],
  );

  const enqueueRoadmapMutation = useCallback(
    (
      evaluate: (document: NotesDocumentV3) => RoadmapMutationApplication,
    ): Promise<NotesRoadmapMutationResult> =>
      new Promise((resolve) => {
        enqueueMutation({
          evaluate,
          settle: (result) => resolve(result as NotesRoadmapMutationResult),
          failure: (reason) => ({ status: "failed", reason }),
        });
      }),
    [enqueueMutation],
  );

  const enqueueReminderMutation = useCallback(
    (
      evaluate: (document: NotesDocumentV3) => ReminderMutationApplication,
    ): Promise<NotesReminderMutationResult> =>
      new Promise((resolve) => {
        enqueueMutation({
          evaluate,
          settle: (result) => resolve(result as NotesReminderMutationResult),
          failure: (reason, error) => ({
            status: "failed",
            reason:
              reason === "invalid"
                ? "validation"
                : reason === "storage"
                  ? "storage"
                  : "unavailable",
            ...(error ? { error } : {}),
          }),
        });
      }),
    [enqueueMutation],
  );

  const onChange = useCallback(
    (value: string) => {
      const now = clock();
      enqueueMutation({
        coalesceKey: "reference",
        evaluate: documentMutation((current) =>
          current.reference === value ? null : { ...current, reference: value, updatedAt: now },
        ),
      });
    },
    [clock, enqueueMutation],
  );

  const changeCurrentFocus = useCallback(
    (value: string) => {
      const now = clock();
      enqueueMutation({
        coalesceKey: "current-focus",
        evaluate: documentMutation((current) =>
          current.currentFocus === value
            ? null
            : { ...current, currentFocus: value, updatedAt: now },
        ),
      });
    },
    [clock, enqueueMutation],
  );

  const createTask = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const now = clock();
      const id = idFactory();
      enqueueMutation({
        evaluate: documentMutation((current) =>
          current.tasks.some((task) => task.id === id)
            ? null
            : {
                ...current,
                tasks: [
                  ...current.tasks,
                  {
                    id,
                    text: trimmed,
                    status: "todo",
                    createdAt: now,
                    updatedAt: now,
                    completedAt: null,
                    archivedAt: null,
                  },
                ],
                updatedAt: now,
              },
        ),
      });
    },
    [clock, enqueueMutation, idFactory],
  );

  const editTask = useCallback(
    (id: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const now = clock();
      enqueueMutation({
        evaluate: documentMutation((current) => {
          const index = current.tasks.findIndex((task) => task.id === id);
          const task = current.tasks[index];
          if (!task || task.archivedAt !== null || task.text === trimmed) return null;
          const tasks = [...current.tasks];
          tasks[index] = { ...task, text: trimmed, updatedAt: now };
          return { ...current, tasks, updatedAt: now };
        }),
      });
    },
    [clock, enqueueMutation],
  );

  const toggleTask = useCallback(
    (id: string) => {
      const selectedTask = documentRef.current.tasks.find((task) => task.id === id);
      if (!selectedTask || selectedTask.archivedAt !== null) return;
      const now = clock();
      const targetStatus = selectedTask.status === "todo" ? "done" : "todo";
      enqueueMutation({
        evaluate: documentMutation((current) => {
          const index = current.tasks.findIndex((task) => task.id === id);
          const task = current.tasks[index];
          if (!task || task.archivedAt !== null || task.status === targetStatus) return null;
          const tasks = [...current.tasks];
          tasks[index] = {
            ...task,
            status: targetStatus,
            completedAt: targetStatus === "done" ? now : null,
            updatedAt: now,
          };
          return { ...current, tasks, updatedAt: now };
        }),
      });
    },
    [clock, enqueueMutation],
  );

  const moveTask = useCallback(
    (id: string, direction: "up" | "down") => {
      const activeTasks = documentRef.current.tasks.filter((task) => task.archivedAt === null);
      const activePosition = activeTasks.findIndex((task) => task.id === id);
      const targetPosition = activePosition + (direction === "up" ? -1 : 1);
      const targetId = activeTasks[targetPosition]?.id;
      if (activePosition === -1 || !targetId) return;
      const now = clock();
      const placeBeforeTarget = direction === "up";
      enqueueMutation({
        evaluate: documentMutation((current) => {
          const activeIds = current.tasks
            .filter((task) => task.archivedAt === null)
            .map((task) => task.id);
          const sourcePosition = activeIds.indexOf(id);
          const anchorPosition = activeIds.indexOf(targetId);
          if (sourcePosition === -1 || anchorPosition === -1) return null;
          if (
            (placeBeforeTarget && sourcePosition < anchorPosition) ||
            (!placeBeforeTarget && sourcePosition > anchorPosition)
          ) {
            return null;
          }

          const tasks = [...current.tasks];
          const sourceIndex = tasks.findIndex((task) => task.id === id);
          const [movedTask] = tasks.splice(sourceIndex, 1);
          if (!movedTask) return null;
          const targetIndex = tasks.findIndex((task) => task.id === targetId);
          tasks.splice(placeBeforeTarget ? targetIndex : targetIndex + 1, 0, movedTask);
          return { ...current, tasks, updatedAt: now };
        }),
      });
    },
    [clock, enqueueMutation],
  );

  const archiveTask = useCallback(
    (id: string) => {
      const now = clock();
      enqueueMutation({
        evaluate: documentMutation((current) =>
          updateTask(current, id, now, (task) =>
            task.archivedAt === null ? { ...task, archivedAt: now, updatedAt: now } : null,
          ),
        ),
      });
    },
    [clock, enqueueMutation],
  );

  const restoreTask = useCallback(
    (id: string) => {
      const now = clock();
      enqueueMutation({
        evaluate: documentMutation((current) =>
          updateTask(current, id, now, (task) =>
            task.archivedAt !== null ? { ...task, archivedAt: null, updatedAt: now } : null,
          ),
        ),
      });
    },
    [clock, enqueueMutation],
  );

  const createPhase = useCallback(
    (input: NotesPhaseInput) => {
      const title = input.title.trim();
      if (!title) return;
      const goal = input.goal.trim();
      const doneWhen = normalizeDoneWhen(input.doneWhen);
      const now = clock();
      const id = idFactory();
      enqueueMutation({
        evaluate: documentMutation((current) => {
          if (current.phases.some((phase) => phase.id === id)) return null;
          const phase = createNotesPhaseRecord({
            id,
            title,
            goal,
            doneWhen,
            order: current.phases.length,
            sourcePrompt: "",
            requestedAt: now,
            currentUpdatedAt: current.updatedAt,
          });
          return {
            ...current,
            phases: [...current.phases, phase],
            updatedAt: phase.updatedAt,
          };
        }),
      });
    },
    [clock, enqueueMutation, idFactory],
  );

  const editPhase = useCallback(
    (id: string, input: NotesPhaseInput) => {
      const title = input.title.trim();
      if (!title) return;
      const goal = input.goal.trim();
      const doneWhen = normalizeDoneWhen(input.doneWhen);
      const now = clock();
      enqueueMutation({
        evaluate: documentMutation((current) =>
          updatePhase(current, id, now, (phase) => {
            if (phase.archivedAt !== null) return null;
            if (
              phase.title === title &&
              phase.goal === goal &&
              arraysEqual(phase.doneWhen, doneWhen)
            ) {
              return null;
            }
            return { ...phase, title, goal, doneWhen, updatedAt: now };
          }),
        ),
      });
    },
    [clock, enqueueMutation],
  );

  const movePhase = useCallback(
    (id: string, direction: "up" | "down") => {
      const visiblePhases = documentRef.current.phases.filter((phase) => phase.archivedAt === null);
      const visiblePosition = visiblePhases.findIndex((phase) => phase.id === id);
      const targetId = visiblePhases[visiblePosition + (direction === "up" ? -1 : 1)]?.id;
      if (visiblePosition === -1 || !targetId) return;
      const now = clock();
      const placeBeforeTarget = direction === "up";
      enqueueMutation({
        evaluate: documentMutation((current) => {
          const visiblePhases = current.phases.filter((phase) => phase.archivedAt === null);
          const sourcePosition = visiblePhases.findIndex((phase) => phase.id === id);
          const anchorPosition = visiblePhases.findIndex((phase) => phase.id === targetId);
          if (sourcePosition === -1 || anchorPosition === -1) return null;
          if (
            (placeBeforeTarget && sourcePosition < anchorPosition) ||
            (!placeBeforeTarget && sourcePosition > anchorPosition)
          ) {
            return null;
          }

          const reorderedVisiblePhases = [...visiblePhases];
          const [movedPhase] = reorderedVisiblePhases.splice(sourcePosition, 1);
          if (!movedPhase) return null;
          const targetPosition = reorderedVisiblePhases.findIndex((phase) => phase.id === targetId);
          if (targetPosition === -1) return null;
          reorderedVisiblePhases.splice(
            placeBeforeTarget ? targetPosition : targetPosition + 1,
            0,
            movedPhase,
          );

          let visibleIndex = 0;
          const phases = current.phases.map((phase) =>
            phase.archivedAt === null ? reorderedVisiblePhases[visibleIndex++]! : phase,
          );
          return { ...current, phases: normalizePhaseOrder(phases), updatedAt: now };
        }),
      });
    },
    [clock, enqueueMutation],
  );

  const changePhaseStatus = useCallback(
    (id: string, status: NotesPhaseStatus) => {
      const now = clock();
      const eventId = idFactory();
      enqueueMutation({
        evaluate: documentMutation((current) =>
          updatePhase(current, id, now, (phase) => {
            if (phase.archivedAt !== null || phase.status === status) return null;
            const timestamp = chronologicalTimestamp(now, phase);
            return {
              ...phase,
              status,
              attentionReason: status === "needs-attention" ? phase.attentionReason : null,
              updatedAt: timestamp,
              completedAt: status === "done" || status === "cancelled" ? timestamp : null,
              overrides: {
                ...phase.overrides,
                status: { value: status, source: "user", updatedAt: timestamp },
              },
              lifecycleEvents: [
                ...phase.lifecycleEvents,
                {
                  id: eventId,
                  fromStatus: phase.status,
                  toStatus: status,
                  source: "user",
                  timestamp,
                  reason:
                    status === "cancelled" ? "Phase cancelled by user" : "Status changed by user",
                  kind: "other",
                },
              ],
            };
          }),
        ),
      });
    },
    [clock, enqueueMutation, idFactory],
  );

  const archivePhase = useCallback(
    (id: string) => {
      const now = clock();
      enqueueMutation({
        evaluate: documentMutation((current) =>
          updatePhase(current, id, now, (phase) =>
            phase.archivedAt === null ? { ...phase, archivedAt: now, updatedAt: now } : null,
          ),
        ),
      });
    },
    [clock, enqueueMutation],
  );

  const restorePhase = useCallback(
    (id: string) => {
      const now = clock();
      enqueueMutation({
        evaluate: documentMutation((current) =>
          updatePhase(current, id, now, (phase) =>
            phase.archivedAt !== null ? { ...phase, archivedAt: null, updatedAt: now } : null,
          ),
        ),
      });
    },
    [clock, enqueueMutation],
  );

  const savePrompt = useCallback(
    (input: NotesPromptSaveInput): Promise<NotesPromptSaveResult> => {
      const prompt = input.prompt;
      const title = input.kind === "new-draft" ? input.title.trim() : "";
      if (!prompt.trim() || (input.kind === "new-draft" && !title)) {
        return Promise.resolve({ status: "failed", reason: "invalid" });
      }
      const phaseId = input.kind === "new-draft" ? idFactory() : input.phaseId;
      const requestedAt = clock();
      return new Promise((resolve) => {
        enqueueMutation({
          evaluate: (current) =>
            evaluatePromptSave(current, input, phaseId, title, prompt, requestedAt),
          settle: (result) => resolve(result as NotesPromptSaveResult),
          failure: (reason, error) => ({
            status: "failed",
            reason,
            ...(error ? { error } : {}),
          }),
        });
      });
    },
    [clock, enqueueMutation, idFactory],
  );

  const createReference = useCallback(
    (
      input: NotesReferenceInput,
      phaseIds: readonly string[],
    ): Promise<NotesReferenceOperationResult> => {
      const id = idFactory();
      const capturedAt = clock();
      const requestedPhaseIds = [...new Set(phaseIds)];
      const proposedIdentity = canonicalReferenceIdentity(input);
      if (!proposedIdentity) {
        return Promise.resolve({ status: "failed", reason: "invalid" });
      }
      return enqueueReferenceMutation((current) => {
        const missingPhaseId = requestedPhaseIds.find(
          (phaseId) => !current.phases.some((phase) => phase.id === phaseId),
        );
        if (missingPhaseId) {
          return {
            document: null,
            result: { status: "missing-phase", phaseId: missingPhaseId },
          };
        }
        const idCollision = current.references.find((reference) => reference.id === id);
        if (idCollision) {
          return {
            document: null,
            result: { status: "collision", referenceId: idCollision.id },
          };
        }
        const winner = current.references.find(
          (reference) => canonicalReferenceIdentity(reference) === proposedIdentity,
        );
        const referenceId = winner?.id ?? id;
        const references = winner
          ? current.references
          : [...current.references, { ...input, id, capturedAt }];
        const timestamp = mutationTimestamp(capturedAt, current.updatedAt);
        const phases = linkReferenceToPhases(
          current.phases,
          referenceId,
          requestedPhaseIds,
          timestamp,
        );
        return {
          document:
            winner && phases === current.phases
              ? null
              : { ...current, references, phases, updatedAt: timestamp },
          result: winner
            ? { status: "reused", referenceId: winner.id }
            : { status: "committed", referenceId: id },
        };
      });
    },
    [clock, enqueueReferenceMutation, idFactory],
  );

  const editReference = useCallback(
    (id: string, input: NotesReferenceInput): Promise<NotesReferenceOperationResult> => {
      const now = clock();
      const proposedIdentity = canonicalReferenceIdentity(input);
      if (!proposedIdentity) {
        return Promise.resolve({ status: "failed", reason: "invalid" });
      }
      return enqueueReferenceMutation((current) => {
        const index = current.references.findIndex((reference) => reference.id === id);
        const reference = current.references[index];
        if (!reference) return { document: null, result: { status: "missing-reference" } };
        const collision = current.references.find(
          (candidate) =>
            candidate.id !== id && canonicalReferenceIdentity(candidate) === proposedIdentity,
        );
        if (collision) {
          return {
            document: null,
            result: { status: "collision", referenceId: collision.id },
          };
        }
        const nextReference = { ...input, id: reference.id, capturedAt: reference.capturedAt };
        if (referenceFieldsEqual(reference, nextReference)) {
          return {
            document: null,
            result: { status: "committed", referenceId: id },
          };
        }
        const references = [...current.references];
        references[index] = nextReference;
        return {
          document: {
            ...current,
            references,
            updatedAt: mutationTimestamp(now, current.updatedAt),
          },
          result: { status: "committed", referenceId: id },
        };
      });
    },
    [clock, enqueueReferenceMutation],
  );

  const deleteReference = useCallback(
    (id: string): Promise<NotesReferenceOperationResult> => {
      const now = clock();
      return enqueueReferenceMutation((current) => {
        if (!current.references.some((reference) => reference.id === id)) {
          return { document: null, result: { status: "missing-reference" } };
        }
        const phaseIds = current.phases
          .filter(
            (phase) =>
              phase.referenceIds.includes(id) || phase.overrides.referenceIds?.value.includes(id),
          )
          .map((phase) => phase.id);
        if (phaseIds.length > 0) {
          return { document: null, result: { status: "linked-blocked", phaseIds } };
        }
        return {
          document: {
            ...current,
            references: current.references.filter((reference) => reference.id !== id),
            updatedAt: mutationTimestamp(now, current.updatedAt),
          },
          result: { status: "committed", referenceId: id },
        };
      });
    },
    [clock, enqueueReferenceMutation],
  );

  const linkReferenceToPhase = useCallback(
    (referenceId: string, phaseId: string): Promise<NotesReferenceOperationResult> => {
      const now = clock();
      return enqueueReferenceMutation((current) => {
        if (!current.references.some((reference) => reference.id === referenceId)) {
          return { document: null, result: { status: "missing-reference" } };
        }
        if (!current.phases.some((phase) => phase.id === phaseId)) {
          return { document: null, result: { status: "missing-phase", phaseId } };
        }
        const timestamp = mutationTimestamp(now, current.updatedAt);
        const phases = updateReferenceLink(current.phases, referenceId, phaseId, true, timestamp);
        return {
          document: phases === current.phases ? null : { ...current, phases, updatedAt: timestamp },
          result: { status: "committed", referenceId },
        };
      });
    },
    [clock, enqueueReferenceMutation],
  );

  const unlinkReferenceFromPhase = useCallback(
    (referenceId: string, phaseId: string): Promise<NotesReferenceOperationResult> => {
      const now = clock();
      return enqueueReferenceMutation((current) => {
        if (!current.references.some((reference) => reference.id === referenceId)) {
          return { document: null, result: { status: "missing-reference" } };
        }
        if (!current.phases.some((phase) => phase.id === phaseId)) {
          return { document: null, result: { status: "missing-phase", phaseId } };
        }
        const timestamp = mutationTimestamp(now, current.updatedAt);
        const phases = updateReferenceLink(current.phases, referenceId, phaseId, false, timestamp);
        return {
          document: phases === current.phases ? null : { ...current, phases, updatedAt: timestamp },
          result: { status: "committed", referenceId },
        };
      });
    },
    [clock, enqueueReferenceMutation],
  );

  const acceptReferenceProposal = useCallback(
    (phaseId: string, proposalId: string): Promise<NotesRoadmapMutationResult> => {
      const requestedAt = clock();
      const decisionId = idFactory();
      const referenceId = idFactory();
      return enqueueRoadmapMutation((current) =>
        evaluateReferenceProposalDecision(
          current,
          phaseId,
          proposalId,
          "accepted",
          requestedAt,
          decisionId,
          referenceId,
        ),
      );
    },
    [clock, enqueueRoadmapMutation, idFactory],
  );

  const rejectReferenceProposal = useCallback(
    (phaseId: string, proposalId: string): Promise<NotesRoadmapMutationResult> => {
      const requestedAt = clock();
      const decisionId = idFactory();
      const unusedReferenceId = idFactory();
      return enqueueRoadmapMutation((current) =>
        evaluateReferenceProposalDecision(
          current,
          phaseId,
          proposalId,
          "rejected",
          requestedAt,
          decisionId,
          unusedReferenceId,
        ),
      );
    },
    [clock, enqueueRoadmapMutation, idFactory],
  );

  const resumeAutomaticStatus = useCallback(
    (phaseId: string): Promise<NotesRoadmapMutationResult> => {
      const requestedAt = clock();
      const resetId = idFactory();
      const lifecycleId = idFactory();
      return enqueueRoadmapMutation((current) =>
        evaluateStatusOverrideReset(current, phaseId, requestedAt, resetId, lifecycleId),
      );
    },
    [clock, enqueueRoadmapMutation, idFactory],
  );

  const resumeAutomaticReferences = useCallback(
    (phaseId: string): Promise<NotesRoadmapMutationResult> => {
      const requestedAt = clock();
      const resetId = idFactory();
      return enqueueRoadmapMutation((current) =>
        evaluateReferenceOverrideReset(current, phaseId, requestedAt, resetId),
      );
    },
    [clock, enqueueRoadmapMutation, idFactory],
  );

  const schedulePhaseReminder = useCallback(
    (
      phaseId: string,
      input: { dueAt: string; note: string },
    ): Promise<NotesReminderMutationResult> => {
      const occurrenceKey = idFactory();
      const newReminderId = idFactory();
      return enqueueReminderMutation((current) =>
        evaluateReminderSchedule(current, phaseId, input, clock(), occurrenceKey, newReminderId),
      );
    },
    [clock, enqueueReminderMutation, idFactory],
  );

  const snoozePhaseReminder = useCallback(
    (
      phaseId: string,
      dueAt: string,
      expectedOccurrenceKey?: string,
    ): Promise<NotesReminderMutationResult> => {
      const occurrenceKey = idFactory();
      return enqueueReminderMutation((current) =>
        evaluateReminderSnooze(
          current,
          phaseId,
          dueAt,
          clock(),
          occurrenceKey,
          expectedOccurrenceKey,
        ),
      );
    },
    [clock, enqueueReminderMutation, idFactory],
  );

  const dismissPhaseReminder = useCallback(
    (phaseId: string, expectedOccurrenceKey?: string): Promise<NotesReminderMutationResult> =>
      enqueueReminderMutation((current) =>
        evaluateReminderDismiss(current, phaseId, clock(), expectedOccurrenceKey),
      ),
    [clock, enqueueReminderMutation],
  );

  const changeHandoff = useCallback(
    (text: string) => {
      const now = clock();
      enqueueMutation({
        coalesceKey: "handoff",
        evaluate: documentMutation((current) =>
          current.handoff.text === text
            ? null
            : {
                ...current,
                handoff: { text, updatedAt: now, readAt: null },
                updatedAt: now,
              },
        ),
      });
    },
    [clock, enqueueMutation],
  );

  const markHandoffPresented = useCallback(
    (expectedText: string, expectedUpdatedAt: string | null) => {
      if (expectedUpdatedAt === null) return;
      const now = clock();
      enqueueMutation({
        evaluate: documentMutation((current) => {
          if (
            current.handoff.text !== expectedText ||
            current.handoff.updatedAt !== expectedUpdatedAt ||
            !isNotesHandoffUnread(current)
          ) {
            return null;
          }
          return {
            ...current,
            handoff: { ...current.handoff, readAt: now },
            updatedAt: now,
          };
        }),
      });
    },
    [clock, enqueueMutation],
  );

  return {
    value: document.reference,
    onChange,
    document,
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
    diagnostics: {
      load: loadDiagnostics,
      save: saveDiagnostics,
      authority: authorityDiagnostics,
    },
  };
}

function replayMutations(
  base: NotesDocumentV3,
  mutations: readonly NotesMutation[],
): NotesDocumentV3 {
  let current = base;
  for (const mutation of mutations) {
    current = evaluateMutation(mutation, current).document ?? current;
  }
  return current;
}

function evaluateMutation(mutation: NotesMutation, base: NotesDocumentV3): NotesMutationEvaluation {
  if (mutation.cachedEvaluation?.base === base) return mutation.cachedEvaluation.value;
  const value = mutation.evaluate(base);
  mutation.cachedEvaluation = { base, value };
  return value;
}

function documentMutation(
  update: (document: NotesDocumentV3) => NotesDocumentV3 | null,
): (document: NotesDocumentV3) => NotesMutationEvaluation {
  return (document) => ({ document: update(document) });
}

function settlePendingMutations(
  mutations: readonly NotesMutation[],
  reason: NotesOperationFailureReason,
): void {
  for (const mutation of mutations) {
    mutation.settle?.(mutation.failure?.(reason) ?? { status: "failed", reason });
  }
}

function saveOutcomeFailureReason(outcome: ProjectNotesSaveOutcome): NotesOperationFailureReason {
  if (outcome.status === "invalid") return "invalid";
  if (outcome.status === "missing") return "missing";
  if (outcome.status === "corrupt") return "corrupt";
  return "unavailable";
}

function referenceSaveFailure(outcome: ProjectNotesSaveOutcome): NotesReferenceOperationResult {
  return { status: "failed", reason: saveOutcomeFailureReason(outcome) };
}

function browserStorage(): Storage {
  try {
    return window.localStorage;
  } catch (error) {
    return throwingStorage(error);
  }
}

function throwingStorage(error: unknown): Storage {
  const fail = (): never => {
    throw error;
  };
  return {
    get length() {
      return fail();
    },
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  };
}
