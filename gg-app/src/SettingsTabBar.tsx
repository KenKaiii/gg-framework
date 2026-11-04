import { useLayoutEffect, useRef } from "react";
import type { Icon } from "@phosphor-icons/react";

/**
 * The Settings screen's floating capsule of tabs, ported from yaatuber's
 * settings tab bar (segmented-tabs.ts, itself Glance's SettingsTabBar):
 * icon-only tabs, with the selected tab widening to show its label under one
 * pill. Hover only lightens a tab. Selecting one (click, or arrow keys) springs
 * the pill across, glides the tabs its label pushed aside, and unfurls the new
 * label out of its icon (fade + 4px blur + 10px slide).
 */

export interface SettingsTab<Id extends string> {
  id: Id;
  label: string;
  icon: Icon;
  /** A small red dot on the icon: something on this tab needs attention. */
  alert?: boolean;
}

interface Props<Id extends string> {
  tabs: readonly SettingsTab<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
  /** Id of the panel element the tabs control. */
  panelId: string;
  /** Accessible name and tab ids when this control is reused outside Settings. */
  label?: string;
  tabIdPrefix?: string;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where everything sat on screen just before a selection change. */
interface Before {
  pill: DOMRect | null;
  tabs: Map<string, DOMRect>;
}

function readMotion(): { easing: string; durationMs: number; reduced: boolean } {
  const style = getComputedStyle(document.documentElement);
  const seconds = parseFloat(style.getPropertyValue("--duration-spring"));
  return {
    easing: style.getPropertyValue("--ease-spring").trim() || "ease-out",
    durationMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 500,
    // No Web Animations (older WebKit, jsdom) is treated like reduced motion:
    // the pill still lands on the right tab, it just does not travel.
    reduced:
      typeof Element.prototype.animate !== "function" ||
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches),
  };
}

function tabButtons(bar: HTMLElement): HTMLElement[] {
  return Array.from(bar.querySelectorAll<HTMLElement>(":scope > [data-tab-id]"));
}

function boxOf(tab: HTMLElement): Box {
  return { x: tab.offsetLeft, y: tab.offsetTop, width: tab.offsetWidth, height: tab.offsetHeight };
}

function paint(pill: HTMLElement, box: Box): void {
  pill.style.width = `${box.width}px`;
  pill.style.height = `${box.height}px`;
  pill.style.transform = `translate(${box.x}px, ${box.y}px)`;
}

function cancelAnimations(el: Element): void {
  if (typeof el.getAnimations !== "function") return;
  for (const animation of el.getAnimations()) animation.cancel();
}

export function SettingsTabBar<Id extends string>({
  tabs,
  selected,
  onSelect,
  panelId,
  label = "Settings sections",
  tabIdPrefix = "settings-tab",
}: Props<Id>): React.ReactElement {
  const barRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const beforeRef = useRef<Before | null>(null);

  function select(id: Id): void {
    const bar = barRef.current;
    if (id === selected || !bar) return;
    const pill = pillRef.current;
    beforeRef.current = {
      pill: pill?.classList.contains("is-placed") ? pill.getBoundingClientRect() : null,
      tabs: new Map(
        tabButtons(bar).map((el) => [el.dataset["tabId"] ?? "", el.getBoundingClientRect()]),
      ),
    };
    onSelect(id);
  }

  // Selection changed: put the pill on the new tab and, unless motion is
  // reduced, spring everything from where it was on screen a moment ago.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const pill = pillRef.current;
    if (!bar || !pill) return;
    const target = bar.querySelector<HTMLElement>(`:scope > [data-tab-id="${selected}"]`);
    if (!target) return;
    const before = beforeRef.current;
    beforeRef.current = null;

    const all = tabButtons(bar);
    for (const el of [pill, ...all]) cancelAnimations(el);
    const to = boxOf(target);
    paint(pill, to);
    pill.classList.add("is-placed");

    const motion = readMotion();
    if (!before || motion.reduced) return;
    const spring = { duration: motion.durationMs, easing: motion.easing };
    const barRect = bar.getBoundingClientRect();

    for (const el of all) {
      const old = before.tabs.get(el.dataset["tabId"] ?? "");
      const dx = old ? old.left - el.getBoundingClientRect().left : 0;
      if (Math.abs(dx) > 0.5) {
        el.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], spring);
      }
    }

    if (before.pill) {
      const from: Box = {
        x: before.pill.left - barRect.left - bar.clientLeft,
        y: before.pill.top - barRect.top - bar.clientTop,
        width: before.pill.width,
        height: before.pill.height,
      };
      pill.animate(
        [
          {
            width: `${from.width}px`,
            height: `${from.height}px`,
            transform: `translate(${from.x}px, ${from.y}px)`,
          },
          {
            width: `${to.width}px`,
            height: `${to.height}px`,
            transform: `translate(${to.x}px, ${to.y}px)`,
          },
        ],
        spring,
      );
    }

    target.querySelector(".settings-tab-label")?.animate(
      [
        { opacity: 0, filter: "blur(4px)", transform: "translateX(-10px)" },
        { opacity: 1, filter: "blur(0)", transform: "none" },
      ],
      spring,
    );
  }, [selected]);

  // Layout changes that are not a selection (fonts landing, a window resize)
  // re-place the pill instantly.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const pill = pillRef.current;
    if (!bar || !pill) return;
    const place = (): void => {
      const target = bar.querySelector<HTMLElement>(":scope > [aria-selected='true']");
      if (target && target.offsetWidth > 0) paint(pill, boxOf(target));
    };
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) place();
    });
    if (typeof ResizeObserver !== "function") {
      return () => {
        alive = false;
      };
    }
    const observer = new ResizeObserver(place);
    observer.observe(bar);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, []);

  // Arrow keys, Home and End move between tabs, selecting as they go (the
  // tabs pattern with automatic activation, as in yaatuber).
  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    const last = tabs.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    const target = next === null ? undefined : tabs[next];
    if (!target) return;
    event.preventDefault();
    select(target.id);
    barRef.current?.querySelector<HTMLElement>(`:scope > [data-tab-id="${target.id}"]`)?.focus();
  }

  return (
    <div className="settings-tab-dock">
      <div className="settings-tabs" ref={barRef} role="tablist" aria-label={label}>
        <span className="settings-tabs-pill" ref={pillRef} aria-hidden="true" />
        {tabs.map((tab, index) => {
          const TabIcon = tab.icon;
          const active = tab.id === selected;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className={active ? "settings-tab is-active" : "settings-tab"}
              data-tab-id={tab.id}
              id={`${tabIdPrefix}-${tab.id}`}
              aria-label={tab.label}
              aria-selected={active}
              aria-controls={panelId}
              tabIndex={active ? 0 : -1}
              onKeyDown={(event) => onKeyDown(event, index)}
              onClick={() => select(tab.id)}
            >
              <span className="settings-tab-icon">
                <TabIcon size={19} weight={active ? "fill" : "regular"} aria-hidden="true" />
                {tab.alert && <span className="settings-tab-alert" aria-hidden="true" />}
              </span>
              <span className="settings-tab-label">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
