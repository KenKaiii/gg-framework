import { useEffect, useMemo, useRef, useState } from "react";
import {
  emptyNotesReferenceDraft,
  groupNotesReferences,
  normalizeNotesReferenceDraft,
  notesReferenceFieldMaxLength,
  notesReferenceToDraft,
  referenceRepositoryLabel,
  referenceSourceLabel,
  type NotesReferenceDraft,
  type NotesReferenceDraftField,
  type NotesReferenceInput,
} from "./notes-reference";
import { openReferenceUrl, type OpenReferenceUrl } from "./notes-open-source";
import type { NotesPhase, NotesReference, NotesReferenceOperationResult } from "./notes-types";

interface NotesReferencesProps {
  references: NotesReference[];
  phases: NotesPhase[];
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
  openSource?: OpenReferenceUrl;
  createRequest?: number;
}

type FormMode = { kind: "create" } | { kind: "edit"; id: string };

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function NotesReferences({
  references,
  phases,
  onCreateReference,
  onEditReference,
  onDeleteReference,
  onLinkReferenceToPhase,
  onUnlinkReferenceFromPhase,
  openSource = openReferenceUrl,
  createRequest = 0,
}: NotesReferencesProps): React.ReactElement {
  const groups = useMemo(() => groupNotesReferences(references), [references]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<FormMode | null>(null);
  const [draft, setDraft] = useState<NotesReferenceDraft>(emptyNotesReferenceDraft);
  const [phaseIds, setPhaseIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<Partial<Record<NotesReferenceDraftField, string>>>({});
  const [announcement, setAnnouncement] = useState("");
  const [openError, setOpenError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deletingReference, setDeletingReference] = useState<NotesReference | null>(null);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const fieldRefs = useRef(
    new Map<NotesReferenceDraftField, HTMLInputElement | HTMLTextAreaElement>(),
  );
  const handledCreateRequestRef = useRef(0);
  const selected =
    references.find((reference) => reference.id === selectedId) ??
    (deletingReference?.id === selectedId ? deletingReference : null);

  useEffect(() => {
    if (selectedId === null || selected) return;
    setSelectedId(null);
    setFormMode(null);
    setConfirmDelete(false);
  }, [selected, selectedId]);

  useEffect(() => {
    if (formMode) queueMicrotask(() => fieldRefs.current.get("provider")?.focus());
  }, [formMode]);

  useEffect(() => {
    if (createRequest <= handledCreateRequestRef.current) return;
    handledCreateRequestRef.current = createRequest;
    setSelectedId(null);
    setDraft(emptyNotesReferenceDraft());
    setPhaseIds([]);
    setErrors({});
    setOpenError("");
    setConfirmDelete(false);
    setFormMode({ kind: "create" });
  }, [createRequest]);

  const focusAfterDetail = (referenceId: string | null): void => {
    queueMicrotask(() => {
      if (referenceId && rowRefs.current.get(referenceId)) {
        rowRefs.current.get(referenceId)?.focus();
        return;
      }
      newButtonRef.current?.focus();
    });
  };

  const startCreate = (): void => {
    setSelectedId(null);
    setDraft(emptyNotesReferenceDraft());
    setPhaseIds([]);
    setErrors({});
    setOpenError("");
    setConfirmDelete(false);
    setFormMode({ kind: "create" });
  };

  const closeForm = (): void => {
    const referenceId = formMode?.kind === "edit" ? formMode.id : null;
    setFormMode(null);
    setErrors({});
    focusAfterDetail(referenceId);
  };

  const submit = (): void => {
    const normalized = normalizeNotesReferenceDraft(draft);
    if (!normalized.ok) {
      setErrors(normalized.errors);
      setAnnouncement("Reference has errors. Review the highlighted fields.");
      queueMicrotask(() => fieldRefs.current.get(normalized.firstField)?.focus());
      return;
    }

    const submittedMode = formMode;
    if (!submittedMode || submitting) return;
    const label = referenceSourceLabel({
      ...normalized.input,
      id: submittedMode.kind === "edit" ? submittedMode.id : "pending",
      capturedAt: selected?.capturedAt ?? new Date(0).toISOString(),
    });
    setSubmitting(true);
    const operation =
      submittedMode.kind === "edit"
        ? onEditReference(submittedMode.id, normalized.input)
        : onCreateReference(normalized.input, phaseIds);
    void operation
      .then((result) => {
        if (result.status === "committed" || result.status === "reused") {
          setSelectedId(result.referenceId);
          setFormMode(null);
          setErrors({});
          const reusedReference = references.find(
            (reference) => reference.id === result.referenceId,
          );
          setAnnouncement(
            submittedMode.kind === "edit"
              ? `Updated reference: ${label}`
              : result.status === "reused"
                ? `Already saved: ${reusedReference ? referenceSourceLabel(reusedReference) : label}. Selected the existing reference.`
                : "Created structured reference.",
          );
          return;
        }
        if (result.status === "missing-phase") {
          setPhaseIds((current) => current.filter((id) => id !== result.phaseId));
        }
        setAnnouncement(referenceOperationFailure(result, "save"));
      })
      .catch(() => {
        setAnnouncement("Couldn’t save the reference. Check Notes storage and try again.");
      })
      .finally(() => setSubmitting(false));
  };

  const selectReference = (id: string): void => {
    setFormMode(null);
    setConfirmDelete(false);
    setOpenError("");
    setSelectedId(id);
  };

  const closeDetail = (): void => {
    const id = selectedId;
    setSelectedId(null);
    setConfirmDelete(false);
    setOpenError("");
    focusAfterDetail(id);
  };

  const linkedPhases = selected
    ? phases.filter(
        (phase) =>
          phase.referenceIds.includes(selected.id) ||
          phase.overrides.referenceIds?.value.includes(selected.id),
      )
    : [];

  const deleteSelected = (): void => {
    if (!selected || linkedPhases.length > 0 || deletingReference) return;
    const index = references.findIndex((reference) => reference.id === selected.id);
    const nextFocusId = references[index + 1]?.id ?? references[index - 1]?.id ?? null;
    const deleting = selected;
    const label = referenceSourceLabel(deleting);
    setDeletingReference(deleting);
    void onDeleteReference(deleting.id)
      .then((result) => {
        if (result.status === "committed" || result.status === "reused") {
          setSelectedId(null);
          setConfirmDelete(false);
          setAnnouncement(`Deleted reference: ${label}`);
          focusAfterDetail(nextFocusId);
          return;
        }
        if (result.status === "missing-reference") {
          setSelectedId(null);
          setConfirmDelete(false);
          focusAfterDetail(nextFocusId);
        } else {
          setConfirmDelete(false);
        }
        setAnnouncement(referenceOperationFailure(result, "delete"));
      })
      .catch(() => {
        setConfirmDelete(false);
        setAnnouncement("Couldn’t delete the reference. Check Notes storage and try again.");
      })
      .finally(() => setDeletingReference(null));
  };

  const changeReferenceLink = (
    reference: NotesReference,
    phase: NotesPhase,
    linked: boolean,
  ): void => {
    const operationKey = `${reference.id}:${phase.id}`;
    if (pendingLink === operationKey) return;
    setPendingLink(operationKey);
    const operation = linked
      ? onLinkReferenceToPhase(reference.id, phase.id)
      : onUnlinkReferenceFromPhase(reference.id, phase.id);
    void operation
      .then((result) => {
        if (result.status === "committed" || result.status === "reused") {
          setAnnouncement(
            linked
              ? `Attached reference to ${phase.title}.`
              : `Detached reference from ${phase.title}.`,
          );
          return;
        }
        setAnnouncement(referenceOperationFailure(result, linked ? "attach" : "detach"));
      })
      .catch(() => {
        setAnnouncement(
          `Couldn’t ${linked ? "attach" : "detach"} the reference. Check Notes storage and try again.`,
        );
      })
      .finally(() => setPendingLink(null));
  };

  return (
    <div className={`notes-references${selected || formMode ? " has-detail" : ""}`}>
      <div className="notes-references-toolbar">
        <div>
          <h3 id="notes-structured-references-heading">Structured references</h3>
          <p>{references.length === 1 ? "1 reference" : `${references.length} references`}</p>
        </div>
        <button
          ref={newButtonRef}
          type="button"
          className="notes-reference-new"
          aria-expanded={formMode?.kind === "create"}
          aria-controls={formMode?.kind === "create" ? "notes-reference-form" : undefined}
          onClick={() => {
            if (formMode?.kind === "create") closeForm();
            else startCreate();
          }}
        >
          {formMode?.kind === "create" ? "Close" : "New reference"}
        </button>
      </div>

      {formMode && (
        <ReferenceForm
          mode={formMode.kind}
          draft={draft}
          errors={errors}
          phaseIds={phaseIds}
          phases={phases}
          fieldRefs={fieldRefs}
          pending={submitting}
          onChange={(field, value) => {
            setDraft((current) => ({ ...current, [field]: value }));
            setErrors((current) => ({ ...current, [field]: undefined }));
          }}
          onTogglePhase={(phaseId, checked) =>
            setPhaseIds((current) =>
              checked ? [...current, phaseId] : current.filter((id) => id !== phaseId),
            )
          }
          onSubmit={submit}
          onCancel={closeForm}
        />
      )}

      <div className={`notes-reference-workspace${selected ? " has-detail" : ""}`}>
        {references.length === 0 ? (
          <div className="notes-reference-empty">
            <strong>No structured references yet</strong>
            <p>Save an exact source once, then attach it to any roadmap phase.</p>
          </div>
        ) : (
          <div className="notes-reference-groups" aria-label="Structured references by repository">
            {groups.map((group) => (
              <section key={group.key} className="notes-reference-group">
                <h4>
                  <span>
                    {group.owner}/{group.repo}
                  </span>
                  <small>{group.provider}</small>
                </h4>
                <ul aria-label={`${group.owner}/${group.repo} references`}>
                  {group.references.map((reference) => {
                    const linkCount = phases.filter((phase) =>
                      phase.referenceIds.includes(reference.id),
                    ).length;
                    const isSelected = reference.id === selectedId;
                    return (
                      <li
                        key={reference.id}
                        className={`notes-reference-row${isSelected ? " is-selected" : ""}`}
                      >
                        <button
                          ref={(element) => {
                            if (element) rowRefs.current.set(reference.id, element);
                            else rowRefs.current.delete(reference.id);
                          }}
                          type="button"
                          aria-pressed={isSelected}
                          aria-label={`Inspect reference: ${referenceSourceLabel(reference)} in ${referenceRepositoryLabel(reference)}`}
                          onClick={() => selectReference(reference.id)}
                        >
                          <span className="notes-reference-row-source">
                            {reference.tool ?? reference.provider}
                          </span>
                          <strong>{referenceSourceLabel(reference)}</strong>
                          <span className="notes-reference-row-relevance">
                            {reference.relevance || "No relevance note."}
                          </span>
                          <span className="notes-reference-row-count">
                            {linkCount} linked {linkCount === 1 ? "phase" : "phases"}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        {selected && !formMode && (
          <section
            className="notes-reference-detail"
            aria-labelledby={`notes-reference-detail-${selected.id}`}
          >
            <div className="notes-reference-detail-heading">
              <div>
                <h4 id={`notes-reference-detail-${selected.id}`}>
                  {referenceSourceLabel(selected)}
                </h4>
                <span>{referenceRepositoryLabel(selected)}</span>
              </div>
              <div className="notes-reference-detail-actions">
                <button
                  type="button"
                  onClick={() => {
                    setDraft(notesReferenceToDraft(selected));
                    setPhaseIds([]);
                    setErrors({});
                    setConfirmDelete(false);
                    setFormMode({ kind: "edit", id: selected.id });
                  }}
                >
                  Edit
                </button>
                <button type="button" onClick={closeDetail}>
                  Back to references
                </button>
              </div>
            </div>

            <dl className="notes-reference-metadata">
              <Metadata label="Provider" value={selected.provider} />
              <Metadata label="Tool" value={selected.tool} />
              <Metadata label="Repository" value={referenceRepositoryLabel(selected)} />
              <Metadata label="Revision" value={selected.revision} />
              <Metadata label="Path" value={selected.path} />
              <Metadata
                label="Line range"
                value={
                  selected.range ? `${selected.range.startLine} to ${selected.range.endLine}` : null
                }
              />
              <Metadata label="Issue" value={selected.issue?.toString() ?? null} />
              <Metadata label="Pull request" value={selected.pullRequest?.toString() ?? null} />
              <Metadata label="Query" value={selected.query} />
              <Metadata label="Anchor" value={selected.anchor} />
              <div className="notes-reference-metadata-wide">
                <dt>Canonical URL</dt>
                <dd>{selected.canonicalUrl}</dd>
              </div>
              <div className="notes-reference-metadata-wide">
                <dt>Relevance</dt>
                <dd>{selected.relevance || "No relevance note."}</dd>
              </div>
              <div>
                <dt>Captured</dt>
                <dd>
                  <time dateTime={selected.capturedAt}>
                    {dateFormatter.format(new Date(selected.capturedAt))}
                  </time>
                </dd>
              </div>
            </dl>

            <div className="notes-reference-open">
              <button
                type="button"
                disabled={opening}
                onClick={() => {
                  setOpening(true);
                  setOpenError("");
                  void openSource(selected.canonicalUrl)
                    .then(() => setAnnouncement(`Opened source: ${referenceSourceLabel(selected)}`))
                    .catch(() => {
                      setOpenError("Couldn’t open this source in the system browser. Try again.");
                      setAnnouncement("Source opener failed.");
                    })
                    .finally(() => setOpening(false));
                }}
              >
                {opening ? "Opening…" : "Open source"}
              </button>
              {openError && (
                <p className="notes-reference-error" role="alert">
                  {openError}
                </p>
              )}
            </div>

            <fieldset className="notes-reference-phase-links">
              <legend>Linked phases</legend>
              {phases.length === 0 ? (
                <p>No roadmap phases are available.</p>
              ) : (
                <ul>
                  {phases.map((phase) => {
                    const checked = phase.referenceIds.includes(selected.id);
                    return (
                      <li key={phase.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={pendingLink === `${selected.id}:${phase.id}`}
                            onChange={(event) =>
                              changeReferenceLink(selected, phase, event.target.checked)
                            }
                          />
                          <span>
                            <strong>{phase.title}</strong>
                            <small>{phase.archivedAt ? "Archived" : phaseStatusLabel(phase)}</small>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </fieldset>

            <div className="notes-reference-delete">
              {linkedPhases.length > 0 ? (
                <p>
                  Unlink this reference from {linkedPhases.map((phase) => phase.title).join(", ")}{" "}
                  before deleting it.
                </p>
              ) : confirmDelete ? (
                <div
                  className="notes-reference-delete-confirm"
                  role="group"
                  aria-label="Confirm delete reference"
                >
                  <p>Delete {referenceSourceLabel(selected)} from the shared library?</p>
                  <button
                    type="button"
                    disabled={deletingReference !== null}
                    onClick={deleteSelected}
                  >
                    {deletingReference ? "Deleting…" : "Confirm delete"}
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)}>
                    Keep reference
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirmDelete(true)}>
                  Delete reference
                </button>
              )}
            </div>
          </section>
        )}
      </div>

      <div className="notes-status" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}

function ReferenceForm({
  mode,
  draft,
  errors,
  phaseIds,
  phases,
  fieldRefs,
  pending,
  onChange,
  onTogglePhase,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  draft: NotesReferenceDraft;
  errors: Partial<Record<NotesReferenceDraftField, string>>;
  phaseIds: string[];
  phases: NotesPhase[];
  fieldRefs: React.RefObject<Map<NotesReferenceDraftField, HTMLInputElement | HTMLTextAreaElement>>;
  pending: boolean;
  onChange(field: NotesReferenceDraftField, value: string): void;
  onTogglePhase(phaseId: string, checked: boolean): void;
  onSubmit(): void;
  onCancel(): void;
}): React.ReactElement {
  const errorCount = Object.values(errors).filter(Boolean).length;
  return (
    <form
      id="notes-reference-form"
      className="notes-reference-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="notes-reference-form-heading">
        <h4>{mode === "create" ? "New structured reference" : "Edit structured reference"}</h4>
        <p>Save exact source coordinates. Opening the source always uses the canonical URL.</p>
      </div>
      {errorCount > 0 && (
        <p className="notes-reference-error-summary" role="alert">
          Fix {errorCount} {errorCount === 1 ? "field" : "fields"} to save this reference.
        </p>
      )}
      <div className="notes-reference-form-grid">
        {referenceField({ field: "provider", label: "Provider", required: true })}
        {referenceField({ field: "tool", label: "Tool" })}
        {referenceField({
          field: "canonicalUrl",
          label: "Canonical URL",
          required: true,
          wide: true,
          inputMode: "url",
        })}
        {referenceField({ field: "owner", label: "Repository owner", required: true })}
        {referenceField({ field: "repo", label: "Repository name", required: true })}
        {referenceField({
          field: "relevance",
          label: "Relevance note",
          wide: true,
          multiline: true,
        })}
      </div>

      <fieldset className="notes-reference-optional">
        <legend>Optional source coordinates</legend>
        <div className="notes-reference-form-grid">
          {referenceField({ field: "revision", label: "Revision" })}
          {referenceField({ field: "path", label: "Path", wide: true })}
          {referenceField({ field: "startLine", label: "Start line", inputMode: "numeric" })}
          {referenceField({ field: "endLine", label: "End line", inputMode: "numeric" })}
          {referenceField({ field: "issue", label: "Issue number", inputMode: "numeric" })}
          {referenceField({
            field: "pullRequest",
            label: "Pull request number",
            inputMode: "numeric",
          })}
          {referenceField({ field: "query", label: "Query", wide: true })}
          {referenceField({ field: "anchor", label: "Anchor", wide: true })}
        </div>
      </fieldset>

      {mode === "create" && phases.length > 0 && (
        <fieldset className="notes-reference-initial-phases">
          <legend>Attach to phases</legend>
          <div className="notes-reference-checkboxes">
            {phases.map((phase) => (
              <label key={phase.id}>
                <input
                  type="checkbox"
                  checked={phaseIds.includes(phase.id)}
                  disabled={pending}
                  onChange={(event) => onTogglePhase(phase.id, event.target.checked)}
                />
                <span>
                  {phase.title}
                  {phase.archivedAt ? " (archived)" : ""}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="notes-reference-form-actions">
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : mode === "create" ? "Create reference" : "Save changes"}
        </button>
        <button type="button" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );

  function referenceField({
    field,
    label,
    required = false,
    wide = false,
    multiline = false,
    inputMode,
  }: {
    field: NotesReferenceDraftField;
    label: string;
    required?: boolean;
    wide?: boolean;
    multiline?: boolean;
    inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  }): React.ReactElement {
    const id = `notes-reference-${mode}-${field}`;
    const error = errors[field];
    const describedBy = error ? `${id}-error` : undefined;
    const common = {
      id,
      value: draft[field],
      required,
      disabled: pending,
      maxLength: notesReferenceFieldMaxLength(field),
      "aria-invalid": error ? (true as const) : undefined,
      "aria-describedby": describedBy,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        onChange(field, event.target.value),
      ref: (element: HTMLInputElement | HTMLTextAreaElement | null) => {
        if (element) fieldRefs.current.set(field, element);
        else fieldRefs.current.delete(field);
      },
    };
    return (
      <div className={`notes-field${wide ? " notes-reference-form-wide" : ""}`}>
        <label htmlFor={id}>
          {label}
          {required ? " (required)" : ""}
        </label>
        {multiline ? <textarea {...common} /> : <input {...common} inputMode={inputMode} />}
        {error && (
          <p id={`${id}-error`} className="notes-reference-field-error">
            {error}
          </p>
        )}
      </div>
    );
  }
}

function Metadata({
  label,
  value,
}: {
  label: string;
  value: string | null;
}): React.ReactElement | null {
  if (!value) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function referenceOperationFailure(
  result: Exclude<NotesReferenceOperationResult, { status: "committed" } | { status: "reused" }>,
  action: "save" | "delete" | "attach" | "detach",
): string {
  if (result.status === "collision") {
    return "Couldn’t save: another reference now uses these source coordinates. Change this reference or use the existing one.";
  }
  if (result.status === "linked-blocked") {
    return "Couldn’t delete: this reference was attached to a phase in another window. Unlink it from every phase, then try again.";
  }
  if (result.status === "missing-reference") {
    return action === "save"
      ? "Couldn’t save: this reference was removed in another window. Your draft is still open."
      : `Couldn’t ${action}: the reference was removed in another window.`;
  }
  if (result.status === "missing-phase") {
    return `Couldn’t ${action}: the phase was removed in another window.`;
  }
  if (result.reason === "invalid") {
    return `Couldn’t ${action}: Project Notes rejected the change. Review the reference and try again.`;
  }
  if (result.reason === "corrupt") {
    return `Couldn’t ${action}: Project Notes are unreadable. Repair or restore project storage first.`;
  }
  if (result.reason === "missing") {
    return `Couldn’t ${action}: project Notes storage is missing. Reopen the project and try again.`;
  }
  if (result.reason === "storage") {
    return `Couldn’t ${action}: local Notes storage failed. Free space and try again.`;
  }
  return `Couldn’t ${action} the reference. Check Notes storage and try again.`;
}

function phaseStatusLabel(phase: NotesPhase): string {
  return phase.status.replace(/-/g, " ");
}
