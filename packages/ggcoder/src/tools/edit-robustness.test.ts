/**
 * Robustness benchmark for the edit/update tool's matcher.
 *
 * "old_text not found" is the dominant edit failure. Models rarely reproduce a
 * snippet byte-for-byte — they drift on whitespace, quotes, indentation, line
 * endings, and invisible unicode. This benchmark throws 50+ realistic LLM
 * perturbations at the REAL tool against realistic source files and reports the
 * pass rate per category.
 *
 * Three expectations, so this measures correctness — not just leniency:
 *   - "match"      → the matcher MUST locate and apply the edit.
 *   - "reject"     → the snippet genuinely differs (rename/reorder); applying it
 *                     would corrupt the file, so the matcher MUST NOT match.
 *   - "limitation" → a drift we deliberately don't handle (internal-whitespace
 *                     paraphrasing); failing is acceptable and reported only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createEditTool } from "./edit.js";

// ── Base files + the block the model is trying to edit ─────

interface Base {
  source: string;
  old: string;
  new: string;
  oldMark: string;
  newMark: string;
}

const spaces: Base = {
  source: `export const SETTINGS = {
  name: "widget",
  retries: 3,
  label: 'auto-sync',
  mode: "fast",
};
`,
  old: ['  name: "widget",', "  retries: 3,", "  label: 'auto-sync',"].join("\n"),
  new: ['  name: "gadget",', "  retries: 5,", "  label: 'auto-sync',"].join("\n"),
  oldMark: '"widget"',
  newMark: '"gadget"',
};

const tabs: Base = {
  source: `function run() {
\tconst host = "alpha";
\tconst port = 8080;
\treturn host;
}
`,
  old: ['\tconst host = "alpha";', "\tconst port = 8080;"].join("\n"),
  new: ['\tconst host = "beta";', "\tconst port = 9090;"].join("\n"),
  oldMark: '"alpha"',
  newMark: '"beta"',
};

const single: Base = {
  source: `const greeting = "hello world";
`,
  old: `const greeting = "hello world";`,
  new: `const greeting = "hi there";`,
  oldMark: "hello world",
  newMark: "hi there",
};

// ── Perturbation primitives ────────────────────────────────

const NBSP = "\u00A0";
const id = (s: string) => s;
const compose =
  (...fns: ((s: string) => string)[]) =>
  (s: string): string =>
    fns.reduce((acc, f) => f(acc), s);

const trailAll = (s: string): string =>
  s
    .split("\n")
    .map((l) => (l === "" ? l : l + "   "))
    .join("\n");
const trailFirst = (s: string): string => s.replace(/^(.*)$/m, "$1  ");
const leadBlank = (s: string): string => "\n" + s;
const twoLeadBlank = (s: string): string => "\n\n" + s;
const trailNewline = (s: string): string => s + "\n";
const crlf = (s: string): string => s.replace(/\n/g, "\r\n");

const underIndent = (s: string): string => s.replace(/^ {2}/gm, "");
const stripIndent = (s: string): string => s.replace(/^\s+/gm, "");
const overIndent = (s: string): string => s.replace(/^/gm, "    ");
const spacesForTab = (s: string): string => s.replace(/^\t/gm, "    ");

const smartD = (s: string): string => s.replace(/"/g, "\u201C");
const smartS = (s: string): string => s.replace(/'/g, "\u2018");
const enDash = (s: string): string => s.replace(/-/g, "\u2013");
const emDash = (s: string): string => s.replace(/-/g, "\u2014");
const uMinus = (s: string): string => s.replace(/-/g, "\u2212");

const nbspInternal = (s: string): string => s.replace(/: /g, ":" + NBSP);
const nbspLeading = (s: string): string => s.replace(/^ +/gm, (m) => NBSP.repeat(m.length));
const zeroWidth = (s: string): string => s.replace(/: /g, ": \u200B");
const bom = (s: string): string => "\uFEFF" + s;
const wordJoiner = (s: string): string => s.replace(/: /g, ":\u2060 ");
const ideographic = (s: string): string => s.replace(/ /g, "\u3000");
const thinSpace = (s: string): string => s.replace(/: /g, ":\u2009");
const narrowNbsp = (s: string): string => s.replace(/: /g, ":\u202F");

const collapseInternal = (s: string): string => s.replace(/: /g, ":");
const expandInternal = (s: string): string => s.replace(/: /g, ":   ");
const renameVar = (s: string): string =>
  s.replace(/\bname\b/, "title").replace(/\bhost\b/, "server");
const reorderLines = (s: string): string => {
  const lines = s.split("\n");
  if (lines.length >= 2) [lines[0], lines[1]] = [lines[1], lines[0]];
  return lines.join("\n");
};

// ── Scenario table ─────────────────────────────────────────

type Expect = "match" | "reject" | "limitation";
interface Scenario {
  name: string;
  base: Base;
  expect: Expect;
  oldFn: (s: string) => string;
  newFn?: (s: string) => string; // for indentation drifts, transform new the same way
}

const scenarios: Scenario[] = [
  // ── whitespace / structure (spaces base) ──
  { name: "exact", base: spaces, expect: "match", oldFn: id },
  { name: "trailing-ws-all", base: spaces, expect: "match", oldFn: trailAll },
  { name: "trailing-ws-first-line", base: spaces, expect: "match", oldFn: trailFirst },
  { name: "leading-blank-line", base: spaces, expect: "match", oldFn: leadBlank },
  { name: "two-leading-blank-lines", base: spaces, expect: "match", oldFn: twoLeadBlank },
  { name: "trailing-newline-extra", base: spaces, expect: "match", oldFn: trailNewline },
  {
    name: "under-indent-uniform",
    base: spaces,
    expect: "match",
    oldFn: underIndent,
    newFn: underIndent,
  },
  {
    name: "strip-all-indent",
    base: spaces,
    expect: "match",
    oldFn: stripIndent,
    newFn: stripIndent,
  },
  {
    name: "over-indent-uniform",
    base: spaces,
    expect: "match",
    oldFn: overIndent,
    newFn: overIndent,
  },
  { name: "crlf-line-endings", base: spaces, expect: "match", oldFn: crlf },

  // ── invisible unicode (spaces base) ──
  { name: "nbsp-internal", base: spaces, expect: "match", oldFn: nbspInternal },
  { name: "nbsp-leading", base: spaces, expect: "match", oldFn: nbspLeading },
  { name: "zero-width-space", base: spaces, expect: "match", oldFn: zeroWidth },
  { name: "bom-prefix", base: spaces, expect: "match", oldFn: bom },
  { name: "word-joiner", base: spaces, expect: "match", oldFn: wordJoiner },
  { name: "ideographic-space", base: spaces, expect: "match", oldFn: ideographic },
  { name: "thin-space", base: spaces, expect: "match", oldFn: thinSpace },
  { name: "narrow-nbsp", base: spaces, expect: "match", oldFn: narrowNbsp },

  // ── quotes / dashes (spaces base) ──
  { name: "smart-double-quotes", base: spaces, expect: "match", oldFn: smartD },
  { name: "smart-single-quotes", base: spaces, expect: "match", oldFn: smartS },
  { name: "smart-both-quotes", base: spaces, expect: "match", oldFn: compose(smartD, smartS) },
  { name: "en-dash", base: spaces, expect: "match", oldFn: enDash },
  { name: "em-dash", base: spaces, expect: "match", oldFn: emDash },
  { name: "unicode-minus", base: spaces, expect: "match", oldFn: uMinus },

  // ── realistic combos (spaces base) ──
  { name: "smart+trailing", base: spaces, expect: "match", oldFn: compose(smartD, trailAll) },
  { name: "nbsp+smart", base: spaces, expect: "match", oldFn: compose(nbspInternal, smartD) },
  { name: "emdash+trailing", base: spaces, expect: "match", oldFn: compose(emDash, trailAll) },
  {
    name: "leadingblank+trailing",
    base: spaces,
    expect: "match",
    oldFn: compose(leadBlank, trailAll),
  },
  { name: "zerowidth+smart", base: spaces, expect: "match", oldFn: compose(zeroWidth, smartD) },
  { name: "crlf+smart", base: spaces, expect: "match", oldFn: compose(crlf, smartD) },
  {
    name: "under-indent+smart",
    base: spaces,
    expect: "match",
    oldFn: compose(underIndent, smartD),
    newFn: underIndent,
  },
  {
    name: "over-indent+smart",
    base: spaces,
    expect: "match",
    oldFn: compose(overIndent, smartD),
    newFn: overIndent,
  },
  {
    name: "strip-indent+trailing",
    base: spaces,
    expect: "match",
    oldFn: compose(stripIndent, trailAll),
    newFn: stripIndent,
  },
  {
    name: "nbsp-leading+trailing",
    base: spaces,
    expect: "match",
    oldFn: compose(nbspLeading, trailAll),
  },
  { name: "ideographic+smart", base: spaces, expect: "match", oldFn: compose(ideographic, smartD) },
  {
    name: "thinspace+trailing",
    base: spaces,
    expect: "match",
    oldFn: compose(thinSpace, trailAll),
  },
  { name: "narrownbsp+smart", base: spaces, expect: "match", oldFn: compose(narrowNbsp, smartD) },
  { name: "bom+trailing", base: spaces, expect: "match", oldFn: compose(bom, trailAll) },
  { name: "uminus+trailing", base: spaces, expect: "match", oldFn: compose(uMinus, trailAll) },
  {
    name: "twoblank+trailing",
    base: spaces,
    expect: "match",
    oldFn: compose(twoLeadBlank, trailAll),
  },

  // ── tabs base ──
  { name: "tabs-exact", base: tabs, expect: "match", oldFn: id },
  { name: "tabs-trailing-ws", base: tabs, expect: "match", oldFn: trailAll },
  { name: "tabs-smart-double", base: tabs, expect: "match", oldFn: smartD },
  { name: "tabs-crlf", base: tabs, expect: "match", oldFn: crlf },
  {
    name: "spaces-for-tab-indent",
    base: tabs,
    expect: "match",
    oldFn: spacesForTab,
    newFn: spacesForTab,
  },

  // ── single-line base ──
  { name: "single-exact", base: single, expect: "match", oldFn: id },
  { name: "single-trailing-ws", base: single, expect: "match", oldFn: trailAll },
  { name: "single-smart-double", base: single, expect: "match", oldFn: smartD },
  { name: "single-nbsp", base: single, expect: "match", oldFn: nbspInternal },
  { name: "single-zero-width", base: single, expect: "match", oldFn: zeroWidth },
  { name: "single-em-dash", base: single, expect: "match", oldFn: emDash },
  { name: "single-leading-blank", base: single, expect: "match", oldFn: leadBlank },

  // ── correctness controls: MUST be rejected (would corrupt the file) ──
  { name: "renamed-token", base: spaces, expect: "reject", oldFn: renameVar },
  { name: "reordered-lines", base: spaces, expect: "reject", oldFn: reorderLines },
  { name: "renamed-token-tabs", base: tabs, expect: "reject", oldFn: renameVar },

  // ── NFKC agnostic layer (curated) ──
  {
    name: "ligature-fi",
    base: {
      source: 'const profile = "config-file";\n',
      old: 'const profile = "config-file";',
      new: 'const profile = "config-data";',
      oldMark: "config-file",
      newMark: "config-data",
    },
    expect: "match",
    // "config" contains "fi" -> ligature ﬁ; NFKC folds it back to "fi".
    oldFn: (s) => s.replace("fi", "\uFB01"),
  },

  // ── known limitations (internal-whitespace paraphrasing) ──
  { name: "collapsed-internal-space", base: spaces, expect: "limitation", oldFn: collapseInternal },
  { name: "expanded-internal-space", base: spaces, expect: "limitation", oldFn: expandInternal },
];

// ── Generated matrix: many file types × many drifts (100+ scenarios) ─────────
//
// Every base block carries the features each transform needs (a double-quoted
// string, a hyphen, an inner space, and — unless 0-indent — leading indentation),
// so each generated scenario is a meaningful, non-redundant drift.

interface GenBase {
  id: string;
  source: string;
  old: string;
  new: string;
  oldMark: string;
  newMark: string;
  indent: string; // one indentation level, "" for none
}

// Build a base from two content lines; line one carries the mark that changes.
function gen(
  id: string,
  indent: string,
  pre: string,
  line1: { old: string; new: string },
  line2: string,
  post: string,
  marks: { old: string; new: string },
): GenBase {
  const oldBlock = `${indent}${line1.old}\n${indent}${line2}`;
  const newBlock = `${indent}${line1.new}\n${indent}${line2}`;
  const source = `${pre}\n${oldBlock}\n${post}\n`;
  return {
    id,
    source,
    old: oldBlock,
    new: newBlock,
    oldMark: marks.old,
    newMark: marks.new,
    indent,
  };
}

const genBases: GenBase[] = [
  gen(
    "ts-object",
    "  ",
    "export const settings = {",
    { old: 'api_host: "edge-1.example.com",', new: 'api_host: "edge-2.example.com",' },
    "max_items: 25,",
    "};",
    { old: "edge-1", new: "edge-2" },
  ),
  gen(
    "python",
    "    ",
    "def connect():",
    { old: 'host = "db-primary"  # primary-node', new: 'host = "db-replica"  # primary-node' },
    "timeout: int = 30",
    "    return host",
    { old: "db-primary", new: "db-replica" },
  ),
  gen(
    "json",
    "  ",
    "{",
    { old: '"name": "co-pilot",', new: '"name": "co-driver",' },
    '"flag": "on-off"',
    "}",
    { old: "co-pilot", new: "co-driver" },
  ),
  gen(
    "yaml",
    "  ",
    "service:",
    { old: 'image: "nginx-stable"', new: 'image: "nginx-latest"' },
    'note: "multi-arch"',
    "  port: 8080",
    { old: "nginx-stable", new: "nginx-latest" },
  ),
  gen(
    "go-tabs",
    "\t",
    "func dial() string {",
    { old: 'addr := "node-a-1:7000"', new: 'addr := "node-b-1:7000"' },
    'mode := "read-only"',
    "}",
    { old: "node-a-1", new: "node-b-1" },
  ),
  gen(
    "css",
    "  ",
    ".btn {",
    { old: 'content: "step-one";', new: 'content: "step-two";' },
    "margin: 0 auto;",
    "}",
    { old: "step-one", new: "step-two" },
  ),
  gen(
    "nested-ts",
    "  ",
    "      return {",
    { old: 'kind: "task-run",', new: 'kind: "task-done",' },
    "id: nextId(),",
    "      };",
    { old: "task-run", new: "task-done" },
  ),
  gen(
    "shell",
    "  ",
    "deploy() {",
    { old: 'local target = "prod-west"', new: 'local target = "prod-east"' },
    'local tag = "v1-2"',
    "}",
    { old: "prod-west", new: "prod-east" },
  ),
  gen(
    "markdown",
    "",
    "## Setup",
    { old: 'Install the "core-lib" package.', new: 'Install the "core-api" package.' },
    "Run the setup-script now.",
    "Done.",
    { old: "core-lib", new: "core-api" },
  ),
  gen(
    "sql",
    "",
    "SELECT * FROM users",
    { old: 'WHERE status = "active-1"', new: 'WHERE status = "active-2"' },
    'AND role = "read-only";',
    "LIMIT 10;",
    { old: "active-1", new: "active-2" },
  ),
  gen(
    "toml",
    "",
    "[server]",
    { old: 'host = "web-01"', new: 'host = "web-02"' },
    'tags = "edge-cache"',
    "enabled = true",
    { old: "web-01", new: "web-02" },
  ),
  gen(
    "jsx",
    "  ",
    "return (",
    { old: '<Button label="sign-in" />', new: '<Button label="sign-up" />' },
    "<Spacer size={8} />",
    ");",
    { old: "sign-in", new: "sign-up" },
  ),
];

const IDEO = "\u3000";
const firstInner =
  (repl: string) =>
  (s: string): string =>
    s.replace(/(\S) /, `$1${repl}`); // first space following a non-space char
const insertAfterInner =
  (ins: string) =>
  (s: string): string =>
    s.replace(/(\S) /, `$1 ${ins}`);

const underIndentB = (s: string, b: GenBase): string =>
  b.indent
    ? s
        .split("\n")
        .map((l) => (l.startsWith(b.indent) ? l.slice(b.indent.length) : l))
        .join("\n")
    : s;
const overIndentB = (s: string, b: GenBase): string => s.replace(/^/gm, b.indent);
const stripIndentB = (s: string): string => s.replace(/^[ \t]+/gm, "");
const renameToken = (s: string): string => s.replace(/[A-Za-z]{3,}/, (m) => `${m}_XYZ`);
// Map printable ASCII (0x21-0x7E) to fullwidth forms; NFKC folds them back.
const toFullwidth = (s: string): string =>
  s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));

interface GenTransform {
  name: string;
  expect: Expect;
  needsIndent?: boolean;
  old: (s: string, b: GenBase) => string;
  new?: (s: string, b: GenBase) => string;
}

const genTransforms: GenTransform[] = [
  { name: "trailing-ws", expect: "match", old: (s) => trailAll(s) },
  { name: "leading-blank", expect: "match", old: (s) => leadBlank(s) },
  { name: "leading-blanks-3", expect: "match", old: (s) => "\n\n\n" + s },
  { name: "trailing-blank", expect: "match", old: (s) => s + "\n\n" },
  { name: "crlf", expect: "match", old: (s) => crlf(s) },
  { name: "smart-double", expect: "match", old: (s) => smartD(s) },
  { name: "internal-nbsp", expect: "match", old: (s) => firstInner(NBSP)(s) },
  { name: "internal-zwsp", expect: "match", old: (s) => insertAfterInner("\u200B")(s) },
  { name: "internal-ideographic", expect: "match", old: (s) => firstInner(IDEO)(s) },
  { name: "em-dash", expect: "match", old: (s) => emDash(s) },
  { name: "en-dash", expect: "match", old: (s) => enDash(s) },
  { name: "word-joiner", expect: "match", old: (s) => insertAfterInner("\u2060")(s) },
  // NFKC agnostic layer — folded generically, not enumerated.
  { name: "fullwidth-quotes", expect: "match", old: (s) => s.replace(/"/g, "\uFF02") },
  { name: "horizontal-bar", expect: "match", old: (s) => s.replace(/-/g, "\u2015") },
  { name: "fullwidth-content", expect: "match", old: (s) => toFullwidth(s) },
  {
    name: "under-indent",
    expect: "match",
    needsIndent: true,
    old: (s, b) => underIndentB(s, b),
    new: (s, b) => underIndentB(s, b),
  },
  {
    name: "over-indent",
    expect: "match",
    needsIndent: true,
    old: (s, b) => overIndentB(s, b),
    new: (s, b) => overIndentB(s, b),
  },
  {
    name: "strip-indent",
    expect: "match",
    needsIndent: true,
    old: (s) => stripIndentB(s),
    new: (s) => stripIndentB(s),
  },
  { name: "smart+trailing", expect: "match", old: (s) => trailAll(smartD(s)) },
  { name: "nbsp+smart", expect: "match", old: (s) => smartD(firstInner(NBSP)(s)) },
  { name: "crlf+smart", expect: "match", old: (s) => smartD(crlf(s)) },
  { name: "leadingblank+trailing", expect: "match", old: (s) => leadBlank(trailAll(s)) },
  {
    name: "underindent+smart",
    expect: "match",
    needsIndent: true,
    old: (s, b) => smartD(underIndentB(s, b)),
    new: (s, b) => underIndentB(s, b),
  },
  // Correctness controls: must NOT be applied.
  { name: "renamed-token", expect: "reject", old: (s) => renameToken(s) },
  { name: "reordered-lines", expect: "reject", old: (s) => reorderLines(s) },
];

const generatedScenarios: Scenario[] = genBases.flatMap((b) =>
  genTransforms
    .filter((t) => !(t.needsIndent && b.indent === ""))
    .map((t): Scenario => {
      const base: Base = {
        source: b.source,
        old: b.old,
        new: b.new,
        oldMark: b.oldMark,
        newMark: b.newMark,
      };
      return {
        name: `${b.id}/${t.name}`,
        base,
        expect: t.expect,
        oldFn: (s) => t.old(s, b),
        newFn: t.new ? (s) => t.new!(s, b) : id,
      };
    }),
);

const allScenarios: Scenario[] = [...scenarios, ...generatedScenarios];

describe("edit tool matcher robustness benchmark", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-robustness-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function run(sc: Scenario): Promise<{ correct: boolean; applied: boolean }> {
    const fileName = `${sc.name.replace(/[^A-Za-z0-9]+/g, "_")}.txt`;
    const filePath = path.join(tmpDir, fileName);
    await fs.writeFile(filePath, sc.base.source);
    const tool = createEditTool(tmpDir);
    try {
      await tool.execute(
        {
          file_path: fileName,
          edits: [{ old_text: sc.oldFn(sc.base.old), new_text: (sc.newFn ?? id)(sc.base.new) }],
        },
        { signal: new AbortController().signal, toolCallId: sc.name },
      );
    } catch {
      /* failed match throws */
    }
    const written = await fs.readFile(filePath, "utf-8");
    const applied = written !== sc.base.source;
    const hasNew = written.includes(sc.base.newMark);
    const hasOld = written.includes(sc.base.oldMark);
    const correct =
      sc.expect === "match"
        ? applied && hasNew && !hasOld
        : // reject + limitation: must NOT have mis-applied a wrong edit
          !applied && hasOld && !hasNew;
    return { correct, applied };
  }

  it("matches realistic LLM drift and rejects genuine mismatches (150+ scenarios)", async () => {
    const rows: { name: string; expect: Expect; correct: boolean }[] = [];
    for (const sc of allScenarios) {
      const { correct } = await run(sc);
      rows.push({ name: sc.name, expect: sc.expect, correct });
    }

    const byExpect = (e: Expect) => rows.filter((r) => r.expect === e);
    const matchRows = byExpect("match");
    const rejectRows = byExpect("reject");
    const limitationRows = byExpect("limitation");
    const matchPass = matchRows.filter((r) => r.correct).length;
    const rejectPass = rejectRows.filter((r) => r.correct).length;

    const misses = rows.filter((r) => !r.correct);
    const missTable = misses.length
      ? misses.map((r) => `  MISS [${r.expect.padEnd(10)}] ${r.name}`).join("\n")
      : "  (none)";
    console.info(
      `\nEdit matcher robustness — ${allScenarios.length} scenarios\n` +
        `  match : ${matchPass}/${matchRows.length}\n` +
        `  reject: ${rejectPass}/${rejectRows.length} (genuine mismatches correctly NOT applied)\n` +
        `  limitations (tracked, not asserted): ${limitationRows.length}\n` +
        `  failures:\n${missTable}\n`,
    );

    // Every realistic drift must match.
    for (const r of matchRows) {
      expect(`${r.name}:${r.correct}`).toBe(`${r.name}:true`);
    }
    // Every genuine mismatch must be rejected — never silently mis-applied.
    for (const r of rejectRows) {
      expect(`${r.name}:${r.correct}`).toBe(`${r.name}:true`);
    }
  });
});
