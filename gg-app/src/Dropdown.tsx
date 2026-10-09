import { useEffect, useId, useRef, useState } from "react";
import { CheckIcon, CaretDownIcon } from "@phosphor-icons/react";
import { FloatingSurface } from "./FloatingSurface";
import { useScrollEdges } from "./popover";

export interface DropdownOption {
  value: string;
  label: string;
  /** Secondary line under the label (e.g. a station's genre). */
  description?: string;
  disabled?: boolean;
}

interface Props {
  options: readonly DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  /** Accessible name — there is no native <select> to borrow a label from. */
  label: string;
  disabled?: boolean;
  /** Shown when nothing is selected (or the list is still empty). */
  placeholder?: string;
  /** Extra class on the wrapper (width overrides etc.). */
  className?: string;
  /** Id for the trigger, so a form `<label htmlFor>` can point at it. */
  id?: string;
  /** Id(s) of help text describing the field, set as the trigger's `aria-describedby`. */
  describedBy?: string;
}

/**
 * Custom listbox dropdown: a styled trigger plus an in-webview option list.
 *
 * A native `<select>` popup is drawn by the OS, so it ignores the app's theme
 * entirely and can't show a per-option description. This renders the list
 * ourselves, following the platform listbox contract — `aria-activedescendant`
 * keeps focus on the listbox while arrows move the active option, Enter/Space
 * commit, Escape cancels, and focus returns to the trigger either way.
 *
 * Escape and outside clicks are stopped here rather than allowed to bubble:
 * the dropdown is used inside `Modal`, whose document-level Escape handler
 * would otherwise close the whole modal along with the open list.
 */
export function Dropdown({
  options,
  value,
  onChange,
  label,
  disabled,
  placeholder = "Select\u2026",
  className,
  id,
  describedBy,
}: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const onListScroll = useScrollEdges(listRef, open);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number): string => `${baseId}-option-${index}`;

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const unavailable = Boolean(disabled) || options.length === 0;

  useEffect(() => {
    if (unavailable) setOpen(false);
  }, [unavailable]);

  function openList(): void {
    if (unavailable) return;
    // Start on the current value so arrowing moves relative to what's playing,
    // not from the top of the list every time.
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }

  function closeList(returnFocus = true): void {
    // The list folds back up into the trigger (see "Exits" in App.css).
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function commit(index: number): void {
    const option = options[index];
    if (!option || option.disabled) return;
    closeList();
    if (option.value !== value) onChange(option.value);
  }

  // Move to the next selectable option in `direction`, skipping disabled rows
  // so a disabled entry can never trap the keyboard.
  function step(from: number, direction: 1 | -1): number {
    for (let offset = 1; offset <= options.length; offset++) {
      const raw = (from + direction * offset) % options.length;
      const index = raw < 0 ? raw + options.length : raw;
      if (!options[index]?.disabled) return index;
    }
    return from;
  }

  function edge(direction: 1 | -1): number {
    const start = direction === 1 ? 0 : options.length - 1;
    return options[start]?.disabled ? step(start, direction) : start;
  }

  useEffect(() => {
    if (!open) return;
    // A press that starts outside the control cancels the list. Registered on
    // the next tick so the click that opened it doesn't immediately close it.
    const closeOnOutsidePress = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const listenerId = window.setTimeout(
      () => document.addEventListener("mousedown", closeOnOutsidePress),
      0,
    );
    requestAnimationFrame(() => listRef.current?.focus());
    return () => {
      window.clearTimeout(listenerId);
      document.removeEventListener("mousedown", closeOnOutsidePress);
    };
  }, [open]);

  // Keep the active option in view when arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    // Rows are the list's direct children, in option order.
    const row = listRef.current?.children[activeIndex];
    if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
  });

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === " ") {
      event.preventDefault();
      openList();
    }
  }

  function onListKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((current) => step(current, event.key === "ArrowDown" ? 1 : -1));
        return;
      case "Home":
      case "End":
        event.preventDefault();
        setActiveIndex(edge(event.key === "Home" ? 1 : -1));
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        return;
      case "Escape":
        event.preventDefault();
        // Cancel the list only — never the modal hosting it.
        event.nativeEvent.stopPropagation();
        closeList();
        return;
      case "Tab":
        closeList(false);
        return;
      default:
    }
  }

  return (
    <div className={className ? `dropdown ${className}` : "dropdown"} ref={rootRef}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="dropdown-trigger"
        disabled={unavailable}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        aria-describedby={describedBy}
        onClick={() => (open ? closeList(false) : openList())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="dropdown-value">{selected?.label ?? placeholder}</span>
        <CaretDownIcon className="dropdown-chevron" size={16} aria-hidden="true" />
      </button>
      <FloatingSurface>
        {open && !unavailable && (
          <div className="dropdown-menu">
            <div
              ref={listRef}
              id={listId}
              className="pop-scroll dropdown-list"
              role="listbox"
              aria-label={label}
              aria-activedescendant={optionId(activeIndex)}
              tabIndex={-1}
              onKeyDown={onListKeyDown}
              onScroll={onListScroll}
            >
              {options.map((option, index) => (
                <div
                  key={option.value}
                  id={optionId(index)}
                  className={`dropdown-option${index === activeIndex ? " active" : ""}`}
                  role="option"
                  aria-selected={option.value === value}
                  aria-disabled={option.disabled || undefined}
                  onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                  onClick={() => commit(index)}
                >
                  <span className="dropdown-option-text">
                    <span className="dropdown-option-label">{option.label}</span>
                    {option.description && (
                      <span className="dropdown-option-description">{option.description}</span>
                    )}
                  </span>
                  {option.value === value && (
                    <CheckIcon className="dropdown-option-check" size={14} aria-hidden="true" />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </FloatingSurface>
    </div>
  );
}
