import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runBackgroundGit } from "../utils/git.js";
import { log } from "./logger.js";

/** Observations of setup, never audit verdicts. No project code is executed. */
export interface ChecklistDetection {
  readonly summary: string;
  readonly facts: readonly string[];
}
export interface ChecklistDetections {
  readonly items: Readonly<Record<string, ChecklistDetection>>;
  readonly warnings: readonly string[];
}

const MAX_ENTRIES = 256;
const MAX_PACKAGES = 32;
const MAX_MANIFEST_BYTES = 256 * 1024;
const Manifest = z.object({
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

/** Cheap, bounded, local observations. Missing/unsupported setup is not a failure. */
export async function detectChecklist(
  cwd: string,
  signal?: AbortSignal,
): Promise<ChecklistDetections> {
  const started = Date.now();
  const items: Record<string, ChecklistDetection> = {};
  const warnings = new Set<string>();
  const facts = new Map<string, Set<string>>();
  let root: string;
  try {
    root = await fs.realpath(cwd);
  } catch {
    return { items, warnings: ["Project setup could not be read."] };
  }

  function add(id: string, fact: string): void {
    const lines = facts.get(id) ?? new Set<string>();
    if (lines.size < 10) lines.add(fact);
    facts.set(id, lines);
  }
  async function contained(relative: string): Promise<string | null> {
    if (signal?.aborted) return null;
    const file = path.join(root, relative);
    try {
      // Don't follow even in-project symlinks: opening a checklist must not
      // traverse a link to a secret, device, or another project's files.
      let current = root;
      for (const part of relative.split("/")) {
        current = path.join(current, part);
        if ((await fs.lstat(current)).isSymbolicLink()) return null;
      }
      const resolved = await fs.realpath(file);
      const rel = path.relative(root, resolved);
      return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
        ? null
        : resolved;
    } catch {
      return null;
    }
  }
  async function names(relative: string): Promise<{ files: string[]; directories: string[] }> {
    const result = { files: [] as string[], directories: [] as string[] };
    const directory = relative === "." ? root : await contained(relative);
    if (!directory || signal?.aborted) return result;
    try {
      let count = 0;
      const handle = await fs.opendir(directory);
      for await (const entry of handle) {
        if (signal?.aborted) break;
        if (++count > MAX_ENTRIES) {
          warnings.add(
            "Setup detection was limited in a large directory; unlisted files were not checked.",
          );
          break;
        }
        if (entry.isFile()) result.files.push(entry.name);
        else if (entry.isDirectory()) result.directories.push(entry.name);
      }
      result.files.sort();
      result.directories.sort();
    } catch {
      warnings.add("Some project folders could not be read; setup detection may be incomplete.");
    }
    return result;
  }
  async function manifest(relative: string): Promise<z.infer<typeof Manifest> | null> {
    const file = await contained(relative);
    if (!file || signal?.aborted) return null;
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
        warnings.add(
          "A package manifest was too large or not a regular file; it was not inspected.",
        );
        return null;
      }
      // A capped handle read also bounds a file that grows after stat().
      const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
      let length = 0;
      while (length < buffer.length && !signal?.aborted) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (signal?.aborted) return null;
      if (length > MAX_MANIFEST_BYTES) {
        warnings.add("A package manifest exceeded the read limit; it was not inspected.");
        return null;
      }
      const parsed = Manifest.safeParse(
        JSON.parse(buffer.subarray(0, length).toString("utf-8")) as unknown,
      );
      if (parsed.success) return parsed.data;
    } catch {
      // Never report file contents, script bodies or dependency URLs.
    } finally {
      await handle?.close();
    }
    warnings.add("A package manifest could not be parsed; setup detection may be incomplete.");
    return null;
  }

  const top = await names(".");
  for (const file of top.files) {
    if (/^(AGENTS|CLAUDE)\.md$/i.test(file)) add("agent-setup", `${file} found`);
    if (/^readme(?:\.(?:md|rst|txt))?$/i.test(file)) add("docs", "README found");
    if (/^(?:licen[cs]e|copying)(?:\.(?:md|txt|rst))?$/i.test(file))
      add("docs", "Licence file found");
    if (file === "CONTEXT.md") add("naming", "Project glossary found");
    if (file === ".gitignore") add("git-github", ".gitignore found");
    if (
      /^(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/.test(
        file,
      )
    )
      add("dependencies", `${file} found`);
    if (/^(?:CHANGELOG|CHANGES)(?:\.md)?$/i.test(file)) add("build-release", "Changelog found");
    if ([".gitlab-ci.yml", "azure-pipelines.yml", "Jenkinsfile"].includes(file))
      add("ci", "CI configuration found");
  }
  for (const relative of [
    ".gg/commands/commit.md",
    ".claude/commands/commit.md",
    ".husky/pre-commit",
  ]) {
    const file = await contained(relative);
    if (file && (await fs.stat(file)).isFile())
      add("commit-gate", "Project commit check configuration found");
  }
  if ((await names("docs/adr")).files.length > 0)
    add("naming", "Decision records found in docs/adr");
  const workflows = await names(".github/workflows");
  if (workflows.files.some((file) => /\.ya?ml$/i.test(file)))
    add("ci", "GitHub workflow files found");

  const packages = ["."];
  for (const parent of ["packages", "apps"]) {
    for (const directory of (await names(parent)).directories) {
      if (packages.length >= MAX_PACKAGES + 1) {
        warnings.add("Setup detection covered only the first 32 workspace packages.");
        break;
      }
      packages.push(`${parent}/${directory}`);
    }
  }
  for (const directory of packages) {
    if (signal?.aborted) break;
    const listing = directory === "." ? top : await names(directory);
    if (
      listing.files.some((file) =>
        /^(?:eslint\.config\.|\.eslintrc(?:\.|$)|biome\.jsonc?$|ruff\.toml$|\.ruff\.toml$|\.golangci\.)/.test(
          file,
        ),
      )
    )
      add("quality-tools", "Lint configuration found");
    if (
      listing.files.some((file) =>
        /^(?:\.prettierrc(?:\.|$)|prettier\.config\.|biome\.jsonc?$|rustfmt\.toml$|\.clang-format$)/.test(
          file,
        ),
      )
    )
      add("quality-tools", "Formatter configuration found");
    if (listing.files.some((file) => /^tsconfig(?:\..+)?\.json$/.test(file)))
      add("quality-tools", "TypeScript configuration found");
    if (
      listing.files.some((file) =>
        /^(?:vitest\.config\.|jest\.config\.|playwright\.config\.|pytest\.ini$|phpunit\.xml)/.test(
          file,
        ),
      ) ||
      listing.files.some((file) => /_test\.go$/.test(file))
    )
      add("tests", "Test configuration or test files found");
    if (!listing.files.includes("package.json")) continue;
    const data = await manifest(directory === "." ? "package.json" : `${directory}/package.json`);
    if (!data) continue;
    const scriptNames = Object.keys(data.scripts ?? {});
    if (scriptNames.some((name) => /^(?:lint|format|typecheck|type-check|check)(?::|$)/.test(name)))
      add("quality-tools", "Code quality scripts found");
    if (scriptNames.some((name) => /^test(?::|$)/.test(name))) add("tests", "Test script found");
    if (scriptNames.some((name) => /^build(?::|$)/.test(name)))
      add("build-release", "Build script found");
    const dependencies = { ...data.dependencies, ...data.devDependencies };
    if (
      ["eslint", "prettier", "typescript", "@biomejs/biome"].some((name) =>
        Object.hasOwn(dependencies, name),
      )
    )
      add("quality-tools", "Code quality tools declared");
    if (
      ["vitest", "jest", "@playwright/test", "mocha"].some((name) =>
        Object.hasOwn(dependencies, name),
      )
    )
      add("tests", "Test runner declared");
  }
  try {
    const git = await runBackgroundGit(["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      timeoutMs: 3000,
      maxBuffer: 4096,
      ...(signal ? { signal } : {}),
    });
    if (git.stdout.trim() === "true") add("git-github", "Git repository initialized");
  } catch {
    // Not a worktree or Git unavailable: do not claim setup is missing.
  }
  const summaries: Readonly<Record<string, string>> = {
    "agent-setup": "Agent instructions found",
    docs: "Documentation found",
    naming: "Project vocabulary found",
    "git-github": facts.get("git-github")?.has("Git repository initialized")
      ? "Git initialized"
      : "Ignore file found",
    "quality-tools": "Tools or configuration detected",
    tests: "Test setup found",
    ci: "CI configuration found",
    "commit-gate": "Commit check configuration found",
    dependencies: "Lockfile found",
    "build-release": "Build or release setup found",
  };
  for (const id of [...facts.keys()].sort()) {
    const lines = facts.get(id);
    if (lines?.size)
      items[id] = { summary: summaries[id] ?? "Setup detected", facts: [...lines].sort() };
  }
  log("INFO", "checklist", "Detected project setup", {
    cwd: root,
    detectedItems: Object.keys(items).length,
    elapsedMs: Date.now() - started,
  });
  return { items, warnings: [...warnings].sort() };
}
