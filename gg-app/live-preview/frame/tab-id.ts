// Which browser tab this chat is in: each tab chats with its own session. The id
// lives in sessionStorage, so a reload keeps the tab's chat. A duplicated tab
// copies sessionStorage too, so before reusing an id we ask the other tabs
// whether one of them already has it.

export const TAB_HEADER = "x-gg-live-tab";
const KEY = "gg-live-tab";

interface Channel {
  post: (msg: unknown) => void;
  listen: (fn: (msg: unknown) => void) => void;
}

export function claimTabId(
  storage: Pick<Storage, "getItem" | "setItem">,
  channel: Channel | null,
  newId: () => string,
  waitMs = 150,
): Promise<string> {
  let saved: string | null = null;
  try {
    saved = storage.getItem(KEY);
  } catch {
    /* no storage: a new chat each load */
  }
  let id = saved || newId();
  let claimed = false;
  return new Promise((resolve) => {
    const claim = () => {
      claimed = true;
      try {
        storage.setItem(KEY, id);
      } catch {
        /* the chat just won't survive a reload */
      }
      resolve(id);
    };
    if (channel) {
      channel.listen((data) => {
        const msg = data as { ask?: unknown; taken?: unknown } | null;
        if (claimed && msg?.ask === id) channel.post({ taken: id });
        else if (!claimed && msg?.taken === id) id = newId();
      });
    }
    // A brand-new id can't belong to another tab.
    if (!saved || !channel) {
      claim();
      return;
    }
    channel.post({ ask: id });
    setTimeout(claim, waitMs);
  });
}

let mine: Promise<string> | null = null;

function tabsChannel(): Channel | null {
  if (typeof BroadcastChannel !== "function") return null;
  const bc = new BroadcastChannel("gg-live-tabs");
  return {
    post: (msg) => bc.postMessage(msg),
    listen: (fn) => bc.addEventListener("message", (e) => fn(e.data)),
  };
}

export function frameTabId(): Promise<string> {
  mine ??= claimTabId(sessionStorage, tabsChannel(), () => crypto.randomUUID());
  return mine;
}
