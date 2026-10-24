import { useEffect, useId, useMemo, useRef, useState } from "react";
import { setThinkingLevel, type AgentState, type ModelOption } from "./agent";
import { PanelHead } from "./DeckPanelHead";
import { Icon } from "./icons";
import { modelDisplayName } from "./model-name";
import { searchModels } from "./model-search";
import { providerLabel } from "./provider-labels";
import { thinkingLabel, ThinkingDots } from "./thinking-display";

/** Who the picker is choosing for: GG itself, or its second agent. */
export type ModelTarget = "gg" | "second";

export interface SecondAgent {
  /** "Ken" in a code window, "Critters" in a Goal. */
  name: string;
  /** Whose model the second agent follows when unpinned ("GG", "GG Goals"). */
  followLabel: string;
  /** The second agent's current model (its pin, or the one it follows). */
  model: string;
  /** True while it follows GG's model rather than a pin of its own. */
  following: boolean;
  disabled: boolean;
  onSelect: (modelId: string | null) => void;
}

const FOLLOW_ID = "__follow__";

interface Option {
  id: string;
  name: string;
  /** Group heading shown with flat (search) results. */
  provider: string;
  disabled: boolean;
  hint?: string;
  /** Picking this model spends real money (Claude fast mode). */
  paid?: boolean;
  /** What it bills, shown in the confirmation before it's switched to. */
  billingDetail?: string;
  /** The model sessions go back to when this paid one is not carried over. */
  standardName?: string;
  contextWindow?: number;
}

function contextLabel(tokens: number | undefined): string {
  if (!tokens) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/** Marks the matched words of `name` for the search results. */
function Highlighted({ name, query }: { name: string; query: string }): React.ReactElement {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = name.toLowerCase();
  const marks = new Array<boolean>(name.length).fill(false);
  for (const word of words) {
    const at = lower.indexOf(word);
    if (at >= 0) for (let i = at; i < at + word.length; i++) marks[i] = true;
  }
  const parts: { text: string; mark: boolean }[] = [];
  for (let i = 0; i < name.length; i++) {
    const mark = marks[i] ?? false;
    const last = parts[parts.length - 1];
    if (last && last.mark === mark) last.text += name[i];
    else parts.push({ text: name[i] ?? "", mark });
  }
  return <>{parts.map((part, i) => (part.mark ? <mark key={i}>{part.text}</mark> : part.text))}</>;
}

/**
 * The deck's model picker. It takes the message box's place, so the caret
 * stays where the user was typing: a search field over every model GG can run,
 * grouped by provider, with a switch between GG and its second agent (Ken, or a
 * Goal's critters) and GG's thinking level beside it.
 */
export function ModelPanel({
  state,
  models,
  modelsFailed,
  running,
  onSelectModel,
  second,
  onClose,
}: {
  state: AgentState | null;
  models: readonly ModelOption[];
  modelsFailed: boolean;
  running: boolean;
  onSelectModel: (modelId: string, options?: { confirmPaid?: boolean }) => void;
  second: SecondAgent | null;
  onClose: () => void;
}): React.ReactElement {
  const [target, setTarget] = useState<ModelTarget>("gg");
  const [query, setQuery] = useState("");
  // null: rest on the current model; a number once the user moves or types.
  const [active, setActive] = useState<number | null>(null);
  const [thinkingError, setThinkingError] = useState<string | null>(null);
  // A real-money model waiting on the user's explicit yes. Picking it never
  // switches by itself: the panel asks first, with Cancel as the default.
  const [pendingPaid, setPendingPaid] = useState<Option | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const forSecond = target === "second" && second !== null;
  const currentId = forSecond ? second.model : (state?.model ?? "");
  const locked = forSecond ? second.disabled : running;

  const groups = useMemo(() => {
    const out: { label: string; options: Option[] }[] = [];
    if (forSecond && !query.trim()) {
      out.push({
        label: second.name,
        options: [
          {
            id: FOLLOW_ID,
            name: `Follow ${second.followLabel}`,
            provider: "",
            disabled: false,
            hint: modelDisplayName(models, state?.model),
          },
        ],
      });
    }
    for (const group of searchModels(models, query)) {
      out.push({
        label: group.label,
        options: group.models.map((model) => {
          // Ken and Goal workers run unwatched in the background, so a model
          // that spends real money is main-chat only (the sidecar enforces it).
          const paidForSecond = forSecond && model.billing?.paid === true;
          return {
            id: model.id,
            name: model.name,
            provider: providerLabel(model.provider),
            disabled: model.supportsTools === false || paidForSecond,
            // Fast modes change what the user pays, so the row says so up front.
            hint:
              model.supportsTools === false
                ? "no tool calling"
                : paidForSecond
                  ? "main chat only"
                  : model.billing?.label,
            paid: model.billing?.paid,
            billingDetail: model.billing?.detail,
            standardName: model.billing?.standardModel
              ? modelDisplayName(models, model.billing.standardModel)
              : undefined,
            contextWindow: model.contextWindow,
          };
        }),
      });
    }
    return out;
  }, [forSecond, models, query, second, state?.model]);

  const flat = useMemo(() => groups.flatMap((group) => group.options), [groups]);
  const searching = query.trim() !== "";
  const selectedIndex = flat.findIndex((option) =>
    option.id === FOLLOW_ID ? Boolean(second?.following) : option.id === currentId,
  );
  const activeIndex = Math.min(active ?? Math.max(0, selectedIndex), Math.max(0, flat.length - 1));

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, groups]);

  function choose(option: Option | undefined): void {
    if (!option || option.disabled || locked) return;
    if (!forSecond && option.paid && option.id !== currentId) {
      setPendingPaid(option);
      return;
    }
    if (forSecond) second.onSelect(option.id === FOLLOW_ID ? null : option.id);
    else onSelectModel(option.id);
    onClose();
  }

  function confirmPaid(option: Option): void {
    setPendingPaid(null);
    if (locked) return;
    onSelectModel(option.id, { confirmPaid: true });
    onClose();
  }

  function cancelPaid(): void {
    setPendingPaid(null);
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + flat.length) % flat.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(flat[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (query) setQuery("");
      else onClose();
    }
  }

  const levels = state?.supportedThinkingLevels ?? [];
  const level = state?.thinkingLevel ?? null;
  // The chosen model's cost note stays visible while the picker is open.
  const currentBilling = models.find((model) => model.id === currentId)?.billing;
  let index = 0;

  return (
    <div className="deck-panel model-panel">
      <PanelHead title="Model" onClose={onClose} />
      <div className="deck-prow model-head">
        {second && (
          <div className="key-group" role="radiogroup" aria-label="Choose a model for">
            <button
              type="button"
              className="key key-sm target-key"
              role="radio"
              aria-checked={target === "gg"}
              onClick={() => {
                setTarget("gg");
                setActive(null);
              }}
            >
              GG
              <span className="well trunc">{modelDisplayName(models, state?.model)}</span>
            </button>
            <button
              type="button"
              className="key key-sm target-key"
              role="radio"
              aria-checked={target === "second"}
              title={
                second.following
                  ? `${second.name} follows ${second.followLabel}'s model`
                  : `${second.name} is pinned to ${modelDisplayName(models, second.model)}`
              }
              onClick={() => {
                setTarget("second");
                setActive(null);
              }}
            >
              {second.name}
              <span className="well trunc">
                {second.following
                  ? `= ${second.followLabel}`
                  : modelDisplayName(models, second.model)}
              </span>
            </button>
          </div>
        )}
        <span className="deck-spacer" />
        {!forSecond && levels.length > 0 && (
          <ThinkingKeys
            levels={levels}
            level={level}
            locked={running}
            onChange={(choice) => {
              setThinkingError(null);
              setThinkingLevel(choice).catch((reason: unknown) =>
                setThinkingError(reason instanceof Error ? reason.message : String(reason)),
              );
            }}
          />
        )}
      </div>
      {thinkingError && !forSecond && (
        <p className="deck-note" role="alert">
          Couldn't change thinking: {thinkingError}
        </p>
      )}
      {pendingPaid && (
        <PaidConfirm
          option={pendingPaid}
          onConfirm={() => confirmPaid(pendingPaid)}
          onCancel={cancelPaid}
        />
      )}
      {currentBilling && !pendingPaid && (
        <p className="deck-note" data-paid={currentBilling.paid || undefined}>
          {currentBilling.detail}
        </p>
      )}
      {locked && (
        <p className="deck-note">
          Can't switch models while the agent is working. Stop it or wait.
        </p>
      )}
      {models.length === 0 && (
        <p className="deck-note">
          {modelsFailed
            ? "Couldn't load models from the agent. Reopen the project to try again."
            : "Loading models\u2026"}
        </p>
      )}
      <div
        ref={listRef}
        id={listId}
        hidden={pendingPaid !== null}
        className="deck-list model-list"
        role="listbox"
        aria-label={forSecond ? `${second.name}'s model` : "GG's model"}
      >
        {groups.map((group) =>
          group.options.length === 0 ? null : (
            <div key={group.label} role="group" aria-label={group.label}>
              <div className="deck-group" aria-hidden="true">
                {group.label}
                {!searching && <span className="deck-count">{group.options.length}</span>}
              </div>
              {group.options.map((option) => {
                const i = index++;
                const current =
                  option.id === FOLLOW_ID ? Boolean(second?.following) : option.id === currentId;
                return (
                  <div
                    key={`${group.label}:${option.id}`}
                    id={`${listId}-${i}`}
                    data-index={i}
                    className="deck-option"
                    role="option"
                    aria-selected={i === activeIndex}
                    aria-disabled={option.disabled || locked || undefined}
                    data-current={current || undefined}
                    onMouseMove={() => setActive(i)}
                    onClick={() => choose(option)}
                  >
                    <span className="opt-name">
                      <Highlighted name={option.name} query={query} />
                    </span>
                    {/* Always present so the context size keeps to the right edge. */}
                    <span className="opt-sub" data-paid={option.paid || undefined}>
                      {searching || option.hint ? (option.hint ?? option.provider) : ""}
                    </span>
                    <span className="opt-end">{contextLabel(option.contextWindow)}</span>
                  </div>
                );
              })}
            </div>
          ),
        )}
        {searching && flat.length === 0 && (
          <p className="deck-note">
            No model matches &ldquo;{query}&rdquo;. Try a provider name, like &ldquo;grok&rdquo;.
          </p>
        )}
      </div>
      <label className="deck-field" hidden={pendingPaid !== null}>
        <Icon name="search" size={15} />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={flat.length ? `${listId}-${activeIndex}` : undefined}
          aria-label="Search models"
          autoComplete="off"
          spellCheck={false}
          placeholder={`Search ${models.length} models`}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <span className="deck-hint" aria-hidden="true">
          ↑↓ ↵
        </span>
      </label>
    </div>
  );
}

/**
 * The explicit "this spends real money" step before switching to a paid model.
 * Inline, not a modal: it replaces the list until the user answers, keeps
 * Cancel focused so Enter never pays by accident, and Escape backs out.
 */
function PaidConfirm({
  option,
  onConfirm,
  onCancel,
}: {
  option: Option;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const titleId = useId();
  return (
    <div
      className="paid-confirm"
      role="group"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <p className="deck-note" data-paid>
        <strong id={titleId}>{option.name} spends real money.</strong> {option.billingDetail}
      </p>
      <p className="deck-note">
        It stays on for this session only. New sessions, restarts and new windows go back to{" "}
        {option.standardName || "a standard model"}, and Ken and helper agents never use it.
      </p>
      <div className="deck-prow">
        <span className="deck-spacer" />
        <div className="key-group">
          {/* Cancel takes focus: the safe answer is the default one. */}
          <button type="button" className="key key-sm" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="key key-sm paid-confirm-yes" onClick={onConfirm}>
            Use it and pay
          </button>
        </div>
      </div>
    </div>
  );
}

/** Off plus every level the current model supports. */
function ThinkingKeys({
  levels,
  level,
  locked,
  onChange,
}: {
  levels: readonly string[];
  level: string | null;
  locked: boolean;
  onChange: (level: string | null) => void;
}): React.ReactElement {
  const choices: (string | null)[] = [null, ...levels];
  return (
    <div
      className="key-group thinking-keys"
      role="radiogroup"
      aria-label="Thinking"
      title={locked ? "Can't change thinking while the agent is working" : undefined}
    >
      {choices.map((choice) => (
        <button
          key={choice ?? "off"}
          type="button"
          className="key key-sm"
          role="radio"
          aria-checked={choice === level}
          aria-label={`Thinking ${thinkingLabel(choice)}`}
          disabled={locked}
          onClick={() => onChange(choice)}
        >
          <ThinkingDots levels={levels} level={choice} />
          <span className="lb">{thinkingLabel(choice)}</span>
        </button>
      ))}
    </div>
  );
}
