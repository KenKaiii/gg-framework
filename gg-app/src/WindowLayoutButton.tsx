import { useEffect, useId, useRef, useState } from "react";
import { AppWindow } from "lucide-react";
import { setupWindows, arrangeAllWindows } from "./agent";
import { supportsNativeSelectPopup } from "./platform";
import { playSound } from "./sounds";
import { theme } from "./theme";

/**
 * Titlebar control that tiles the app into a 2-, 4-, or 6-window grid, or
 * auto-arranges all open windows. macOS uses a native select popup;
 * Windows/Linux use an in-webview fallback to avoid embedded-webview popup
 * regressions that can open a list without allowing a selection.
 */
export function WindowLayoutButton({ onArrange }: { onArrange?: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

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
    requestAnimationFrame(() =>
      rootRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus(),
    );
    return () => {
      window.clearTimeout(listenerId);
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  async function run(choice: string): Promise<void> {
    if (busy) return;
    setOpen(false);
    setBusy(true);
    try {
      if (choice === "auto") {
        await arrangeAllWindows();
      } else {
        const count = Number(choice);
        if (count > 1) {
          onArrange?.();
          playSound("hover");
        }
        await setupWindows(count);
      }
    } finally {
      setBusy(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }

  function moveMenuFocus(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']"),
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

  if (supportsNativeSelectPopup()) {
    return (
      <span className="winlayout">
        <span className="winlayout-icon-btn btn btn-ghost btn-sm btn-nav-icon" aria-hidden="true">
          <AppWindow size={16} />
        </span>
        <select
          className="winlayout-select"
          value=""
          disabled={busy}
          title="Arrange into multiple project windows"
          aria-label="Arrange into multiple project windows"
          onChange={(event) => {
            if (event.target.value) void run(event.target.value);
          }}
        >
          <option value="" disabled>
            Arrange
          </option>
          <option value="2">2 windows</option>
          <option value="4">4 windows</option>
          <option value="6">6 windows</option>
          <option value="auto">Auto-arrange all</option>
        </select>
      </span>
    );
  }

  return (
    <div className="winlayout" ref={rootRef}>
      <button
        ref={triggerRef}
        className="btn btn-ghost btn-sm btn-nav-icon"
        disabled={busy}
        title="Arrange into multiple project windows"
        aria-label="Arrange into multiple project windows"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <AppWindow size={16} />
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />
          <div
            id={menuId}
            className="winlayout-menu"
            role="menu"
            aria-label="Window layout"
            onKeyDown={moveMenuFocus}
            style={{ background: theme.surface2, borderColor: theme.border }}
          >
            <button role="menuitem" className="winlayout-item" onClick={() => void run("2")}>
              2 windows
            </button>
            <button role="menuitem" className="winlayout-item" onClick={() => void run("4")}>
              4 windows
            </button>
            <button role="menuitem" className="winlayout-item" onClick={() => void run("6")}>
              6 windows
            </button>
            <div className="winlayout-divider" role="separator" />
            <button role="menuitem" className="winlayout-item" onClick={() => void run("auto")}>
              Auto-arrange all
            </button>
          </div>
        </>
      )}
    </div>
  );
}
