import { useEffect, useId, useRef, useState } from "react";
import { theme } from "./theme";
import { FloatingSurface } from "./FloatingSurface";
import { useScrollEdges } from "./popover";
import { modelDisplayName } from "./model-name";
import { groupByProvider } from "./provider-labels";
import { supportsNativeSelectPopup } from "./platform";
import type { ModelOption } from "./agent";

interface Props {
  models: readonly ModelOption[];
  currentModel: string;
  onSelect: (modelId: string) => void;
  disabled?: boolean;
  /** Tooltip + accessible name (e.g. "Switch GG Coder's model"). */
  title: string;
  /** Optional compact action copy; the menu still selects the current model. */
  label?: string;
  /** Accent color for the closed control (GG = text, Ken = ken). */
  color?: string;
  /** When set, adds a "Follow GG Coder" choice (Ken's picker) — selecting it
   *  clears the pin. `followActive` makes it the selected value. */
  onSelectFollow?: () => void;
  followActive?: boolean;
  /** The model list failed to load. With no models, the locked picker says
   *  so instead of claiming it is still connecting. */
  loadFailed?: boolean;
}

const FOLLOW_VALUE = "__follow__";

/** Backoff before each attempt, in ms. First try is immediate. */
const MODEL_LOAD_RETRIES = [0, 400, 1200, 2500];

/**
 * Load the model list, retrying a transient failure or an empty answer.
 *
 * The list is fetched once per session and an empty list disables the picker
 * outright, so one unlucky call used to leave a dead dropdown for the whole
 * session — the user's only escape was reopening the project. This is the
 * Windows-only report: the sidecar boots slower there (antivirus scans the
 * bundled node binary), so this first call is the one most likely to arrive
 * before `/models` can answer. The `models_change` event refetches only on
 * auth or discovery changes, which may never come.
 *
 * An empty list is retried as well: at boot it nearly always means providers
 * are still registering. A genuinely empty list (nothing connected) costs only
 * these few attempts, and `models_change` still corrects it later.
 */
export async function loadModelsWithRetry(
  fetchModels: () => Promise<ModelOption[] | null>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<ModelOption[] | null> {
  let last: ModelOption[] | null = null;
  for (const delay of MODEL_LOAD_RETRIES) {
    if (delay > 0) await sleep(delay);
    last = await fetchModels();
    if (last && last.length > 0) return last;
  }
  return last;
}

/**
 * Run {@link loadModelsWithRetry} in the background and apply the result only
 * if it is still wanted.
 *
 * The load is deliberately not awaited by its caller, so on a project switch
 * the PREVIOUS sidecar's retries can still be in flight — and with backoff they
 * can easily outlive the switch. Without `isStale` the old sidecar's list would
 * land after the new one's and leave the picker showing models that belong to a
 * project the user already left. `apply` is skipped entirely on failure, so the
 * picker keeps whatever it already had.
 *
 * Resolves `false` only when every attempt failed, so the caller can show a
 * failed-load state; `true` when the list was applied or the load went stale.
 */
export async function loadModelsInto(
  fetchModels: () => Promise<ModelOption[] | null>,
  apply: (models: ModelOption[]) => void,
  isStale: () => boolean,
  sleep?: (ms: number) => Promise<void>,
): Promise<boolean> {
  const models = await loadModelsWithRetry(fetchModels, sleep);
  if (!models) return false;
  if (isStale()) return true;
  apply(models);
  return true;
}

/**
 * Footer model picker. macOS uses its reliable native popup; Windows/Linux use
 * an in-webview menu because their embedded webviews have shipped native select
 * regressions where the popup opens but cannot commit a mouse selection.
 */
export function ModelSelect({
  models,
  currentModel,
  onSelect,
  disabled,
  title,
  label,
  color,
  onSelectFollow,
  followActive,
  loadFailed,
}: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollEdges(scrollRef, open);
  const menuId = useId();
  const following = Boolean(onSelectFollow && followActive);
  const value = following ? FOLLOW_VALUE : currentModel;
  const known = models.some((model) => model.id === currentModel);
  const unavailable = Boolean(disabled || models.length === 0);
  // A locked picker has to SAY it is locked. Both controls render the model as
  // plain footer text, so without this the disabled state is invisible: the
  // label looks identical, the click does nothing, and the tooltip still
  // promises "Switch GG Coder's model". Users read that as a broken dropdown
  // (and the sidecar agrees with the lock — POST /model answers 409 while a run
  // is in flight), so name the reason instead of going quietly inert.
  const unavailableReason = disabled
    ? "Can't switch models while the agent is running — cancel the run or wait for it to finish"
    : models.length === 0
      ? loadFailed
        ? "Couldn't load models from the agent. Reopen the project to try again."
        : "No models available yet — still connecting to the agent"
      : null;
  // One group per provider company, in registry order, with Local pinned last
  // (it's the user's own machine, not an account, and its length depends on what
  // they've pulled). A flat list of 40+ models across a dozen vendors is
  // unreadable; the vendor is the first thing you scan for.
  const groups = groupByProvider(models);
  const activeLocal = models.find((model) => model.id === currentModel && model.local);
  // Which machine/server is answering matters when a local model is active.
  const triggerTitle =
    unavailableReason ?? (activeLocal?.endpoint ? `${title} — ${activeLocal.endpoint}` : title);
  // Dim to match every other disabled control in the footer, so "you can't use
  // this right now" is visible before the click rather than after it.
  //
  // Rest one step below full ink: hover lifts the label with `filter: brightness`
  // (App.css), and `theme.text` is so close to white that brightening it clips to
  // #fff with no visible change. Callers passing their own `color` (Ken's picker)
  // are mid-range already and keep it.
  const controlColor = unavailable ? theme.textDim : (color ?? theme.textSecondary);

  useEffect(() => {
    if (unavailable) setOpen(false);
  }, [unavailable]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const listenerId = window.setTimeout(
      () => document.addEventListener("mousedown", closeOnOutsideClick),
      0,
    );
    document.addEventListener("keydown", closeOnEscape);
    requestAnimationFrame(() => {
      const menu = rootRef.current?.querySelector<HTMLElement>(".model-menu");
      const active = menu?.querySelector<HTMLElement>("[aria-checked='true']");
      (active ?? menu?.querySelector<HTMLElement>("[role='menuitemradio']"))?.focus();
    });
    return () => {
      window.clearTimeout(listenerId);
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function chooseModel(modelId: string): void {
    setOpen(false);
    onSelect(modelId);
    triggerRef.current?.focus();
  }

  function chooseFollow(): void {
    setOpen(false);
    onSelectFollow?.();
    triggerRef.current?.focus();
  }

  function moveMenuFocus(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitemradio']"),
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  function renderItem(model: ModelOption): React.ReactElement {
    const active = model.id === currentModel && !(onSelectFollow && following);
    // A local model that can't call tools can't run the agent — keep it visible
    // (so the user knows it was found) but unselectable, with the reason.
    const toolless = model.supportsTools === false;
    return (
      <button
        key={`${model.provider}:${model.id}`}
        className="model-menu-item"
        role="menuitemradio"
        aria-checked={active}
        disabled={toolless}
        style={{ color: toolless ? theme.textDim : active ? theme.primary : theme.text }}
        onClick={() => chooseModel(model.id)}
        title={
          toolless
            ? `${model.name} has no tool calling, so it can't run the agent`
            : model.endpoint
              ? `${model.endpoint} · ${model.id}`
              : `${model.provider} · ${model.id}`
        }
      >
        {model.name}
      </button>
    );
  }

  if (supportsNativeSelectPopup()) {
    return (
      <span className="model-picker model-picker-native" style={{ color: controlColor }}>
        <span className="model-select-text" aria-hidden="true">
          {label ?? modelDisplayName(models, currentModel)}
        </span>
        <select
          className="model-select"
          value={value}
          disabled={unavailable}
          title={triggerTitle}
          aria-label={title}
          onChange={(event) => {
            const next = event.target.value;
            if (next === FOLLOW_VALUE) onSelectFollow?.();
            else if (next) onSelect(next);
          }}
        >
          {value === "" && (
            <option value="" disabled>
              {"\u2026"}
            </option>
          )}
          {onSelectFollow && (
            <option value={FOLLOW_VALUE}>
              {following
                ? `Follow GG Coder (${modelDisplayName(models, currentModel)})`
                : "Follow GG Coder"}
            </option>
          )}
          {!known && currentModel !== "" && <option value={currentModel}>{currentModel}</option>}
          {groups.map((group) => (
            <optgroup key={group.provider} label={group.label}>
              {group.models.map((model) => (
                <option
                  key={`${model.provider}:${model.id}`}
                  value={model.id}
                  disabled={model.supportsTools === false}
                >
                  {model.supportsTools === false ? `${model.name} — no tool calling` : model.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </span>
    );
  }

  return (
    <span className="model-picker" ref={rootRef} style={{ color: controlColor }}>
      <button
        ref={triggerRef}
        className="model-button"
        style={{ color: controlColor }}
        disabled={unavailable}
        title={triggerTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {label ?? modelDisplayName(models, currentModel)}
      </button>
      <FloatingSurface>
        {open && !unavailable && (
          <div
            id={menuId}
            className="model-menu"
            role="menu"
            aria-label={title}
            onKeyDown={moveMenuFocus}
            style={{ background: theme.surface2, borderColor: theme.border }}
          >
            <div className="model-menu-title" style={{ color: theme.textMuted }} aria-hidden="true">
              {title}
            </div>
            <div ref={scrollRef} className="pop-scroll model-menu-scroll" onScroll={onScroll}>
              {onSelectFollow && (
                <button
                  className="model-menu-item model-menu-follow"
                  role="menuitemradio"
                  aria-checked={following}
                  style={{ color: following ? theme.primary : theme.text }}
                  onClick={chooseFollow}
                  title="Ken adopts whatever model GG Coder is using"
                >
                  Follow GG Coder
                </button>
              )}
              {groups.map((group) => (
                <div key={group.provider} className="model-menu-section">
                  <div
                    className="model-menu-subtitle"
                    style={{ color: theme.textMuted }}
                    aria-hidden="true"
                  >
                    {group.label}
                  </div>
                  <div className="model-menu-grid" role="group" aria-label={group.label}>
                    {group.models.map((model) => renderItem(model))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </FloatingSurface>
    </span>
  );
}
