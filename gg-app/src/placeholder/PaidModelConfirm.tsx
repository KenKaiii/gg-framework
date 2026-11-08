import { useId } from "react";
import type { ModelOption } from "../agent";
import "./placeholder.css";

/**
 * Placeholder (the fork owns the desktop design): the explicit "this spends
 * real money" step before switching to a paid model (Claude fast mode, MiMo
 * UltraSpeed). Cancel takes focus so Enter never pays by accident, and Escape
 * backs out.
 */
export function PaidModelConfirm({
  model,
  standardName,
  onConfirm,
  onCancel,
}: {
  model: Pick<ModelOption, "name" | "billing">;
  /** The model sessions go back to when this paid one isn't carried over. */
  standardName?: string;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const titleId = useId();
  return (
    <div
      className="placeholder-notice"
      role="group"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <div className="placeholder-notice-body">
        <p>
          <strong id={titleId} className="placeholder-attention">
            {model.name} spends real money.
          </strong>{" "}
          {model.billing?.detail}
        </p>
        <p className="placeholder-muted">
          It stays on for this session only. New sessions, restarts and new windows go back to{" "}
          {standardName || "a standard model"}, and the Helper and sub-agents never use it.
        </p>
        {/* Cancel takes focus: the safe answer is the default one. */}
        <button type="button" autoFocus onClick={onCancel}>
          Cancel
        </button>{" "}
        <button type="button" onClick={onConfirm}>
          Use it and pay
        </button>
      </div>
    </div>
  );
}
