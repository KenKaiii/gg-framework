import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import {
  classifyVerificationCommand,
  collectVerificationEvidence,
  containsBoundedCheck,
} from "./verification-evidence.js";

describe("classifyVerificationCommand", () => {
  it("only preserves prior evidence for the transcript's mixed check/help chain", () => {
    expect(
      classifyVerificationCommand(
        "npm run lint && npm run format:check && npx tsx scripts/youtube/retention-inventory.mts --help",
      ),
    ).toMatchObject({
      accepted: false,
      snapshotEligible: true,
      snapshotPreserveOnly: true,
    });
  });

  it.each([
    "npm run check && node script.mjs --help || true",
    "npm run check; node script.mjs --help",
    "cd ../other && npm run check && node script.mjs --help",
    "npm run check && prettier --write .",
  ])("does not preserve evidence for unsafe or mutating chains: %s", (command) => {
    expect(classifyVerificationCommand(command).snapshotPreserveOnly).not.toBe(true);
  });
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
    "npm test 2>&1",
    "npm test 2>/dev/null",
    ".venv/bin/ruff check src 2>&1",
    "python -m ruff check src",
    ".venv/bin/python -m mypy src",
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
    ["npm test 2>&1 > result.txt", "unsafe shell"],
    ["npm test 2> errors.log", "unsafe shell"],
    ["python -m ruff check --fix src", "mutating"],
    ["tsc --noEmit | sort", "pipe stage"],
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

  it.each([
    "git status --short && git diff --stat",
    "rm -r scratch.html examples/ && git status --short && echo CLEAN",
    "git status && git log -1",
  ])("does not treat a status prelude as a check needing snapshot comparison: %s", (command) => {
    const result = classifyVerificationCommand(command);
    expect(result.accepted).toBe(false);
    expect(result.candidate).toBe(false);
    expect(result.snapshotEligible).not.toBe(true);
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

  // Shapes Haiku 5.5 actually wrote in the 2026-10-09 arena. Each left the run
  // "Unverified" although the tests passed. They now qualify for the host's
  // before/after workspace comparison, never for transcript-only acceptance.
  it.each([
    'cd /w && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖|✔"',
    "grep -rn getUserById . --exclude-dir=.git; npm run test 2>&1 | tail -15",
    "cd /w && rg -n formatPrice . --glob '!.git' ; npm run test 2>&1 | tail -15",
    "npm test && git diff --stat",
    "cat -n src/a.js && echo ---- && cat -n src/b.js; npm test",
    "npm test 2>&1 | grep -c pass",
    "tsc --noEmit | cat",
    // The 11 runs still "Unverified" after the first fix used these shapes.
    'cd /w && rg -n "formatPrice" . --glob \'!.git\'; echo "remaining: $?"; npm run test 2>&1 | tail -15',
    'cd /w && echo "remaining: $(grep -rn formatPrice --exclude-dir=.git . | wc -l)" && npm run test 2>&1 | tail -25',
    'cd /w && (rg -n "formatPrice" . || echo "no formatPrice left") && npm run test 2>&1 | tail -15',
    'cd /w && (rg -n "getUserById" --hidden -g \'!.git\' || echo "no old refs") && npm run test 2>&1 | grep -E "^ℹ (tests|pass|fail)"',
    'grep -rn "getUserById" . --exclude-dir=.git; echo "refs-exit=$?"; npm test 2>&1 | grep -E "^ℹ"',
  ])("counts a check with read-only commands around it, via snapshot: %s", (command) => {
    // Only under bash with pipefail; a caller that does not know the shell
    // (or the Windows cmd.exe fallback) gets the strict answer.
    expect(classifyVerificationCommand(command).ambiguousFailure).toBeUndefined();
    expect(classifyVerificationCommand(command, { posixShell: true })).toMatchObject({
      accepted: false,
      candidate: true,
      mayMutate: false,
      snapshotEligible: true,
      ambiguousFailure: true,
    });
    expect(
      classifyVerificationCommand(command, { posixShell: true }).snapshotPreserveOnly,
    ).toBeUndefined();
  });

  it.each([
    // A later status replaces the check's.
    ["npm test; git diff --stat", "`;` after the check"],
    ["npm test; echo done", "`;` after the check"],
    ["npm test || true", "`||`"],
    ["npm test && npm run test:other; echo ok", "`;` after a check"],
    // Something in the chain can write files or run arbitrary code.
    ["sed -i s/a/b/ src/a.js; npm test", "mutating prelude"],
    ["npm test | tee out.log", "tee writes a file"],
    ["npm test | sort", "filter that exists in cmd.exe (no pipefail there)"],
    ["npm test && npm run clean", "mutating trailer"],
    ['echo "$(rm -rf src)"; npm test', "command substitution"],
    ["cat a.js; npm test > out.txt", "redirection"],
    ["git -c core.fsmonitor=helper status; npm test", "git running a configured helper"],
    ["git config core.pager x; npm test", "git writing config"],
    ["(cd sub; npm test)", "subshell"],
    ["! npm test", "negated status"],
    ["npm test | tail -f log", "never-ending filter"],
    ['npm test | grep "-o" x', "flag hidden in quotes"],
    ["cat a.js \\; npm test", "escape"],
    // A check skipped or masked by `||`; a cd not joined by `&&`.
    ["cat a.js || npm test", "check only runs if cat fails"],
    ["npm test || echo failed", "`||` after the check"],
    ["cd /w; npm test", "cd joined by ;"],
    // Expansions and groups that could run or hide something.
    ['echo "$(sed -i s/a/b/ x.js)"; npm test', "substitution with a writer"],
    ["(sed -i s/a/b/ x.js) && npm test", "group with a writer"],
    ["(cat a) x && npm test", "text after a group"],
    ["(npm test) && cat a", "check inside a group"],
    ["grep $'\\x2do' x; npm test", "ANSI-C quoted flag"],
    ["cat $HOME/x; npm test", "variable expansion"],
    ["cat a\u0000read-only-group && npm test", "forged group marker"],
    // Read-only commands that can run a helper program.
    ["rg --pre ./x.sh TODO; npm test", "rg preprocessor"],
    ["git diff --ext-diff; npm test", "git external diff"],
    // No check at all.
    ["cat a.js; git diff --stat", "no check"],
  ])("does not count %s (%s)", (command) => {
    const result = classifyVerificationCommand(command, { posixShell: true });
    expect(result.accepted).toBe(false);
    expect(result.ambiguousFailure).toBeUndefined();
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

describe("containsBoundedCheck", () => {
  it.each([
    ["npm test; git diff --stat", true],
    [".venv/bin/ruff check a.py 2>&1 | sort > /tmp/base.txt", true],
    ["ls .venv/bin/ | grep -i ruff; .venv/bin/ruff --version", false],
    ["git status --short && echo done", false],
    ["cat pyproject.toml | grep ruff", false],
  ])("%s -> %s", (command, expected) => {
    expect(containsBoundedCheck(command)).toBe(expected);
  });
});

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
