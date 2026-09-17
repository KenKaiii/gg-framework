import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import {
  PROJECT_ACCENTS,
  PROJECT_COLOUR_NAMES,
  resolveProjectAccent,
  type ProjectColourChoice,
} from "./projectAccent";
import { projectColourStore } from "./project-colours";

const CHOICES: readonly ProjectColourChoice[] = ["Automatic", "None", ...PROJECT_COLOUR_NAMES];

interface Props {
  cwd: string;
  choice: ProjectColourChoice;
  stripe: boolean;
  ready: boolean;
  loadError: string | null;
}

/** Compact non-modal picker. Portal escapes the title's overflow clipping. */
export function ProjectColourPicker({
  cwd,
  choice,
  stripe,
  ready,
  loadError,
}: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<React.CSSProperties | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const savingRef = useRef(false);
  const focusFrame = useRef<number | null>(null);
  const id = useId();
  const accent = resolveProjectAccent(cwd, choice);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (focusFrame.current !== null) window.cancelAnimationFrame(focusFrame.current);
    };
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const trigger = triggerRef.current;
      const picker = pickerRef.current;
      if (!trigger || !picker) return;
      const rect = trigger.getBoundingClientRect();
      // WebKit returns unzoomed rects; Chromium includes the app's CSS zoom.
      // Fixed-position styles and offsets use unzoomed CSS pixels in both.
      const zoom =
        Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("zoom")) || 1;
      const rectZoom = rect.width / trigger.offsetWidth || 1;
      const viewportWidth = window.innerWidth / zoom;
      const viewportHeight = window.innerHeight / zoom;
      const margin = 8;
      const maxWidth = Math.max(0, viewportWidth - margin * 2);
      const maxHeight = Math.max(0, viewportHeight - margin * 2);
      setPos({
        left: Math.max(
          margin,
          Math.min(
            rect.left / rectZoom,
            viewportWidth - Math.min(picker.offsetWidth, maxWidth) - margin,
          ),
        ),
        top: Math.max(
          margin,
          Math.min(
            rect.bottom / rectZoom + 6,
            viewportHeight - Math.min(picker.offsetHeight, maxHeight) - margin,
          ),
        ),
        maxWidth,
        maxHeight,
      });
    };
    let frame: number | null = null;
    const schedulePlace = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        place();
      });
    };
    place();
    window.addEventListener("resize", schedulePlace);
    const zoomObserver = new MutationObserver(schedulePlace);
    zoomObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    const sizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedulePlace);
    if (pickerRef.current) sizeObserver?.observe(pickerRef.current);
    return () => {
      window.removeEventListener("resize", schedulePlace);
      if (frame !== null) window.cancelAnimationFrame(frame);
      zoomObserver.disconnect();
      sizeObserver?.disconnect();
    };
  }, [open, error, loadError]);

  useLayoutEffect(() => {
    if (open) pickerRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (restore: boolean): void => {
      setOpen(false);
      if (restore) triggerRef.current?.focus();
    };
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || pickerRef.current?.contains(target)) return;
      // Let a clicked control receive focus, but do not leave focus in a portal
      // that is about to disappear when the click lands on non-interactive space.
      const interactive =
        target instanceof Element &&
        target.closest("button, a, input, select, textarea, [tabindex]");
      const restore = !interactive && Boolean(pickerRef.current?.contains(document.activeElement));
      dismiss(false);
      if (restore) {
        // The browser's default mouse-down focus happens after pointerdown.
        // Restore on the next frame, unless the click focused another control.
        if (focusFrame.current !== null) window.cancelAnimationFrame(focusFrame.current);
        focusFrame.current = window.requestAnimationFrame(() => {
          focusFrame.current = null;
          if (
            document.activeElement === document.body ||
            document.activeElement === document.documentElement
          ) {
            triggerRef.current?.focus();
          }
        });
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    };
    const onFocus = (event: FocusEvent): void => {
      const target = event.target as Node;
      if (!pickerRef.current?.contains(target) && !triggerRef.current?.contains(target))
        dismiss(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus);
    };
  }, [open]);

  async function save(action: () => Promise<void>): Promise<void> {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await action();
    } catch {
      if (mounted.current) setError("Could not save or confirm this choice. Please try again.");
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`project-colour-trigger${accent ? "" : " project-colour-trigger-none"}`}
        aria-label={`Project colour: ${choice}`}
        title={`Project colour: ${choice} — change colour`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          setError(null);
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="chat-head-accent-dot" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={pickerRef}
            id={id}
            className="project-colour-picker"
            role="dialog"
            aria-labelledby={`${id}-title`}
            aria-busy={saving}
            style={pos ?? { left: 8, top: 8 }}
          >
            <div className="project-colour-picker-heading">
              <span id={`${id}-title`}>Project colour</span>
              <button
                type="button"
                className="project-colour-close"
                aria-label="Close colour picker"
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                ×
              </button>
            </div>
            <div className="project-colour-choices" role="group" aria-label="Colour choices">
              {CHOICES.map((option, index) => (
                <button
                  type="button"
                  key={option}
                  className="project-colour-choice"
                  aria-pressed={option === choice}
                  aria-disabled={!ready || saving}
                  onClick={() => {
                    if (ready && !savingRef.current) {
                      void save(() => projectColourStore.setChoice(cwd, option));
                    }
                  }}
                  onKeyDown={(event) => {
                    const direction =
                      event.key === "ArrowRight" || event.key === "ArrowDown"
                        ? 1
                        : event.key === "ArrowLeft" || event.key === "ArrowUp"
                          ? -1
                          : 0;
                    if (!direction && event.key !== "Home" && event.key !== "End") return;
                    event.preventDefault();
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? CHOICES.length - 1
                          : (index + direction + CHOICES.length) % CHOICES.length;
                    pickerRef.current
                      ?.querySelectorAll<HTMLButtonElement>(".project-colour-choice")
                      [next]?.focus();
                  }}
                >
                  <span
                    className={`project-colour-swatch${option === "None" ? " project-colour-swatch-none" : ""}`}
                    style={
                      option !== "None"
                        ? {
                            background:
                              option === "Automatic"
                                ? (resolveProjectAccent(cwd) ?? undefined)
                                : PROJECT_ACCENTS[index - 2],
                          }
                        : undefined
                    }
                    aria-hidden="true"
                  />
                  <span>{option}</span>
                  {option === choice && (
                    <Check size={14} className="project-colour-check" aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
            <label className="project-colour-stripe-setting">
              <input
                type="checkbox"
                checked={stripe}
                disabled={saving}
                onChange={(event) => {
                  const value = event.currentTarget.checked;
                  void save(() => projectColourStore.setStripe(value));
                }}
              />
              <span>
                Show header stripe
                <small>All project windows on this device</small>
              </span>
            </label>
            {(error || loadError) && (
              <p className="project-colour-error" role="alert">
                {error || loadError}
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
