/**
 * Shape-aware compaction for routine command output that is small enough to
 * skip truncation (`renderBashOutput`'s under-limit path), where GG used to
 * pass every byte through.
 *
 * The idea comes from rtk (rtk-ai/rtk), measured in the gg-bench goal
 * (2026-10-24): on medium-sized output GG returned raw, rtk cut `git log` 58%,
 * `git status` 60%, `ls -la` 80% and an all-green vitest run 99%. It also hid
 * 676 of 726 `find` results and made failing vitest output 74% larger. So this
 * copies only the lossless or near-lossless parts:
 *
 *  - `git log` (default format): one header line per commit — 12-char hash,
 *    decorations, ISO-ish date, author + email — and the message, without the
 *    `commit`/`Author:`/`Date:` labels, blank separators and 4-space indent.
 *  - `git status` (long format): drops the `(use "git …")` hint lines only.
 *  - `ls -l`/`-la`: when every entry shares one owner and group, states them
 *    once and drops the link-count/owner/group columns.
 *  - all-green vitest/jest runs: replaces the per-FILE pass lines with a count.
 *    Per-test lines (`✓ name 542ms`, failures, skips) and the summary stay,
 *    because the compactor's failing-test carry-forward reads test-level lines.
 *
 * Never touched: failing test runs, file lists (`find`, `grep`), file dumps
 * that don't match these shapes. Every transform is gated on an unambiguous
 * shape and returns its input unchanged when anything doesn't fit.
 */

export function compactRoutineOutput(raw: string): string {
  let text = raw;
  text = compactGitLog(text);
  text = compactGitStatus(text);
  text = compactLsLong(text);
  text = compactPassingTestRun(text);
  return text;
}

/* ------------------------------------------------------------------ */
/* git log                                                              */
/* ------------------------------------------------------------------ */

const COMMIT_LINE = /^commit ([0-9a-f]{40})((?: \(.*\))?)$/;
const MONTHS: Record<string, string> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};
/** git's default date: `Sat Oct 24 01:23:14 2026 +0800`. */
const GIT_DEFAULT_DATE = /^\w{3} (\w{3}) (\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4}) ([+-]\d{4})$/;

function compactDate(date: string): string {
  const m = GIT_DEFAULT_DATE.exec(date);
  const month = m ? MONTHS[m[1]] : undefined;
  if (!m || !month) return date;
  return `${m[4]}-${month}-${m[2].padStart(2, "0")} ${m[3]} ${m[5]}`;
}

export function compactGitLog(text: string): string {
  if (!/^commit [0-9a-f]{40}/m.test(text) || !/^Author: /m.test(text)) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let changed = false;
  let i = 0;
  while (i < lines.length) {
    const commit = COMMIT_LINE.exec(lines[i]);
    if (!commit) {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i + 1;
    let merge = "";
    if (lines[j]?.startsWith("Merge: ")) {
      merge = ` merge ${lines[j].slice("Merge: ".length).trim()}`;
      j++;
    }
    const author = /^Author:\s+(.+)$/.exec(lines[j] ?? "");
    const date = author ? /^Date:\s+(.+)$/.exec(lines[j + 1] ?? "") : null;
    if (!author || !date || lines[j + 2] !== "") {
      out.push(lines[i]);
      i++;
      continue;
    }
    j += 3;
    // Message: 4-space-indented lines, with blank lines allowed between them.
    const message: string[] = [];
    while (j < lines.length) {
      if (lines[j].startsWith("    ")) {
        message.push(lines[j].slice(4));
        j++;
      } else if (lines[j] === "" && lines[j + 1]?.startsWith("    ")) {
        message.push("");
        j++;
      } else break;
    }
    const [subject = "", ...body] = message;
    // Subject and body are separated by one blank line in git's layout.
    if (body[0] === "") body.shift();
    out.push(
      `${commit[1].slice(0, 12)}${commit[2]} ${compactDate(date[1])} ${author[1]}${merge}`,
      `  ${subject}`,
      ...body.map((line) => (line ? `  ${line}` : "")),
    );
    // Drop the separator blank before the next commit; keep it before a diff.
    if (lines[j] === "" && COMMIT_LINE.test(lines[j + 1] ?? "")) j++;
    changed = true;
    i = j;
  }
  return changed ? out.join("\n") : text;
}

/* ------------------------------------------------------------------ */
/* git status                                                           */
/* ------------------------------------------------------------------ */

const STATUS_SECTION =
  /^(?:On branch \S+|HEAD detached (?:at|from) \S+|Changes to be committed:|Changes not staged for commit:|Untracked files:|Unmerged paths:)$/m;
const STATUS_HINT =
  /^\s+\((?:use "git [^"]*"(?:,? (?:and\/or|or) "git [^"]*")*[^()]*|commit or discard the untracked or modified content in submodules)\)$/;

export function compactGitStatus(text: string): string {
  if (!STATUS_SECTION.test(text)) return text;
  const lines = text.split("\n");
  const kept = lines.filter((line) => !STATUS_HINT.test(line));
  return kept.length === lines.length ? text : kept.join("\n");
}

/* ------------------------------------------------------------------ */
/* ls -l / ls -la                                                       */
/* ------------------------------------------------------------------ */

/** perms, links, owner, group, then size (`1234`, `10K`, or `8, 1` for devices). */
const LS_ENTRY =
  /^([bcdlps-][rwxsStT-]{9}[@+.]?)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d[\d.,]*[KMGTPB]?,?\s.*)$/;
const MIN_LS_ENTRIES = 5;

export function compactLsLong(text: string): string {
  if (!/^total \d+/m.test(text)) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let changed = false;
  let i = 0;
  while (i < lines.length) {
    if (!/^total \d+$/.test(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i + 1;
    const entries: RegExpExecArray[] = [];
    while (j < lines.length) {
      const m = LS_ENTRY.exec(lines[j]);
      if (!m) break;
      entries.push(m);
      j++;
    }
    const blockEnds = j >= lines.length || lines[j] === "";
    const owner = entries[0]?.[3];
    const group = entries[0]?.[4];
    const uniform = entries.every((m) => m[3] === owner && m[4] === group);
    if (!blockEnds || entries.length < MIN_LS_ENTRIES || !uniform) {
      out.push(...lines.slice(i, j));
      i = j;
      continue;
    }
    out.push(`${lines[i]} (owner ${owner}, group ${group} for all entries; link counts omitted)`);
    for (const m of entries) out.push(`${m[1]} ${m[5]}`);
    changed = true;
    i = j;
  }
  return changed ? out.join("\n") : text;
}

/* ------------------------------------------------------------------ */
/* all-green vitest / jest runs                                         */
/* ------------------------------------------------------------------ */

/** A file-level vitest pass line: ` ✓ src/a.test.ts (12 tests) 3ms` — no skips. */
const VITEST_FILE_PASS = /^ ?[✓√] \S+ \(\d+ tests?\)(?: \d+(?:\.\d+)?m?s)?$/;
const JEST_FILE_PASS = /^ ?PASS \S+(?: \(\d+(?:\.\d+)? ?m?s\))?$/;
const ANY_FAILURE = /\b\d+ failed\b|^\s*(?:FAIL|[×✕❯])\s/m;

export function compactPassingTestRun(text: string): string {
  const vitest = /^\s*Test Files\s+\d+ passed/m.test(text);
  const jest = /^Test Suites:\s+\d+ passed, \d+ total/m.test(text);
  if ((!vitest && !jest) || ANY_FAILURE.test(text)) return text;
  const fileLine = vitest ? VITEST_FILE_PASS : JEST_FILE_PASS;
  const lines = text.split("\n");
  const count = lines.filter((line) => fileLine.test(line)).length;
  if (count < 2) return text;
  const out: string[] = [];
  let noted = false;
  for (const line of lines) {
    if (!fileLine.test(line)) {
      out.push(line);
    } else if (!noted) {
      out.push(`[${count} passing test files not listed — all passed; summary below]`);
      noted = true;
    }
  }
  return out.join("\n");
}
