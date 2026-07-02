/**
 * Autopilot toggle — the Material-style switch (Uiverse by lenin55) that turns
 * auto-review on/off for THIS window's project. Sits left of the "+ New" button
 * in the nav row. State lives on the sidecar (persisted per-cwd in gg-app.json);
 * this is a controlled switch that optimistically flips then fires `setAutopilot`.
 *
 * Markup mirrors the source snippet exactly (label.cl-switch > input + span);
 * the styling lives in `.cl-switch` rules in App.css, re-themed to the app's
 * accent so the "on" track/thumb read as gg-coder purple, not the original teal.
 */
interface Props {
  /** Current on/off state (from the sidecar's AgentState). */
  checked: boolean;
  /** Fired with the next value when the user flips the switch. */
  onChange: (next: boolean) => void;
  /** True while GG Coder (or an autopilot review/injected run) is active —
   *  disables the switch, mirroring "+ New" and "/commit". Autopilot must be
   *  idle before its own on/off state can change. */
  disabled?: boolean;
}

export function AutopilotToggle({ checked, onChange, disabled }: Props): React.ReactElement {
  return (
    <span
      className="autopilot-toggle"
      title="Autopilot: after each run, auto-review the work and continue if adjustments are needed"
      data-suppress-click-sound
    >
      <span className="autopilot-label">Autopilot</span>
      <span className="cl-toggle-switch">
        <label className="cl-switch">
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span />
        </label>
      </span>
    </span>
  );
}
