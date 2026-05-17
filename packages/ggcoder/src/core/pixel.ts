import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import {
  DEFAULT_INGEST_URL,
  install,
  isInstallProbeFingerprint,
  verifyInstall,
  type VerifyOutcome,
} from "@kenkaiiii/gg-pixel";

interface ProjectMapping {
  name: string;
  path: string;
  /** Bearer secret for /api/* calls. Missing on legacy entries — those projects
   *  can't be queried until they're re-installed. */
  secret?: string;
}

interface ErrorRow {
  id: string;
  fingerprint: string;
  status: string;
  type: string | null;
  message: string | null;
  stack: string | null;
  occurrences: number;
  recurrence_count: number;
  last_seen_at: number;
  branch: string | null;
}

interface ListOptions {
  ingestUrl?: string;
  homeDir?: string;
  fetchFn?: typeof fetch;
}

export interface PixelEntry {
  errorId: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  status: string;
  type: string;
  message: string;
  occurrences: number;
  recurrenceCount: number;
  location: string;
  branch: string | null;
  lastSeenAt?: number;
}

export interface PixelFetchResult {
  entries: PixelEntry[];
  unreachable: string[];
  /** Project names that exist in projects.json but are missing the bearer
   *  secret — they need to be re-installed before they can be managed. */
  unmanaged: string[];
  hasProjects: boolean;
}

export async function fetchPixelEntries(opts: ListOptions = {}): Promise<PixelFetchResult> {
  const home = opts.homeDir ?? homedir();
  const path = join(home, ".gg", "projects.json");
  const fetchFn = opts.fetchFn ?? fetch;

  if (!existsSync(path)) return { entries: [], unreachable: [], unmanaged: [], hasProjects: false };

  let map: Record<string, ProjectMapping>;
  try {
    map = JSON.parse(readFileSync(path, "utf8")) as Record<string, ProjectMapping>;
  } catch {
    return { entries: [], unreachable: [], unmanaged: [], hasProjects: false };
  }

  const projectIds = Object.keys(map);
  if (projectIds.length === 0)
    return { entries: [], unreachable: [], unmanaged: [], hasProjects: false };

  const ingestUrl = (opts.ingestUrl ?? DEFAULT_INGEST_URL).replace(/\/+$/, "");
  const entries: PixelEntry[] = [];
  const unreachable: string[] = [];
  const unmanaged: string[] = [];

  for (const id of projectIds) {
    const project = map[id];
    if (!project) continue;
    if (!project.secret) {
      unmanaged.push(project.name);
      continue;
    }
    try {
      const res = await fetchFn(`${ingestUrl}/api/projects/${id}/errors`, {
        headers: { authorization: `Bearer ${project.secret}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 401) {
        console.warn(
          chalk.hex("#fbbf24")(
            `⚠ 401 for project ${project.name} — secret may need refresh. Run \`ggcoder pixel install\` to refresh.`,
          ),
        );
        unreachable.push(project.name);
        continue;
      }
      if (!res.ok) {
        unreachable.push(project.name);
        continue;
      }
      const body = (await res.json()) as { errors: ErrorRow[] };
      for (const err of body.errors) {
        if (err.status === "merged") continue;
        // Hide install-verification probes from the overlay even if the
        // probe-cleanup DELETE didn't land (network blip, etc.).
        if (isInstallProbeFingerprint(err.fingerprint)) continue;
        entries.push({
          errorId: err.id,
          projectId: id,
          projectName: project.name,
          projectPath: project.path,
          status: err.status,
          type: err.type ?? "Error",
          message: (err.message ?? "").trim(),
          occurrences: err.occurrences,
          recurrenceCount: err.recurrence_count,
          location: deriveLocation(err.stack, project.path),
          branch: err.branch,
          lastSeenAt: err.last_seen_at,
        });
      }
    } catch {
      unreachable.push(project.name);
    }
  }

  // Group by project name; within project, order by status priority then count.
  const statusOrder: Record<string, number> = {
    failed: 0,
    open: 1,
    in_progress: 2,
    awaiting_review: 3,
  };
  const grouped = new Map<string, PixelEntry[]>();
  for (const e of entries) {
    if (!grouped.has(e.projectName)) grouped.set(e.projectName, []);
    grouped.get(e.projectName)!.push(e);
  }
  const sorted: PixelEntry[] = [];
  const projectNames = [...grouped.keys()].sort();
  for (const name of projectNames) {
    const group = grouped.get(name)!;
    group.sort((a, b) => {
      const ord = (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
      if (ord !== 0) return ord;
      if (a.recurrenceCount !== b.recurrenceCount) return b.recurrenceCount - a.recurrenceCount;
      return b.occurrences - a.occurrences;
    });
    sorted.push(...group);
  }

  return { entries: sorted, unreachable, unmanaged, hasProjects: true };
}

function deriveLocation(stack: string | null, projectPath?: string): string {
  if (!stack) return "unknown";
  try {
    const parsed = JSON.parse(stack) as unknown;
    if (Array.isArray(parsed)) {
      const top =
        parsed.find(
          (f): f is { file: string; line: number; in_app: boolean } =>
            typeof f === "object" &&
            f !== null &&
            "file" in f &&
            "line" in f &&
            "in_app" in f &&
            (f as { in_app: boolean }).in_app === true,
        ) ?? (parsed[0] as { file?: string; line?: number } | undefined);
      if (top && top.file) {
        const rel = relativizeFile(top.file, projectPath);
        return `${rel}:${top.line ?? "?"}`;
      }
    }
  } catch {
    // ignore
  }
  return "unknown";
}

function relativizeFile(file: string, projectPath?: string): string {
  let f = file;
  if (f.startsWith("file://")) f = f.slice("file://".length);
  if (projectPath && f.startsWith(projectPath + "/")) f = f.slice(projectPath.length + 1);
  return f;
}

export async function listAllErrors(opts: ListOptions = {}): Promise<void> {
  const home = opts.homeDir ?? homedir();
  const path = join(home, ".gg", "projects.json");
  const fetchFn = opts.fetchFn ?? fetch;

  if (!existsSync(path)) {
    printNoProjects();
    return;
  }

  let map: Record<string, ProjectMapping>;
  try {
    map = JSON.parse(readFileSync(path, "utf8")) as Record<string, ProjectMapping>;
  } catch {
    console.error(chalk.red(`✗ ${path} is not valid JSON.`));
    process.exitCode = 1;
    return;
  }

  const projectIds = Object.keys(map);
  if (projectIds.length === 0) {
    printNoProjects();
    return;
  }

  const ingestUrl = (opts.ingestUrl ?? DEFAULT_INGEST_URL).replace(/\/+$/, "");

  let totalOpen = 0;
  let totalAwaiting = 0;
  let totalInProgress = 0;
  let totalFailed = 0;

  for (const id of projectIds) {
    const project = map[id];
    if (!project) continue;
    const url = `${ingestUrl}/api/projects/${id}/errors`;

    if (!project.secret) {
      console.log(
        chalk.hex("#fbbf24")(
          `⚠ ${project.name}: missing bearer secret — re-run \`ggcoder pixel install\` to refresh management access`,
        ),
      );
      continue;
    }

    let body: { errors: ErrorRow[] };
    try {
      const res = await fetchFn(url, {
        headers: { authorization: `Bearer ${project.secret}` },
      });
      if (!res.ok) {
        console.log(
          chalk.red(`✗ ${project.name}: failed to fetch (${res.status})`) + chalk.dim(`  ${url}`),
        );
        continue;
      }
      body = (await res.json()) as { errors: ErrorRow[] };
    } catch (err) {
      console.log(
        chalk.red(`✗ ${project.name}: ${err instanceof Error ? err.message : String(err)}`),
      );
      continue;
    }

    const errors = body.errors.filter(
      (e) => e.status !== "merged" && !isInstallProbeFingerprint(e.fingerprint),
    );
    if (errors.length === 0) {
      console.log(chalk.hex("#4ade80")(`✓ ${project.name}`) + chalk.dim("  no open errors"));
      continue;
    }

    console.log("");
    console.log(chalk.hex("#a78bfa").bold(`▾ ${project.name}`) + chalk.dim(`  ${project.path}`));

    for (const err of errors) {
      switch (err.status) {
        case "open":
          totalOpen++;
          break;
        case "in_progress":
          totalInProgress++;
          break;
        case "awaiting_review":
          totalAwaiting++;
          break;
        case "failed":
          totalFailed++;
          break;
      }
      printError(err);
    }
  }

  printSummary(totalOpen, totalInProgress, totalAwaiting, totalFailed, projectIds.length);
}

function printError(err: ErrorRow): void {
  const stack = parseStack(err.stack);
  const topInApp = stack.find((f) => f.in_app) ?? stack[0];
  const loc = topInApp ? `${topInApp.file}:${topInApp.line}` : "unknown location";

  const statusBadge = badgeFor(err.status);
  const message = (err.message ?? "").trim().slice(0, 100);
  const recurrence =
    err.recurrence_count > 0 ? chalk.hex("#fbbf24")(` ↻${err.recurrence_count}`) : "";

  console.log(
    "  " +
      statusBadge +
      "  " +
      chalk.bold(err.type ?? "Error") +
      chalk.dim(`  ×${err.occurrences}`) +
      recurrence,
  );
  if (message) console.log("    " + chalk.hex("#cbd5e1")(message));
  console.log("    " + chalk.dim(loc));
  if (err.branch) console.log("    " + chalk.dim(`branch: ${err.branch}`));
}

function badgeFor(status: string): string {
  const labels: Record<string, string> = {
    open: chalk.bgHex("#dc2626").white(" OPEN "),
    in_progress: chalk.bgHex("#2563eb").white(" WORKING "),
    awaiting_review: chalk.bgHex("#eab308").black(" REVIEW "),
    failed: chalk.bgHex("#7f1d1d").white(" FAILED "),
  };
  return labels[status] ?? chalk.bgHex("#374151").white(` ${status.toUpperCase()} `);
}

function parseStack(raw: string | null): Array<{ file: string; line: number; in_app: boolean }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (f): f is { file: string; line: number; in_app: boolean } =>
          typeof f === "object" && f !== null && "file" in f && "line" in f && "in_app" in f,
      );
    }
  } catch {
    // ignore
  }
  return [];
}

function printNoProjects(): void {
  console.log("");
  console.log(chalk.dim("No projects registered yet."));
  console.log("");
  console.log(
    "Run " +
      chalk.hex("#60a5fa").bold("ggcoder pixel install") +
      " inside any project to wire it up.",
  );
  console.log("");
}

function printSummary(
  open: number,
  inProgress: number,
  awaiting: number,
  failed: number,
  projectCount: number,
): void {
  const total = open + inProgress + awaiting + failed;
  console.log("");
  if (total === 0) {
    console.log(chalk.hex("#4ade80")(`All clean across ${plural(projectCount, "project")}.`));
    console.log("");
    return;
  }
  const parts: string[] = [];
  if (open) parts.push(chalk.hex("#ef4444")(`${open} open`));
  if (inProgress) parts.push(chalk.hex("#60a5fa")(`${inProgress} working`));
  if (awaiting) parts.push(chalk.hex("#eab308")(`${awaiting} awaiting review`));
  if (failed) parts.push(chalk.hex("#7f1d1d")(`${failed} failed`));
  console.log(
    parts.join(chalk.dim(" · ")) + chalk.dim(`  across ${plural(projectCount, "project")}`),
  );
  console.log("");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

interface InstallCliOptions {
  ingestUrl?: string;
  name?: string;
  skipPackageInstall: boolean;
}

export async function runPixelInstall(opts: InstallCliOptions): Promise<void> {
  const result = await install({
    ingestUrl: opts.ingestUrl,
    projectName: opts.name,
    skipPackageInstall: opts.skipPackageInstall,
  });

  console.log("");
  console.log(
    chalk
      .hex("#4ade80")
      .bold(result.reused ? "Pixel re-wired (existing project)." : "Pixel installed."),
  );
  console.log(
    chalk.dim(`  Project:   `) + result.projectName + chalk.dim(`  (${result.projectId})`),
  );
  console.log(chalk.dim(`  Kind:      `) + result.projectKind);
  console.log(chalk.dim(`  Init file: `) + result.initFilePath);
  console.log(chalk.dim(`  Env file:  `) + result.envFilePath);
  console.log(chalk.dim(`  Mapping:   `) + result.projectsJsonPath);
  switch (result.entryWiring.kind) {
    case "injected":
      console.log(chalk.dim(`  Wired:     `) + result.entryWiring.entryPath);
      break;
    case "already_present":
      console.log(
        chalk.dim(`  Entry:     `) + result.entryWiring.entryPath + chalk.dim("  (already wired)"),
      );
      break;
    case "no_entry_found":
      console.log(chalk.hex("#fbbf24")(`  ⚠  Could not auto-detect your entry file.`));
      console.log(chalk.dim(`     Add to the TOP of your entry: `));
      console.log("       " + chalk.hex("#60a5fa")(`import "./gg-pixel.init.mjs";`));
      break;
    case "skipped":
      console.log(chalk.hex("#fbbf24")(`  ⚠  Entry wiring skipped: ${result.entryWiring.reason}`));
      break;
  }
  if (!result.packageInstalled && !opts.skipPackageInstall) {
    console.log(
      chalk.hex("#fbbf24")(
        `  ⚠  Package install via ${result.packageManager} failed. Run it manually.`,
      ),
    );
  }
  if (result.secondaryInit) {
    console.log(chalk.dim(`  Also wrote: `) + result.secondaryInit.path);
    console.log(chalk.dim(`              `) + chalk.dim(result.secondaryInit.description));
  }
  for (const w of result.warnings) {
    console.log(chalk.hex("#fbbf24")(`  ⚠  ${w}`));
  }
  console.log("");

  await runVerification(result, opts.ingestUrl);
  console.log("");
}

/**
 * Fires a synthetic event end-to-end and waits for it to round-trip through
 * D1. Catches the silent-failure modes that wiring alone can't (stale env,
 * sandboxed renderer, missing dotenv, broken `node_modules`, etc.).
 */
async function runVerification(
  result: {
    projectId: string;
    projectKey: string;
    projectSecret: string;
    projectKind: string;
    projectRoot: string;
  },
  ingestUrl: string | undefined,
): Promise<void> {
  if (!canVerify(result.projectKind)) {
    // Non-JS kinds (python/go/ruby) have their own SDKs; verification path
    // doesn't apply yet. Print a one-line note instead of leaving silence.
    console.log(chalk.dim("  Verification skipped — not implemented for ") + result.projectKind);
    return;
  }
  console.log(chalk.dim("  Verifying install…"));
  const ingest = (ingestUrl ?? DEFAULT_INGEST_URL).replace(/\/+$/, "");
  let outcome: VerifyOutcome;
  try {
    outcome = await verifyInstall({
      projectId: result.projectId,
      projectKey: result.projectKey,
      projectSecret: result.projectSecret,
      ingestUrl: ingest,
      projectRoot: result.projectRoot,
      // React Native's runtime isn't Node, so don't try to spawn a Node child
      // there — but still attempt direct ingest so we at least confirm the
      // server side of the wiring.
      skipChildProbe: result.projectKind === "react-native",
    });
  } catch (err) {
    console.log(
      chalk.hex("#ef4444")(
        `  ✗ Verification crashed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return;
  }

  if (outcome.kind === "ok") {
    const via = outcome.method === "child_process" ? "via spawned probe" : "via direct ingest";
    console.log(
      chalk.hex("#4ade80")(`  ✓ Pixel verified end-to-end`) +
        chalk.dim(` (${outcome.latencyMs}ms ${via})`),
    );
  } else {
    console.log(chalk.hex("#ef4444")(`  ✗ Verification failed: ${outcome.reason}`));
    if (outcome.hint) {
      console.log(chalk.dim(`    hint: ${outcome.hint}`));
    }
    console.log(
      chalk.dim(
        `    The install files are written, but no event arrived at the backend. Inspect the project's runtime to see why.`,
      ),
    );
  }
}

function canVerify(kind: string): boolean {
  // Python/Go/Ruby SDKs have their own probe paths; not wiring them through
  // the JS verifier yet. Everything else (browser, node, hybrid frameworks,
  // electron, even react-native) gets the round-trip check.
  return kind !== "python" && kind !== "go" && kind !== "ruby";
}
