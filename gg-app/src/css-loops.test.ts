import { describe, expect, it } from "vitest";

// Guard: every looping CSS animation must follow the window's motion level.
// A loop that ignores `--loop-play-state` keeps repainting in background
// windows (see `:root[data-motion]` in App.css): that is how the plan-mode
// shimmer, the signal arcs and the scorecard's rank shimmer were missed by
// the old hand-kept pause list.

/** Every stylesheet next to this test, as text, keyed by "./Name.css". */
const SHEETS = import.meta.glob<string>("./*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});
const LOOP_STATE = "var(--loop-play-state, running)";

function lastIndex(list: readonly string[], test: (item: string) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (item !== undefined && test(item)) return i;
  }
  return -1;
}

/** Split a comma list at the top level (commas inside `()` don't count). */
function splitTop(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

interface Problem {
  readonly at: string;
  readonly reason: string;
}

/** Problems in one stylesheet's looping animations. */
function loopProblems(file: string, css: string): Problem[] {
  const problems: Problem[] = [];
  for (const block of css.matchAll(/\{([^{}]*)\}/g)) {
    const body = (block[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    const decls = body
      .split(";")
      .map((d) => d.trim().replace(/\s+/g, " "))
      .filter((d) => d.startsWith("animation"));
    if (!decls.some((d) => /\binfinite\b/.test(d))) continue;
    const line = css.slice(0, block.index).split("\n").length;
    const at = `${file}:${line}`;
    const stateIndex = lastIndex(decls, (d) => d.startsWith("animation-play-state:"));
    const shorthandIndex = lastIndex(decls, (d) => /^animation ?:/.test(d));
    if (stateIndex === -1) {
      problems.push({ at, reason: `loops without animation-play-state: ${LOOP_STATE}` });
      continue;
    }
    if (stateIndex < shorthandIndex) {
      problems.push({ at, reason: "animation shorthand after play-state resets it to running" });
      continue;
    }
    const states = splitTop(decls[stateIndex]?.split(":").slice(1).join(":") ?? "");
    const shorthand = decls[shorthandIndex];
    const entries = shorthand ? splitTop(shorthand.split(":").slice(1).join(":")) : [];
    if (entries.length === 0) {
      // Longhands only (iteration-count set here, name elsewhere).
      if (!states.every((s) => s === LOOP_STATE)) {
        problems.push({ at, reason: `play-state must be ${LOOP_STATE}` });
      }
      continue;
    }
    entries.forEach((entry, i) => {
      const state = states[i % states.length];
      const loops = /\binfinite\b/.test(entry);
      if (loops && state !== LOOP_STATE) {
        problems.push({ at, reason: `"${entry}" loops but its play-state is ${state}` });
      }
      if (!loops && state === LOOP_STATE) {
        problems.push({ at, reason: `one-shot "${entry}" would freeze half-played when paused` });
      }
    });
  }
  return problems;
}

describe("looping CSS animations", () => {
  const sheets = Object.keys(SHEETS).sort();

  it("finds the app stylesheets", () => {
    expect(sheets).toContain("./App.css");
  });

  it("all pause with the window's motion level", () => {
    const problems = sheets.flatMap((name) => loopProblems(name, SHEETS[name] ?? ""));
    expect(problems).toEqual([]);
  });

  it("catches a loop that ignores the motion level", () => {
    const css = ".spin {\n  animation: spin 1s linear infinite;\n}\n";
    expect(loopProblems("x.css", css)).toEqual([
      { at: "x.css:1", reason: `loops without animation-play-state: ${LOOP_STATE}` },
    ]);
  });

  it("only pauses the looping entries of a mixed list", () => {
    const good = `.a {\n  animation: pop 1s both, glow 2s infinite;\n  animation-play-state: running, ${LOOP_STATE};\n}`;
    const bad = `.a {\n  animation: pop 1s both, glow 2s infinite;\n  animation-play-state: ${LOOP_STATE};\n}`;
    expect(loopProblems("x.css", good)).toEqual([]);
    expect(loopProblems("x.css", bad).map((p) => p.reason)).toEqual([
      'one-shot "pop 1s both" would freeze half-played when paused',
    ]);
  });
});

// Guard: Home's update key is disabled while it installs, and a dimming
// :disabled rule once faded it so the progress was hard to see. No rule for
// either update key itself (as opposed to its effects) may lower its opacity.
describe("update keys", () => {
  it.each([
    ["./HomeUpdateButton.css", /\.(?:home-update|lvl-face|lvl-base)\b/],
    ["./UpdateBanner.css", /\.(?:update-banner|ub-row|ub-key)/],
  ])("%s never fades, including while it installs or is pressed", (sheet, names) => {
    const css = SHEETS[sheet] ?? "";
    const rules = (css.match(/[^{}]*\{[^}]*\}/g) ?? []).filter((rule) =>
      names.test(rule.slice(0, rule.indexOf("{"))),
    );
    expect(rules.length).toBeGreaterThan(3);
    for (const rule of rules) expect(rule).not.toMatch(/\bopacity:\s*0?\.\d/);
  });
});

// Guard: the What's new window is GG Royale's lounge, the same in both themes:
// pixel fonts (never the app's sans) and the Daily's dark board, so its fixed
// cream and gold text keep their contrast whatever the app theme is.
describe("What's new window", () => {
  const css = SHEETS["./WhatsNew.css"] ?? "";
  const rule = (selector: string): string =>
    css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";

  it("sets its own pixel type instead of the app's sans", () => {
    expect(rule(".whatsnew-window")).toContain('font-family: "m5x7"');
    expect(css).not.toContain("var(--sans)");
  });

  it("puts the notes on the Daily's dark board, in every theme", () => {
    expect(rule(".wn-board")).toContain("background: #251c22");
    expect(rule(".whatsnew-highlight")).toContain("color: var(--wn-gold)");
    expect(css).not.toMatch(/data-theme/);
  });
});

// Guard: the production bundle loads AboutPage.css before App.css, so a
// single-class About rule lost to the shared class it sits beside (the maker
// card stacked into one column in the release, though dev looked right). Every
// About rule that restyles a shared class's element names both classes, so it
// wins in any load order.
describe("About page layout", () => {
  const css = SHEETS["./AboutPage.css"] ?? "";

  it.each([
    [".settings-card.about-maker", ".about-maker"],
    [".btn.about-cta", ".about-cta"],
    [".settings-section-title.about-log-title", ".about-log-title"],
    [".about-ken.ken-dialogue", ".about-ken"],
  ])("styles %s with both classes", (both, alone) => {
    expect(css).toContain(`${both} {`);
    expect(css).not.toMatch(new RegExp(`(?:^|\\n)\\s*${alone.replace(/\./g, "\\.")} \\{`));
  });
});

// Guard: the CI indicator inherits its font (it was drawn for the title bar),
// so in the Git panel's tab row it rendered at the page's 16px beside 11.5px
// keys. The row gives it the keys' type.
describe("Git panel CI indicator", () => {
  it("takes the row's key type instead of inheriting the page's", () => {
    const css = SHEETS["./Deck.css"] ?? "";
    const rule = css.match(/\n\.git-tabs \.chat-head-ci \{([^}]*)\}/)?.[1] ?? "";
    const keySm = css.match(/\n\.key-sm \{([^}]*)\}/)?.[1] ?? "";
    const size = (body: string): string | undefined => body.match(/font-size:\s*([^;]+);/)?.[1];
    expect(size(rule)).toBeDefined();
    expect(size(rule)).toBe(size(keySm));
  });
});
