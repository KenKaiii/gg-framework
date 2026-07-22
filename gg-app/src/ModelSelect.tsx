import { theme } from "./theme";
import { modelDisplayName } from "./model-name";
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
}

const FOLLOW_VALUE = "__follow__";

/**
 * Footer model picker: reads as plain text (like the old footer button), but
 * the text is covered by a transparent native <select> stretched over it —
 * clicking anywhere on the model name opens the OS-native dropdown, so there's
 * no popover to position or dismiss. The visible label is a separate span
 * (aria-hidden); the select itself carries the value, options, and a11y name.
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
}: Props): React.ReactElement {
  const following = Boolean(onSelectFollow && followActive);
  const value = following ? FOLLOW_VALUE : currentModel;
  // Keep the control showing the active model even before the registry list
  // hydrates (or if the pinned model was removed from it).
  const known = models.some((m) => m.id === currentModel);

  return (
    <span className="model-picker" style={{ color: color ?? theme.text }}>
      <span className="model-select-text" aria-hidden="true">
        {modelDisplayName(models, currentModel)}
      </span>
      <select
        className="model-select"
        value={value}
        disabled={disabled || models.length === 0}
        title={title}
        aria-label={title}
        onChange={(e) => {
          const next = e.target.value;
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
        {models.map((m) => (
          <option key={`${m.provider}:${m.id}`} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </span>
  );
}
