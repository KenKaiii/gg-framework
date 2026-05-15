/**
 * Repro for the "old_text found N times in pomodoro.css" failure the user
 * reported. Builds a real CSS file with repeated property values (the exact
 * failure mode CSS / HTML files trigger), then exercises the edit tool three
 * ways:
 *   1. OLD behavior — short non-unique snippet → must fail with line numbers
 *      of every duplicate match in the error (new feature: was just a count).
 *   2. NEW path — same edit with replace_all: true → must succeed.
 *   3. Mixed batch — replace_all + sequential edits in one call → must succeed.
 *
 * Run: pnpm --filter @kenkaiiii/ggcoder build && \
 *      node packages/ggcoder/dist/scripts/verify-edit-pomodoro.js
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEditTool } from "../src/tools/edit.js";

const POMODORO_CSS = [
  ".pomodoro-app {",
  "  display: flex;",
  "  color: white;",
  "}",
  "",
  ".pomodoro-app .timer {",
  "  font-size: 64px;",
  "  color: white;",
  "}",
  "",
  ".pomodoro-app .controls button {",
  "  background: #444;",
  "  color: white;",
  "  border: none;",
  "}",
  "",
  ".pomodoro-app .label {",
  "  color: white;",
  "  font-weight: bold;",
  "}",
  "",
].join("\n");

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  const tag = pass ? "PASS" : "FAIL";
  process.stdout.write(`[${tag}] ${name}\n`);
  if (detail) process.stdout.write(`       ${detail.replace(/\n/g, "\n       ")}\n`);
}

async function main(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-edit-"));
  try {
    const cssPath = path.join(tmpDir, "pomodoro.css");
    await fs.writeFile(cssPath, POMODORO_CSS);

    const tool = createEditTool(tmpDir);
    const ctx = { signal: new AbortController().signal, toolCallId: "verify" };

    // 1. Reproduce the original failure mode and check the new error format.
    let caught: Error | null = null;
    try {
      await tool.execute(
        {
          file_path: "pomodoro.css",
          edits: [{ old_text: "color: white;", new_text: "color: red;" }],
        },
        ctx,
      );
    } catch (err) {
      caught = err as Error;
    }

    if (!caught) {
      record("repro: short snippet on duplicate value should fail", false, "no error thrown");
    } else {
      const msg = caught.message;
      const hasCount = /found 4 times/.test(msg);
      const hasMatchesHeader = /Matches at:/.test(msg);
      const linesShown = ["line 3", "line 8", "line 13", "line 18"].every((l) => msg.includes(l));
      const mentionsReplaceAll = /replace_all: true/.test(msg);
      record(
        "duplicate-match error contains line numbers (line 3, 8, 13, 18)",
        hasCount && hasMatchesHeader && linesShown,
        msg,
      );
      record(
        "duplicate-match error suggests replace_all: true",
        mentionsReplaceAll,
        mentionsReplaceAll ? "" : "missing 'replace_all: true' hint",
      );
    }

    // Reset file before the next check since the failure was atomic but make explicit.
    await fs.writeFile(cssPath, POMODORO_CSS);

    // 2. Same edit with replace_all should succeed.
    const okResult = await tool.execute(
      {
        file_path: "pomodoro.css",
        edits: [
          { old_text: "color: white;", new_text: "color: red;", replace_all: true },
        ],
      },
      ctx,
    );
    const okSummary =
      typeof okResult === "string" ? okResult : (okResult as { content: string }).content;
    const after = await fs.readFile(cssPath, "utf-8");
    const replacedAll = !after.includes("color: white;") && (after.match(/color: red;/g) ?? []).length === 4;
    record(
      "replace_all swaps every occurrence and returns success",
      replacedAll && /Successfully/.test(okSummary),
      `summary=${okSummary}; remaining 'color: white;' count=${(after.match(/color: white;/g) ?? []).length}`,
    );

    // 3. Mixed batch — replace_all + targeted edit in the same call.
    await fs.writeFile(cssPath, POMODORO_CSS);
    const mixedResult = await tool.execute(
      {
        file_path: "pomodoro.css",
        edits: [
          { old_text: "color: white;", new_text: "color: blue;", replace_all: true },
          { old_text: "font-size: 64px;", new_text: "font-size: 72px;" },
        ],
      },
      ctx,
    );
    const mixedSummary =
      typeof mixedResult === "string"
        ? mixedResult
        : (mixedResult as { content: string }).content;
    const mixedAfter = await fs.readFile(cssPath, "utf-8");
    const mixedOk =
      !mixedAfter.includes("color: white;") &&
      mixedAfter.includes("color: blue;") &&
      mixedAfter.includes("font-size: 72px;") &&
      !mixedAfter.includes("font-size: 64px;");
    record(
      "mixed batch (replace_all + targeted edit) applies both",
      mixedOk && /2 edits/.test(mixedSummary),
      `summary=${mixedSummary}`,
    );

    // 4. The user's reported scenario: a 19-edit refactor where 2 edits drift.
    //    Old behavior: the whole batch is rolled back, the model wastes minutes
    //    re-doing the other 17. New behavior: 17 land, model only retries 2.
    const bigPath = path.join(tmpDir, "StartingYourAgency.tsx");
    const bigLines = Array.from(
      { length: 19 },
      (_, i) => `      <div className="card-${i}">Section ${i}</div>`,
    );
    await fs.writeFile(bigPath, bigLines.join("\n") + "\n");

    const bigEdits = bigLines.map((line, i) => ({
      old_text: line,
      new_text: line.replace("card-", "glass-card-"),
    }));
    // Drift edit 8 and edit 14 the same way the model paraphrases.
    bigEdits[7] = {
      old_text: `      <div className="card-7">Section 7</div>`.replace("card-", "Card-"),
      new_text: `      <div className="glass-card-7">Section 7</div>`,
    };
    bigEdits[13] = {
      old_text: `      <div className="card-13">Section thirteen</div>`,
      new_text: `      <div className="glass-card-13">Section 13</div>`,
    };

    const bigResult = await tool.execute(
      { file_path: "StartingYourAgency.tsx", edits: bigEdits },
      ctx,
    );
    const bigSummary =
      typeof bigResult === "string" ? bigResult : (bigResult as { content: string }).content;
    const bigAfter = await fs.readFile(bigPath, "utf-8");
    const landed = (bigAfter.match(/glass-card-/g) ?? []).length;
    const stillUnchanged =
      bigAfter.includes(`className="card-7"`) && bigAfter.includes(`className="card-13"`);
    const namesOnlyFailed = /edit 8\/19/.test(bigSummary) && /edit 14\/19/.test(bigSummary);
    record(
      "19-edit batch with 2 drifted edits lands the other 17 (partial-apply)",
      landed === 17 && stillUnchanged && namesOnlyFailed && /Applied 17 of 19/.test(bigSummary),
      `landed=${landed}; summary first line=${bigSummary.split("\n")[0]}`,
    );

    // 5. Same call shape with atomic: true must throw and write nothing.
    await fs.writeFile(bigPath, bigLines.join("\n") + "\n");
    let atomicCaught: Error | null = null;
    try {
      await tool.execute(
        { file_path: "StartingYourAgency.tsx", edits: bigEdits, atomic: true },
        ctx,
      );
    } catch (err) {
      atomicCaught = err as Error;
    }
    const atomicAfter = await fs.readFile(bigPath, "utf-8");
    const atomicUntouched = atomicAfter === bigLines.join("\n") + "\n";
    record(
      "atomic: true reverts to all-or-nothing — same batch throws and writes nothing",
      atomicCaught !== null && atomicUntouched && /no changes written/.test(atomicCaught?.message ?? ""),
      atomicCaught ? `error first line=${atomicCaught.message.split("\n")[0]}` : "no error thrown",
    );

    // 6. Aider issue #25 — leading blank line in old_text. Should still match.
    const blankPath = path.join(tmpDir, "blank.ts");
    await fs.writeFile(blankPath, "function foo() {\n  return 42;\n}\n");
    const blankResult = await tool.execute(
      {
        file_path: "blank.ts",
        edits: [{ old_text: "\n  return 42;", new_text: "\n  return 100;" }],
      },
      ctx,
    );
    const blankSummary =
      typeof blankResult === "string" ? blankResult : (blankResult as { content: string }).content;
    const blankAfter = await fs.readFile(blankPath, "utf-8");
    record(
      "leading-blank-line in old_text is auto-stripped and the edit lands",
      /Successfully/.test(blankSummary) && blankAfter === "function foo() {\n  return 100;\n}\n",
      `summary=${blankSummary}; after=${JSON.stringify(blankAfter)}`,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.pass);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
