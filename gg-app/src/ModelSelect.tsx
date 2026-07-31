import { useEffect, useId, useRef, useState } from "react";
import { theme } from "./theme";
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
  /** Accent color for the closed control (GG = text, Ken = ken). */
  color?: string;
  /** When set, adds a "Follow GG Coder" choice (Ken's picker) — selecting it
   *  clears the pin. `followActive` makes it the selected value. */
  onSelectFollow?: () => void;
  followActive?: boolean;
  /** Incremented when the backing daemon/catalog identity changes. */
  refreshNonce?: number;
}

const FOLLOW_VALUE = "__follow__";

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
  color,
  onSelectFollow,
  followActive,
  refreshNonce = 0,
}: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const following = Boolean(onSelectFollow && followActive);
  const value = following ? FOLLOW_VALUE : currentModel;
  const known = models.some((model) => model.id === currentModel);
  const unavailable = Boolean(disabled || models.length === 0);
  // One group per provider company, in registry order, with Local pinned last
  // (it's the user's own machine, not an account, and its length depends on what
  // they've pulled). A flat list of 40+ models across a dozen vendors is
  // unreadable; the vendor is the first thing you scan for.
  const groups = groupByProvider(models);
  const activeLocal = models.find((model) => model.id === currentModel && model.local);
  // Which machine/server is answering matters when a local model is active.
  const triggerTitle = activeLocal?.endpoint ? `${title} — ${activeLocal.endpoint}` : title;

  useEffect(() => {
    setOpen(false);
  }, [models, refreshNonce]);

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
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function chooseFollow(): void {
    setOpen(false);
    onSelectFollow?.();
    requestAnimationFrame(() => triggerRef.current?.focus());
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
        style={{
          color: toolless ? theme.textDim : active ? theme.primary : theme.text,
          background: active ? theme.surface2 : "transparent",
        }}
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
      <span className="model-picker model-picker-native" style={{ color: color ?? theme.text }}>
        <span className="model-select-text" aria-hidden="true">
          {modelDisplayName(models, currentModel)}
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
    <span className="model-picker" ref={rootRef} style={{ color: color ?? theme.text }}>
      <button
        ref={triggerRef}
        className="model-button"
        style={{ color: color ?? theme.text }}
        disabled={unavailable}
        title={triggerTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {modelDisplayName(models, currentModel)}
      </button>
      {open && (
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
          {onSelectFollow && (
            <button
              className="model-menu-item model-menu-follow"
              role="menuitemradio"
              aria-checked={following}
              style={{
                color: following ? theme.primary : theme.text,
                background: following ? theme.surface2 : "transparent",
              }}
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
      )}
    </span>
  );
}
