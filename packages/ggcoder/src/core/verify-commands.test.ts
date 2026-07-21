import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LanguageId } from "./language-detector.js";
import { detectVerifyCommands, renderVerifySection } from "./verify-commands.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-cmd-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(rel: string, content = ""): void {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function set(...langs: LanguageId[]): Set<LanguageId> {
  return new Set(langs);
}

describe("detectVerifyCommands", () => {
  it("returns empty for empty project", () => {
    expect(detectVerifyCommands(tmpDir, set())).toEqual([]);
  });

  it("emits TS commands from package.json scripts using pnpm when lock present", () => {
    write(
      "package.json",
      JSON.stringify({
        scripts: { lint: "eslint .", typecheck: "tsc --noEmit", test: "vitest" },
      }),
    );
    write("pnpm-lock.yaml", "");
    write("tsconfig.json", "{}");
    const cmds = detectVerifyCommands(tmpDir, set("typescript"));
    expect(cmds.map((c) => c.command)).toEqual(["pnpm lint", "pnpm typecheck", "pnpm test"]);
  });

  it("falls back to npm run when no lockfile is present", () => {
    write("package.json", JSON.stringify({ scripts: { lint: "eslint ." } }));
    const cmds = detectVerifyCommands(tmpDir, set("typescript"));
    expect(cmds[0].command).toBe("npm run lint");
  });

  it("falls back to direct tsc when TS project has no package.json scripts", () => {
    write("tsconfig.json", "{}");
    const cmds = detectVerifyCommands(tmpDir, set("typescript"));
    expect(cmds.map((c) => c.command)).toContain("tsc --noEmit");
  });

  it("emits Rust toolchain commands universally", () => {
    write("Cargo.toml", "");
    const cmds = detectVerifyCommands(tmpDir, set("rust"));
    const labels = cmds.map((c) => c.label);
    expect(labels).toContain("lint");
    expect(labels).toContain("format");
    expect(labels).toContain("test");
  });

  it("emits Go toolchain commands universally", () => {
    const cmds = detectVerifyCommands(tmpDir, set("go"));
    expect(cmds.map((c) => c.command)).toEqual(["go vet ./...", "gofmt -l .", "go test ./..."]);
  });

  it("only emits Python commands when pyproject.toml configures the tool", () => {
    write("pyproject.toml", "[tool.ruff]\nline-length = 100\n[tool.pyright]\nstrict = []\n");
    const cmds = detectVerifyCommands(tmpDir, set("python"));
    expect(cmds.map((c) => c.label).sort()).toEqual(["format", "lint", "typecheck"]);
  });

  it("groups commands by language and falls back gracefully on malformed json", () => {
    write("package.json", "{ this is not json");
    write("Cargo.toml", "");
    const cmds = detectVerifyCommands(tmpDir, set("typescript", "rust"));
    // package.json was unparseable but Rust commands still emit.
    expect(cmds.every((c) => c.language === "rust")).toBe(true);
  });
});

describe("renderVerifySection", () => {
  it("returns empty string for no commands", () => {
    expect(renderVerifySection([])).toBe("");
  });

  it("groups commands by language in stable order", () => {
    const out = renderVerifySection([
      { label: "lint", command: "pnpm lint", language: "typescript" },
      { label: "lint", command: "cargo clippy", language: "rust" },
    ]);
    expect(out).toBe(
      "## Verification\n\n- **rust**: `cargo clippy` (lint)\n- **typescript**: `pnpm lint` (lint)",
    );
  });
});
