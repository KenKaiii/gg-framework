// @ts-check
// Tipsy (owner): drinking alcohol makes you more and more tipsy, in 5 levels. You see the drink in your hand and take
// 2-3 sips (one sip per few seconds, arm up to the mouth), then it's finished. Each finished drink adds to your
// tipsiness, and it wears off slowly over a few minutes. The higher the level:
//   - the screen: a slow sway and a soft blur/double vision around the edges (level 3+), a warm flush
//   - walking: you weave, drift sideways, sometimes stumble; your body sways when standing
//   - talking: your chat lines start slurring and, later, come out as random drunk nonsense
// Nothing flickers faster than a 1.5 s cycle. It's all local: other players will see you wobble once multiplayer
// sends avatar state.
import * as THREE from 'three';

/** Alcoholic menu items (by id): how strong (a lager 1, a cocktail 1.5, a gargle blaster 3). Everything else: none. */
export const STRENGTH = /** @type {Record<string, number>} */ ({
  dude: 1.5, martini: 1.5, red: 1, blue: 1, ipa: 1, negroni: 1.5, hotfix: 1.5, gargle: 3, mystery: 1.5, round: 1, lager: 1, ipa2: 1,
});
export const LEVELS = ['Sober', 'Tipsy', 'Buzzed', 'Drunk', 'Wasted', 'Absolutely gone'];
const MAX = 5;
const PER_LEVEL = 1;        // strength units per level: every drink shows (a lager = 1 level, a cocktail 1.5, a gargle blaster 3)
const WEAR_OFF = 1 / 150;   // strength units per second: a level wears off in ~2.5 minutes
const SIP_EVERY = 3.2;      // seconds between sips while holding a drink

/** @typedef {{ amount: number, drink: null | { id: string, prop: string, sips: number, total: number, strength: number, t: number }, sway: number, swayV: number, stumbleT: number }} TipsyState */

/** @param {any} S */
export function tipsyOf(S) { return S.tipsy || (S.tipsy = /** @type {TipsyState} */ ({ amount: 0, drink: null, sway: 0, swayV: 0, stumbleT: 4 })); }
/** 0 (sober) .. 5 (gone). @param {any} S */
export function tipsyLevel(S) { const st = tipsyOf(S); return st.amount < 0.25 ? 0 : Math.min(MAX, Math.ceil(st.amount / PER_LEVEL - 1e-6)); } // a whole lager = level 1 straight away; each level holds until its whole unit has worn off

/**
 * A drink was handed over: hold it and sip it 2-3 times. @param {any} S @param {string} id @param {string} prop
 * @param {(prop: string | null) => void} hold puts the prop in (or out of) the hand
 */
export function startDrink(S, id, prop, hold) {
  const st = tipsyOf(S), strength = STRENGTH[id] || 0;
  const sips = 2 + (Math.random() < 0.5 ? 1 : 0);
  st.drink = { id, prop, sips, total: sips, strength, t: 1.2 };
  /** @type {any} */ (st).hold = hold;
}

const SLUR = /** @type {[RegExp, string][]} */ ([[/s/g, 'sh'], [/S/g, 'Sh'], [/\bthe\b/gi, 'teh'], [/ing\b/g, "in'"], [/you/gi, 'ya']]);
const BABBLE = [
  'i love you guys. i mean it. *hic*', "who moved the floor", 'is it just me or is the room doing the thing', 'i should push to main rn',
  'BEST. BAR. EVER.', "i'm not drunk you're drunk", "what if... we rewrote it... in rust", 'where are my keys. i have no keys. this is a game',
  "*hic* sorry", 'one more and then bed. two more.', 'the bartender gets me', "i'm gonna text my ex. kidding. unless",
  'everything is a cache if you think about it', 'did i leave a console.log in prod', 'hold my drink', "the floor's lava. no wait",
  "who wants a hug", 'tabs > spaces fight me', 'i can see the code', '*sings loudly and badly*', 'wait whose drink is this',
];
/** Make a chat line sound as tipsy as you are. Level 0-1: unchanged; 2: slurred; 3+: slurred + extra; 4-5: sometimes nonsense. */
/** @param {string} text @param {number} level */
export function slur(text, level) {
  if (level < 2 || !text) return text;
  if (level >= 4 && Math.random() < (level === 5 ? 0.6 : 0.3)) return BABBLE[Math.floor(Math.random() * BABBLE.length)];
  let t = text; for (const [re, s] of SLUR) if (Math.random() < 0.35 + level * 0.15) t = t.replace(re, s);
  if (level >= 3) { t = t.replace(/([aeiou])/i, '$1$1$1'); if (Math.random() < 0.5) t += ' *hic*'; }
  if (level >= 5) t = t.toUpperCase();
  return t;
}
/** Every so often a drunk player blurts something on their own (level 3+). Returns a line or null. @param {number} level */
export function blurt(level) { return level >= 3 ? BABBLE[Math.floor(Math.random() * BABBLE.length)] : null; }

/**
 * Per frame. Sips the held drink, wears tipsiness off, and returns what the player's movement and the screen should do.
 * @param {any} S @param {number} dt
 * @returns {{ level: number, k: number, drift: number, speed: number, swayZ: number }}
 */
export function tickTipsy(S, dt) {
  const st = tipsyOf(S), av = S.me?.av;
  // sipping: arm up to the mouth every few seconds; the last sip finishes the drink (hand empties)
  if (st.drink) {
    st.drink.t -= dt;
    if (st.drink.t <= 0) {
      st.drink.sips--; st.drink.t = SIP_EVERY;
      if (av?.fx) av.fx.sip = 1.1;
      // the drink's strength arrives over its sips, so a whole lager adds exactly one level
      st.amount = Math.min(MAX * PER_LEVEL + 1, st.amount + st.drink.strength / st.drink.total);
      if (st.drink.sips <= 0) { const h = /** @type {any} */ (st).hold; st.drink = null; setTimeout(() => h?.(null), 900); }
    }
  }
  if (!st.drink) st.amount = Math.max(0, st.amount - WEAR_OFF * dt); // nothing wears off while you've still got a drink on the go
  const level = tipsyLevel(S), k = Math.min(1, st.amount / (MAX * PER_LEVEL));
  // a slow, springy sway (no fast flicker): drives the body lean, the walking drift and the screen roll
  const target = Math.sin(S.t * (0.55 + k * 0.4)) * 0.6 + Math.sin(S.t * 0.27 + 1.3) * 0.4;
  st.swayV += (target - st.sway) * dt * 2.2; st.swayV *= Math.exp(-dt * 1.8); st.sway += st.swayV * dt * 2.2;
  // a stumble now and then from level 3
  let stumble = 0; if (level >= 3) { st.stumbleT -= dt; if (st.stumbleT <= 0) { st.stumbleT = 4 + Math.random() * (9 - level); stumble = (Math.random() < 0.5 ? -1 : 1); } }
  return { level, k, drift: st.sway * k * 0.9 + stumble * k * 0.7, speed: 1 - k * 0.28, swayZ: st.sway * k * 0.22 };
}

/** Lean the body with the sway (called after the avatar's own update). @param {any} av @param {number} swayZ */
export function leanBody(av, swayZ) {
  if (!av || Math.abs(swayZ) < 0.002) return;
  av.rot?.('hips', 0, 0, swayZ * 0.5); av.rot?.('chest', 0, 0, swayZ * 0.8); av.rot?.('head', swayZ * 0.3, 0, swayZ * 1.2);
}

/**
 * The screen: a CSS layer over the canvas (vignette blur, warm flush) and a slow canvas roll/zoom. Cheap (CSS only,
 * no extra render pass). @param {HTMLCanvasElement} canvas
 */
export function makeTipsyScreen(canvas) {
  const veil = document.createElement('div');
  // the canvas tilts (a CSS transform lifts it into its own layer), so the veil and the HUD (#ui, z 2) sit above it
  canvas.style.position = canvas.style.position || 'relative'; canvas.style.zIndex = '0';
  veil.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1;opacity:0;transition:opacity 1.2s;'
    + '-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);'
    + '-webkit-mask-image:radial-gradient(ellipse 62% 58% at 50% 50%,transparent 45%,#000 100%);mask-image:radial-gradient(ellipse 62% 58% at 50% 50%,transparent 45%,#000 100%);'
    + 'background:radial-gradient(ellipse 70% 65% at 50% 50%,transparent 50%,rgba(255,120,90,.16) 100%)';
  document.body.appendChild(veil);
  let shown = -1, lastLv = -1;
  return {
    /** @param {number} level @param {number} k @param {number} sway @param {number} t */
    update(level, k, sway, t) {
      const want = level >= 2 ? Math.min(1, (level - 1) / 3) : 0;
      if (Math.abs(want - shown) > 0.01) { veil.style.opacity = String(want); shown = want; }
      if (level !== lastLv) { lastLv = level; const bl = level >= 5 ? 6 : level >= 4 ? 4.5 : 3; veil.style.setProperty('-webkit-backdrop-filter', `blur(${bl}px)`); veil.style.setProperty('backdrop-filter', `blur(${bl}px)`); }
      if (level >= 1) {
        const deg = sway * k * (1.2 + level * 0.35), rad = Math.abs(deg) * Math.PI / 180;
        // scale enough that the tilted picture always covers the window (no dark corners)
        const cover = 1 + rad * (Math.max(innerWidth, innerHeight) / Math.min(innerWidth, innerHeight)) + 0.01, z = cover + k * 0.02 + Math.sin(t * 0.5) * k * 0.01;
        canvas.style.transform = `rotate(${deg.toFixed(3)}deg) scale(${z.toFixed(4)})`;
      } else if (canvas.style.transform) canvas.style.transform = '';
    },
  };
}

void THREE;
