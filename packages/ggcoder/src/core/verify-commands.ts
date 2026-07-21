import fs from "node:fs";
import path from "node:path";
import type { LanguageId } from "./language-detector.js";

/**
 * A verification command the agent should consider running after meaningful
 * edits to satisfy the active style pack(s). These are *recommendations* —
 * the agent picks the relevant ones for the change it just made.
 *
 * Detection is filesystem-only (manifest reads + script-name scans) — no
 * command execution. Cheap to compute alongside language detection.
 */
export interface VerifyCommand {
  /** Display label for the prompt (e.g. "lint", "typecheck", "test"). */
  label: string;
  /** The exact shell command, including the runner (pnpm/cargo/uv/etc.). */
  command: string;
  /** Which language pack this command verifies — for grouping in the prompt. */
  language: LanguageId;
}

/**
 * Compute the recommended verify commands for the active language set in `cwd`.
 *
 * Conservative by design: we only emit a command when its existence is
 * essentially guaranteed by a manifest or convention. We never invent commands
 * that might not exist. False positives here would train the agent to run
 * commands that fail, which is worse than no recommendation at all.
 */
export function detectVerifyCommands(cwd: string, active: Set<LanguageId>): VerifyCommand[] {
  const cmds: VerifyCommand[] = [];

  // ── Node ecosystem (TS / JS) — read scripts from package.json
  if (active.has("typescript") || active.has("javascript")) {
    const scripts = readPackageJsonScripts(cwd);
    if (scripts) {
      const runner = detectNodeRunner(cwd);
      const lang: LanguageId = active.has("typescript") ? "typescript" : "javascript";
      // Common script names, in priority order — we pick the first match per category.
      const pick = (...candidates: string[]): string | null => {
        for (const c of candidates) {
          if (typeof scripts[c] === "string") return c;
        }
        return null;
      };
      const lintScript = pick("lint", "lint:check");
      if (lintScript)
        cmds.push({ label: "lint", command: `${runner} ${lintScript}`, language: lang });
      const typecheckScript = pick("typecheck", "check", "type-check");
      if (typecheckScript)
        cmds.push({ label: "typecheck", command: `${runner} ${typecheckScript}`, language: lang });
      const formatScript = pick("format:check", "format-check", "prettier:check");
      if (formatScript)
        cmds.push({ label: "format", command: `${runner} ${formatScript}`, language: lang });
      const testScript = pick("test", "test:unit");
      if (testScript)
        cmds.push({ label: "test", command: `${runner} ${testScript}`, language: lang });
    } else if (active.has("typescript") && fileExists(path.join(cwd, "tsconfig.json"))) {
      // No package.json scripts — fall back to direct tsc invocation.
      cmds.push({ label: "typecheck", command: "tsc --noEmit", language: "typescript" });
    }
  }

  // ── Python — pyproject.toml conventions
  if (active.has("python")) {
    const pyproject = readFileSafe(path.join(cwd, "pyproject.toml"));
    if (pyproject) {
      if (/\[tool\.ruff/.test(pyproject)) {
        cmds.push({ label: "lint", command: "ruff check .", language: "python" });
        cmds.push({ label: "format", command: "ruff format --check .", language: "python" });
      }
      if (/\[tool\.pyright/.test(pyproject)) {
        cmds.push({ label: "typecheck", command: "pyright", language: "python" });
      } else if (/\[tool\.mypy/.test(pyproject)) {
        cmds.push({ label: "typecheck", command: "mypy .", language: "python" });
      }
      if (/\[tool\.pytest/.test(pyproject)) {
        cmds.push({ label: "test", command: "pytest", language: "python" });
      }
    }
  }

  // ── Go — universally available toolchain
  if (active.has("go")) {
    cmds.push({ label: "vet", command: "go vet ./...", language: "go" });
    cmds.push({ label: "format", command: "gofmt -l .", language: "go" });
    cmds.push({ label: "test", command: "go test ./...", language: "go" });
  }

  // ── Rust — Cargo guarantees the toolchain
  if (active.has("rust")) {
    cmds.push({
      label: "lint",
      command: "cargo clippy --all-targets -- -D warnings",
      language: "rust",
    });
    cmds.push({ label: "format", command: "cargo fmt --check", language: "rust" });
    cmds.push({ label: "test", command: "cargo test", language: "rust" });
  }

  // ── Java — Gradle/Maven detection
  if (active.has("java") || active.has("kotlin")) {
    const lang: LanguageId = active.has("kotlin") ? "kotlin" : "java";
    if (fileExists(path.join(cwd, "gradlew"))) {
      cmds.push({ label: "build", command: "./gradlew build", language: lang });
      cmds.push({ label: "test", command: "./gradlew test", language: lang });
    } else if (fileExists(path.join(cwd, "pom.xml"))) {
      cmds.push({ label: "verify", command: "mvn verify", language: lang });
    }
  }

  // ── C# — dotnet CLI
  if (active.has("csharp")) {
    cmds.push({ label: "build", command: "dotnet build --no-incremental", language: "csharp" });
    cmds.push({
      label: "format",
      command: "dotnet format --verify-no-changes",
      language: "csharp",
    });
    cmds.push({ label: "test", command: "dotnet test", language: "csharp" });
  }

  // ── Ruby — bundle + standardrb/rubocop conventions
  if (active.has("ruby")) {
    if (fileExists(path.join(cwd, "Gemfile"))) {
      cmds.push({ label: "lint", command: "bundle exec rubocop", language: "ruby" });
      cmds.push({ label: "test", command: "bundle exec rspec", language: "ruby" });
    }
  }

  // ── Elixir — mix is canonical
  if (active.has("elixir")) {
    cmds.push({ label: "format", command: "mix format --check-formatted", language: "elixir" });
    cmds.push({ label: "test", command: "mix test", language: "elixir" });
  }

  // ── PHP — composer + phpstan conventions
  if (active.has("php")) {
    if (fileExists(path.join(cwd, "composer.json"))) {
      cmds.push({ label: "test", command: "composer test", language: "php" });
    }
  }

  // ── Bash — shellcheck when scripts present
  if (active.has("bash")) {
    cmds.push({ label: "lint", command: "shellcheck **/*.sh", language: "bash" });
  }

  // ── Terraform / OpenTofu
  if (active.has("terraform")) {
    cmds.push({ label: "validate", command: "terraform validate", language: "terraform" });
    cmds.push({
      label: "format",
      command: "terraform fmt -check -recursive",
      language: "terraform",
    });
  }

  return cmds;
}

// ── helpers ──────────────────────────────────────────────────────────────

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readFileSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function readPackageJsonScripts(cwd: string): Record<string, unknown> | null {
  const raw = readFileSafe(path.join(cwd, "package.json"));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    return parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : null;
  } catch {
    return null;
  }
}

/**
 * Detect the Node package runner: pnpm if `pnpm-lock.yaml` exists, yarn if
 * `yarn.lock`, bun if `bun.lockb`, otherwise npm. Conservative default — npm
 * is always available.
 */
function detectNodeRunner(cwd: string): string {
  if (fileExists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fileExists(path.join(cwd, "yarn.lock"))) return "yarn";
  if (fileExists(path.join(cwd, "bun.lockb"))) return "bun";
  return "npm run";
}

/**
 * Render the Verification section for the system prompt. Returns empty string
 * when no commands were detected so the caller can skip the section entirely.
 *
 * Commands are grouped by language so the agent can quickly pick the relevant
 * subset when its edit only touched one language.
 */
export function renderVerifySection(cmds: readonly VerifyCommand[]): string {
  if (cmds.length === 0) return "";
  const byLang = new Map<LanguageId, VerifyCommand[]>();
  for (const c of cmds) {
    const list = byLang.get(c.language);
    if (list) list.push(c);
    else byLang.set(c.language, [c]);
  }
  const sortedLangs = [...byLang.keys()].sort();
  const lines: string[] = [];
  for (const lang of sortedLangs) {
    const list = byLang.get(lang)!;
    const parts = list.map((c) => `\`${c.command}\` (${c.label})`).join(", ");
    lines.push(`- **${lang}**: ${parts}`);
  }
  return `## Verification\n\n${lines.join("\n")}`;
}
