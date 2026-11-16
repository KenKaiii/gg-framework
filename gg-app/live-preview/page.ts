// Live preview's page script. Added to the previewed app by the page proxy, it
// runs among the app's own scripts, so it holds nothing worth stealing: it
// picks elements, draws outlines and hosts the chat, which is a cross-origin
// iframe (frame/main.tsx). It sends the frame element data only.
import { parseFrameMessage, type PageToFrame, type PickedElement } from "./protocol";

export interface Picked {
  selector: string;
  tag: string;
  text: string;
  /** The route it was picked on. */
  path: string;
  /** Its classes, to recognise it after a re-render. */
  cls: string;
}

export function selectorFor(start: Element | null, root: Element | null = document.body): string {
  const parts: string[] = [];
  let el = start;
  while (el && el.nodeType === 1 && el !== root && parts.length < 5) {
    let part = el.tagName.toLowerCase();
    if (el.id) {
      parts.unshift(`${part}#${CSS.escape(el.id)}`);
      break;
    }
    const cls = [...el.classList]
      .slice(0, 2)
      .map((c) => CSS.escape(c))
      .join(".");
    if (cls) part += `.${cls}`;
    const parent: Element | null = el.parentElement;
    const tag = el.tagName;
    const sibs = parent ? [...parent.children].filter((s) => s.tagName === tag) : [];
    if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(el) + 1})`;
    parts.unshift(part);
    el = parent;
  }
  return parts.join(" > ");
}

export const labelFor = (el: Element): { tag: string; text: string } => ({
  tag: el.tagName.toLowerCase(),
  text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
});

const classesOf = (el: Element): string => [...el.classList].join(" ");

export function pickedFrom(el: Element, pathname = location.pathname): Picked {
  return { selector: selectorFor(el), ...labelFor(el), path: pathname, cls: classesOf(el) };
}

/**
 * Find the picked element again after a reload or hot update replaced it. The
 * same content wins over the same position, since an edit may have shifted its
 * siblings; position decides only when the content itself changed (or is ambiguous).
 */
export function findPicked(
  p: Picked,
  doc: Document = document,
  pathname = location.pathname,
): Element | null {
  if (p.path !== pathname) return null;
  let bySelector: Element | null = null;
  try {
    bySelector = doc.querySelector(p.selector);
  } catch {
    /* a selector from an older page that no longer parses */
  }
  const twins = [...doc.querySelectorAll(p.tag)].filter(
    (el) => classesOf(el) === p.cls && labelFor(el).text === p.text,
  );
  if (twins.length === 1) return twins[0];
  if (twins.length > 1) return bySelector && twins.includes(bySelector) ? bySelector : twins[0];
  return bySelector && bySelector.tagName.toLowerCase() === p.tag ? bySelector : null;
}

// Arrow with click rays at the tip (hotspot 9,7): dark fill and a white edge read on any page.
const PICK_CURSOR = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><path d="M9 7v15.6l4.1-4.2 3 6.9 2.7-1.2-3-6.8h5.9z" fill="#16171c" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/><g stroke="#4c5bf0" stroke-width="2" stroke-linecap="round"><path d="M9 1.6v2.2"/><path d="M3.6 7h2.2"/><path d="M4.9 2.9l1.5 1.5"/><path d="M13.1 2.9l-1.5 1.5"/></g></svg>`;

const DOC_CSS = `html.gg-live-picking, html.gg-live-picking * { cursor: url("data:image/svg+xml,${encodeURIComponent(PICK_CURSOR)}") 9 7, default !important; }
gg-live-preview { all: initial !important; position: fixed !important; inset: 0 !important; pointer-events: none !important; margin: 0 !important; padding: 0 !important; border: 0 !important; background: transparent !important; overflow: visible !important; width: auto !important; height: auto !important; max-width: none !important; max-height: none !important; z-index: 2147483647 !important; display: block !important; }
gg-live-marks { all: initial !important; position: absolute !important; left: 0 !important; top: 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; pointer-events: none !important; z-index: 2147483646 !important; display: block !important; }`;

// One blue-violet that holds 3:1 on light and dark pages and doesn't read as an error.
const MARKS_CSS = `:host { --pick: #4c5bf0; --pick-rgb: 76 91 240; --ease: cubic-bezier(0.16, 1, 0.3, 1); }
.outline { position: absolute; left: 0; top: 0; border-radius: 6px; opacity: 0; pointer-events: none; box-sizing: border-box;
  transition: transform 200ms var(--ease), width 200ms var(--ease), height 200ms var(--ease), opacity 160ms ease-out; }
.outline.on { opacity: 1; }
.outline.snap { transition: opacity 160ms ease-out; }
.hovering { background: rgb(var(--pick-rgb) / 0.08); box-shadow: inset 0 0 0 1px rgb(var(--pick-rgb) / 0.8); }
.picked { background: rgb(var(--pick-rgb) / 0.05); box-shadow: inset 0 0 0 1.5px var(--pick), 0 0 0 1px rgb(255 255 255 / 0.55); }
.pulse { position: absolute; inset: 0; border-radius: inherit; animation: pulse 560ms cubic-bezier(0.22, 1, 0.36, 1) both; }
@keyframes pulse { from { box-shadow: 0 0 0 0 rgb(var(--pick-rgb) / 0.4); } to { box-shadow: 0 0 0 10px rgb(var(--pick-rgb) / 0); } }
.label { position: absolute; left: 0; bottom: calc(100% + 6px); display: flex; gap: 6px; align-items: baseline; max-width: 300px; padding: 3px 8px;
  font: 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; white-space: nowrap; color: #fff; background: var(--pick); border-radius: 5px;
  box-shadow: 0 4px 14px -4px rgb(var(--pick-rgb) / 0.55); }
.label b { font-weight: 600; }
.label span { overflow: hidden; text-overflow: ellipsis; opacity: 0.86; }
.label.below { bottom: auto; top: calc(100% + 6px); }
.label:empty { display: none; }
@media (prefers-reduced-motion: reduce) { .outline, .pulse { transition: none; animation: none; } }`;

// The frame and the page must agree on color-scheme, or the browser paints the
// transparent frame with an opaque backdrop.
// The iframe spans the viewport and is clipped to the chat's box: resizing an iframe can
// draw it blank for a frame, a clip never does, and the clipped-out part takes no clicks.
const HOST_CSS = `iframe { display: block; border: 0; width: 100%; height: 100%; background: transparent; color-scheme: dark; pointer-events: auto; clip-path: inset(100% 0 0 0); }`;

const PICK_KEY = "__gg_live_pick";
const PAD = 6;

type Box = { x: number; y: number; w: number; h: number; viewTop: number };
const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, viewTop: r.top };
};

function outline(root: ShadowRoot, kind: "picked" | "hovering") {
  const el = document.createElement("div");
  el.className = `outline ${kind}`;
  const label = document.createElement("span");
  label.className = "label";
  el.appendChild(label);
  root.appendChild(el);
  let on = false;
  return {
    show(box: Box | null, opts: { snap?: boolean; label?: { tag: string; text: string } } = {}) {
      if (!box) {
        on = false;
        el.classList.remove("on");
        return;
      }
      // Appearing fades in where it is; moving glides from the last element.
      el.classList.toggle("snap", Boolean(opts.snap) || !on);
      el.style.transform = `translate3d(${box.x - PAD}px, ${box.y - PAD}px, 0)`;
      el.style.width = `${box.w + PAD * 2}px`;
      el.style.height = `${box.h + PAD * 2}px`;
      label.replaceChildren();
      if (opts.label) {
        const b = document.createElement("b");
        b.textContent = opts.label.tag;
        label.appendChild(b);
        if (opts.label.text) {
          const s = document.createElement("span");
          s.textContent = opts.label.text;
          label.appendChild(s);
        }
        label.classList.toggle("below", box.viewTop < 36);
      }
      on = true;
      el.classList.add("on");
    },
    pulse() {
      el.querySelector(".pulse")?.remove();
      const p = document.createElement("span");
      p.className = "pulse";
      el.appendChild(p);
    },
  };
}

/**
 * The chat lives in the browser's top layer (a manual popover), above the page's
 * own dialogs and popovers. A modal <dialog> makes everything outside it inert,
 * so while one is open the chat moves inside it, and back out when it closes.
 */
function keepOnTop(host: HTMLElement): void {
  if (!("showPopover" in host)) {
    document.documentElement.appendChild(host);
    return;
  }
  host.popover = "manual";
  const topModal = () =>
    [...document.querySelectorAll("dialog")].filter((d) => d.matches(":modal")).pop() ?? null;
  const place = (parent: Element) => {
    if (host.parentNode === parent) return;
    // moveBefore keeps the iframe loaded; a plain move reloads it (the chat replays).
    const move = (parent as Element & { moveBefore?: (n: Node, c: Node | null) => void })
      .moveBefore;
    if (move && host.isConnected) {
      try {
        move.call(parent, host, null);
        return;
      } catch {
        /* fall back below */
      }
    }
    parent.appendChild(host);
  };
  const raise = () => {
    place(topModal() ?? document.documentElement);
    if (host.matches(":popover-open")) host.hidePopover();
    host.showPopover();
  };
  raise();
  // Something else entered the top layer: a page popover or dialog opening.
  document.addEventListener(
    "toggle",
    (e) => {
      if (e.target !== host && (e as ToggleEvent).newState === "open") raise();
    },
    true,
  );
  new MutationObserver(() => {
    if (!host.isConnected || host.parentNode !== (topModal() ?? document.documentElement)) raise();
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["open"],
  });
}

function mount(frameOrigin: string): void {
  const docStyle = document.createElement("style");
  docStyle.textContent = DOC_CSS;
  document.head.appendChild(docStyle);

  // Outlines stay in the page (not the top layer) so the page's own scrolling carries them.
  const marksHost = document.createElement("gg-live-marks");
  const marks = marksHost.attachShadow({ mode: "open" });
  const marksStyle = document.createElement("style");
  marksStyle.textContent = MARKS_CSS;
  marks.appendChild(marksStyle);
  document.documentElement.appendChild(marksHost);
  const pickedOutline = outline(marks, "picked");
  const hoverOutline = outline(marks, "hovering");

  const host = document.createElement("gg-live-preview");
  const shadow = host.attachShadow({ mode: "open" });
  const hostStyle = document.createElement("style");
  hostStyle.textContent = HOST_CSS;
  const iframe = document.createElement("iframe");
  iframe.title = "GG Coder chat";
  iframe.allow = "clipboard-write";
  iframe.src = `${frameOrigin}/frame`;
  shadow.append(hostStyle, iframe);
  document.documentElement.appendChild(host);
  keepOnTop(host);

  const post = (msg: PageToFrame) => iframe.contentWindow?.postMessage(msg, frameOrigin);
  const viewport = () => ({ width: innerWidth, height: innerHeight });
  // The chat sits centred on the bottom edge of the iframe (frame/live.css .lp-root).
  let chatSize = { width: 0, height: 0 };
  const clipToChat = () => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    const side = Math.max(0, (w - Math.ceil(chatSize.width)) / 2);
    const top = Math.max(0, h - Math.ceil(chatSize.height));
    iframe.style.clipPath = `inset(${top}px ${side}px 0px ${side}px)`;
  };

  // ── Picked element ──
  let picked: Picked | null = null;
  try {
    picked = JSON.parse(sessionStorage.getItem(PICK_KEY) || "null") as Picked | null;
  } catch {
    picked = null;
  }
  let pickedEl: Element | null = picked ? findPicked(picked) : null;
  let chatOpen = false;
  let lastSent = "";
  const sendPicked = () => {
    const el = pickedEl?.isConnected ? pickedEl : null;
    const element: PickedElement | null = picked
      ? {
          selector: picked.selector,
          tag: picked.tag,
          text: picked.text,
          html: el ? el.outerHTML.slice(0, 1500) : "",
        }
      : null;
    const msg: PageToFrame = { type: "gg-live:picked", element, missing: Boolean(picked && !el) };
    const key = JSON.stringify([element, msg.missing]);
    if (key === lastSent) return;
    lastSent = key;
    post(msg);
  };
  const savePick = () => {
    try {
      if (picked) sessionStorage.setItem(PICK_KEY, JSON.stringify(picked));
      else sessionStorage.removeItem(PICK_KEY);
    } catch {
      /* storage off: the pick lasts for this page only */
    }
  };
  let lastFind = 0;
  const sync = (snap: boolean) => {
    if (!picked) {
      pickedOutline.show(null);
      sendPicked();
      return;
    }
    let el = pickedEl;
    if (el && (!el.isConnected || picked.path !== location.pathname)) el = pickedEl = null;
    // Searching the page is the costly part: at most every 250ms while it's missing.
    if (!el && performance.now() - lastFind > 250) {
      lastFind = performance.now();
      el = pickedEl = findPicked(picked);
    }
    pickedOutline.show(chatOpen && el ? boxOf(el) : null, { snap });
    if (el) {
      const label = labelFor(el);
      if (label.tag !== picked.tag || label.text !== picked.text) {
        picked = { ...picked, ...label };
        savePick();
      }
    }
    sendPicked();
  };
  const choose = (el: Element) => {
    pickedEl = el;
    picked = pickedFrom(el);
    savePick();
    lastSent = "";
    sync(false);
    pickedOutline.pulse();
    setPicking(false);
    iframe.focus();
    post({ type: "gg-live:focus" });
  };

  // ── Pick mode: hover outlines elements, a click picks one instead of reaching the page ──
  let picking = false;
  let hovered: Element | null = null;
  const pickable = (t: EventTarget | null): t is Element =>
    t instanceof Element &&
    t !== host &&
    t !== marksHost &&
    t !== document.body &&
    t !== document.documentElement;
  const showHover = (el: Element | null, snap: boolean) => {
    hovered = el;
    hoverOutline.show(el && el !== pickedEl ? boxOf(el) : null, {
      snap,
      ...(el ? { label: labelFor(el) } : {}),
    });
  };
  const onMove = (e: PointerEvent) => {
    const el = pickable(e.target) ? e.target : null;
    if (el !== hovered) showHover(el, false);
  };
  const block = (e: Event) => {
    if (!(e.target instanceof Element) || e.target === host) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === "click" && pickable(e.target)) choose(e.target);
  };
  const BLOCKED = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick"];
  function setPicking(on: boolean, fromFrame = false) {
    if (on === picking) return;
    picking = on;
    document.documentElement.classList.toggle("gg-live-picking", on);
    if (on) {
      addEventListener("pointermove", onMove, true);
      for (const k of BLOCKED) addEventListener(k, block, true);
    } else {
      removeEventListener("pointermove", onMove, true);
      for (const k of BLOCKED) removeEventListener(k, block, true);
      showHover(null, false);
    }
    if (!fromFrame) post({ type: "gg-live:picking", on });
  }

  // Right-click picks too; Shift+right-click keeps the browser's menu.
  document.addEventListener(
    "contextmenu",
    (e) => {
      if (e.shiftKey || !pickable(e.target)) return;
      e.preventDefault();
      choose(e.target);
    },
    true,
  );
  // Esc on the page: with an element picked, drops it and goes back to picking another; in pick
  // mode, leaves it.
  addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      if (picking) {
        e.preventDefault();
        e.stopPropagation();
        setPicking(false);
        iframe.focus();
        post({ type: "gg-live:focus" });
      } else if (picked && chatOpen) {
        e.preventDefault();
        e.stopPropagation();
        picked = null;
        pickedEl = null;
        savePick();
        sync(false);
        setPicking(true);
      }
    },
    true,
  );

  // ── Layout tracking ──
  let frame = 0;
  new MutationObserver((records) => {
    // Our own outline/host changes aren't page changes.
    if (records.every((r) => r.target === host || r.target === marksHost)) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => sync(false));
  }).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  addEventListener(
    "scroll",
    () => {
      sync(true);
      if (picking && hovered) showHover(hovered, true);
    },
    true,
  );
  addEventListener("resize", () => {
    clipToChat();
    sync(true);
    post({ type: "gg-live:viewport", viewport: viewport() });
  });
  // Client-side navigation doesn't reload the frame: tell it the page moved.
  let lastUrl = location.href;
  const checkUrl = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    post({ type: "gg-live:url", url: lastUrl });
    sync(false);
  };
  addEventListener("popstate", checkUrl);
  setInterval(checkUrl, 500);

  // ── Messages from the frame ──
  const hello = () => {
    post({ type: "gg-live:hello", url: location.href, viewport: viewport() });
    lastSent = "";
    sendPicked();
  };
  iframe.addEventListener("load", hello);
  addEventListener("message", (e) => {
    if (e.source !== iframe.contentWindow || e.origin !== frameOrigin) return;
    const msg = parseFrameMessage(e.data);
    if (!msg) return;
    switch (msg.type) {
      case "gg-live:ready":
        hello();
        break;
      case "gg-live:size":
        chatSize = { width: msg.width, height: msg.height };
        clipToChat();
        break;
      case "gg-live:picking":
        setPicking(msg.on, true);
        break;
      case "gg-live:clear-pick":
        picked = null;
        pickedEl = null;
        savePick();
        sync(false);
        break;
      case "gg-live:open":
        chatOpen = msg.open;
        if (!chatOpen) setPicking(false);
        sync(false);
        break;
    }
  });
}

declare global {
  interface Window {
    __ggLivePreview?: boolean;
  }
}

// Read now: currentScript is only set while this script first runs.
const script = typeof document !== "undefined" ? document.currentScript : null;
if (
  script instanceof HTMLScriptElement &&
  script.src &&
  window.top === window &&
  !window.__ggLivePreview
) {
  window.__ggLivePreview = true;
  const frameOrigin = new URL(script.src).origin;
  if (document.body) mount(frameOrigin);
  else document.addEventListener("DOMContentLoaded", () => mount(frameOrigin), { once: true });
}
