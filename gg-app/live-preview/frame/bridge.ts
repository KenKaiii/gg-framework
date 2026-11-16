// The frame's side of the page protocol. Messages count only when they come
// from the parent window at one of the proxy's origins; replies go to that
// origin alone. Messages that arrive before the config is known wait.
import { parsePageMessage, type FrameToPage, type PageToFrame } from "../protocol";

export interface ParentBridge {
  /** Start accepting messages from these origins (the page proxy's). */
  setOrigins: (origins: readonly string[]) => void;
  post: (msg: FrameToPage) => void;
  onMessage: (fn: (msg: PageToFrame) => void) => () => void;
}

export function createParentBridge(win: Window = window): ParentBridge {
  let origins: readonly string[] | null = null;
  let parentOrigin: string | null = null;
  const waiting: MessageEvent[] = [];
  const listeners = new Set<(msg: PageToFrame) => void>();

  const accept = (e: MessageEvent): void => {
    if (e.source !== win.parent || win.parent === win) return;
    if (!origins) {
      waiting.push(e);
      return;
    }
    if (!origins.includes(e.origin)) return;
    const msg = parsePageMessage(e.data);
    if (!msg) return;
    parentOrigin = e.origin;
    for (const fn of listeners) fn(msg);
  };
  win.addEventListener("message", accept);

  return {
    setOrigins: (next) => {
      origins = next;
      for (const e of waiting.splice(0)) accept(e);
    },
    post: (msg) => {
      if (win.parent === win) return;
      // Until the page has spoken, try each proxy origin: only the right one is delivered.
      const targets = parentOrigin ? [parentOrigin] : (origins ?? []);
      for (const origin of targets) win.parent.postMessage(msg, origin);
    },
    onMessage: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
