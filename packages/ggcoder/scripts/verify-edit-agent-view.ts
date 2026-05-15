/**
 * End-to-end verification: what does an LLM actually SEE when it calls `edit`?
 *
 * Unit tests verify mechanics. This script runs the tool through the same
 * code path the agent loop uses (`tool.execute(...)` → `normalizeToolResult`)
 * and prints the EXACT string that lands in the tool_result. The `details`
 * field (the diff) is UI-only; the model never sees it. So `content` is the
 * whole contract.
 *
 * Run: pnpm --filter @kenkaiiii/ggcoder build && \
 *      npx tsx packages/ggcoder/scripts/verify-edit-agent-view.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEditTool } from "../src/tools/edit.js";

// Mirror of `normalizeToolResult` in @kenkaiiii/gg-agent agent-loop.ts.
// Kept inline so this script doesn't need a dist build of gg-agent.
type ToolReturn = string | { content: string; details?: unknown };
function normalizeToolResult(raw: ToolReturn): { content: string; details?: unknown } {
  return typeof raw === "string" ? { content: raw } : raw;
}

interface Scenario {
  name: string;
  setup: () => Promise<{ filePath: string; relPath: string }>;
  call: () => Parameters<ReturnType<typeof createEditTool>["execute"]>[0];
  expectThrow: boolean;
}

const HR = "─".repeat(78);
const checks: { name: string; pass: boolean }[] = [];

function dumpAgentView(label: string, content: string, isError: boolean): void {
  process.stdout.write(`\n${HR}\nMODEL TOOL_RESULT — ${label}${isError ? " (isError=true)" : ""}\n${HR}\n`);
  process.stdout.write(content);
  process.stdout.write(`\n${HR}\n`);
}

function check(name: string, pass: boolean, detail = ""): void {
  checks.push({ name, pass });
  process.stdout.write(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? `\n         ${detail}` : ""}\n`);
}

async function main(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-view-"));
  const tool = createEditTool(tmpDir);
  const ctx = { signal: new AbortController().signal, toolCallId: "e2e" };

  try {
    // ─────────────────────────────────────────────────────────────────
    // 1. Pure success — single edit
    // ─────────────────────────────────────────────────────────────────
    {
      const filePath = path.join(tmpDir, "single.txt");
      await fs.writeFile(filePath, "hello world\n");
      const raw = await tool.execute(
        { file_path: "single.txt", edits: [{ old_text: "hello", new_text: "goodbye" }] },
        ctx,
      );
      const { content } = normalizeToolResult(raw as ToolReturn);
      dumpAgentView("single edit success", content, false);
      check(
        "1. Single-edit success message is concise",
        content === "Successfully replaced text in single.txt.",
        content.length > 80 ? `(was ${content.length} chars)` : "",
      );
    }

    // ─────────────────────────────────────────────────────────────────
    // 2. Pure success — multi-edit
    // ─────────────────────────────────────────────────────────────────
    {
      const filePath = path.join(tmpDir, "multi.txt");
      await fs.writeFile(filePath, "alpha\nbeta\ngamma\n");
      const raw = await tool.execute(
        {
          file_path: "multi.txt",
          edits: [
            { old_text: "alpha", new_text: "ALPHA" },
            { old_text: "gamma", new_text: "GAMMA" },
          ],
        },
        ctx,
      );
      const { content } = normalizeToolResult(raw as ToolReturn);
      dumpAgentView("multi-edit success", content, false);
      check(
        "2. Multi-edit success message names the count",
        /Successfully applied 2 edits/.test(content),
      );
    }

    // ─────────────────────────────────────────────────────────────────
    // 3. The headline scenario — 19 edits, 2 drift
    // ─────────────────────────────────────────────────────────────────
    {
      const filePath = path.join(tmpDir, "StartingYourAgency.tsx");
      const lines = Array.from(
        { length: 19 },
        (_, i) => `      <div className="card-${i}">Section ${i}</div>`,
      );
      await fs.writeFile(filePath, lines.join("\n") + "\n");

      const edits = lines.map((line) => ({
        old_text: line,
        new_text: line.replace("card-", "glass-card-"),
      }));
      // Same drift pattern the user reported: model paraphrases two strings.
      edits[7] = {
        old_text: `      <div className="Card-7">Section 7</div>`,
        new_text: `      <div className="glass-card-7">Section 7</div>`,
      };
      edits[13] = {
        old_text: `      <div className="card-13">Section thirteen</div>`,
        new_text: `      <div className="glass-card-13">Section 13</div>`,
      };

      const raw = await tool.execute(
        { file_path: "StartingYourAgency.tsx", edits },
        ctx,
      );
      const { content } = normalizeToolResult(raw as ToolReturn);
      dumpAgentView("19-edit batch — 17 land, 2 drift (partial-apply)", content, false);

      const writtenAfter = await fs.readFile(filePath, "utf-8");
      const landed = (writtenAfter.match(/glass-card-/g) ?? []).length;

      check("3a. Header is unmistakable: 'Applied 17 of 19'", /Applied 17 of 19/.test(content));
      check(
        "3b. Tells model NOT to redo the others",
        /re-issue ONLY these/.test(content) && /already done/.test(content),
      );
      check("3c. Names the failed indices (edit 8/19, edit 14/19)", /edit 8\/19/.test(content) && /edit 14\/19/.test(content));
      check(
        "3d. Suppresses noisy Closest-match snippet in partial-apply (other edits gave context)",
        (content.match(/Closest match in file:/g) ?? []).length === 0,
      );
      check("3e. The 17 successful edits actually wrote to disk", landed === 17);
      check(
        "3f. The 2 failed lines remain unchanged on disk",
        writtenAfter.includes(`className="card-7"`) && writtenAfter.includes(`className="card-13"`),
      );
    }

    // ─────────────────────────────────────────────────────────────────
    // 4. Same scenario with atomic: true — rolled back, error thrown
    // ─────────────────────────────────────────────────────────────────
    {
      const filePath = path.join(tmpDir, "atomic.tsx");
      const lines = Array.from({ length: 19 }, (_, i) => `      <div className="card-${i}">x</div>`);
      await fs.writeFile(filePath, lines.join("\n") + "\n");

      const edits = lines.map((line) => ({
        old_text: line,
        new_text: line.replace("card-", "glass-card-"),
      }));
      edits[7] = { old_text: `      <div className="Card-7">x</div>`, new_text: "" };
      edits[13] = { old_text: `      <div className="cArD-13">x</div>`, new_text: "" };

      let errorMsg = "";
      let isError = false;
      try {
        await tool.execute({ file_path: "atomic.tsx", edits, atomic: true }, ctx);
      } catch (err) {
        errorMsg = (err as Error).message;
        isError = true;
      }
      dumpAgentView("19-edit batch, atomic:true — failure", errorMsg, isError);

      const writtenAfter = await fs.readFile(filePath, "utf-8");
      check("4a. atomic:true throws (model sees it as tool error)", isError);
      check("4b. Header says 'no changes written (atomic)'", /no changes written \(atomic\)/.test(errorMsg));
      check("4c. File on disk is byte-identical to before (no changes)", writtenAfter === lines.join("\n") + "\n");
      check(
        "4d. atomic mode keeps Closest-match snippet (model retries against unchanged file, needs guidance)",
        /Closest match in file:/.test(errorMsg),
      );
    }

    // ─────────────────────────────────────────────────────────────────
    // 5. Duplicate-match — model picks a too-short snippet
    // ─────────────────────────────────────────────────────────────────
    {
      const filePath = path.join(tmpDir, "pomodoro.css");
      await fs.writeFile(
        filePath,
        [
          ".timer { color: white; }",
          ".button { color: black; }",
          ".label { color: white; }",
          ".footer { color: white; }",
          "",
        ].join("\n"),
      );

      let errorMsg = "";
      try {
        await tool.execute(
          {
            file_path: "pomodoro.css",
            edits: [{ old_text: "color: white;", new_text: "color: red;" }],
          },
          ctx,
        );
      } catch (err) {
        errorMsg = (err as Error).message;
      }
      dumpAgentView("duplicate-match error", errorMsg, true);

      check("5a. Error names the count: 'found 3 times'", /found 3 times/.test(errorMsg));
      check(
        "5b. Includes line numbers of every duplicate",
        ["line 1", "line 3", "line 4"].every((l) => errorMsg.includes(l)),
      );
      check("5c. Suggests replace_all: true escape hatch", /replace_all: true/.test(errorMsg));
    }

    // ─────────────────────────────────────────────────────────────────
    // 6. Same edit with replace_all — silent success
    // ─────────────────────────────────────────────────────────────────
    {
      const filePath = path.join(tmpDir, "rename.css");
      await fs.writeFile(
        filePath,
        [".a { color: white; }", ".b { color: white; }", ".c { color: white; }"].join("\n") + "\n",
      );
      const raw = await tool.execute(
        {
          file_path: "rename.css",
          edits: [{ old_text: "color: white;", new_text: "color: red;", replace_all: true }],
        },
        ctx,
      );
      const { content } = normalizeToolResult(raw as ToolReturn);
      dumpAgentView("replace_all success", content, false);
      check("6. replace_all returns a clean success message", /Successfully/.test(content));
    }

    // ─────────────────────────────────────────────────────────────────
    // 7. Aider issue #25 — leading blank line in old_text
    // ─────────────────────────────────────────────────────────────────
    {
      const filePath = path.join(tmpDir, "blank.ts");
      await fs.writeFile(filePath, "function foo() {\n  return 42;\n}\n");
      const raw = await tool.execute(
        {
          file_path: "blank.ts",
          edits: [{ old_text: "\n  return 42;", new_text: "\n  return 100;" }],
        },
        ctx,
      );
      const { content } = normalizeToolResult(raw as ToolReturn);
      dumpAgentView("leading-blank-line auto-strip", content, false);
      check("7. Edit lands despite spurious leading blank line", /Successfully/.test(content));
    }

    // ─────────────────────────────────────────────────────────────────
    // 8. Pathological case — every edit fails (partial-apply still throws)
    // ─────────────────────────────────────────────────────────────────
    {
      const filePath = path.join(tmpDir, "all-fail.txt");
      await fs.writeFile(filePath, "untouched line\n");
      let errorMsg = "";
      let isError = false;
      try {
        await tool.execute(
          {
            file_path: "all-fail.txt",
            edits: [
              { old_text: "MISSING-A", new_text: "x" },
              { old_text: "MISSING-B", new_text: "y" },
            ],
          },
          ctx,
        );
      } catch (err) {
        errorMsg = (err as Error).message;
        isError = true;
      }
      dumpAgentView("all edits fail (partial-apply still throws)", errorMsg, isError);
      check("8a. Throws when nothing succeeds even in partial-apply mode", isError);
      check("8b. Says '2 of 2 edits failed'", /2 of 2 edits failed/.test(errorMsg));
      const writtenAfter = await fs.readFile(filePath, "utf-8");
      check("8c. File is unchanged on disk", writtenAfter === "untouched line\n");
    }

    // ─────────────────────────────────────────────────────────────────
    // 9. Chained-edit interaction — edit 1 fails, edit 2 needs edit 1's output
    // ─────────────────────────────────────────────────────────────────
    {
      const filePath = path.join(tmpDir, "chain.txt");
      await fs.writeFile(filePath, "alpha\nindependent\n");
      // edit 1 (foo→bar) fails because foo isn't in the file.
      // edit 2 (bar→baz) was supposed to chain off edit 1 — also fails because
      //                  bar isn't in the file either.
      // edit 3 (independent→INDEPENDENT) succeeds — it's not chained.
      // Model should see: 1 of 3 applied, 2 to retry, with clear error per edit.
      const raw = await tool.execute(
        {
          file_path: "chain.txt",
          edits: [
            { old_text: "foo", new_text: "bar" },
            { old_text: "bar", new_text: "baz" },
            { old_text: "independent", new_text: "INDEPENDENT" },
          ],
        },
        ctx,
      );
      const { content } = normalizeToolResult(raw as ToolReturn);
      dumpAgentView("chained edits — predecessor fails, dependent fails, independent lands", content, false);

      check("9a. Header: 'Applied 1 of 3'", /Applied 1 of 3/.test(content));
      check("9b. Reports both chained failures (edit 1/3, edit 2/3)", /edit 1\/3/.test(content) && /edit 2\/3/.test(content));
      check("9c. Does NOT mention edit 3/3 in the failures list", !/edit 3\/3/.test(content));
      const writtenAfter = await fs.readFile(filePath, "utf-8");
      check("9d. The independent edit landed on disk", writtenAfter === "alpha\nINDEPENDENT\n");
    }
    // ─────────────────────────────────────────────────────────────────
    // 9.4. Indent-flex (aider's replace_part_with_missing_leading_whitespace).
    //      Model writes the block with NO leading indent; the file has 4
    //      spaces because the block lives inside a function. Edit must land
    //      with the file's actual 4-space prefix preserved.
    // ─────────────────────────────────────────────────────────────────
    {
      const filePath = path.join(tmpDir, "indent.ts");
      await fs.writeFile(
        filePath,
        "function wrap() {\n    const x = 1;\n    const y = 2;\n    return x + y;\n}\n",
      );
      const raw = await tool.execute(
        {
          file_path: "indent.ts",
          edits: [
            {
              // Model omitted the 4-space indent entirely.
              old_text: "const x = 1;\nconst y = 2;\nreturn x + y;",
              new_text: "const x = 10;\nconst y = 20;\nreturn x * y;",
            },
          ],
        },
        ctx,
      );
      const { content } = normalizeToolResult(raw as ToolReturn);
      dumpAgentView("indent-flex — model omitted leading whitespace, edit still lands", content, false);
      const writtenAfter = await fs.readFile(filePath, "utf-8");
      check("9.4a. Returns success message", /Successfully/.test(content));
      check(
        "9.4b. File's 4-space indent preserved on rewritten lines",
        writtenAfter ===
          "function wrap() {\n    const x = 10;\n    const y = 20;\n    return x * y;\n}\n",
      );
    }

    // ─────────────────────────────────────────────────────────────────
    // 9.5. Aider-style `...` elision — model writes a long block with the
    //      middle replaced by `...`, we anchor on bookends and preserve
    //      the elided middle from the file.
    // ─────────────────────────────────────────────────────────────────
    {
      const filePath = path.join(tmpDir, "elide.ts");
      await fs.writeFile(
        filePath,
        [
          "function pomodoro() {",
          "  const timer = startTimer();",
          "  trackPomodoro(timer);",
          "  scheduleBreak();",
          "  notifyUser();",
          "  return timer;",
          "}",
        ].join("\n") + "\n",
      );
      const raw = await tool.execute(
        {
          file_path: "elide.ts",
          edits: [
            {
              // Model only writes the bookends; trusts `...` to preserve the
              // 4-line middle without having to retype it perfectly.
              old_text: "function pomodoro() {\n  ...\n  return timer;\n}",
              new_text: "function pomodoro(): Timer {\n  ...\n  return timer;\n}",
            },
          ],
        },
        ctx,
      );
      const { content } = normalizeToolResult(raw as ToolReturn);
      dumpAgentView("dotdotdots — elide preserves middle", content, false);
      const writtenAfter = await fs.readFile(filePath, "utf-8");
      check("9.5a. Returns a clean success message", /Successfully/.test(content));
      check("9.5b. Bookend was rewritten (function signature now has return type)", writtenAfter.includes("function pomodoro(): Timer {"));
      check(
        "9.5c. Elided middle preserved verbatim (4 lines untouched)",
        writtenAfter.includes("trackPomodoro(timer);") &&
          writtenAfter.includes("scheduleBreak();") &&
          writtenAfter.includes("notifyUser();") &&
          writtenAfter.includes("const timer = startTimer();"),
      );
    }

    // ─────────────────────────────────────────────────────────────────
    // 10. No-op edit: old_text == new_text. Most public tools reject this
    //     (model-confusion signal); we treat it as a per-edit failure that
    //     plays nicely with partial-apply.
    // ─────────────────────────────────────────────────────────────────
    {
      const filePath = path.join(tmpDir, "noop.txt");
      await fs.writeFile(filePath, "hello world\n");
      let errorMsg = "";
      let isError = false;
      try {
        await tool.execute(
          {
            file_path: "noop.txt",
            edits: [{ old_text: "hello", new_text: "hello" }],
          },
          ctx,
        );
      } catch (err) {
        errorMsg = (err as Error).message;
        isError = true;
      }
      dumpAgentView("no-op edit (old_text == new_text)", errorMsg, isError);
      check("10a. No-op edit throws (single-edit batch)", isError);
      check("10b. Error explicitly says 'identical' and 'no-op'", /identical/.test(errorMsg) && /no-op/.test(errorMsg));
      const writtenAfter = await fs.readFile(filePath, "utf-8");
      check("10c. File on disk untouched", writtenAfter === "hello world\n");
    }

    // ─────────────────────────────────────────────────────────────────
    // 11. No-op inside a partial-apply batch — others still land
    // ─────────────────────────────────────────────────────────────────
    {
      const filePath = path.join(tmpDir, "noop-batch.txt");
      await fs.writeFile(filePath, "alpha\nbeta\n");
      const raw = await tool.execute(
        {
          file_path: "noop-batch.txt",
          edits: [
            { old_text: "alpha", new_text: "ALPHA" },
            { old_text: "beta", new_text: "beta" }, // no-op
          ],
        },
        ctx,
      );
      const { content } = normalizeToolResult(raw as ToolReturn);
      dumpAgentView("no-op inside a 2-edit batch — partial-apply", content, false);
      check("11a. Header: 'Applied 1 of 2'", /Applied 1 of 2/.test(content));
      check("11b. Names the no-op failure with edit 2/2", /edit 2\/2/.test(content) && /identical/.test(content));
      const writtenAfter = await fs.readFile(filePath, "utf-8");
      check("11c. The non-noop edit landed on disk", writtenAfter === "ALPHA\nbeta\n");
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.pass);
  process.stdout.write(`\n${HR}\n${checks.length - failed.length}/${checks.length} agent-view checks passed\n${HR}\n`);
  if (failed.length > 0) {
    for (const f of failed) process.stderr.write(`  FAILED: ${f.name}\n`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
