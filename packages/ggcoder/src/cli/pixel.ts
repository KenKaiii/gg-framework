import chalk from "chalk";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { loadSavedSettings } from "../config.js";
import { getDefaultModel } from "../core/model-registry.js";
import type { ThemeName } from "../ui/theme/theme.js";

/** Options accepted by the Ink TUI launcher injected into the pixel command. */
export interface RunInkTUIOptions {
  provider: Provider;
  model: string;
  cwd: string;
  thinkingLevel?: ThinkingLevel;
  continueRecent?: boolean;
  resumeSessionPath?: string;
  theme?: "auto" | ThemeName;
  initialOverlay?: "pixel";
}

/** Dependencies the pixel command needs from the CLI entry point. */
export interface PixelCommandDeps {
  runInkTUI: (opts: RunInkTUIOptions) => Promise<void>;
}

interface ParsedInstall {
  ingestUrl?: string;
  name?: string;
  skipPackageInstall: boolean;
}

function defaultModelFor(p: Provider): string {
  return getDefaultModel(p).id;
}

export function parsePixelInstallArgs(args: string[]): ParsedInstall {
  const out: ParsedInstall = { skipPackageInstall: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--ingest-url") out.ingestUrl = args[++i];
    else if (a === "--name") out.name = args[++i];
    else if (a === "--skip-install") out.skipPackageInstall = true;
  }
  return out;
}

export function printPixelHelp(): void {
  console.log(`ggcoder pixel — error tracking + auto-fix queue

Usage:
  ggcoder pixel                  List open errors across every registered project
  ggcoder pixel install          Register the current project and wire up the SDK
  ggcoder pixel fix <error_id>   Fix one specific error end-to-end
  ggcoder pixel run              Auto-fix every open error across all projects

  ggcoder pixel install --name <name>      Override the project name
  ggcoder pixel install --ingest-url <url> Use a custom backend URL
  ggcoder pixel install --skip-install     Don't run the package manager
`);
}

export async function runPixel(deps: PixelCommandDeps): Promise<void> {
  const sub = process.argv[3];
  const rest = process.argv.slice(4);

  if (sub === "install") {
    const { runPixelInstall } = await import("../core/pixel.js");
    const opts = parsePixelInstallArgs(rest);
    await runPixelInstall(opts);
    return;
  }

  if (sub === "fix") {
    const errorId = rest[0];
    if (!errorId) {
      process.stderr.write("Usage: ggcoder pixel fix <error_id>\n");
      process.exit(1);
    }
    const { fixError } = await import("../core/pixel-fix.js");
    const result = await fixError(errorId);
    if (result.outcome === "awaiting_review") {
      console.log(chalk.hex("#4ade80")(`✓ ${result.reason}`));
    } else {
      console.log(chalk.hex("#ef4444")(`✗ ${result.reason}`));
      process.exit(1);
    }
    return;
  }

  if (sub === "run") {
    const { runQueue } = await import("../core/pixel-fix.js");
    const result = await runQueue();
    console.log(
      chalk.bold(`${result.fixed} fixed · ${result.failed} failed · ${result.total} total`),
    );
    if (result.failed > 0) process.exit(1);
    return;
  }

  if (sub === "--help" || sub === "-h") {
    printPixelHelp();
    return;
  }

  if (sub === "list") {
    const { listAllErrors } = await import("../core/pixel.js");
    await listAllErrors();
    return;
  }

  if (sub) {
    process.stderr.write(`Unknown pixel subcommand: ${sub}\n`);
    printPixelHelp();
    process.exit(1);
  }

  // No subcommand → launch the Ink TUI with the pixel overlay open. The fix
  // flow runs through the same agent loop, streaming live in the chat instead
  // of spawning a subprocess.
  // Non-TTY (CI, piped) → fall back to text list.
  if (!process.stdin.isTTY) {
    const { listAllErrors } = await import("../core/pixel.js");
    await listAllErrors();
    return;
  }

  const saved = loadSavedSettings();
  const provider: Provider = saved.provider ?? "anthropic";
  const model: string = saved.model ?? defaultModelFor(provider);
  await deps.runInkTUI({
    provider,
    model,
    cwd: process.cwd(),
    thinkingLevel: saved.thinkingEnabled ? (saved.thinkingLevel ?? "medium") : undefined,
    theme: saved.theme,
    initialOverlay: "pixel",
  });
}
