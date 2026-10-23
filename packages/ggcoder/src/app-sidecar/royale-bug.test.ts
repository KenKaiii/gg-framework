import { describe, expect, it } from "vitest";
import { type MessageLike, categorizeFailure, classifyFixedCheck } from "./royale-bug.js";

function run(id: string, command: string, result: string, name = "bash"): MessageLike[] {
  return [
    { role: "assistant", content: [{ type: "tool_call", id, name, args: { command } }] },
    { role: "tool", content: [{ type: "tool_result", toolCallId: id, content: result }] },
  ];
}

describe("classifyFixedCheck", () => {
  it("returns the category when a failing check later passes", () => {
    const msgs = [
      ...run("1", "npx tsc --noEmit", "Exit code: 2\nsrc/a.ts(1,1): error TS2322: nope"),
      ...run("2", "npx  tsc --noEmit", "Exit code: 0\n"),
    ];
    expect(classifyFixedCheck(msgs)).toBe("type");
  });

  it("returns null when never fixed, never failed, or not a check", () => {
    expect(classifyFixedCheck(run("1", "pnpm test", "Exit code: 1\nAssertionError"))).toBeNull();
    expect(classifyFixedCheck(run("1", "pnpm test", "Exit code: 0\n"))).toBeNull();
    expect(
      classifyFixedCheck([
        ...run("1", "ls missing", "Exit code: 1\nTypeError"),
        ...run("2", "ls missing", "Exit code: 0\n"),
      ]),
    ).toBeNull();
    // Different command passing doesn't count.
    expect(
      classifyFixedCheck([
        ...run("1", "pnpm test", "Exit code: 1\nexpected 1"),
        ...run("2", "pnpm lint", "Exit code: 0\n"),
      ]),
    ).toBeNull();
    // Non-shell tools ignored.
    expect(
      classifyFixedCheck([
        ...run("1", "pnpm test", "Exit code: 1\nx", "read"),
        ...run("2", "pnpm test", "Exit code: 0\n", "read"),
      ]),
    ).toBeNull();
  });

  it("reads array content parts", () => {
    const msgs: MessageLike[] = [
      ...run("1", "pytest", ""),
      ...run("2", "pytest", "Exit code: 0\n"),
    ];
    msgs[1] = {
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: "1",
          content: [{ type: "text", text: "Exit code: 1\nAttributeError: 'NoneType'" }],
        },
      ],
    };
    expect(classifyFixedCheck(msgs)).toBe("null");
  });
});

describe("categorizeFailure", () => {
  it.each([
    ["TypeError: x is not a function", "vitest", "type"],
    ["Cannot read properties of undefined (reading 'a')", "jest", "null"],
    ["panic: nil pointer dereference", "go test", "crash"],
    ["NullPointerException", "gradle test", "null"],
    ["AssertionError: expected 1 to be 2", "vitest", "test"],
    ["Build failed with 1 error", "pnpm build", "build"],
    ["3 problems (eslint)", "pnpm lint", "lint"],
    ["SyntaxError: Unexpected token }", "node --test", "syntax"],
    ["Test timed out in 5000ms", "vitest", "timeout"],
    ["Segmentation fault (core dumped)", "cargo test", "crash"],
    ["something", "cargo clippy", "lint"],
    ["something", "cargo build", "build"],
    ["something", "pnpm test", "test"],
  ] as const)("%s → %s", (out, cmd, cat) => {
    expect(categorizeFailure(out, cmd)).toBe(cat);
  });
});
