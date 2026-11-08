import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import {
  deleteJiwa,
  deleteMemory,
  isJiwaChangeEvent,
  isMemoryChangeEvent,
  listJiwa,
  listMemories,
  saveJiwa,
  saveMemory,
  subscribe,
  type JiwaCategory,
  type JiwaEntry,
  type JiwaInput,
  type JiwaSnapshot,
  type Memory,
  type MemoryCategory,
  type MemoryInput,
  type MemorySnapshot,
} from "./agent";
import { Badge } from "./Badge";
import { Modal } from "./Modal";

interface Props {
  onClose: () => void;
}

type BrainTab = "memories" | "jiwa";
type BrainEntry = Memory | JiwaEntry;

interface CategoryOption<C extends string = string> {
  value: C;
  label: string;
}

/** An add or edit in progress. Each tab keeps its own, so switching tabs keeps it. */
interface Draft {
  /** The entry being edited; null while adding one. */
  id: string | null;
  text: string;
  category: string;
  importance: number;
  /** What it opened with, so an edit that changed nothing can't be saved. */
  initial: { text: string; category: string; importance: number };
  saving: boolean;
  /** Why the last save failed, in the sidecar's words. */
  error: string | null;
}

type DraftFields = Partial<Pick<Draft, "text" | "category" | "importance">>;

type SaveRequest =
  | { tab: "memories"; id: string | null; input: MemoryInput }
  | { tab: "jiwa"; id: string | null; input: JiwaInput };

/** Where focus goes after the next render. */
type FocusRequest = { kind: "editor" } | { kind: "add" } | { kind: "edit"; id: string };

const EMPTY_MEMORY_SNAPSHOT: MemorySnapshot = { memories: [], softLimit: 60, hardLimit: 90 };
const EMPTY_JIWA_SNAPSHOT: JiwaSnapshot = { jiwa: [], softLimit: 60, hardLimit: 90 };

/** The stores' limit on an entry's text. The sidecar checks it again. */
const TEXT_LIMIT = 600;
/** The character counter shows from this length. */
const COUNTER_FROM = 500;
const IMPORTANCE_LEVELS = [1, 2, 3, 4, 5] as const;

const MEMORY_CATEGORIES: readonly CategoryOption<MemoryCategory>[] = [
  { value: "identity", label: "Identity" },
  { value: "preference", label: "Preference" },
  { value: "project", label: "Project" },
  { value: "relationship", label: "Relationship" },
  { value: "health", label: "Health" },
  { value: "other", label: "Other" },
];

const JIWA_CATEGORIES: readonly CategoryOption<JiwaCategory>[] = [
  { value: "identity", label: "Identity" },
  { value: "voice", label: "Voice" },
  { value: "interaction", label: "Interaction" },
  { value: "boundaries", label: "Boundaries" },
  { value: "workflow", label: "Workflow" },
  { value: "other", label: "Other" },
];

/**
 * An older host's sidecar has no add or edit routes, so it answers them with
 * its catch-all `{error:"not found"}`. (A missing entry has its own wording.)
 */
const OLDER_HOST_ERROR = "not found";
const OLDER_HOST_MESSAGE =
  "Your host runs an older Kleio, which can't add or edit here. Update Kleio on your host.";

function updatedLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function saveFailure(cause: unknown): string {
  const message = errorText(cause);
  return message === OLDER_HOST_ERROR ? OLDER_HOST_MESSAGE : message;
}

/** A category as the editor names it ("Identity"), for the iPhone's line under each entry. */
function categoryLabel(tab: BrainTab, value: string): string {
  const options: readonly CategoryOption[] =
    tab === "memories" ? MEMORY_CATEGORIES : JIWA_CATEGORIES;
  return options.find((option) => option.value === value)?.label ?? value;
}

function memoryCategory(value: string): MemoryCategory | undefined {
  return MEMORY_CATEGORIES.find((option) => option.value === value)?.value;
}

function jiwaCategory(value: string): JiwaCategory | undefined {
  return JIWA_CATEGORIES.find((option) => option.value === value)?.value;
}

/** A new draft: blank with the tools' defaults, or filled from the entry to edit. */
function openDraft(entry: BrainEntry | null): Draft {
  const initial = entry
    ? { text: entry.text, category: entry.category, importance: entry.importance }
    : { text: "", category: "other", importance: 3 };
  return { id: entry?.id ?? null, ...initial, initial, saving: false, error: null };
}

/**
 * What Save would send, or null while it has to stay off: saving already, the
 * text blank, no category of this tab's, or an edit that changed nothing.
 */
function saveRequest(tab: BrainTab, draft: Draft): SaveRequest | null {
  const text = draft.text.trim();
  if (draft.saving || !text) return null;
  const unchanged =
    text === draft.initial.text.trim() &&
    draft.category === draft.initial.category &&
    draft.importance === draft.initial.importance;
  if (draft.id !== null && unchanged) return null;
  if (tab === "memories") {
    const category = memoryCategory(draft.category);
    if (!category) return null;
    return { tab, id: draft.id, input: { text, category, importance: draft.importance } };
  }
  const category = jiwaCategory(draft.category);
  if (!category) return null;
  return { tab, id: draft.id, input: { text, category, importance: draft.importance } };
}

export function MemoryModal({ onClose }: Props): React.ReactElement {
  const [activeTab, setActiveTab] = useState<BrainTab>("memories");
  const [memories, setMemories] = useState<MemorySnapshot>(EMPTY_MEMORY_SNAPSHOT);
  const [jiwa, setJiwa] = useState<JiwaSnapshot>(EMPTY_JIWA_SNAPSHOT);
  const [loading, setLoading] = useState<Record<BrainTab, boolean>>({
    memories: true,
    jiwa: true,
  });
  const [errors, setErrors] = useState<Record<BrainTab, string | null>>({
    memories: null,
    jiwa: null,
  });
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<BrainTab, Draft | null>>({
    memories: null,
    jiwa: null,
  });
  const [announcement, setAnnouncement] = useState("");
  const memoryTabRef = useRef<HTMLButtonElement>(null);
  const jiwaTabRef = useRef<HTMLButtonElement>(null);
  // Mirrors activeTab for a save that finishes after the user switched tabs.
  const activeTabRef = useRef<BrainTab>("memories");
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const editorTextRef = useRef<HTMLTextAreaElement>(null);
  const editButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const focusRequestRef = useRef<FocusRequest | null>(null);

  const refreshMemories = useCallback(async (): Promise<void> => {
    try {
      setMemories(await listMemories());
      setErrors((current) => ({ ...current, memories: null }));
    } catch (cause) {
      setErrors((current) => ({ ...current, memories: errorText(cause) }));
    } finally {
      setLoading((current) => ({ ...current, memories: false }));
    }
  }, []);

  const refreshJiwa = useCallback(async (): Promise<void> => {
    try {
      setJiwa(await listJiwa());
      setErrors((current) => ({ ...current, jiwa: null }));
    } catch (cause) {
      setErrors((current) => ({ ...current, jiwa: errorText(cause) }));
    } finally {
      setLoading((current) => ({ ...current, jiwa: false }));
    }
  }, []);

  useEffect(() => {
    void refreshMemories();
    void refreshJiwa();
    return subscribe((event) => {
      if (isMemoryChangeEvent(event)) void refreshMemories();
      if (isJiwaChangeEvent(event)) void refreshJiwa();
    });
  }, [refreshJiwa, refreshMemories]);

  // Runs after every render: a focus request is made together with the state
  // change that renders its target. Without a target, focus stays in the
  // dialog on the active tab rather than dropping to the page behind it.
  useEffect(() => {
    const request = focusRequestRef.current;
    if (!request) return;
    focusRequestRef.current = null;
    const fallback =
      addButtonRef.current ??
      (activeTabRef.current === "memories" ? memoryTabRef.current : jiwaTabRef.current);
    const target =
      request.kind === "editor"
        ? editorTextRef.current
        : request.kind === "edit"
          ? (editButtonsRef.current.get(request.id) ?? fallback)
          : fallback;
    target?.focus();
  });

  const remove = useCallback(async (tab: BrainTab, entry: BrainEntry): Promise<void> => {
    const key = `${tab}:${entry.id}`;
    setDeletingKey(key);
    try {
      if (tab === "memories") setMemories(await deleteMemory(entry.id));
      else setJiwa(await deleteJiwa(entry.id));
      setErrors((current) => ({ ...current, [tab]: null }));
    } catch (cause) {
      setErrors((current) => ({ ...current, [tab]: errorText(cause) }));
    } finally {
      setDeletingKey((current) => (current === key ? null : current));
    }
  }, []);

  const patchDraft = (
    tab: BrainTab,
    patch: DraftFields | Pick<Draft, "saving" | "error">,
  ): void => {
    setDrafts((current) => {
      const draft = current[tab];
      return draft ? { ...current, [tab]: { ...draft, ...patch } } : current;
    });
  };

  const openEditor = (tab: BrainTab, entry: BrainEntry | null): void => {
    setDrafts((current) => ({ ...current, [tab]: openDraft(entry) }));
    // Cleared so the next save is announced even when it reads the same.
    setAnnouncement("");
    focusRequestRef.current = { kind: "editor" };
  };

  const closeEditor = (tab: BrainTab, draft: Draft): void => {
    setDrafts((current) => ({ ...current, [tab]: null }));
    focusRequestRef.current = draft.id === null ? { kind: "add" } : { kind: "edit", id: draft.id };
  };

  const save = async (tab: BrainTab, draft: Draft): Promise<void> => {
    const request = saveRequest(tab, draft);
    if (!request) return;
    patchDraft(tab, { saving: true, error: null });
    try {
      let savedId: string;
      if (request.tab === "memories") {
        const { memory, ...snapshot } = await saveMemory(request.id, request.input);
        setMemories(snapshot);
        savedId = memory.id;
      } else {
        const { entry, ...snapshot } = await saveJiwa(request.id, request.input);
        setJiwa(snapshot);
        savedId = entry.id;
      }
      setDrafts((current) => ({ ...current, [tab]: null }));
      setErrors((current) => ({ ...current, [tab]: null }));
      setAnnouncement(
        `${tab === "memories" ? "Memory" : "Instruction"} ${request.id === null ? "added" : "saved"}.`,
      );
      if (activeTabRef.current === tab) {
        focusRequestRef.current =
          request.id === null ? { kind: "add" } : { kind: "edit", id: savedId };
      }
    } catch (cause) {
      // The draft stays, with the reason under its buttons.
      patchDraft(tab, { saving: false, error: saveFailure(cause) });
      if (activeTabRef.current === tab) focusRequestRef.current = { kind: "editor" };
    }
  };

  const selectTab = useCallback((tab: BrainTab, focus = false): void => {
    setActiveTab(tab);
    activeTabRef.current = tab;
    if (focus) {
      const target = tab === "memories" ? memoryTabRef.current : jiwaTabRef.current;
      target?.focus();
    }
  }, []);

  const onTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>): void => {
      let next: BrainTab | null = null;
      if (event.key === "ArrowLeft" || event.key === "Home") next = "memories";
      if (event.key === "ArrowRight" || event.key === "End") next = "jiwa";
      if (!next) return;
      event.preventDefault();
      selectTab(next, true);
    },
    [selectTab],
  );

  const draft = drafts[activeTab];
  const entries: BrainEntry[] = activeTab === "memories" ? memories.memories : jiwa.jiwa;
  const hardLimit = activeTab === "memories" ? memories.hardLimit : jiwa.hardLimit;
  const label = activeTab === "memories" ? "memories" : "Jiwa";
  const entryLabel = activeTab === "memories" ? "Memory" : "Instruction";
  const noun = activeTab === "memories" ? "memory" : "Jiwa instruction";
  const error = errors[activeTab];
  const isLoading = loading[activeTab];

  return (
    <Modal
      title={
        <span className="memory-modal-title">
          <span>Brain</span>
          {!isLoading && <Badge>{entries.length}</Badge>}
          <span className="brain-tabs" role="tablist" aria-label="Brain contents">
            <button
              ref={memoryTabRef}
              id="brain-tab-memories"
              type="button"
              role="tab"
              aria-selected={activeTab === "memories"}
              aria-controls="brain-panel"
              tabIndex={activeTab === "memories" ? 0 : -1}
              onClick={() => selectTab("memories")}
              onKeyDown={onTabKeyDown}
            >
              Memories
            </button>
            <button
              ref={jiwaTabRef}
              id="brain-tab-jiwa"
              type="button"
              role="tab"
              aria-selected={activeTab === "jiwa"}
              aria-controls="brain-panel"
              tabIndex={activeTab === "jiwa" ? 0 : -1}
              onClick={() => selectTab("jiwa")}
              onKeyDown={onTabKeyDown}
            >
              Jiwa
            </button>
          </span>
        </span>
      }
      onClose={onClose}
      className="memory-modal"
    >
      <div
        id="brain-panel"
        className="brain-panel"
        role="tabpanel"
        aria-labelledby={`brain-tab-${activeTab}`}
      >
        {draft ? (
          <BrainEditor
            key={activeTab}
            tab={activeTab}
            draft={draft}
            textRef={editorTextRef}
            onChange={(fields) => patchDraft(activeTab, fields)}
            onCancel={() => closeEditor(activeTab, draft)}
            onSave={() => void save(activeTab, draft)}
          />
        ) : (
          <>
            {!isLoading && !error && (
              <div className="brain-toolbar">
                {entries.length >= hardLimit && (
                  <p className="brain-full-note">Full. Adding one removes the least important.</p>
                )}
                <button
                  ref={addButtonRef}
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => openEditor(activeTab, null)}
                >
                  <PlusIcon size={14} weight="bold" aria-hidden="true" />
                  {activeTab === "memories" ? "Add memory" : "Add instruction"}
                </button>
              </div>
            )}
            <div className="memory-table-wrap">
              {isLoading ? (
                <div className="memory-modal-state">Loading {label}…</div>
              ) : error ? (
                <div className="memory-modal-state memory-modal-error" role="alert">
                  Couldn't load {label}: {error}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() =>
                      void (activeTab === "memories" ? refreshMemories() : refreshJiwa())
                    }
                  >
                    Try again
                  </button>
                </div>
              ) : entries.length === 0 ? (
                <div className="memory-modal-state">
                  {activeTab === "memories"
                    ? "No durable memories yet."
                    : "No Jiwa instructions yet."}
                </div>
              ) : (
                <table className="memory-table">
                  <thead>
                    <tr>
                      <th>{entryLabel}</th>
                      <th className="memory-col-detail">Category</th>
                      <th className="memory-col-detail">Importance</th>
                      <th className="memory-col-detail">Updated</th>
                      <th className="memory-actions-cell">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => {
                      const deleting = deletingKey === `${activeTab}:${entry.id}`;
                      return (
                        <tr key={entry.id}>
                          <td className="memory-table-text">
                            {entry.text}
                            {/* The iPhone hides the detail columns and shows this instead. */}
                            <span className="memory-meta">
                              <span aria-hidden="true">
                                {categoryLabel(activeTab, entry.category)} · {entry.importance} / 5
                              </span>
                              <span className="sr-only">
                                {categoryLabel(activeTab, entry.category)}, importance{" "}
                                {entry.importance} of 5
                              </span>
                            </span>
                          </td>
                          <td className="memory-col-detail">
                            <span className="memory-category">{entry.category}</span>
                          </td>
                          <td
                            className="memory-importance memory-col-detail"
                            aria-label={`Importance ${entry.importance} of 5`}
                          >
                            {entry.importance} / 5
                          </td>
                          <td className="memory-updated memory-col-detail">
                            {updatedLabel(entry.updatedAt)}
                          </td>
                          <td className="memory-actions-cell">
                            <button
                              ref={(node) => {
                                if (node) editButtonsRef.current.set(entry.id, node);
                                else editButtonsRef.current.delete(entry.id);
                              }}
                              type="button"
                              className="memory-action"
                              aria-label={`Edit ${noun}: ${entry.text}`}
                              title={`Edit ${noun}`}
                              disabled={deleting}
                              onClick={() => openEditor(activeTab, entry)}
                            >
                              <PencilSimpleIcon size={14} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="memory-action memory-delete"
                              aria-label={`Delete ${noun}: ${entry.text}`}
                              title={`Delete ${noun}`}
                              disabled={deleting}
                              onClick={() => void remove(activeTab, entry)}
                            >
                              <TrashIcon size={14} aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
      <div className="sr-only" role="status">
        {announcement}
      </div>
    </Modal>
  );
}

interface EditorProps {
  tab: BrainTab;
  draft: Draft;
  textRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (fields: DraftFields) => void;
  onCancel: () => void;
  onSave: () => void;
}

/** Adds or edits one entry. It stands in for its tab's list until saved or cancelled. */
function BrainEditor({
  tab,
  draft,
  textRef,
  onChange,
  onCancel,
  onSave,
}: EditorProps): React.ReactElement {
  const id = useId();
  const isMemory = tab === "memories";
  const categories: readonly CategoryOption[] = isMemory ? MEMORY_CATEGORIES : JIWA_CATEGORIES;
  const ready = saveRequest(tab, draft) !== null;
  const showCounter = draft.text.length >= COUNTER_FROM;
  const titleId = `${id}-title`;
  const textId = `${id}-text`;
  const countId = `${id}-count`;
  const hintId = `${id}-hint`;

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    // Cancel the editor only, never the Brain around it (as Dropdown does).
    event.preventDefault();
    event.nativeEvent.stopPropagation();
    if (!draft.saving) onCancel();
  };

  return (
    <form
      className="brain-editor"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSave();
      }}
    >
      <h3 id={titleId} className="brain-editor-title">
        {`${draft.id === null ? "New" : "Edit"} ${isMemory ? "memory" : "Jiwa instruction"}`}
      </h3>
      <label className="modal-label" htmlFor={textId}>
        {isMemory ? "Memory" : "Instruction"}
      </label>
      <textarea
        ref={textRef}
        id={textId}
        className="modal-input brain-editor-text"
        value={draft.text}
        maxLength={TEXT_LIMIT}
        rows={3}
        readOnly={draft.saving}
        placeholder={
          isMemory
            ? "Works as a GP in Leeds, three days a week."
            : "Keep answers short unless I ask for detail."
        }
        aria-describedby={showCounter ? countId : undefined}
        onChange={(event) => onChange({ text: event.target.value })}
      />
      {showCounter && (
        <p id={countId} className="brain-editor-count">
          {draft.text.length} / {TEXT_LIMIT}
        </p>
      )}
      <fieldset className="brain-editor-field" disabled={draft.saving}>
        <legend className="modal-label">Category</legend>
        <div className="modal-radio-group">
          {categories.map((option) => (
            <label key={option.value} className="modal-radio">
              <input
                type="radio"
                name={`${id}-category`}
                value={option.value}
                checked={draft.category === option.value}
                onChange={() => onChange({ category: option.value })}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="brain-editor-field" disabled={draft.saving} aria-describedby={hintId}>
        <legend className="modal-label">Importance</legend>
        <div className="modal-radio-group">
          {IMPORTANCE_LEVELS.map((level) => (
            <label key={level} className="modal-radio">
              <input
                type="radio"
                name={`${id}-importance`}
                value={level}
                checked={draft.importance === level}
                onChange={() => onChange({ importance: level })}
              />
              <span>{level}</span>
            </label>
          ))}
        </div>
        <p id={hintId} className="modal-hint">
          1 is low, 5 is high. When Brain is full, the least important go first; Identity never
          does.
        </p>
      </fieldset>
      <div className="modal-actions">
        <button type="button" className="modal-btn" disabled={draft.saving} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="modal-btn primary" disabled={!ready}>
          {draft.saving ? "Saving…" : "Save"}
        </button>
      </div>
      {draft.error && (
        <p className="modal-error brain-editor-error" role="alert">
          {draft.error}
        </p>
      )}
    </form>
  );
}
