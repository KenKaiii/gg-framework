// GG Motion move kit: springs, arrivals, handoffs, contact, an operated
// camera and a pressing cursor for HyperFrames compositions.
//
// Install with `node library.mjs kit <project>` and put the printed <script>
// in the root index.html <head>, after GSAP. Then, in any composition script:
//
//   const kit = window.GGMotionKit;
//   const tl = gsap.timeline({ paused: true });
//   const landed = kit.dropLetters(tl, root.querySelector(".name"), 0.4);
//   kit.camera(tl, root.querySelector(".world"), [...keys], { duration: 8 });
//
// Every move adds tweens to the timeline you pass and returns the time of its
// key moment (landing, press, arrival) so the next move can start from it.
// Everything is a pure function of timeline time: no randomness except the
// seeded generator, no clocks, no free-running loops. Seeking any frame twice
// draws the same picture.
//
// Coordinates: positions are CSS pixels in the space of the element's offset
// parent (the composition's 1920x1080 stage unless you nest). `kit.centerOf`
// reads layout offsets, so camera and transform moves never disturb it.
(function (root) {
  "use strict";

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, p) => a + (b - a) * p;

  // ---------------------------------------------------------------- timing

  /** Named spring settings. Stiffness, damping and mass, as in a physical spring. */
  const springs = {
    snappy: { stiffness: 380, damping: 30, mass: 1 },
    bouncy: { stiffness: 240, damping: 13, mass: 1 },
    soft: { stiffness: 110, damping: 19, mass: 1 },
    heavy: { stiffness: 140, damping: 22, mass: 2.2 },
    whip: { stiffness: 300, damping: 22, mass: 1 },
  };

  function springParams(spec) {
    const s = typeof spec === "string" ? springs[spec] : spec;
    if (!s) throw new Error(`Unknown spring "${spec}"`);
    const stiffness = s.stiffness ?? 170;
    const damping = s.damping ?? 16;
    const mass = s.mass ?? 1;
    const omega = Math.sqrt(stiffness / mass);
    const zeta = damping / (2 * Math.sqrt(stiffness * mass));
    return { omega, zeta, velocity: s.velocity ?? 0 };
  }

  /**
   * Position of a damped spring released at 0 heading for 1, after t seconds.
   * Closed form, so any time can be sampled directly.
   */
  function spring(t, spec = "bouncy") {
    if (t <= 0) return 0;
    const { omega, zeta, velocity: v0 } = springParams(spec);
    if (zeta < 1) {
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      const decay = Math.exp(-zeta * omega * t);
      const b = (zeta * omega - v0) / wd;
      return 1 - decay * (Math.cos(wd * t) + b * Math.sin(wd * t));
    }
    if (zeta === 1) {
      return 1 - Math.exp(-omega * t) * (1 + (omega - v0) * t);
    }
    const root1 = -omega * (zeta - Math.sqrt(zeta * zeta - 1));
    const root2 = -omega * (zeta + Math.sqrt(zeta * zeta - 1));
    const a = (v0 + root2) / (root1 - root2);
    return 1 + a * Math.exp(root1 * t) + (-1 - a) * Math.exp(root2 * t);
  }

  /** Seconds until the spring stays within `tolerance` of its target for good. */
  function settleTime(spec = "bouncy", tolerance = 0.002) {
    const { omega, zeta, velocity: v0 } = springParams(spec);
    if (zeta < 1) {
      // The motion never leaves its decaying envelope, so the bound is exact enough.
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      const b = (zeta * omega - v0) / wd;
      const amplitude = Math.sqrt(1 + b * b);
      return Math.max(0.05, Math.log(amplitude / tolerance) / (zeta * omega));
    }
    const step = 1 / 600;
    for (let t = step; t < 30; t += step) {
      if (Math.abs(1 - spring(t, spec)) < tolerance) return t;
    }
    return 30;
  }

  /** A GSAP-compatible ease that follows the spring over its settle time. */
  function springEase(spec = "bouncy") {
    const settle = settleTime(spec);
    return (p) => (p <= 0 ? 0 : p >= 1 ? 1 : spring(p * settle, spec));
  }

  /** Decaying vibration after a contact: 0 before it, then rings down. */
  function ring(t, opts = {}) {
    if (t < 0) return 0;
    const freq = opts.freq ?? 11;
    const decay = opts.decay ?? 7;
    const amp = opts.amp ?? 1;
    return amp * Math.exp(-decay * t) * Math.sin(2 * Math.PI * freq * t);
  }

  /** Curves, chosen by feel. All map 0..1 to 0..1 (springs overshoot first). */
  const ease = {
    linear: (p) => p,
    // Sharp start, long glide into place: arrivals and reveals.
    snap: (p) => 1 - (1 - p) ** 4,
    // Starts slow, ends hard: things falling or diving into contact.
    drop: (p) => p ** 2.4,
    // Slow, even turn of the head: drifts and handheld pushes.
    glide: (p) => 0.5 - 0.5 * Math.cos(Math.PI * p),
    // Fast middle, soft ends: a hand moving a cursor or a camera across.
    travel: (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2),
    // Quick move that overshoots a little and settles.
    whip: springEase("whip"),
    settle: springEase("soft"),
    bounce: springEase("bouncy"),
    firm: springEase("snappy"),
    // Holds still, then jumps.
    cut: (p) => (p > 0 ? 1 : 0),
  };

  function easeOf(name, fallback) {
    if (typeof name === "function") return name;
    const fn = ease[name ?? fallback];
    if (!fn) throw new Error(`Unknown ease "${name}"`);
    return fn;
  }

  /** Seeded generator: same seed, same sequence. Returns numbers in [0, 1). */
  function rng(seed = 1) {
    let s = seed >>> 0 || 0x9e3779b9;
    return () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
  }

  function hash(i, seed) {
    let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca77);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae3d);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }

  /** Smooth deterministic noise in [-1, 1]; one wobble per unit of t. */
  function noise(seed, t) {
    const i = Math.floor(t);
    const f = t - i;
    const s = f * f * f * (f * (f * 6 - 15) + 10);
    return lerp(hash(i, seed), hash(i + 1, seed), s) * 2 - 1;
  }

  // ------------------------------------------------------------ elements

  /** Centre of an element in `space`'s coordinates, from layout offsets. */
  function centerOf(el, space) {
    let x = el.offsetWidth / 2;
    let y = el.offsetHeight / 2;
    let node = el;
    while (node && node !== space) {
      x += node.offsetLeft;
      y += node.offsetTop;
      node = node.offsetParent;
    }
    return { x, y };
  }

  /** Box of an element in `space`'s coordinates: { x, y, w, h } (top-left). */
  function rectOf(el, space) {
    const c = centerOf(el, space);
    return {
      x: c.x - el.offsetWidth / 2,
      y: c.y - el.offsetHeight / 2,
      w: el.offsetWidth,
      h: el.offsetHeight,
    };
  }

  /**
   * Wrap an element's text in spans. "words" gives one span per word; "chars"
   * gives one per character, grouped so words never break. `mask: true` puts
   * each word in a clipping box for rise-from-below reveals.
   */
  function split(el, by = "words", opts = {}) {
    const doc = el.ownerDocument;
    const text = el.textContent.trim().replace(/\s+/g, " ");
    el.textContent = "";
    const parts = [];
    text.split(" ").forEach((word, wi) => {
      if (wi > 0) el.appendChild(doc.createTextNode(" "));
      const outer = doc.createElement("span");
      outer.style.display = "inline-block";
      outer.style.whiteSpace = "nowrap";
      if (opts.mask) {
        outer.style.overflow = "hidden";
        outer.style.verticalAlign = "top";
        outer.style.paddingBottom = "0.14em";
        outer.style.marginBottom = "-0.14em";
      }
      el.appendChild(outer);
      if (by === "words") {
        const inner = doc.createElement("span");
        inner.style.display = "inline-block";
        inner.textContent = word;
        outer.appendChild(inner);
        parts.push(inner);
        return;
      }
      for (const ch of word) {
        const span = doc.createElement("span");
        span.style.display = "inline-block";
        span.textContent = ch;
        outer.appendChild(span);
        parts.push(span);
      }
    });
    return parts;
  }

  /**
   * One tween from `at` for `duration` that calls draw(localTime) on every
   * render, including seeks. Draws the first frame immediately.
   */
  function drive(tl, at, duration, draw) {
    const state = { t: 0 };
    draw(0);
    tl.fromTo(
      state,
      { t: 0 },
      {
        t: duration,
        duration,
        ease: "none",
        immediateRender: false,
        onUpdate: () => draw(state.t),
      },
      at,
    );
    return at + duration;
  }

  // ------------------------------------------------------------ arrivals

  /** Words rise into place from below their own line, one after another. */
  function liftWords(tl, el, at, opts = {}) {
    const words = split(el, "words", { mask: true });
    const stagger = opts.stagger ?? 0.07;
    const spec = opts.spring ?? "snappy";
    const duration = opts.duration ?? settleTime(spec);
    tl.fromTo(
      words,
      { yPercent: opts.from ?? 115 },
      { yPercent: 0, duration, ease: springEase(spec), stagger },
      at,
    );
    return at + stagger * Math.max(0, words.length - 1) + duration * 0.4;
  }

  /** Letters fall in, squash as they land and spring back up. Returns the last landing. */
  function dropLetters(tl, el, at, opts = {}) {
    const chars = split(el, "chars");
    const height = opts.height ?? 260;
    const fall = opts.fall ?? 0.38;
    const stagger = opts.stagger ?? 0.05;
    const squash = opts.squash ?? 0.24;
    const recover = opts.spring ?? "bouncy";
    let landed = at;
    chars.forEach((ch, i) => {
      const start = at + i * stagger;
      landed = start + fall;
      ch.style.transformOrigin = "50% 100%";
      tl.fromTo(ch, { y: -height }, { y: 0, duration: fall, ease: ease.drop }, start);
      tl.fromTo(
        ch,
        { opacity: 0 },
        { opacity: 1, duration: Math.min(0.12, fall), ease: "none" },
        start,
      );
      tl.to(
        ch,
        { scaleY: 1 - squash, scaleX: 1 + squash * 0.55, duration: 0.06, ease: "power1.out" },
        landed,
      );
      tl.to(
        ch,
        { scaleY: 1, scaleX: 1, duration: settleTime(recover), ease: springEase(recover) },
        landed + 0.06,
      );
    });
    return landed;
  }

  /** A clip-path reveal from one side. */
  function reveal(tl, el, at, opts = {}) {
    const from = opts.from ?? "bottom";
    const hidden = {
      top: "inset(0% 0% 100% 0%)",
      bottom: "inset(100% 0% 0% 0%)",
      left: "inset(0% 100% 0% 0%)",
      right: "inset(0% 0% 0% 100%)",
    }[from];
    if (!hidden) throw new Error(`reveal: unknown side "${from}"`);
    const duration = opts.duration ?? 0.8;
    tl.fromTo(
      el,
      { clipPath: hidden },
      { clipPath: "inset(0% 0% 0% 0%)", duration, ease: easeOf(opts.ease, "snap") },
      at,
    );
    return at + duration;
  }

  /**
   * Keystroke times for typing `text`: uneven like a person, with a beat
   * after spaces and punctuation. Pure; used by typewrite.
   */
  function typePlan(text, opts = {}) {
    const cps = opts.cps ?? 22;
    const jitter = opts.jitter ?? 0.4;
    const next = rng(opts.seed ?? 11);
    const times = [];
    let t = 0;
    for (let i = 0; i < text.length; i++) {
      times.push(t);
      let gap = (1 / cps) * (1 + jitter * (next() * 2 - 1));
      if (/[\s]/.test(text[i])) gap *= 1.6;
      if (/[.,;:!?]/.test(text[i])) gap *= 2.6;
      t += gap;
    }
    return { times, duration: t };
  }

  /** Types the element's text (plain text only) with a caret while typing. */
  function typewrite(tl, el, at, opts = {}) {
    const text = opts.text ?? el.textContent;
    const plan = typePlan(text, opts);
    const caret = opts.caret === false ? "" : (opts.caret ?? "\u258d");
    const hold = opts.caretHold ?? 0;
    const draw = (t) => {
      let n = 0;
      while (n < plan.times.length && plan.times[n] <= t) n++;
      const typing = t > 0 && n < text.length;
      const blinking =
        n === text.length &&
        t - plan.duration < hold &&
        Math.floor((t - plan.duration) * 2.2) % 2 === 0;
      el.textContent = text.slice(0, n) + (caret && (typing || blinking) ? caret : "");
    };
    return drive(tl, at, plan.duration + hold, draw) - hold;
  }

  /** Draws an SVG stroke (a checkmark path, an underline) from start to end. */
  function tick(tl, path, at, opts = {}) {
    const length = path.getTotalLength();
    const duration = opts.duration ?? 0.34;
    tl.fromTo(
      path,
      { strokeDasharray: length, strokeDashoffset: length },
      { strokeDashoffset: 0, duration, ease: easeOf(opts.ease, "snap") },
      at,
    );
    // A round line cap still paints a dot at full offset: hide it until the draw.
    tl.fromTo(path, { opacity: 0 }, { opacity: 1, duration: 0.01, ease: "none" }, at);
    return at + duration;
  }

  /** Pops in from small with a spring overshoot. */
  function pop(tl, el, at, opts = {}) {
    const spec = opts.spring ?? "bouncy";
    const duration = settleTime(spec);
    tl.fromTo(el, { scale: opts.from ?? 0.3 }, { scale: 1, duration, ease: springEase(spec) }, at);
    tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.1, ease: "none" }, at);
    return at + duration * 0.35;
  }

  /** Slams down from large, squashes on contact and settles. Returns the contact time. */
  function stamp(tl, el, at, opts = {}) {
    const fall = opts.duration ?? 0.2;
    const rotate = opts.rotate ?? -4;
    const contact = at + fall;
    tl.fromTo(
      el,
      { scale: opts.from ?? 2.4, rotation: rotate * 2.5, opacity: 0 },
      { scale: 1, rotation: rotate, opacity: 1, duration: fall, ease: ease.drop },
      at,
    );
    tl.to(el, { scale: 0.93, duration: 0.05, ease: "power1.out" }, contact);
    tl.to(
      el,
      { scale: 1, duration: settleTime("bouncy"), ease: springEase("bouncy") },
      contact + 0.05,
    );
    return contact;
  }

  // ------------------------------------------------------------ handoffs

  /**
   * A box becomes the next frame: morphs an absolutely positioned element's
   * box (left, top, width, height, corner radius) into `to`, a { x, y, w, h,
   * r } rect or an element measured in the same space. Defaults to the
   * `travel` curve over 0.85 s so the change reads; pass `spring` for a
   * small box that should land with weight.
   */
  function reshape(tl, el, at, to, opts = {}) {
    const target = typeof to.offsetWidth === "number" ? rectOf(to, el.offsetParent) : to;
    const duration = opts.duration ?? (opts.spring ? settleTime(opts.spring) : 0.85);
    const vars = {
      left: target.x,
      top: target.y,
      width: target.w,
      height: target.h,
      duration,
      ease: opts.spring && !opts.ease ? springEase(opts.spring) : easeOf(opts.ease, "travel"),
    };
    if (target.r !== undefined) {
      // A pill radius (999px) is clamped by the browser and would stay round
      // until the last moment: start from the radius actually drawn.
      const view = el.ownerDocument && el.ownerDocument.defaultView;
      const drawn = view ? parseFloat(view.getComputedStyle(el).borderTopLeftRadius) || 0 : 0;
      const cap = Math.min(el.offsetWidth, el.offsetHeight) / 2;
      if (drawn > cap) tl.set(el, { borderRadius: cap }, at);
      vars.borderRadius = target.r;
    }
    tl.to(el, vars, at);
    return at + duration * 0.45;
  }

  /** Radius that covers the whole frame from (x, y). */
  function coverRadius(x, y, width, height) {
    return (
      Math.max(
        Math.hypot(x, y),
        Math.hypot(width - x, y),
        Math.hypot(x, height - y),
        Math.hypot(width - x, height - y),
      ) + 2
    );
  }

  /** The next stage opens as a growing circle from a point on the subject. */
  function openFrom(tl, stage, at, opts = {}) {
    const width = opts.width ?? 1920;
    const height = opts.height ?? 1080;
    const x = opts.x ?? width / 2;
    const y = opts.y ?? height / 2;
    const duration = opts.duration ?? 0.9;
    const end = coverRadius(x, y, width, height);
    tl.fromTo(
      stage,
      { clipPath: `circle(${opts.from ?? 0}px at ${x}px ${y}px)` },
      {
        clipPath: `circle(${end}px at ${x}px ${y}px)`,
        duration,
        ease: easeOf(opts.ease, "travel"),
      },
      at,
    );
    return at + duration;
  }

  /**
   * The camera pushes through a point (a card, a letter, a hole) until it
   * fills the frame, then hands over to `next`. Give the scene its own layer:
   * this sets transform-origin and scale on `layer`.
   */
  function diveThrough(tl, layer, at, opts = {}) {
    const duration = opts.duration ?? 1.0;
    const zoom = opts.zoom ?? 16;
    tl.set(layer, { transformOrigin: `${opts.x ?? 960}px ${opts.y ?? 540}px` }, at);
    tl.fromTo(layer, { scale: 1 }, { scale: zoom, duration, ease: easeOf(opts.ease, "drop") }, at);
    const end = at + duration;
    tl.set(layer, { visibility: "hidden" }, end);
    if (opts.next) {
      tl.set(opts.next, { visibility: "hidden" }, 0);
      tl.set(opts.next, { visibility: "visible" }, end);
    }
    return end;
  }

  /** Point on a quadratic curve from a to b, bowed sideways by `bow` × distance. */
  function arcPoint(a, b, bow, p) {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const cx = mx - dy * bow;
    const cy = my + dx * bow;
    const u = 1 - p;
    return {
      x: u * u * a.x + 2 * u * p * cx + p * p * b.x,
      y: u * u * a.y + 2 * u * p * cy + p * p * b.y,
    };
  }

  /**
   * Scattered items travel on arcs into one point (the logo, the end card)
   * and shrink into it. Owns each item's transform: to also pop or stamp an
   * item, wrap it and converge the wrapper. Returns the last arrival.
   */
  function converge(tl, els, at, target, opts = {}) {
    const list = Array.from(els);
    const duration = opts.duration ?? 0.85;
    const stagger = opts.stagger ?? 0.05;
    const bow = opts.bow ?? 0.28;
    const shrink = opts.shrink ?? 0.12;
    const next = rng(opts.seed ?? 5);
    const into = easeOf(opts.ease, "drop");
    let last = at;
    list.forEach((el, i) => {
      const start = centerOf(el, opts.space ?? el.offsetParent);
      const side = next() < 0.5 ? -1 : 1;
      const myBow = bow * side * (0.6 + next() * 0.8);
      const begin = at + i * stagger;
      last = begin + duration;
      drive(tl, begin, duration, (t) => {
        const p = into(clamp(t / duration, 0, 1));
        const pt = arcPoint(start, target, myBow, p);
        const s = lerp(1, shrink, p);
        el.style.transform = `translate(${pt.x - start.x}px, ${pt.y - start.y}px) scale(${s})`;
        el.style.opacity = String(p >= 1 ? 0 : 1);
      });
    });
    return last;
  }

  // ------------------------------------------------------------- contact

  /**
   * Height, width-scale and height-scale of a hop at local time t: crouch,
   * a parabola with stretch, a squash on landing, a spring back. Pure.
   */
  function hopAt(t, opts = {}) {
    const height = opts.height ?? 140;
    const air = opts.duration ?? 0.5;
    const squash = opts.squash ?? 0.2;
    const crouch = 0.08;
    const hit = 0.05;
    if (t <= 0) return { lift: 0, sx: 1, sy: 1 };
    if (t < crouch) {
      const q = t / crouch;
      return { lift: 0, sx: 1 + squash * 0.3 * q, sy: 1 - squash * 0.6 * q };
    }
    if (t < crouch + air) {
      const p = (t - crouch) / air;
      const stretch = 1 + squash * 0.5 * Math.sin(Math.PI * p);
      return { lift: 4 * height * p * (1 - p), sx: 2 - stretch, sy: stretch };
    }
    const d = t - crouch - air;
    if (d < hit) {
      const q = d / hit;
      return { lift: 0, sx: 1 + squash * 0.5 * q, sy: 1 - squash * q };
    }
    const e = spring(d - hit, "bouncy");
    return { lift: 0, sx: lerp(1 + squash * 0.5, 1, e), sy: lerp(1 - squash, 1, e) };
  }

  /**
   * Crouch, hop on a parabola, land with a squash. Owns the element's
   * transform while it plays (wrap it to move it otherwise). Returns the
   * landing time.
   */
  function hop(tl, el, at, opts = {}) {
    const air = opts.duration ?? 0.5;
    const landing = at + 0.08 + air;
    el.style.transformOrigin = "50% 100%";
    drive(tl, at, 0.08 + air + 0.05 + settleTime("bouncy"), (t) => {
      const h = hopAt(t, opts);
      el.style.transform = `translate(0px, ${-h.lift}px) scale(${h.sx}, ${h.sy})`;
    });
    return landing;
  }

  /**
   * A hit: a short ring-down shake on `shake` (a layer that is not the
   * camera's world; use camera shakes for that) and, with `split`, two halves
   * thrown apart. Returns the hit time.
   */
  function impact(tl, at, opts = {}) {
    const amount = opts.amount ?? 16;
    if (opts.shake) {
      const el = opts.shake;
      const length = opts.duration ?? 0.6;
      drive(tl, at, length, (t) => {
        const x = amount * ring(t, { freq: 13, decay: 8 });
        const y = amount * 0.6 * ring(t, { freq: 17, decay: 9 });
        el.style.translate = `${x}px ${y}px`;
      });
    }
    if (opts.split) {
      const [left, right] = opts.split;
      const spread = opts.spread ?? 140;
      const duration = settleTime("soft");
      tl.to(left, { x: -spread, rotation: -6, duration, ease: springEase("soft") }, at);
      tl.to(right, { x: spread, rotation: 6, duration, ease: springEase("soft") }, at);
    }
    return at;
  }

  /**
   * A chain reaction: each element is knocked along `axis`, then springs
   * back, and hits the next one as it moves. Returns the last contact.
   */
  function knock(tl, els, at, opts = {}) {
    const list = Array.from(els);
    const push = opts.push ?? 48;
    const gap = opts.gap ?? 0.11;
    const tilt = opts.tilt ?? 7;
    const prop = opts.axis === "y" ? "y" : "x";
    let contact = at;
    list.forEach((el, i) => {
      contact = at + i * gap;
      const decay = 1 - Math.min(0.5, i * 0.06);
      tl.to(
        el,
        { [prop]: push * decay, rotation: tilt * decay, duration: 0.08, ease: "power2.out" },
        contact,
      );
      tl.to(
        el,
        { [prop]: 0, rotation: 0, duration: settleTime("bouncy"), ease: springEase("bouncy") },
        contact + 0.08,
      );
    });
    return contact;
  }

  // -------------------------------------------------------------- camera

  const BASE = { x: 960, y: 540, zoom: 1, rotate: 0 };

  function poseOf(key) {
    return { x: key.x ?? BASE.x, y: key.y ?? BASE.y, zoom: key.zoom ?? 1, rotate: key.rotate ?? 0 };
  }

  /**
   * Prepares camera keys: each key is a move that starts at `at` (minus the
   * lead) and takes `duration` to reach { x, y, zoom, rotate }, the world
   * point at the centre of the frame. The first key is where it starts.
   */
  function cameraPlan(keys, opts = {}) {
    if (!keys.length) throw new Error("camera: needs at least one key");
    const lead = opts.lead ?? 0;
    const moves = keys.slice(1).map((key) => ({
      start: (key.at ?? 0) - lead,
      duration: key.duration ?? (key.move === "cut" ? 0.001 : 0.9),
      ease: easeOf(key.move, "whip"),
      to: poseOf(key),
    }));
    moves.sort((a, b) => a.start - b.start);
    const plan = { first: poseOf(keys[0]), moves: [] };
    for (const move of moves) {
      plan.moves.push({ ...move, from: posePlanned(plan, move.start) });
    }
    return plan;
  }

  function posePlanned(plan, t) {
    let pose = plan.first;
    for (const move of plan.moves) {
      if (t < move.start) break;
      const p = easeOf(move.ease)(clamp((t - move.start) / move.duration, 0, 1));
      pose = {
        x: lerp(move.from.x, move.to.x, p),
        y: lerp(move.from.y, move.to.y, p),
        zoom: Math.max(0.05, lerp(move.from.zoom, move.to.zoom, p)),
        rotate: lerp(move.from.rotate, move.to.rotate, p),
      };
    }
    return pose;
  }

  /** 0 inside any rest, rising smoothly to 1 within `fade` seconds of it. */
  function restEnvelope(t, rests = [], fade = 0.3) {
    let env = 1;
    for (const [a, b] of rests) {
      if (t >= a && t <= b) return 0;
      const d = t < a ? a - t : t - b;
      if (d < fade) env = Math.min(env, ease.glide(d / fade));
    }
    return env;
  }

  /** The hand-held float: small, slow, seeded drift that is exactly zero in rests. */
  function handheld(t, opts = {}) {
    const seed = opts.seed ?? 7;
    const amp = opts.amp ?? 6;
    const rot = opts.rotate ?? 0.2;
    const rate = opts.rate ?? 0.5;
    const env = restEnvelope(t, opts.rests, opts.fade);
    if (env === 0) return { x: 0, y: 0, rotate: 0 };
    const wob = (s) =>
      0.72 * noise(seed + s, t * rate) + 0.28 * noise(seed + s + 50, t * rate * 2.7);
    return { x: amp * env * wob(0), y: amp * 0.8 * env * wob(1), rotate: rot * env * wob(2) };
  }

  /** Shake offsets at t from a list of { at, amount, decay } hits. */
  function shakeAt(t, shakes = []) {
    let x = 0;
    let y = 0;
    for (const s of shakes) {
      const amount = s.amount ?? 14;
      x += amount * ring(t - s.at, { freq: s.freq ?? 15, decay: s.decay ?? 9 });
      y +=
        amount * 0.7 * ring(t - s.at - 0.013, { freq: (s.freq ?? 15) * 1.27, decay: s.decay ?? 9 });
    }
    return { x, y };
  }

  /** Full camera state at t: planned pose plus hand-held float and shakes (screen px). */
  function cameraAt(plan, t, opts = {}) {
    const pose = posePlanned(plan, t);
    const hand = opts.handheld
      ? handheld(t, { rests: opts.rests, ...opts.handheld })
      : { x: 0, y: 0, rotate: 0 };
    const shake = shakeAt(t, opts.shakes);
    return {
      ...pose,
      offsetX: hand.x + shake.x,
      offsetY: hand.y + shake.y,
      rotate: pose.rotate + hand.rotate,
    };
  }

  /**
   * The camera as seen by a layer at `depth`: 1 is the world itself, 0 is
   * pinned to the screen (a far sky), 0.5 drifts half as far, 1.4 is a near
   * foreground that rushes past. Pan, float and shake scale with depth; zoom
   * scales geometrically so it stays positive. Pure.
   */
  function atDepth(cam, depth, width = 1920, height = 1080) {
    const cx = width / 2;
    const cy = height / 2;
    return {
      x: cx + (cam.x - cx) * depth,
      y: cy + (cam.y - cy) * depth,
      zoom: cam.zoom ** depth,
      rotate: cam.rotate * depth,
      offsetX: (cam.offsetX ?? 0) * depth,
      offsetY: (cam.offsetY ?? 0) * depth,
    };
  }

  /** CSS transform that puts camera state `cam` on a layer with origin 0 0. */
  function cameraTransform(cam, width = 1920, height = 1080) {
    return `translate(${width / 2 + (cam.offsetX ?? 0)}px, ${height / 2 + (cam.offsetY ?? 0)}px) rotate(${cam.rotate}deg) scale(${cam.zoom}) translate(${-cam.x}px, ${-cam.y}px)`;
  }

  /** Where world point (x, y) lands on screen under camera state `cam`. */
  function toScreen(cam, x, y, width = 1920, height = 1080) {
    const dx = (x - cam.x) * cam.zoom;
    const dy = (y - cam.y) * cam.zoom;
    const r = (cam.rotate * Math.PI) / 180;
    return {
      x: width / 2 + (cam.offsetX ?? 0) + dx * Math.cos(r) - dy * Math.sin(r),
      y: height / 2 + (cam.offsetY ?? 0) + dx * Math.sin(r) + dy * Math.cos(r),
    };
  }

  /**
   * An operated camera on `world` (a layer holding the whole scene, in world
   * coordinates). Keys say where it looks; options add lead, a hand-held
   * float (zero in `rests`), impact `shakes`, and parallax `layers`
   * ([{ el, depth }], each a full-frame layer in its own world coordinates;
   * see atDepth). Returns the plan and a `toScreen(t, x, y)` helper for
   * placing overlays.
   */
  function camera(tl, world, keys, opts = {}) {
    const width = opts.width ?? 1920;
    const height = opts.height ?? 1080;
    const plan = cameraPlan(keys, opts);
    const lastMove = plan.moves.reduce((end, m) => Math.max(end, m.start + m.duration), 0);
    const duration = opts.duration ?? lastMove + 0.01;
    const layers = Array.from(opts.layers ?? []);
    for (const layer of layers) {
      if (!layer || !layer.el || !Number.isFinite(layer.depth) || layer.depth < 0)
        throw new Error("camera: each layer needs { el, depth } with depth >= 0");
    }
    world.style.transformOrigin = "0 0";
    for (const layer of layers) layer.el.style.transformOrigin = "0 0";
    airSources.push({ tl, plan, duration, width, height });
    queueFlush();
    drive(tl, 0, duration, (t) => {
      const cam = cameraAt(plan, t, opts);
      world.style.transform = cameraTransform(cam, width, height);
      for (const layer of layers) {
        layer.el.style.transform = cameraTransform(
          atDepth(cam, layer.depth, width, height),
          width,
          height,
        );
      }
    });
    return {
      plan,
      at: (t) => cameraAt(plan, t, opts),
      toScreen: (t, x, y) => toScreen(cameraAt(plan, t, opts), x, y, width, height),
    };
  }

  // ----------------------------------------------------------- deep zoom

  function finitePoint(p, label) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y))
      throw new Error(`${label} must be { x, y } numbers`);
    return { x: p.x, y: p.y };
  }

  function deepZoomOpts(opts) {
    const width = opts.width ?? 1920;
    const height = opts.height ?? 1080;
    const centre = { x: width / 2, y: height / 2 };
    const from = opts.from ?? 1;
    const to = opts.to ?? 100;
    for (const [name, z] of [
      ["from", from],
      ["to", to],
    ]) {
      if (!(Number.isFinite(z) && z > 0)) throw new Error(`deepZoom: ${name} zoom must be > 0`);
    }
    const duration = opts.duration ?? 3;
    if (!(duration > 0)) throw new Error("deepZoom: duration must be > 0");
    return {
      width,
      height,
      anchor: finitePoint(opts.anchor ?? centre, "deepZoom: anchor"),
      from,
      to,
      screenFrom: finitePoint(opts.screenFrom ?? centre, "deepZoom: screenFrom"),
      screenTo: finitePoint(opts.screenTo ?? opts.screenFrom ?? centre, "deepZoom: screenTo"),
      duration,
      ease: easeOf(opts.ease, "glide"),
    };
  }

  /**
   * Camera state at local time t of a deep zoom: the zoom is eased in log
   * space and the anchor's screen point is eased linearly; the world point at
   * frame centre is recovered from those, so the anchor never drifts however
   * far the zoom goes. Same shape as cameraAt (works with toScreen). Pure.
   */
  function deepZoomAt(t, opts = {}) {
    const o = deepZoomOpts(opts);
    const p = o.ease(clamp(t / o.duration, 0, 1));
    const zoom = Math.exp(lerp(Math.log(o.from), Math.log(o.to), p));
    const sx = lerp(o.screenFrom.x, o.screenTo.x, p);
    const sy = lerp(o.screenFrom.y, o.screenTo.y, p);
    return {
      x: o.anchor.x - (sx - o.width / 2) / zoom,
      y: o.anchor.y - (sy - o.height / 2) / zoom,
      zoom,
      rotate: 0,
      offsetX: 0,
      offsetY: 0,
    };
  }

  /**
   * Zooms `world` (same conventions as camera: world coordinates, origin 0 0)
   * by any factor, keyed by where `anchor` sits on screen. Returns the end.
   */
  function deepZoom(tl, world, at, opts = {}) {
    const o = deepZoomOpts(opts);
    world.style.transformOrigin = "0 0";
    return drive(tl, at, o.duration, (t) => {
      world.style.transform = cameraTransform(deepZoomAt(t, opts), o.width, o.height);
    });
  }

  // --------------------------------------------------------------- light

  function lightOpts(opts) {
    const rise = opts.rise ?? 0.9;
    const hold = opts.hold ?? 0.6;
    const drain = opts.drain ?? 0.9;
    for (const [name, v] of [
      ["rise", rise],
      ["hold", hold],
      ["drain", drain],
    ]) {
      if (!(Number.isFinite(v) && v >= 0)) throw new Error(`lightGround: ${name} must be >= 0`);
    }
    if (rise + hold + drain <= 0) throw new Error("lightGround: needs a duration");
    return { rise, hold, drain, ease: easeOf(opts.ease, "glide") };
  }

  /** Light level 0..1 at local time t: rises, holds flooded, drains. Pure. */
  function lightLevel(t, opts = {}) {
    const o = lightOpts(opts);
    if (t <= 0) return 0;
    if (t < o.rise) return o.ease(t / o.rise);
    if (t <= o.rise + o.hold) return 1;
    if (t < o.rise + o.hold + o.drain) return 1 - o.ease((t - o.rise - o.hold) / o.drain);
    return o.drain > 0 ? 0 : 1;
  }

  /**
   * A soft field of light anchored below the frame (x, y default centre,
   * height + 0.25 h) that rises, floods and drains. On a canvas it paints a
   * radial gradient; on any other element it sets --light (0..1), --light-r
   * (px), --light-x and --light-y for its CSS to use. Returns the flood time.
   */
  function lightGround(tl, el, at, opts = {}) {
    const o = lightOpts(opts);
    const width = opts.width ?? 1920;
    const height = opts.height ?? 1080;
    const x = opts.x ?? width / 2;
    const y = opts.y ?? height * 1.25;
    const color = opts.color ?? "255, 244, 222";
    const full = coverRadius(x, y, width, height) * (opts.reach ?? 1.15);
    const ctx = typeof el.getContext === "function" ? el.getContext("2d") : null;
    drive(tl, at, o.rise + o.hold + o.drain, (t) => {
      const level = lightLevel(t, opts);
      const r = Math.max(1, full * level);
      if (ctx) {
        ctx.clearRect(0, 0, el.width, el.height);
        if (level <= 0) return;
        const sx = el.width / width;
        const g = ctx.createRadialGradient(x * sx, y * sx, 0, x * sx, y * sx, r * sx);
        g.addColorStop(0, `rgba(${color}, ${level})`);
        g.addColorStop(0.55, `rgba(${color}, ${level * 0.85})`);
        g.addColorStop(1, `rgba(${color}, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, el.width, el.height);
        return;
      }
      el.style.setProperty("--light", String(level));
      el.style.setProperty("--light-r", `${r}px`);
      el.style.setProperty("--light-x", `${x}px`);
      el.style.setProperty("--light-y", `${y}px`);
    });
    return at + o.rise;
  }

  function ringsOpts(opts) {
    const count = opts.count ?? 4;
    if (!(Number.isInteger(count) && count >= 1)) throw new Error("rings: count must be >= 1");
    const duration = opts.duration ?? 1.2;
    if (!(duration > 0)) throw new Error("rings: duration must be > 0");
    const stagger = opts.stagger ?? 0.14;
    if (!(stagger >= 0)) throw new Error("rings: stagger must be >= 0");
    const width = opts.width ?? 1920;
    const height = opts.height ?? 1080;
    const x = opts.x ?? width / 2;
    const y = opts.y ?? height / 2;
    return {
      count,
      duration,
      stagger,
      x,
      y,
      end: coverRadius(x, y, width, height),
      ease: easeOf(opts.ease, "snap"),
    };
  }

  /**
   * Rings at local time t: [{ r, inner }] outer and inner radius of each
   * revealed band, ring 0 first and largest. Each ring grows from the point
   * and fills in to a disc, so ring 0 ends covering the frame. Pure.
   */
  function ringsAt(t, opts = {}) {
    const o = ringsOpts(opts);
    const out = [];
    for (let i = 0; i < o.count; i++) {
      const p = clamp((t - i * o.stagger) / o.duration, 0, 1);
      const r = o.end * o.ease(p);
      out.push({ r, inner: r * (1 - ease.drop(p)) });
    }
    return out;
  }

  /** Union of the ring bands as a CSS mask: opaque where revealed. */
  function ringsMask(list, x, y) {
    const bands = list
      .filter((b) => b.r > 0.01)
      .map((b) => [b.inner, b.r])
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const b of bands) {
      const last = merged[merged.length - 1];
      if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1]);
      else merged.push([...b]);
    }
    if (!merged.length)
      return `radial-gradient(circle at ${x}px ${y}px, transparent 0, transparent 100%)`;
    const stops = [];
    for (const [a, b] of merged) {
      stops.push(`transparent ${a}px`, `#000 ${a}px`, `#000 ${b}px`, `transparent ${b}px`);
    }
    return `radial-gradient(circle at ${x}px ${y}px, transparent 0px, ${stops.join(", ")})`;
  }

  /**
   * Reveals `el` (the next scene, layered above the flood) through
   * concentric rings expanding from (x, y), ending fully shown: an end to a
   * flood without a wipe. Returns the time it is fully revealed.
   */
  function rings(tl, el, at, opts = {}) {
    const o = ringsOpts(opts);
    const total = o.duration + o.stagger * (o.count - 1);
    drive(tl, at, total, (t) => {
      const mask = ringsMask(ringsAt(t, opts), o.x, o.y);
      el.style.maskImage = mask;
      el.style.webkitMaskImage = mask;
    });
    return at + o.duration;
  }

  // ---------------------------------------------------------------- silk

  function parseColor(c) {
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(c).trim());
    if (!m) throw new Error(`silk: colours must be hex like #1a2b3c, got ${c}`);
    const h = m[1].length === 3 ? [...m[1]].map((d) => d + d).join("") : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  /** Smooth 2D value noise in [-1, 1] from the kit's hash. */
  function noise2(seed, x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fade = (f) => f * f * f * (f * (f * 6 - 15) + 10);
    const u = fade(x - xi);
    const v = fade(y - yi);
    const h = (i, j) => hash(i * 73856093 + j * 19349663, seed);
    return (
      lerp(lerp(h(xi, yi), h(xi + 1, yi), u), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u), v) * 2 - 1
    );
  }

  function silkOpts(opts) {
    if (!Array.isArray(opts.colors) || opts.colors.length < 2)
      throw new Error("silk: needs colors, at least two hex colours");
    const cols = opts.cols ?? 64;
    const rows = opts.rows ?? Math.round((cols * 9) / 16);
    if (!(Number.isInteger(cols) && cols >= 2 && Number.isInteger(rows) && rows >= 2))
      throw new Error("silk: cols and rows must be integers >= 2");
    return {
      colors: opts.colors.map(parseColor),
      seed: opts.seed ?? 1,
      speed: opts.speed ?? 0.08,
      scale: opts.scale ?? 2.2,
      warp: opts.warp ?? 1.2,
      cols,
      rows,
    };
  }

  /**
   * RGBA pixels (cols x rows) of the silk field at time t: warped seeded
   * noise mapped across the colours. Pure.
   */
  function silkField(t, opts = {}) {
    const o = silkOpts(opts);
    const out = new Uint8ClampedArray(o.cols * o.rows * 4);
    const s = o.seed * 101;
    const time = t * o.speed;
    const last = o.colors.length - 1;
    for (let j = 0; j < o.rows; j++) {
      for (let i = 0; i < o.cols; i++) {
        const x = (i / o.cols) * o.scale * (o.cols / o.rows);
        const y = (j / o.rows) * o.scale;
        const qx = noise2(s + 1, x + time, y - time * 0.7);
        const qy = noise2(s + 2, x - time * 0.6, y + time + 5.2);
        const v =
          0.65 * noise2(s + 3, x + o.warp * qx + time * 0.3, y + o.warp * qy) +
          0.35 * noise2(s + 4, 2 * x - o.warp * qy, 2 * y + o.warp * qx - time * 0.5);
        const f = clamp(0.5 + 0.62 * v, 0, 1) * last;
        const k = Math.min(last - 1, Math.floor(f));
        const a = o.colors[k];
        const b = o.colors[k + 1];
        const p = ease.glide(f - k);
        const at = (j * o.cols + i) * 4;
        out[at] = lerp(a[0], b[0], p);
        out[at + 1] = lerp(a[1], b[1], p);
        out[at + 2] = lerp(a[2], b[2], p);
        out[at + 3] = 255;
      }
    }
    return out;
  }

  /**
   * A slowly flowing colour field on `canvas`: drawn into a small grid
   * (cols x rows backing pixels) and stretched smoothly by CSS. Returns the end.
   */
  function silk(tl, canvas, at, duration, opts = {}) {
    const o = silkOpts(opts);
    if (!(duration > 0)) throw new Error("silk: duration must be > 0");
    canvas.width = o.cols;
    canvas.height = o.rows;
    canvas.style.imageRendering = "auto";
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(o.cols, o.rows);
    return drive(tl, at, duration, (t) => {
      image.data.set(silkField(at + t, opts));
      ctx.putImageData(image, 0, 0);
    });
  }

  // ---------------------------------------------------------------- belt

  function beltOpts(opts) {
    const speed = opts.speed ?? 240;
    if (!(Number.isFinite(speed) && speed > 0)) throw new Error("belt: speed must be > 0");
    const run = opts.stop ?? 4;
    if (!(Number.isFinite(run) && run > 0)) throw new Error("belt: stop must be after the start");
    let rampIn = opts.rampIn ?? 0.6;
    let rampOut = opts.rampOut ?? 0.9;
    if (!(rampIn >= 0 && rampOut >= 0)) throw new Error("belt: ramps must be >= 0");
    if (rampIn + rampOut > run) {
      const k = run / (rampIn + rampOut);
      rampIn *= k;
      rampOut *= k;
    }
    return { speed, run, rampIn, rampOut };
  }

  // Distance covered while easing up from rest over `ramp` seconds, after u seconds.
  function rampDistance(u, ramp) {
    if (ramp <= 0) return u;
    const q = clamp(u / ramp, 0, 1);
    return ramp * (q / 2 - Math.sin(Math.PI * q) / (2 * Math.PI)) + Math.max(0, u - ramp);
  }

  /**
   * Belt state at local time t (`stop` here is local, seconds after the
   * start): offset travelled (px, exact integral of the speed), current speed
   * (px/s) and clock (offset / speed: running seconds that slow with it). Pure.
   */
  function beltAt(t, opts = {}) {
    const o = beltOpts(opts);
    const u = clamp(t, 0, o.run);
    const cruiseEnd = o.run - o.rampOut;
    let dist = rampDistance(Math.min(u, cruiseEnd), o.rampIn);
    let speed = o.rampIn > 0 ? o.speed * ease.glide(clamp(u / o.rampIn, 0, 1)) : o.speed;
    if (u > cruiseEnd) {
      // The ramp down mirrors a ramp up, run backwards from the stop.
      const left = o.run - u;
      dist += rampDistance(o.rampOut, o.rampOut) - rampDistance(left, o.rampOut);
      speed = o.rampOut > 0 ? o.speed * ease.glide(clamp(left / o.rampOut, 0, 1)) : 0;
    }
    if (t <= 0 || t >= o.run) speed = 0;
    const offset = dist * o.speed;
    return { offset, speed, clock: offset / o.speed };
  }

  /**
   * A carousel: `items` sit `spacing` px apart along `axis` and travel at
   * constant `speed` (direction -1 leftward/up), easing up from rest at `at`
   * and easing to a stop exactly at `stop` (timeline time). Items wrap round
   * a loop of `wrap` px starting at `origin`. Owns each item's transform.
   * Returns { stop, at(t), clock(t) } in timeline time.
   */
  function belt(tl, items, at, opts = {}) {
    const list = Array.from(items);
    if (!list.length) throw new Error("belt: needs at least one item");
    const stop = opts.stop ?? at + 4;
    if (!(stop > at)) throw new Error("belt: stop must be after the start");
    const local = { ...opts, stop: stop - at };
    beltOpts(local);
    const spacing = opts.spacing ?? 360;
    const wrap = opts.wrap ?? spacing * list.length;
    if (!(spacing > 0 && wrap > 0)) throw new Error("belt: spacing and wrap must be > 0");
    const origin = opts.origin ?? -spacing;
    const dir = opts.direction ?? -1;
    const axis = opts.axis === "y" ? "y" : "x";
    drive(tl, at, stop - at, (t) => {
      const { offset } = beltAt(t, local);
      list.forEach((el, i) => {
        const raw = i * spacing + dir * offset - origin;
        const pos = origin + (((raw % wrap) + wrap) % wrap);
        el.style.transform = axis === "x" ? `translate(${pos}px, 0px)` : `translate(0px, ${pos}px)`;
      });
    });
    return {
      stop,
      at: (t) => beltAt(t - at, local),
      clock: (t) => beltAt(t - at, local).clock,
    };
  }

  // --------------------------------------------------------------- brush

  /**
   * Points along an SVG path string (M L H V C Q Z, absolute or relative),
   * curves sampled every ~`step` px. Pure.
   */
  function pathPoints(d, step = 6) {
    const tokens = String(d).match(/[MLHVCQZmlhvcqz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
    if (!tokens || !/[Mm]/.test(tokens[0])) throw new Error("brushStroke: path must start with M");
    const pts = [];
    let cmd = "";
    let i = 0;
    let cx = 0;
    let cy = 0;
    let sx = 0;
    let sy = 0;
    const num = () => {
      const v = Number(tokens[i++]);
      if (!Number.isFinite(v)) throw new Error(`brushStroke: bad path near "${tokens[i - 1]}"`);
      return v;
    };
    const curve = (fn, len) => {
      const n = Math.max(2, Math.ceil(len / step));
      for (let k = 1; k <= n; k++) pts.push(fn(k / n));
    };
    while (i < tokens.length) {
      if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
      const rel = cmd === cmd.toLowerCase();
      const ox = rel ? cx : 0;
      const oy = rel ? cy : 0;
      switch (cmd.toUpperCase()) {
        case "M":
          cx = ox + num();
          cy = oy + num();
          sx = cx;
          sy = cy;
          pts.push({ x: cx, y: cy });
          cmd = rel ? "l" : "L";
          break;
        case "L":
          cx = ox + num();
          cy = oy + num();
          pts.push({ x: cx, y: cy });
          break;
        case "H":
          cx = ox + num();
          pts.push({ x: cx, y: cy });
          break;
        case "V":
          cy = oy + num();
          pts.push({ x: cx, y: cy });
          break;
        case "C": {
          const a = { x: cx, y: cy };
          const b = { x: ox + num(), y: oy + num() };
          const c = { x: ox + num(), y: oy + num() };
          const e = { x: ox + num(), y: oy + num() };
          const len =
            Math.hypot(b.x - a.x, b.y - a.y) +
            Math.hypot(c.x - b.x, c.y - b.y) +
            Math.hypot(e.x - c.x, e.y - c.y);
          curve((p) => {
            const u = 1 - p;
            return {
              x: u * u * u * a.x + 3 * u * u * p * b.x + 3 * u * p * p * c.x + p * p * p * e.x,
              y: u * u * u * a.y + 3 * u * u * p * b.y + 3 * u * p * p * c.y + p * p * p * e.y,
            };
          }, len);
          cx = e.x;
          cy = e.y;
          break;
        }
        case "Q": {
          const a = { x: cx, y: cy };
          const b = { x: ox + num(), y: oy + num() };
          const e = { x: ox + num(), y: oy + num() };
          const len = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(e.x - b.x, e.y - b.y);
          curve((p) => {
            const u = 1 - p;
            return {
              x: u * u * a.x + 2 * u * p * b.x + p * p * e.x,
              y: u * u * a.y + 2 * u * p * b.y + p * p * e.y,
            };
          }, len);
          cx = e.x;
          cy = e.y;
          break;
        }
        case "Z":
          cx = sx;
          cy = sy;
          pts.push({ x: cx, y: cy });
          break;
        default:
          throw new Error(`brushStroke: unsupported path command "${cmd}"`);
      }
    }
    return pts;
  }

  /**
   * Prepares a brush stroke: the path resampled evenly (`spacing` px) with
   * arc position s 0..1, direction normals and seeded bristles. Pure.
   */
  function brushPlan(opts = {}) {
    const raw = opts.path !== undefined ? pathPoints(opts.path) : opts.points;
    if (!Array.isArray(raw) || raw.length < 2)
      throw new Error("brushStroke: needs points (2 or more) or an SVG path");
    raw.forEach((p) => finitePoint(p, "brushStroke: each point"));
    const width = opts.width ?? 28;
    const count = opts.bristles ?? 48;
    if (!(width > 0)) throw new Error("brushStroke: width must be > 0");
    if (!(Number.isInteger(count) && count >= 1))
      throw new Error("brushStroke: bristles must be an integer >= 1");
    const spacing = opts.spacing ?? 3;
    const cum = [0];
    for (let i = 1; i < raw.length; i++)
      cum.push(cum[i - 1] + Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y));
    const length = cum[cum.length - 1];
    if (!(length > 0)) throw new Error("brushStroke: path has no length");
    const n = Math.max(2, Math.ceil(length / spacing) + 1);
    const samples = [];
    let seg = 1;
    for (let k = 0; k < n; k++) {
      const d = (k / (n - 1)) * length;
      while (seg < raw.length - 1 && cum[seg] < d) seg++;
      const a = raw[seg - 1];
      const b = raw[seg];
      const span = cum[seg] - cum[seg - 1] || 1;
      const p = clamp((d - cum[seg - 1]) / span, 0, 1);
      const tx = b.x - a.x;
      const ty = b.y - a.y;
      const tn = Math.hypot(tx, ty) || 1;
      samples.push({
        x: lerp(a.x, b.x, p),
        y: lerp(a.y, b.y, p),
        nx: -ty / tn,
        ny: tx / tn,
        s: d / length,
      });
    }
    const seed = opts.seed ?? 3;
    const next = rng(seed);
    const bristles = Array.from({ length: count }, (_, i) => ({
      // Denser in the middle, like a loaded round brush.
      offset: (next() * 2 - 1) * (0.55 + 0.45 * next()),
      thick: 0.6 + next() * 0.9,
      alpha: 0.35 + next() * 0.5,
      hold: next(),
      seed: seed * 977 + i * 13,
    }));
    return {
      samples,
      bristles,
      width,
      length,
      dryness: opts.dryness ?? 0.65,
      color: opts.color ?? "#141414",
    };
  }

  /** Brush width factor along the stroke: swells on touch-down, tapers off. Pure. */
  function brushWidth(s) {
    const touch =
      Math.sqrt(clamp(s / 0.07, 0, 1)) * (1 + 0.22 * Math.exp(-(((s - 0.08) / 0.06) ** 2)));
    const lift = clamp((1 - s) / 0.3, 0, 1) ** 0.7;
    return Math.max(0.12, touch * lift);
  }

  /** Draws the stroke up to progress k (0..1) from scratch on `ctx`. */
  function drawBrush(ctx, plan, k, canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (k <= 0) return 0;
    const last = Math.min(plan.samples.length - 1, Math.floor(k * (plan.samples.length - 1)));
    if (last < 1) return 0;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = plan.color;
    let marks = 0;
    for (const b of plan.bristles) {
      ctx.globalAlpha = b.alpha;
      ctx.lineWidth = (plan.width / plan.bristles.length) * 2.2 * b.thick;
      ctx.beginPath();
      let down = false;
      for (let i = 0; i <= last; i++) {
        const p = plan.samples[i];
        // Dry brush: the further along, the more this bristle skips the paper.
        const dry = plan.dryness * p.s ** 1.6;
        const skip = 0.5 + 0.5 * noise(b.seed, p.s * 18) < dry * (0.6 + 0.8 * b.hold);
        if (skip) {
          down = false;
          continue;
        }
        const w = (plan.width / 2) * brushWidth(p.s) * b.offset;
        const x = p.x + p.nx * w;
        const y = p.y + p.ny * w;
        if (down) {
          ctx.lineTo(x, y);
          marks++;
        } else {
          ctx.moveTo(x, y);
          down = true;
        }
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    return marks;
  }

  /**
   * A natural-media brush stroke drawn along `points` or an SVG `path` on
   * `canvas` (in its pixel space) from `at` over `duration`, redrawn from
   * scratch each frame. Returns the time the brush lifts.
   */
  function brushStroke(tl, canvas, at, opts = {}) {
    const plan = brushPlan(opts);
    const duration = opts.duration ?? 0.8;
    if (!(duration > 0)) throw new Error("brushStroke: duration must be > 0");
    const curve = easeOf(opts.ease, "glide");
    const ctx = canvas.getContext("2d");
    return drive(tl, at, duration, (t) => {
      drawBrush(ctx, plan, curve(clamp(t / duration, 0, 1)), canvas);
    });
  }

  // --------------------------------------------------------------- grain

  /**
   * RGBA pixels of a seeded size x size grain tile: each pixel nudges
   * lighter or darker at alpha <= amount, enough to dither 8-bit bands. Pure.
   */
  function grainTile(opts = {}) {
    const size = opts.size ?? 128;
    const amount = opts.amount ?? 0.05;
    if (!(Number.isInteger(size) && size >= 2 && size <= 1024))
      throw new Error("grain: size must be an integer 2..1024");
    if (!(amount > 0 && amount <= 1)) throw new Error("grain: amount must be 0..1");
    const next = rng(opts.seed ?? 9);
    const out = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      const v = next() * 2 - 1;
      const shade = v < 0 ? 0 : 255;
      out[i * 4] = shade;
      out[i * 4 + 1] = shade;
      out[i * 4 + 2] = shade;
      out[i * 4 + 3] = Math.round(Math.abs(v) * amount * 255);
    }
    return out;
  }

  /**
   * Lays a fixed, seeded grain tile over `el` (a full-frame overlay above dark
   * gradients) as a repeated background. Static: identical on every frame.
   * Returns the tile's data URL.
   */
  function grain(el, opts = {}) {
    const size = opts.size ?? 128;
    const data = grainTile(opts);
    const doc = opts.document ?? el.ownerDocument ?? root.document;
    if (!doc || typeof doc.createElement !== "function")
      throw new Error("grain: needs a document to draw the tile");
    const canvas = doc.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(size, size);
    image.data.set(data);
    ctx.putImageData(image, 0, 0);
    const url = canvas.toDataURL("image/png");
    el.style.backgroundImage = `url(${url})`;
    el.style.backgroundRepeat = "repeat";
    el.style.backgroundSize = `${size}px ${size}px`;
    el.style.pointerEvents = "none";
    el.style.imageRendering = "pixelated";
    return url;
  }

  // --------------------------------------------------------------- print

  // A risograph / screen-print look: flat spot inks that overprint (multiply),
  // a halftone screen, a little misregistration, and paper underneath.

  function screenOpts(opts) {
    const cell = opts.cell ?? 7;
    const angle = opts.angle ?? 15;
    const amount = opts.amount ?? 0.86;
    if (!(cell >= 2 && cell <= 64)) throw new Error("printInk: cell must be 2..64 px");
    if (!Number.isFinite(angle)) throw new Error("printInk: angle must be a number (degrees)");
    if (!(amount > 0 && amount <= 1)) throw new Error("printInk: amount must be 0..1");
    // A screen tiles seamlessly when its lattice step is a whole-pixel vector
    // (a, b): the square tile is then a*a + b*b pixels wide.
    const rad = (angle * Math.PI) / 180;
    let a = Math.round(cell * Math.cos(rad));
    let b = Math.round(cell * Math.sin(rad));
    if (a === 0 && b === 0) a = 1;
    const size = a * a + b * b;
    if (size > 2048) throw new Error("printInk: cell too large for a seamless tile");
    return { a, b, size, amount, rough: opts.rough ?? 0.18, seed: opts.seed ?? 3 };
  }

  /**
   * RGBA pixels of a seamless halftone screen tile (`size` x `size`, returned
   * as { size, data }): black dots whose alpha covers about `amount` of the
   * area, at `angle` degrees with `cell` px pitch; `rough` frays dot edges
   * with seeded per-pixel noise. Alpha is the ink. Pure.
   */
  function halftoneTile(opts = {}) {
    const o = screenOpts(opts);
    const { a, b, size } = o;
    // Dot radius (in cells) for the asked coverage; past ~0.785 dots merge.
    const r = Math.min(0.75, Math.sqrt(o.amount / Math.PI));
    const phaseU = hash(1, o.seed);
    const phaseV = hash(2, o.seed);
    const out = new Uint8ClampedArray(size * size * 4);
    const ss = [0.25, 0.75];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const edge = (hash(y * size + x, o.seed) * 2 - 1) * o.rough * 0.5;
        let ink = 0;
        for (const sy of ss)
          for (const sx of ss) {
            const px = x + sx;
            const py = y + sy;
            const u = (px * a + py * b) / size + phaseU;
            const v = (-px * b + py * a) / size + phaseV;
            const d = Math.hypot(u - Math.round(u), v - Math.round(v));
            if (d < r + edge) ink++;
          }
        const at = (y * size + x) * 4;
        out[at + 3] = Math.round((ink / 4) * 255);
      }
    }
    return { size, data: out };
  }

  function tileURL(doc, size, data, who) {
    if (!doc || typeof doc.createElement !== "function")
      throw new Error(`${who}: needs a document to draw the tile`);
    const canvas = doc.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(size, size);
    image.data.set(data);
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  }

  /**
   * Makes `el` a printed spot-ink layer: multiply blending (overlapping inks
   * darken, like overprinting), a halftone screen as its mask, and a fixed
   * misregistration `offset` {x, y} via the CSS `translate` property (so it
   * stacks with `misregister`'s transforms). Static. Returns the tile URL.
   */
  function printInk(el, opts = {}) {
    const offset = opts.offset ?? { x: 0, y: 0 };
    if (!(Number.isFinite(offset.x) && Number.isFinite(offset.y)))
      throw new Error("printInk: offset must be { x, y } numbers");
    const { size, data } = halftoneTile(opts);
    const doc = opts.document ?? el.ownerDocument ?? root.document;
    const url = tileURL(doc, size, data, "printInk");
    const mask = `url(${url})`;
    el.style.mixBlendMode = "multiply";
    el.style.maskImage = mask;
    el.style.webkitMaskImage = mask;
    el.style.maskRepeat = "repeat";
    el.style.webkitMaskRepeat = "repeat";
    el.style.maskSize = `${size}px ${size}px`;
    el.style.webkitMaskSize = `${size}px ${size}px`;
    el.style.maskMode = "alpha";
    el.style.translate = `${offset.x}px ${offset.y}px`;
    return url;
  }

  function misregisterOpts(count, opts) {
    if (!(Number.isInteger(count) && count >= 1))
      throw new Error("misregister: needs at least one layer");
    const distance = opts.distance ?? 26;
    if (!(distance >= 0)) throw new Error("misregister: distance must be >= 0");
    let from = opts.from;
    if (from !== undefined) {
      if (!Array.isArray(from) || from.length !== count)
        throw new Error("misregister: from must give one { x, y } per layer");
      if (!from.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)))
        throw new Error("misregister: from must give one { x, y } per layer");
    } else {
      // Seeded directions spread around the circle, so layers part ways.
      const next = rng(opts.seed ?? 11);
      const turn = next() * Math.PI * 2;
      from = Array.from({ length: count }, (_, i) => {
        const ang = turn + (i / count) * Math.PI * 2 + (next() - 0.5) * 0.6;
        const d = distance * (0.7 + next() * 0.3);
        return { x: Math.cos(ang) * d, y: Math.sin(ang) * d };
      });
    }
    const spec = opts.spring ?? (opts.ease ? null : "soft");
    const curve = spec ? springEase(spec) : easeOf(opts.ease);
    const duration = opts.duration ?? (spec ? settleTime(spec) : 0.8);
    if (!(duration > 0)) throw new Error("misregister: duration must be > 0");
    return { from, curve, duration, apart: opts.apart ?? false };
  }

  /**
   * Offsets {x, y} of `count` layers t seconds into a misregister move: they
   * start at `from` and settle to 0 (or with `apart`, drift from 0 to `from`). Pure.
   */
  function misregisterAt(t, count, opts = {}) {
    const o = misregisterOpts(count, opts);
    const p = o.curve(clamp(t / o.duration, 0, 1));
    const k = o.apart ? p : 1 - p;
    return o.from.map((f) => ({ x: f.x * k + 0, y: f.y * k + 0 }));
  }

  /**
   * Animates print registration of `layers` from `at`: apart by `distance`
   * (or explicit `from` offsets), settling together on a spring (default
   * "soft") or `ease` over `duration`. Returns the settle time.
   */
  function misregister(tl, layers, at, opts = {}) {
    const list = Array.from(layers ?? []);
    const o = misregisterOpts(list.length, opts);
    return drive(tl, at, o.duration, (t) => {
      misregisterAt(t, list.length, opts).forEach((p, i) => {
        list[i].style.transform = `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px)`;
      });
    });
  }

  /**
   * RGBA pixels of a seamless size x size paper tile: warm `tint` with soft
   * seeded mottling and short fibres, darkened by up to `amount`. Pure.
   */
  function paperTile(opts = {}) {
    const size = opts.size ?? 256;
    const amount = opts.amount ?? 0.06;
    if (!(Number.isInteger(size) && size >= 8 && size <= 1024))
      throw new Error("paperTexture: size must be an integer 8..1024");
    if (!(amount > 0 && amount <= 1)) throw new Error("paperTexture: amount must be 0..1");
    const tint = (() => {
      try {
        return parseColor(opts.tint ?? "#fdf8ee");
      } catch {
        throw new Error("paperTexture: tint must be hex like #fbf3e4");
      }
    })();
    const fibres = opts.fibres ?? 160;
    if (!(Number.isInteger(fibres) && fibres >= 0))
      throw new Error("paperTexture: fibres must be an integer >= 0");
    const seed = opts.seed ?? 5;
    const dark = new Float32Array(size * size);
    // Periodic mottling: noise sampled on a wrapped lattice.
    const cells = 8;
    const wrapNoise = (s, x, y, n) => {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const f = (q) => q * q * (3 - 2 * q);
      const u = f(x - xi);
      const v = f(y - yi);
      const h = (i, j) => hash((((i % n) + n) % n) * 7919 + (((j % n) + n) % n), s);
      return lerp(lerp(h(xi, yi), h(xi + 1, yi), u), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u), v);
    };
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const m =
          0.6 * wrapNoise(seed, (x / size) * cells, (y / size) * cells, cells) +
          0.4 * wrapNoise(seed + 1, (x / size) * cells * 4, (y / size) * cells * 4, cells * 4);
        dark[y * size + x] = 0.45 * m + 0.25 * hash(y * size + x, seed + 2);
      }
    const next = rng(seed + 3);
    for (let f = 0; f < fibres; f++) {
      let x = next() * size;
      let y = next() * size;
      let ang = next() * Math.PI * 2;
      const len = 6 + next() * 22;
      const w = (next() < 0.5 ? -0.5 : 0.7) * (0.4 + next() * 0.6);
      for (let s = 0; s < len; s++) {
        const i = ((Math.floor(y) % size) + size) % size;
        const j = ((Math.floor(x) % size) + size) % size;
        dark[i * size + j] += w;
        ang += (next() - 0.5) * 0.35;
        x += Math.cos(ang);
        y += Math.sin(ang);
      }
    }
    const out = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      const k = 1 - amount * clamp(dark[i], 0, 1.5);
      out[i * 4] = tint[0] * k;
      out[i * 4 + 1] = tint[1] * k;
      out[i * 4 + 2] = tint[2] * k;
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  /**
   * Lays a fixed seeded paper tile over `el` (a full-frame overlay on top of
   * the inks) with multiply blending: warm stock, mottling and fibres.
   * Static: identical on every frame. Returns the tile's data URL.
   */
  function paperTexture(el, opts = {}) {
    const size = opts.size ?? 256;
    const data = paperTile(opts);
    const doc = opts.document ?? el.ownerDocument ?? root.document;
    const url = tileURL(doc, size, data, "paperTexture");
    el.style.backgroundImage = `url(${url})`;
    el.style.backgroundRepeat = "repeat";
    el.style.backgroundSize = `${size}px ${size}px`;
    el.style.mixBlendMode = "multiply";
    el.style.pointerEvents = "none";
    return url;
  }

  // -------------------------------------------------------------- cursor

  /**
   * Plans a cursor that travels on gentle arcs between stops, pressing where
   * `click` is set. Stops are { x, y } points or { el } elements (their
   * centre, in `space`), with optional `hold` (pause after arriving) and
   * `duration` (travel time). Pure; used by cursorPath.
   */
  function cursorPlan(stops, opts = {}) {
    const speed = opts.speed ?? 1500;
    const press = opts.press ?? 0.09;
    const release = opts.release ?? 0.26;
    const points = stops.map((s) =>
      s.el ? { ...centerOf(s.el, opts.space ?? s.el.offsetParent), ...s } : s,
    );
    const legs = [];
    const presses = [];
    let t = points[0].hold ?? 0;
    if (points[0].click) {
      presses.push(t);
      t += press + release;
    }
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const duration = b.duration ?? clamp(dist / speed, 0.35, 1.3);
      legs.push({ start: t, duration, a, b, bow: (opts.bow ?? 0.12) * (i % 2 ? 1 : -1) });
      t += duration;
      if (b.click) {
        presses.push(t + 0.06);
        t += 0.06 + press + release;
      }
      t += b.hold ?? 0.15;
    }
    return { points, legs, presses, press, release, duration: t };
  }

  /** Cursor position and press scale at local time t. */
  function cursorAt(plan, t) {
    let pos = { x: plan.points[0].x, y: plan.points[0].y };
    for (const leg of plan.legs) {
      if (t < leg.start) break;
      const p = ease.travel(clamp((t - leg.start) / leg.duration, 0, 1));
      pos = arcPoint(leg.a, leg.b, leg.bow, p);
    }
    let scale = 1;
    for (const at of plan.presses) {
      const d = t - at;
      if (d < 0 || d > plan.press + plan.release) continue;
      scale =
        d < plan.press
          ? lerp(1, 0.8, d / plan.press)
          : lerp(0.8, 1, ease.bounce((d - plan.press) / plan.release));
    }
    return { x: pos.x, y: pos.y, scale };
  }

  /**
   * Moves a cursor element (its hotspot at `tip`, default top-left + [6, 4])
   * through the stops from `at`. Returns { end, presses } in timeline time:
   * script each pressed state (and its sound) from the press times.
   */
  function cursorPath(tl, cursor, at, stops, opts = {}) {
    const plan = cursorPlan(stops, opts);
    const [tx, ty] = opts.tip ?? [6, 4];
    cursor.style.transformOrigin = `${tx}px ${ty}px`;
    const end = drive(tl, at, plan.duration, (t) => {
      const c = cursorAt(plan, t);
      cursor.style.left = `${c.x - tx}px`;
      cursor.style.top = `${c.y - ty}px`;
      cursor.style.transform = `scale(${c.scale})`;
    });
    return { end, presses: plan.presses.map((p) => at + p) };
  }

  // ---------------------------------------------------------------- sound cues

  // Sound comes from the picture: mark the moments that deserve a sound where
  // the animation creates them, and `cues.mjs` exports them for the score.
  const cueMarks = [];
  const airSources = [];
  let cueFlushQueued = false;
  const AIR_RATE = 50;

  /**
   * How fast the keyed camera move carries the picture past the viewer, in
   * screen px/s: the pan at the current zoom plus the zoom's push at the frame
   * edge. Hand float and shakes are left out; the air follows the operated move.
   */
  function cameraSpeed(plan, t, width = 1920, height = 1080) {
    const dt = 1 / (AIR_RATE * 2);
    const a = posePlanned(plan, Math.max(0, t - dt));
    const b = posePlanned(plan, t + dt);
    const span = 2 * dt;
    const zoom = (a.zoom + b.zoom) / 2;
    const pan = (Math.hypot(b.x - a.x, b.y - a.y) * zoom) / span;
    const push = (Math.abs(Math.log(b.zoom / a.zoom)) * Math.hypot(width, height)) / 2 / span;
    return Math.hypot(pan, push);
  }

  /** The camera's speed curve on the root timeline, or null without a camera. */
  function air() {
    if (!airSources.length) return null;
    const spans = airSources.map((s) => ({ ...s, start: rootTime(s.tl, 0) }));
    const start = Math.min(...spans.map((s) => s.start));
    const end = Math.max(...spans.map((s) => s.start + s.duration));
    const values = [];
    for (let i = 0; i <= Math.ceil((end - start) * AIR_RATE); i++) {
      const t = start + i / AIR_RATE;
      let v = 0;
      for (const s of spans) {
        if (t >= s.start && t <= s.start + s.duration)
          v = Math.max(v, cameraSpeed(s.plan, t - s.start, s.width, s.height));
      }
      values.push(Math.round(v));
    }
    return { rate: AIR_RATE, start: Math.round(start * 10000) / 10000, values };
  }

  /** Time `at` on `tl`, mapped onto the root timeline through any nesting. */
  function rootTime(tl, at) {
    let t = at;
    for (let node = tl; node && node.parent && node.parent.parent; node = node.parent) {
      t = node.startTime() + t / node.timeScale();
    }
    return t;
  }

  /** Every cue so far, in root-timeline seconds, sorted by time. */
  function cues() {
    return cueMarks
      .map(({ tl, at, sfx, gain, pan, send, name }) => ({
        t: Math.round(rootTime(tl, at) * 10000) / 10000,
        sfx,
        gain,
        pan,
        ...(send === undefined ? {} : { send }),
        ...(name ? { name } : {}),
      }))
      .sort((a, b) => a.t - b.t || (a.sfx < b.sfx ? -1 : a.sfx > b.sfx ? 1 : 0));
  }

  function flushCues() {
    cueFlushQueued = false;
    const doc = root.document;
    if (!doc || !doc.documentElement) return;
    if (cueMarks.length) doc.documentElement.setAttribute("data-gg-cues", JSON.stringify(cues()));
    const curve = air();
    if (curve) doc.documentElement.setAttribute("data-gg-air", JSON.stringify(curve));
  }

  // Written once the composition script has finished nesting its timelines.
  function queueFlush() {
    if (!cueFlushQueued && typeof root.queueMicrotask === "function") {
      cueFlushQueued = true;
      root.queueMicrotask(flushCues);
    }
  }

  /**
   * Mark a sound at time `at` of `tl` ("click", "impact", ...; the score's
   * sound names). Adds no tween, so seeking is unaffected. Returns `at`.
   * Options: `gain` 0..2; `pan` -1..1, or `x` (screen px; pans with the
   * picture); `send` 0..1, how far away it sounds (default: the sound's own).
   */
  function cue(tl, at, sfx, opts = {}) {
    if (!(Number.isFinite(at) && at >= 0)) throw new Error(`cue time must be >= 0, got ${at}`);
    if (typeof sfx !== "string" || !/^[a-z][a-z-]*$/.test(sfx))
      throw new Error(`cue sound must be a sound name, got ${sfx}`);
    const gain = opts.gain ?? 1;
    if (opts.x !== undefined && !Number.isFinite(opts.x)) throw new Error("cue x must be a number");
    const width = opts.width ?? 1920;
    const fromX =
      opts.x === undefined ? 0 : Math.max(-1, Math.min(1, (opts.x / width) * 2 - 1)) * 0.7;
    const pan = opts.pan ?? Math.round(fromX * 1000) / 1000;
    if (!(gain >= 0 && gain <= 2)) throw new Error("cue gain must be 0..2");
    if (!(pan >= -1 && pan <= 1)) throw new Error("cue pan must be -1..1");
    if (opts.send !== undefined && !(opts.send >= 0 && opts.send <= 1))
      throw new Error("cue send must be 0..1");
    cueMarks.push({
      tl,
      at,
      sfx,
      gain,
      pan,
      send: opts.send,
      name: opts.name ? String(opts.name).slice(0, 60) : "",
    });
    queueFlush();
    return at;
  }

  root.GGMotionKit = {
    version: 1,
    // timing
    springs,
    spring,
    settleTime,
    springEase,
    ring,
    ease,
    rng,
    noise,
    // elements
    centerOf,
    rectOf,
    split,
    drive,
    // arrivals
    liftWords,
    dropLetters,
    reveal,
    typePlan,
    typewrite,
    tick,
    pop,
    stamp,
    // handoffs
    reshape,
    coverRadius,
    openFrom,
    diveThrough,
    arcPoint,
    converge,
    // contact
    hopAt,
    hop,
    impact,
    knock,
    // camera
    cameraPlan,
    cameraAt,
    restEnvelope,
    handheld,
    shakeAt,
    atDepth,
    toScreen,
    camera,
    cameraSpeed,
    // deep zoom
    deepZoomAt,
    deepZoom,
    // light
    lightLevel,
    lightGround,
    ringsAt,
    rings,
    // fields
    silkField,
    silk,
    grainTile,
    grain,
    // print
    halftoneTile,
    printInk,
    misregisterAt,
    misregister,
    paperTile,
    paperTexture,
    // belt
    beltAt,
    belt,
    // brush
    pathPoints,
    brushPlan,
    brushWidth,
    brushStroke,
    // cursor
    cursorPlan,
    cursorAt,
    cursorPath,
    // sound
    cue,
    cues,
    air,
  };
})(typeof window !== "undefined" ? window : globalThis);
