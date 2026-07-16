import { describe, expect, it, vi } from "vitest";
import stringWidth from "string-width";
import {
  createTerminalHistoryPrinter,
  serializeCompletedItemToTerminalHistory,
} from "./terminal-history.js";
import type { CompletedItem } from "./app-items.js";
import { loadTheme } from "./theme/theme.js";
import type * as figures from "./constants/figures.js";

// BLACK_CIRCLE is platform-dependent (⏺ on macOS, ● elsewhere); pin it so
// the hardcoded frame expectations pass on Linux/Windows CI too.
vi.mock("./constants/figures.js", async (importOriginal) => ({
  ...(await importOriginal<typeof figures>()),
  BLACK_CIRCLE: "\u23FA",
}));

const context = {
  theme: loadTheme("dark"),
  columns: 80,
  version: "0.0.0-test",
  model: "test-model",
  provider: "openai" as const,
  cwd: "/tmp/project",
};

function stripAnsi(value: string): string {
  const escape = String.fromCharCode(27);
  return value.replace(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "");
}

describe("terminal history", () => {
  it("serializes assistant rows with the existing dot prefix", () => {
    const item: CompletedItem = {
      kind: "assistant",
      text: "Hello **world**",
      id: "assistant-1",
    };

    const rendered = stripAnsi(serializeCompletedItemToTerminalHistory(item, context));

    expect(rendered).toContain("Hello");
    expect(rendered).toContain("world");
    expect(rendered).toMatch(/^ [⏺●] Hello/);
  });

  it("hard-wraps long assistant words in durable terminal history", () => {
    const item: CompletedItem = {
      kind: "assistant",
      text: "prefix " + "x".repeat(120),
      id: "assistant-long-word",
    };

    const rendered = stripAnsi(serializeCompletedItemToTerminalHistory(item, context));

    expect(rendered.split("\n").length).toBeGreaterThan(1);
    expect(rendered).toContain("  x");
  });

  it("does not serialize hidden assistant thinking into durable terminal history", () => {
    const item: CompletedItem = {
      kind: "assistant",
      text: "Visible answer",
      thinking: "private chain of thought",
      thinkingMs: 1234,
      id: "assistant-thinking-hidden",
    };

    const rendered = stripAnsi(serializeCompletedItemToTerminalHistory(item, context));

    expect(rendered).toContain("Visible answer");
    expect(rendered).not.toContain("private chain of thought");
    expect(rendered).not.toContain("Thought");
  });

  it("renders assistant continuation chunks without another response dot", () => {
    const item: CompletedItem = {
      kind: "assistant",
      text: "continued poem line one\ncontinued poem line two",
      continuation: true,
      id: "assistant-continuation",
    };

    const rendered = stripAnsi(serializeCompletedItemToTerminalHistory(item, context));

    expect(rendered).not.toMatch(/^ [⏺●] /);
    expect(rendered).toContain("   continued poem line one");
  });

  it("renders final assistant tails after streamed chunks as continuations", () => {
    const finalTail: CompletedItem = {
      kind: "assistant",
      text: "final poem line after streamed chunks",
      continuation: true,
      id: "assistant-final-tail",
    };

    const rendered = stripAnsi(serializeCompletedItemToTerminalHistory(finalTail, context));

    expect(rendered).not.toContain("⏺");
    expect(rendered).toContain("   final poem line after streamed chunks");
  });

  it("serializes user rows as the prompt chip without adding a You label", () => {
    const item: CompletedItem = {
      kind: "user",
      text: "ship it",
      id: "user-1",
    };

    const rendered = stripAnsi(serializeCompletedItemToTerminalHistory(item, context));

    expect(rendered).toContain("> ship it");
    expect(rendered).not.toContain("You");
  });

  it("renders terminal-history user rows with the same full-width shell as the input field", () => {
    const item: CompletedItem = {
      kind: "user",
      text: "ship it",
      id: "user-1",
    };

    const rendered = stripAnsi(serializeCompletedItemToTerminalHistory(item, context));

    const lines = rendered.split("\n");
    expect(lines[0]).toBe("▄".repeat(context.columns));
    expect(lines[1]).toContain("> ship it");
    expect(lines[1]).toHaveLength(context.columns);
    expect(lines[2]).toBe("▀".repeat(context.columns));
  });

  it("collapses typed multiline prompts inside one user row", () => {
    const item: CompletedItem = {
      kind: "user",
      text: "first line\nsecond line\nthird line",
      id: "user-1",
    };

    const rendered = stripAnsi(serializeCompletedItemToTerminalHistory(item, context));

    expect(rendered).toContain("> first line ⏎ second line ⏎ third line");
    expect(rendered).not.toContain("\nsecond line");
    expect(rendered.match(/>/g)).toHaveLength(1);
  });

  it("collapses pasted multiline prompts to the same single badge as live user rows", () => {
    const item: CompletedItem = {
      kind: "user",
      text: "please read:\nline one\nline two\nthen summarize",
      pasteInfo: {
        offset: "please read:\n".length,
        length: "line one\nline two".length,
        lineCount: 2,
      },
      id: "user-1",
    };

    const rendered = stripAnsi(serializeCompletedItemToTerminalHistory(item, context));

    expect(rendered).toContain("> please read:");
    expect(rendered).toContain("[Pasted text #17 +2 lines]");
    expect(rendered).toContain("then summarize");
    expect(rendered).not.toContain("line one");
    expect(rendered).not.toContain("line two");
    expect(rendered).not.toContain("\nline");
    expect(rendered.match(/>/g)).toHaveLength(1);
  });

  it("serializes tool rows with status dots and the response gutter", () => {
    const item: CompletedItem = {
      kind: "tool_done",
      id: "tool-1",
      name: "bash",
      args: { command: "printf hi" },
      result: "Exit code: 0\nhi",
      isError: false,
      durationMs: 1234,
    };

    const rendered = stripAnsi(serializeCompletedItemToTerminalHistory(item, context));

    expect(rendered).toMatch(/^ [⏺●] Bash\(printf hi\)/);
    expect(rendered).toContain("  ⎿  hi");
  });

  it("serializes compact tool rows like the live compact summaries", () => {
    const item: CompletedItem = {
      kind: "tool_done",
      id: "tool-compact-1",
      name: "grep",
      args: { pattern: "needle" },
      result: "src/a.ts:1:needle\nsrc/b.ts:2:needle\n2 matches found",
      isError: false,
      durationMs: 1234,
    };

    const rendered = stripAnsi(serializeCompletedItemToTerminalHistory(item, context));

    expect(rendered).toMatch(/^ [⏺●] Searched for 1 pattern \(2 matches\)$/);
    expect(rendered).not.toContain("src/a.ts");
  });

  it("serializes grouped tool rows as one consolidated summary", () => {
    const item: CompletedItem = {
      kind: "tool_group",
      id: "tool-group-1",
      tools: [
        {
          toolCallId: "read-1",
          name: "read",
          args: { file_path: "src/a.ts" },
          status: "done",
          result: "1\tconst a = 1;",
        },
        {
          toolCallId: "read-2",
          name: "read",
          args: { file_path: "src/b.ts" },
          status: "done",
          result: "1\tconst b = 1;",
        },
      ],
    };

    const rendered = stripAnsi(serializeCompletedItemToTerminalHistory(item, context));

    expect(rendered).toMatch(/^ [⏺●] Read 2 files: a\.ts, b\.ts$/);
  });

  it("serializes server search rows with quoted detail and response summary", () => {
    const item: CompletedItem = {
      kind: "server_tool_done",
      id: "server-tool-1",
      name: "web_search",
      input: { query: "latest docs" },
      resultType: "search_result",
      data: {},
      durationMs: 2400,
    };

    const rendered = stripAnsi(serializeCompletedItemToTerminalHistory(item, context));

    expect(rendered).toMatch(/^ [⏺●] Web Search\("latest docs"\)/);
    expect(rendered).toContain("  ⎿  Did 1 search in 2s");
  });

  it("keeps finalized markdown tables inside the terminal width", () => {
    const narrowContext = { ...context, columns: 52 };
    const item: CompletedItem = {
      kind: "assistant",
      id: "assistant-table-1",
      text:
        "| Area | Details | Status |\n" +
        "| --- | --- | --- |\n" +
        "| Dashboard | Provides a centralized Next.js dashboard with live account statuses, automation activity, error logs, and engagement metrics. | Ready |\n" +
        "| Recovery | Captures long verifier failure summaries without letting table borders overflow terminal width. | Needs review |",
    };

    const rendered = stripAnsi(serializeCompletedItemToTerminalHistory(item, narrowContext));
    const tableLines = rendered.split("\n").filter((line) => /[┌┬┐│├┼┤└┴┘]/.test(line));

    expect(tableLines.length).toBeGreaterThan(4);
    for (const line of tableLines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(narrowContext.columns);
    }
    expect(rendered).not.toContain("| --- | --- | --- |");
  });

  it("serializes subagent groups as the live tree panel shape", () => {
    const item: CompletedItem = {
      kind: "subagent_group",
      id: "subagent-1",
      agents: [
        {
          toolCallId: "agent-1",
          agentName: "bee",
          task: "Inspect widgets",
          status: "done",
          toolUseCount: 2,
          tokenUsage: { input: 1200, output: 300, cacheRead: 2400, cacheWrite: 500 },
          durationMs: 1800,
        },
      ],
    };

    const rendered = stripAnsi(serializeCompletedItemToTerminalHistory(item, context));

    expect(rendered).toMatch(/^ [⏺●] 1 agent completed/);
    expect(rendered).toContain("   └─ ✓ Inspect widgets");
    expect(rendered).toContain("      ⎿ 2.0k tokens · 2.4k cached · 2s");
  });

  it("keeps compaction and update notices bordered with spacing after final flush", () => {
    let output = "";
    const stream = {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    } as NodeJS.WriteStream;
    const printer = createTerminalHistoryPrinter({ stream });

    printer.print(
      [
        {
          kind: "assistant",
          text: "Published @kenkaiiii/ggcoder at 4.3.215.",
          id: "assistant-before-notices",
        },
        {
          kind: "compacted",
          id: "compacted-notice",
          originalCount: 279,
          newCount: 39,
          tokensBefore: 184000,
          tokensAfter: 26000,
        },
        {
          kind: "update_notice",
          id: "update-notice",
          text: "Ken just pushed a fresh update — 4.3.214 → 4.3.215! I'll grab it on next launch (or run npm install -g @kenkaiiii/ggcoder@latest if you can't wait).",
        },
      ],
      context,
    );

    const rendered = stripAnsi(output);
    expect(rendered).toMatch(/4\.3\.215\.\n\n │ ⟳ Conversation compacted/);
    expect(rendered).toMatch(/86% reduction\n\n ╭─+/);
    expect(rendered).toContain(" │ KEN HAS PUSHED A NEW GG CODER UPDATE");
    expect(rendered).not.toContain("Ken just pushed a fresh update");
    expect(rendered).toMatch(/╰─+╯\n$/);
  });

  it("prints each finalized item id once across remount-style replays", () => {
    let output = "";
    const stream = {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    } as NodeJS.WriteStream;
    const printer = createTerminalHistoryPrinter({ stream });
    const items: CompletedItem[] = [
      { kind: "banner", id: "banner" },
      { kind: "user", text: "hello", id: "user-1" },
    ];

    printer.print(items, context);
    printer.print(items, context);

    expect(output.match(/GG Coder/g)).toHaveLength(1);
    expect(output.match(/hello/g)).toHaveLength(1);
  });

  it("leaves one message-sized blank line after the banner", () => {
    let output = "";
    const stream = {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    } as NodeJS.WriteStream;
    const printer = createTerminalHistoryPrinter({ stream });

    printer.print(
      [
        { kind: "banner", id: "banner" },
        { kind: "user", text: "hello", id: "user-1" },
      ],
      context,
    );

    const rendered = stripAnsi(output);
    expect(rendered).toMatch(/toggle thinking\n\n▄+/);
    expect(rendered).toContain("> hello");
    expect(rendered).not.toMatch(/toggle thinking\n\n\n▄+/);
  });

  it("prints one trailing newline after finalized assistant rows", () => {
    let output = "";
    const stream = {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    } as NodeJS.WriteStream;
    const printer = createTerminalHistoryPrinter({ stream });

    printer.print([{ kind: "assistant", text: "last answer", id: "assistant-1" }], context);

    expect(stripAnsi(output)).toMatch(/^ [⏺●] last answer\n$/);
  });

  it("does not add a blank separator between a submitted user row and finalized assistant row", () => {
    let output = "";
    const stream = {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    } as NodeJS.WriteStream;
    const printer = createTerminalHistoryPrinter({ stream });

    printer.print(
      [
        { kind: "user", text: "Fix it", id: "user-1" },
        { kind: "assistant", text: "Fixed.", id: "assistant-1" },
      ],
      context,
    );

    expect(stripAnsi(output)).toMatch(/▀+\n [⏺●] Fixed\./);
    expect(stripAnsi(output)).not.toMatch(/▀+\n\n [⏺●] Fixed\./);
  });

  it("reinserts the paragraph break before an assistant continuation chunk", () => {
    let output = "";
    const stream = {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    } as NodeJS.WriteStream;
    const printer = createTerminalHistoryPrinter({ stream });

    printer.print(
      [
        { kind: "assistant", text: "First chunk.", id: "assistant-1" },
        { kind: "assistant", text: "Second chunk.", continuation: true, id: "assistant-2" },
      ],
      context,
    );

    // A continuation chunk is the next paragraph of a progressively-flushed
    // response, so the blank line that separated the paragraphs is restored —
    // this keeps reassembled scrollback identical to the whole response.
    expect(stripAnsi(output)).toContain(" ⏺ First chunk.\n\n   Second chunk.");
  });

  it("omits tool rows from scrollback (shown in the live tool panel instead)", () => {
    let output = "";
    const stream = {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    } as NodeJS.WriteStream;
    const printer = createTerminalHistoryPrinter({ stream });

    printer.print(
      [
        { kind: "assistant", text: "I’ll inspect the files.", id: "assistant-1" },
        {
          kind: "tool_group",
          id: "tool-group-1",
          tools: [
            {
              toolCallId: "read-1",
              name: "read",
              args: { file_path: "src/a.ts" },
              status: "done",
              result: "ok",
            },
          ],
        },
      ],
      context,
    );

    const text = stripAnsi(output);
    expect(text).toContain("inspect the files.");
    expect(text).not.toContain("Read");
  });

  it("omits consecutive tool_done rows from scrollback", () => {
    let output = "";
    const stream = {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    } as NodeJS.WriteStream;
    const printer = createTerminalHistoryPrinter({ stream });

    printer.print(
      [
        {
          kind: "tool_done",
          id: "tool-1",
          name: "read",
          args: { file_path: "src/a.ts" },
          result: "ok",
          isError: false,
          durationMs: 1,
        },
        {
          kind: "tool_done",
          id: "tool-2",
          name: "grep",
          args: { pattern: "needle" },
          result: "src/a.ts:1:needle\n1 match found",
          isError: false,
          durationMs: 1,
        },
      ],
      context,
    );

    expect(output).toBe("");
  });

  it("does not add a blank separator above the next user row after an assistant", () => {
    let output = "";
    const stream = {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    } as NodeJS.WriteStream;
    const printer = createTerminalHistoryPrinter({ stream });

    printer.print(
      [
        { kind: "assistant", text: "Previous answer.", id: "assistant-1" },
        { kind: "user", text: "Next prompt", id: "user-1" },
      ],
      context,
    );

    expect(stripAnsi(output)).toMatch(/Previous answer\.\n▄+/);
    expect(stripAnsi(output)).not.toMatch(/Previous answer\.\n\n▄+/);
  });

  it("renders a screenshot result as a single Screenshot (media-type) line", () => {
    const item: CompletedItem = {
      kind: "tool_done",
      id: "tool-screenshot-1",
      name: "screenshot",
      args: { url: "http://localhost:3000" },
      result: "Captured http://localhost:3000 → /tmp/shot.png [image/png] (1280×800)",
      isError: false,
      durationMs: 1,
    };

    const rendered = stripAnsi(serializeCompletedItemToTerminalHistory(item, context));

    expect(rendered).toMatch(/^ [⏺●] Screenshot\(image\/png\)$/);
    expect(rendered).not.toContain("Captured");
    expect(rendered).not.toContain("/tmp/shot.png");
  });

  it("writes an inline graphics sequence after an image-bearing item on kitty terminals", () => {
    const prevKitty = process.env.KITTY_WINDOW_ID;
    const prevTmux = process.env.TMUX;
    process.env.KITTY_WINDOW_ID = "1";
    delete process.env.TMUX;
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      let output = "";
      const stream = {
        write(chunk: string) {
          output += chunk;
          return true;
        },
      } as NodeJS.WriteStream;
      const printer = createTerminalHistoryPrinter({ stream });
      const item: CompletedItem = {
        kind: "tool_done",
        id: "tool-image-1",
        name: "read",
        args: { file_path: "shot.png" },
        result: "Read image file shot.png [image/png]",
        isError: false,
        durationMs: 1,
        imagePreviews: [{ base64: "QUJD", mediaType: "image/png" }],
      };

      printer.print([item], context);

      expect(stripAnsi(output)).toContain("Read shot.png");
      // kitty APC graphics sequence with the base64 payload, height-constrained
      // (r=…) with cursor ownership kept by the printer (C=1).
      expect(output).toContain("\u001b_Gf=100,a=T,r=12,C=1,m=0;QUJD\u001b\\");
    } finally {
      if (prevKitty === undefined) delete process.env.KITTY_WINDOW_ID;
      else process.env.KITTY_WINDOW_ID = prevKitty;
      if (prevTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = prevTmux;
      if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
    }
  });

  it("writes only the text line for image items when no graphics terminal is detected", () => {
    const prevKitty = process.env.KITTY_WINDOW_ID;
    const prevTermProgram = process.env.TERM_PROGRAM;
    const prevTerm = process.env.TERM;
    delete process.env.KITTY_WINDOW_ID;
    delete process.env.TERM_PROGRAM;
    process.env.TERM = "xterm-256color";
    try {
      let output = "";
      const stream = {
        write(chunk: string) {
          output += chunk;
          return true;
        },
      } as NodeJS.WriteStream;
      const printer = createTerminalHistoryPrinter({ stream });
      const item: CompletedItem = {
        kind: "tool_done",
        id: "tool-image-2",
        name: "read",
        args: { file_path: "shot.png" },
        result: "Read image file shot.png [image/png]",
        isError: false,
        durationMs: 1,
        imagePreviews: [{ base64: "QUJD", mediaType: "image/png" }],
      };

      printer.print([item], context);

      expect(stripAnsi(output)).toContain("Read shot.png");
      expect(output).not.toContain("\u001b_G");
      expect(output).not.toContain("\u001b]1337");
    } finally {
      if (prevKitty === undefined) delete process.env.KITTY_WINDOW_ID;
      else process.env.KITTY_WINDOW_ID = prevKitty;
      if (prevTermProgram === undefined) delete process.env.TERM_PROGRAM;
      else process.env.TERM_PROGRAM = prevTermProgram;
      if (prevTerm === undefined) delete process.env.TERM;
      else process.env.TERM = prevTerm;
    }
  });

  it("can intentionally clear printed ids for a fresh session", () => {
    let output = "";
    const stream = {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    } as NodeJS.WriteStream;
    const printer = createTerminalHistoryPrinter({ stream });
    const item: CompletedItem = { kind: "user", text: "again", id: "user-1" };

    printer.print([item], context);
    expect(printer.printedIds.has(item.id)).toBe(true);
    printer.clear();
    expect(printer.printedIds.has(item.id)).toBe(false);
    printer.print([item], context);

    expect(output.match(/again/g)).toHaveLength(2);
  });
});
