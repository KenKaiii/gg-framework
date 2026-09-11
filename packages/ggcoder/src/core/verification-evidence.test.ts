import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import {
  classifyVerificationCommand,
  collectVerificationEvidence,
} from "./verification-evidence.js";

describe("classifyVerificationCommand", () => {
  it.each([
    "pnpm build",
    "npm run build",
    "pnpm check && pnpm test && pnpm build",
    "pnpm build && pnpm test",
  ])("requires a host snapshot rather than accepting %s from transcript text", (command) => {
    expect(classifyVerificationCommand(command)).toMatchObject({
      accepted: false,
      mayMutate: true,
      snapshotEligible: true,
    });
  });
  it.each([
    "pnpm build --watch",
    "pnpm build --write",
    "pnpm build --help",
    "pnpm build:watch",
    "pnpm lint:fix && pnpm build",
    "cd ../other && pnpm build",
    "pnpm --dir ../other build",
    "pnpm -C ../other build",
    "pnpm -c ../other build",
    "pnpm -w build",
    "pnpm build || true",
    "pnpm build; pnpm test",
  ])("never grants the snapshot exception to %s", (command) => {
    expect(classifyVerificationCommand(command).snapshotEligible).not.toBe(true);
    expect(classifyVerificationCommand(command).accepted).toBe(false);
  });

  it.each([
    "tsc --noEmit",
    "pnpm exec tsc --noEmit --pretty false",
    "pnpm --filter @kenkaiiii/gg-ai check",
    "pnpm -w typecheck",
    "vitest run src/foo.test.ts",
    "pnpm vitest run src/foo.test.ts",
    "pnpm --filter web vitest run",
    "node --test verification.test.mjs",
    "node --test --import tsx verification.test.ts",
    "node.exe --test verification.test.mjs",
    "python -m unittest",
    "cd packages/app && npm test",
    "git status --short && npm run test",
    "git status && npm test",
    "cd packages/app && git status --porcelain && npm test",
    "pnpm test -- --runInBand",
    "cargo fmt --check && cargo clippy",
    "ruff format --check .",
    "pnpm format:check",
    "npm run format:check",
    "yarn format:check",
    "bun run format:check",
    "pnpm format-check",
    "pnpm check && pnpm lint && pnpm format:check && pnpm test",
  ])("accepts bounded check: %s", (command) => {
    expect(classifyVerificationCommand(command)).toMatchObject({
      accepted: true,
      candidate: true,
      mayMutate: false,
    });
  });

  it.each([
    ["node script.js --test", "must lead"],
    ["node.exe script.js --test", "must lead"],
    ["node -- script.js --test", "must lead"],
    ["node --require --test script.js", "must lead"],
    ["pnpm exec node script.js --test", "must lead"],
    ["tsc --init", "mutating"],
    ["tsc --build", "mutating"],
    ["tsc --noEmit --incremental", "mutating"],
    ["tsc --noEmit --tsBuildInfoFile cache.tsbuildinfo", "mutating"],
    ["prettier --write src", "mutating"],
    ["pnpm build", "artifact-producing"],
    ["pnpm format", "mutating"],
    ["pnpm format:write", "mutating"],
    ["pnpm format:check:write", "mutating"],
    ["pnpm format:check --write", "mutating"],
    ["pnpm format:check --watch", "long-running"],
    ["tsc --watch --noEmit", "long-running"],
    ["vitest --watch", "long-running"],
    ["pnpm vitest --watch", "long-running"],
    ["pnpm eslint --fix src", "mutating"],
    ["pnpm vitest run --listTests", "does not execute"],
    ["pnpm dev", "long-running"],
    ["tsc", "--noEmit"],
    ["tsc --noEmit --noCheck", "does not prove"],
    ["tsc --noEmit --listFilesOnly", "does not prove"],
    ["tsc --showConfig", "does not prove"],
    ["tsc --help", "does not prove"],
    ["tsc --version", "does not prove"],
    ["tsc --noEmit --generateTrace trace", "does not prove"],
    ["tsc --noEmit --generateCpuProfile cpu.cpuprofile", "does not prove"],
    ["tsc --noEmit > result.txt", "unsafe shell"],
    ["tsc --noEmit | cat", "pipe stage"],
    ["tsc --noEmit || echo ignored", "control operator"],
    ["tsc --noEmit; echo ignored", "control operator"],
    ["tsc --noEmit && npm run clean", "mutating"],
  ])("rejects non-evidence command: %s", (command, reason) => {
    expect(classifyVerificationCommand(command)).toMatchObject({
      accepted: false,
      candidate: true,
      reason: expect.stringContaining(reason),
    });
  });

  it.each([
    "git status --short && git status",
    "git status --short && npm test || true",
    "git status --short; npm test",
    "git status --short | npm test",
    "git status --short > status.txt && npm test",
    "git -c core.fsmonitor=helper status --short && npm test",
    "git reset --hard && npm test",
    "git status --help && npm test",
    "git status --short && echo done",
  ])("does not let a status prelude bypass verification: %s", (command) => {
    expect(classifyVerificationCommand(command).accepted).toBe(false);
  });

  it("rejects unknown commands without mislabeling ordinary shell work as verification", () => {
    expect(classifyVerificationCommand("git status --short")).toMatchObject({
      accepted: false,
      candidate: false,
    });
  });

  it("accepts checks piped through pure output limiters (pipefail keeps the status)", () => {
    expect(classifyVerificationCommand("pnpm vitest run src/a.test.ts | tail -20")).toMatchObject({
      accepted: true,
    });
    expect(
      classifyVerificationCommand("cd packages/ggcoder && pnpm test 2>&1 | tail -5"),
    ).toMatchObject({ accepted: true });
    expect(classifyVerificationCommand("npm test | head -3")).toMatchObject({
      accepted: true,
    });
  });

  it("rejects pipes whose stages can transform check results", () => {
    // grep/tee/wc can filter, redirect, or replace what the check proved.
    expect(classifyVerificationCommand("pnpm test | grep -q 'all passed'").accepted).toBe(false);
    expect(classifyVerificationCommand("pnpm test | tee results.log").accepted).toBe(false);
    expect(classifyVerificationCommand("pnpm test | wc -l").accepted).toBe(false);
    // A limiter joined by && (not a pipe) runs AFTER the check and its own 0
    // would mask the check's status — the pipe allowance must not leak to it.
    expect(classifyVerificationCommand("pnpm test && tail -5").accepted).toBe(false);
    // Output redirection into the pipe stage is not a pure limiter either.
    expect(classifyVerificationCommand("pnpm test | tail -f log.txt").accepted).toBe(false);
  });

  it("marks file-rewriting rejections mayMutate, plain unrecognized checks not", () => {
    // The gate bumps its mutation revision when a mayMutate check STARTS (the
    // command can rewrite files). A green `make test` — a real check the
    // classifier just cannot vouch for — must not poison the revision and
    // re-arm the gate into every later question turn.
    expect(classifyVerificationCommand("pnpm lint:fix").mayMutate).toBe(true);
    expect(classifyVerificationCommand("pnpm format:check --write").mayMutate).toBe(true);
    expect(classifyVerificationCommand("pnpm test --update").mayMutate).toBe(true);
    expect(classifyVerificationCommand("pnpm build").mayMutate).toBe(true);
    expect(classifyVerificationCommand("pnpm eslint --fix src/foo.ts").mayMutate).toBe(true);
    expect(classifyVerificationCommand("tsc -p .").mayMutate).toBe(true); // emits JS files
    expect(classifyVerificationCommand("cargo build").mayMutate).toBe(true);
    expect(classifyVerificationCommand("pnpm build 2>&1 | tail -5").mayMutate).toBe(true);
    // Non-mutating shapes: unrecognized runners and pure checks.
    expect(classifyVerificationCommand("make test").mayMutate).toBe(false);
    expect(classifyVerificationCommand("deno test").mayMutate).toBe(false);
    expect(classifyVerificationCommand("pnpm test").mayMutate).toBe(false);
    expect(classifyVerificationCommand("pnpm test | grep -q ok").mayMutate).toBe(false);
  });
});

function bashExchange(
  id: string,
  command: string,
  result: string,
  args: Record<string, unknown> = {},
): Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_call", id, name: "bash", args: { command, ...args } }],
    },
    {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: id, content: result }],
    },
  ];
}

describe("collectVerificationEvidence", () => {
  it("records only successful bounded checks as passed evidence", () => {
    const messages: Message[] = [
      ...bashExchange("pass", "tsc --noEmit", "Exit code: 0\n"),
      ...bashExchange("fail", "vitest run src/foo.test.ts", "Exit code: 1\n1 test failed"),
      ...bashExchange("watch", "tsc --watch --noEmit", "Exit code: 0\nWatching"),
      ...bashExchange("ordinary", "git status --short", "Exit code: 0\n"),
      ...bashExchange("background", "vitest run", "Background process started.", {
        run_in_background: true,
      }),
    ];

    expect(collectVerificationEvidence(messages)).toEqual([
      {
        command: "tsc --noEmit",
        status: "passed",
        reason: "bounded TypeScript no-emit check",
      },
      {
        command: "vitest run src/foo.test.ts",
        status: "failed",
        reason: "bounded check did not exit successfully",
      },
      {
        command: "tsc --watch --noEmit",
        status: "rejected",
        reason: "long-running watch/debug mode",
      },
      {
        command: "vitest run",
        status: "rejected",
        reason: "background or persistent commands are not bounded evidence",
      },
    ]);
  });
});
