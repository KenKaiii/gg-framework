import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guards the motion tokens in App.css `:root`. Every curve outside `:root`
// comes from an --ease-* token, every timed transition names a shared easing,
// and every script timer that waits on CSS motion stays equal to its token.
// Animations are out of scope for the easing check on purpose: most are long
// background loops (breathing, weather) that deliberately use keyword curves.
const FILES = ["App.css", "Deck.css", "ChecklistScreen.css", "ChatErrorNotice.css", "Trophies.css"];
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const sheets = FILES.map((name) => ({
  name,
  // Comments may mention raw values; only real declarations count.
  css: read(`../src/${name}`).replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  ),
}));

/**
 * [start, end) ranges of every `:root { … }` and `@property … { … }` block,
 * including the theme-scoped ones (`:root[data-theme="light"] { … }`).
 */
function definitionBlocks(css) {
  const ranges = [];
  const root = String.raw`:root(?:\[[^\]]*\])?`;
  const opener = new RegExp(
    String.raw`${root}(?:\s*,\s*${root})*\s*\{|@property\s+--[\w-]+\s*\{`,
    "g",
  );
  for (const m of css.matchAll(opener)) {
    ranges.push([m.index, css.indexOf("}", m.index) + 1]);
  }
  return ranges;
}
const lineOf = (css, index) => css.slice(0, index).split("\n").length;
const inBlocks = (blocks, index) => blocks.some(([start, end]) => index >= start && index < end);

// Every token defined in a `:root` block of App.css, by name.
const appCss = sheets[0].css;
const motionTokens = new Map();
for (const [start, end] of definitionBlocks(appCss)) {
  const block = appCss.slice(start, end);
  if (!block.startsWith(":root")) continue;
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)[;}]/g)) {
    motionTokens.set(m[1], m[2].trim());
  }
}

/** Every `transition*` declaration outside definition blocks, with file:line. */
function transitionDeclarations() {
  const out = [];
  for (const { name, css } of sheets) {
    const blocks = definitionBlocks(css);
    for (const m of css.matchAll(
      /(?:^|[\s;{])(transition(?:-[a-z-]+)?)\s*:\s*([^;{}]+?)\s*(?=[;}])/g,
    )) {
      if (inBlocks(blocks, m.index)) continue;
      const line = lineOf(css, m.index) + (m[0].startsWith("\n") ? 1 : 0);
      out.push({ where: `${name}:${line}`, prop: m[1], value: m[2].replace(/\s+/g, " ") });
    }
  }
  return out;
}

/** Split on top-level separators (commas or whitespace), skipping anything in parens. */
function splitTopLevel(value, separator) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && separator.test(ch)) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const KEYWORD_EASING = new Set(["ease", "ease-in", "ease-out", "ease-in-out"]);
const NONZERO_TIME = /^(?:\d*\.)?\d+m?s$/;
const isNonZeroTime = (word) => NONZERO_TIME.test(word) && parseFloat(word) !== 0;

/** `220ms` / `0.22s` → 220. */
const toMs = (value) => {
  const m = /^((?:\d*\.)?\d+)(ms|s)$/.exec(value.trim());
  if (!m) throw new Error(`not a duration: ${value}`);
  return m[2] === "s" ? Math.round(parseFloat(m[1]) * 1000) : parseFloat(m[1]);
};
const normalizeCurve = (value) => value.replace(/\s+/g, "");

// Script timings that wait on (or replay) CSS motion. `equal` pins the value
// to the token; `greater` keeps a fallback timer strictly after the CSS ends.
const MIRRORS = [
  ["AttachmentBar.tsx", "EXIT_MS", "--dur-strip-out", "equal"],
  ["ReferencedFiles.tsx", "EXIT_MS", "--dur-strip-out", "equal"],
  ["CacheExpiryNotice.tsx", "EXIT_MS", "--dur-strip-out", "equal"],
  ["Toaster.tsx", "EXIT_MS", "--dur-toast-out", "equal"],
  ["TooltipLayer.tsx", "EXIT_MS", "--dur-exit", "equal"],
  ["EnhanceDissolve.tsx", "DISSOLVE_MS", "--dur-enhance-dissolve", "equal"],
  ["PlanReviewModal.tsx", "EXIT_FALLBACK_MS", "--dur-plan-out", "greater"],
  ["AskBand.tsx", "HOLD_MS", "--dur-ask-hold", "equal"],
  ["AskBand.tsx", "EXIT_MS", "--dur-strip-out", "equal"],
  ["AskBand.tsx", "KEY_PRESS_MS", "--dur-press", "equal"],
  ["animated-height.ts", "DURATION_MS", "--dur-row", "equal"],
  ["animated-height.ts", "EASING", "--ease-out", "equal"],
  ["chat-layout-motion.ts", "DURATION_MS", "--dur-row", "equal"],
  ["chat-layout-motion.ts", "EASING", "--ease-out", "equal"],
  ["transcript-motion.ts", "EASE_OUT", "--ease-out", "equal"],
  ["transcript-motion.ts", "EASE_IN", "--ease-in", "equal"],
  ["critter-fx.ts", "POP", "--ease-pop", "equal"],
  ["TrophyUnlock.tsx", "EASE_OUT", "--ease-out", "equal"],
  ["TrophyUnlock.tsx", "EASE_EXPO", "--ease-expo", "equal"],
  ["TrophyUnlock.tsx", "EASE_IN", "--ease-in", "equal"],
];

describe("motion tokens", () => {
  it("draws every curve outside :root from a token", () => {
    const offenders = [];
    for (const { name, css } of sheets) {
      const blocks = definitionBlocks(css);
      for (const m of css.matchAll(/cubic-bezier\(/g)) {
        if (!inBlocks(blocks, m.index)) offenders.push(`${name}:${lineOf(css, m.index)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives every timed transition a shared easing", () => {
    const decls = transitionDeclarations();
    expect(decls.length).toBeGreaterThan(50);
    const offenders = [];
    for (const { where, prop, value } of decls) {
      if (prop !== "transition" && prop !== "transition-timing-function") continue;
      for (const entry of splitTopLevel(value, /,/)) {
        const words = splitTopLevel(entry, /\s/);
        const keyword = words.some((word) => KEYWORD_EASING.has(word));
        const timedWithoutToken =
          prop === "transition" &&
          words.some(isNonZeroTime) &&
          !/var\(|\blinear\b|steps\(/.test(entry);
        if (keyword || timedWithoutToken) offenders.push(`${where} ${prop}: ${entry}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps script timings equal to their CSS tokens", () => {
    const offenders = [];
    for (const [file, constant, token, relation] of MIRRORS) {
      const source = read(`../src/${file}`);
      const m = new RegExp(`const ${constant}\\s*=\\s*(?:(\\d+)|"([^"]+)")\\s*;`).exec(source);
      const tokenValue = motionTokens.get(token);
      if (!m || tokenValue === undefined) {
        offenders.push(`${file} ${constant} ↔ ${token}: not found`);
        continue;
      }
      const [, number, text] = m;
      let ok;
      if (text !== undefined) ok = normalizeCurve(text) === normalizeCurve(tokenValue);
      else if (relation === "greater") ok = Number(number) > toMs(tokenValue);
      else ok = Number(number) === toMs(tokenValue);
      if (!ok) {
        const must = relation === "greater" ? "greater than" : "equal to";
        offenders.push(
          `${file} ${constant} = ${number ?? text} must be ${must} ${token} (${tokenValue})`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
