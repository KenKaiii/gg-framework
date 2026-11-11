import { prefersReducedMotion } from "./transcript-motion";

// Mirrored by scripts/motion-tokens.test.mjs. Layout moves, text never scales.
const DURATION_MS = 220;
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const MAX_VISIBLE_ROWS = 80;
// A glide with at least this share of its distance left (its first ~100ms)
// takes a new destination in place. Past it too little time remains to cover
// new ground gently, and a fresh ease reads better.
const RETARGET_REMAINING = 0.05;
const glide = (x: number, y: number): Keyframe[] => [
  { translate: `${x}px ${y}px` },
  { translate: "0px 0px" },
];
/** Where a glide has its node right now, and the share of its distance still ahead. */
function displaced(
  node: HTMLElement,
  x: number,
  y: number,
): { x: number; y: number; left: number } {
  const [nowX, nowY] = (getComputedStyle(node).translate ?? "").split(" ").map(parseFloat);
  const now = { x: nowX || 0, y: nowY || 0 };
  const left = Math.abs(y) >= Math.abs(x) ? now.y / y : now.x / x;
  return { ...now, left: Number.isFinite(left) ? left : 0 };
}

interface LayoutNodes {
  transcript: HTMLElement | null;
  surfaces: readonly (HTMLElement | null)[];
}
interface Position {
  node: HTMLElement;
  left: number;
  /** The edge the node keeps: rows hang from their top, dock surfaces sit on their bottom. */
  edge: number;
  bottom: boolean;
  /** How far a glide in flight had the node displaced when this was read. */
  ox: number;
  oy: number;
}
/** A glide in flight: the node and the offset its first keyframe starts from. */
interface Flight {
  node: HTMLElement;
  x: number;
  y: number;
}
interface Snapshot {
  transcript: HTMLElement;
  positions: Position[];
  anchor: { node: HTMLElement; offset: number } | null;
}

export interface ChatLayoutMotion {
  /** Call immediately before the state update, not from a state updater. */
  capture: () => void;
  /** Call after autosizing and transcript layout effects, before paint. */
  commit: (pinned: boolean, follow: () => void) => boolean;
  /** Manual input, resize, session change, hide and unmount end owned motion. */
  cancel: () => void;
  /** Whether a capture is waiting for its commit. */
  capturing: () => boolean;
  /** Read or write real scroll geometry with owned transforms lifted. The
   * motion carries on: a follow during a glide must not end it. */
  still: (run: () => void) => void;
  /** Ignore the observer notification for the layout we already committed. */
  resized: () => boolean;
}

/** A bounded transaction, not a scroll animator. App still owns scroll intent.
 * Binary search skips offscreen history; only visible rows and two surfaces
 * are held until the next commit. There is no timer or frame loop. */
export function createChatLayoutMotion(nodes: () => LayoutNodes): ChatLayoutMotion {
  let pending: Snapshot | null = null;
  let expiry: number | null = null;
  const clearExpiry = () => {
    if (expiry !== null) cancelAnimationFrame(expiry);
    expiry = null;
  };
  let width = 0;
  let height = 0;
  const animations = new Map<Animation, Flight>();
  // Browser scroll anchoring reads a gliding row's displaced position as a
  // layout shift, and scrolls to undo it once the glide is over: in WebKit a
  // pinned chat lost up to 330px and its pin. Suspended while rows are in
  // flight (App.css turns `overflow-anchor` off for `[data-gliding]`).
  let gliding: HTMLElement | null = null;
  const anchoring = () => {
    if (animations.size > 0 === (gliding !== null)) return;
    if (gliding) gliding.removeAttribute("data-gliding");
    gliding = animations.size > 0 ? nodes().transcript : null;
    gliding?.setAttribute("data-gliding", "");
  };
  const land = (animation: Animation) => {
    animations.delete(animation);
    animation.onfinish = null;
    animation.oncancel = null;
    anchoring();
  };
  const end = (animation: Animation) => {
    land(animation);
    animation.cancel();
  };
  const cancelAnimations = () => {
    for (const animation of [...animations.keys()]) end(animation);
  };
  const cancel = () => {
    clearExpiry();
    pending = null;
    cancelAnimations();
  };
  return {
    cancel,
    capturing: () => pending !== null,
    still(run) {
      // A row displaced below the end of the content stretches the scroll
      // height, and a follow would then overshoot. That glide ends here. Any
      // other cannot skew the read, so it carries on.
      const { transcript } = nodes();
      const last = transcript?.lastElementChild;
      if (transcript && last instanceof HTMLElement && animations.size > 0) {
        const end =
          last.offsetTop +
          last.offsetHeight +
          (parseFloat(getComputedStyle(transcript).paddingBottom) || 0);
        for (const { node, x, y } of animations.values()) {
          if (node.parentElement !== transcript) continue;
          const room = end - node.offsetTop - node.offsetHeight;
          if (y <= room || displaced(node, x, y).y <= room) continue;
          cancelAnimations();
          break;
        }
      }
      run();
    },
    resized() {
      const { transcript } = nodes();
      const nextWidth = transcript?.clientWidth ?? 0;
      const nextHeight = transcript?.clientHeight ?? 0;
      if (width === nextWidth && height === nextHeight) return false;
      width = nextWidth;
      height = nextHeight;
      cancel();
      return true;
    },
    capture() {
      // Several events batched into one React commit share the first snapshot.
      if (pending) return;
      const { transcript, surfaces } = nodes();
      if (!transcript || !transcript.clientHeight) return;
      const viewport = transcript.getBoundingClientRect();
      const children = transcript.children;
      let lo = 0;
      let hi = children.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const child = children.item(mid);
        if (child && child.getBoundingClientRect().bottom <= viewport.top) lo = mid + 1;
        else hi = mid;
      }
      const positions: Position[] = [];
      const flown = new Map<HTMLElement, { x: number; y: number }>();
      for (const { node, x, y } of animations.values()) flown.set(node, displaced(node, x, y));
      let anchor: Snapshot["anchor"] = null;
      for (let i = lo; i < children.length && i < lo + MAX_VISIBLE_ROWS; i++) {
        const node = children.item(i);
        if (!(node instanceof HTMLElement)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.top >= viewport.bottom) break;
        if (rect.height === 0) continue;
        // offsetTop deliberately ignores our in-flight transform. Anchoring is
        // layout, whereas the FLIP snapshot is what is currently displayed.
        anchor ??= { node, offset: node.offsetTop - transcript.scrollTop };
        const { x = 0, y = 0 } = flown.get(node) ?? {};
        positions.push({ node, left: rect.left, edge: rect.top, bottom: false, ox: x, oy: y });
      }
      // A dock surface that grows or shrinks keeps its bottom edge, so its top
      // moving is a resize, not a move: translating it would bob its content.
      for (const node of surfaces) {
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        const { x = 0, y = 0 } = flown.get(node) ?? {};
        if (rect.width && rect.height)
          positions.push({ node, left: rect.left, edge: rect.bottom, bottom: true, ox: x, oy: y });
      }
      pending = { transcript, positions, anchor };
      // A no-op state setter may never commit. Do not carry its old geometry
      // into a later interaction. Two expiry frames, never a frame loop: an
      // update made outside a React event (a sidecar event, a timer) renders
      // in a later task, and a frame can fall between the two. Expiring on
      // that frame dropped the glide and let the rows land in one step.
      if (typeof requestAnimationFrame === "function")
        expiry = requestAnimationFrame(() => {
          expiry = requestAnimationFrame(() => {
            pending = null;
            expiry = null;
          });
        });
    },
    commit(pinned, follow) {
      clearExpiry();
      const snapshot = pending;
      pending = null;
      if (!snapshot) return false;
      const { transcript, positions, anchor } = snapshot;
      if (!transcript.isConnected || !transcript.clientHeight) {
        cancelAnimations();
        return false;
      }
      width = transcript.clientWidth;
      height = transcript.clientHeight;
      const reduced = prefersReducedMotion();
      if (reduced) cancelAnimations();
      // Where each glide in flight has its node now, read before the follow.
      const flying = new Map<
        HTMLElement,
        { animation: Animation; x: number; y: number; left: number }
      >();
      for (const [animation, { node, x, y }] of animations) {
        flying.set(node, { animation, ...displaced(node, x, y) });
      }
      if (pinned) follow();
      else if (anchor?.node.parentElement === transcript) {
        transcript.scrollTop = anchor.node.offsetTop - anchor.offset;
      }
      if (reduced) return true;
      // Batch all reads before animation writes. Rect / offsetWidth converts
      // viewport pixels back to local layout pixels at the user's CSS zoom.
      const moves = positions.flatMap(({ node, left, edge, bottom, ox, oy }) => {
        if (!node.isConnected || typeof node.animate !== "function") return [];
        const rect = node.getBoundingClientRect();
        if (!rect.width || !node.offsetWidth) return [];
        const scale = rect.width / node.offsetWidth;
        // Start from what is displayed now: the layout the capture saw (its
        // reading less the glide then in flight) plus what that glide adds at
        // this moment. A capture can be a frame or two old by now, and going
        // back to where it saw the rows would pull them backwards mid-move.
        // The rect still carries a glide the follow left alive; take it off.
        const flight = flying.get(node);
        const alive = flight !== undefined && animations.has(flight.animation) ? flight : undefined;
        const x = (left - rect.left) / scale - ox + (flight?.x ?? 0) + (alive?.x ?? 0);
        const y =
          (edge - (bottom ? rect.bottom : rect.top)) / scale -
          oy +
          (flight?.y ?? 0) +
          (alive?.y ?? 0);
        return alive || Math.abs(x) >= 0.5 || Math.abs(y) >= 0.5 ? [{ node, x, y, alive }] : [];
      });
      for (const { node, x, y, alive } of moves) {
        flying.delete(node);
        const effect = alive?.animation.effect as KeyframeEffect | null | undefined;
        if (
          alive &&
          typeof effect?.setKeyframes === "function" &&
          alive.left >= RETARGET_REMAINING &&
          alive.left <= 1.01
        ) {
          // A glide still in its fast stretch takes the new destination on the
          // same clock and curve: restarting it would stall the rows for a
          // frame mid-move. Its first keyframe is scaled so that what is
          // displayed now is exactly where the node was a moment ago.
          const flight = { node, x: x / alive.left, y: y / alive.left };
          const was = animations.get(alive.animation);
          // Nothing new to cover: leave it, since even an identical keyframe
          // write makes Chromium hold a glide that has not started for a frame.
          if (was && Math.abs(was.x - flight.x) < 0.5 && Math.abs(was.y - flight.y) < 0.5) continue;
          effect.setKeyframes(glide(flight.x, flight.y));
          animations.set(alive.animation, flight);
          continue;
        }
        if (alive) end(alive.animation);
        if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue;
        const animation = node.animate(glide(x, y), { duration: DURATION_MS, easing: EASING });
        animations.set(animation, { node, x, y });
        animation.onfinish = () => land(animation);
        animation.oncancel = () => land(animation);
      }
      anchoring();
      // A row that left the view mid-glide has no new destination to take.
      for (const { animation } of flying.values()) if (animations.has(animation)) end(animation);
      return true;
    },
  };
}
