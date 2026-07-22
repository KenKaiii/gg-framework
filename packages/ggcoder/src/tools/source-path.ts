import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { log } from "../core/logger.js";

const SOURCE_PATH_TIMEOUT_MS = 120_000;
const MAX_STDERR_CHARS = 10_000;
const OPENSRC_BIN_ENV = "GG_CODER_OPENSRC_BIN";

const SourcePathParams = z.object({
  package: z
    .string()
    .min(1)
    .describe(
      "Package, repo, or registry spec to fetch (e.g. zod, zod@3.22.0, pypi:requests, crates:serde, vercel/next.js)",
    ),
  verbose: z.boolean().optional().describe("Show opensrc fetch progress in the tool result"),
});

export function createSourcePathTool(cwd: string): AgentTool<typeof SourcePathParams> {
  return {
    name: "source_path",
    description:
      "Resolve a package or repository to its cached source-code path using opensrc. " +
      "For npm packages, lockfiles in the current project determine the installed version unless a version is specified. " +
      "Use this before assuming dependency APIs or framework internals; then inspect the returned path with read, grep, find, or ls.",
    parameters: SourcePathParams,
    async execute(args, context) {
      const startTime = Date.now();
      const opensrcBin = getBundledOpenSrcBinPath();
      const cliArgs = ["path", args.package, "--cwd", cwd];
      if (args.verbose === true) cliArgs.push("--verbose");

      log("INFO", "source_path", "opensrc path start", { package: args.package, cwd });

      return new Promise<string>((resolve) => {
        const child = spawn(process.execPath, [opensrcBin, ...cliArgs], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: getOpenSrcEnv(),
        });

        let stdout = "";
        let stderr = "";
        let settled = false;

        const finish = (message: string): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          context.signal.removeEventListener("abort", onAbort);
          resolve(message);
        };

        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          finish(
            `Error: opensrc timed out after ${SOURCE_PATH_TIMEOUT_MS}ms while resolving ${args.package}.`,
          );
        }, SOURCE_PATH_TIMEOUT_MS);

        const onAbort = (): void => {
          child.kill("SIGTERM");
          finish(`Error: source_path was aborted while resolving ${args.package}.`);
        };
        context.signal.addEventListener("abort", onAbort, { once: true });
        if (context.signal.aborted) onAbort();

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf-8");
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderr.length >= MAX_STDERR_CHARS) return;
          stderr += chunk.toString("utf-8");
          if (stderr.length > MAX_STDERR_CHARS) stderr = stderr.slice(0, MAX_STDERR_CHARS);
        });

        child.on("error", (error) => {
          log("ERROR", "source_path", "opensrc spawn failed", {
            package: args.package,
            error: error.message,
          });
          finish(
            `Error: could not run bundled opensrc for ${args.package}: ${error.message}. ` +
              "Try installing ggcoder again or run `npm install -g opensrc`.",
          );
        });

        child.on("close", (code) => {
          const durationMs = Date.now() - startTime;
          log(code === 0 ? "INFO" : "WARN", "source_path", "opensrc path done", {
            package: args.package,
            exitCode: String(code ?? 1),
            durationMs: String(durationMs),
          });

          if (code !== 0) {
            finish(
              `Error: opensrc failed for ${args.package} (exit ${code ?? 1}).\n` +
                `${stderr.trim() || stdout.trim() || "No output."}`,
            );
            return;
          }

          const lines = stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          const sourcePath = lines.at(-1);
          if (!sourcePath) {
            finish(`Error: opensrc returned no source path for ${args.package}.`);
            return;
          }

          const progress =
            args.verbose === true && lines.length > 1 ? lines.slice(0, -1).join("\n") : "";
          const pathLine = `Source path: ${sourcePath}`;
          const nextSteps =
            "Use read, grep, find, or ls with this absolute path to inspect the dependency source.";
          finish(progress ? `${progress}\n${pathLine}\n${nextSteps}` : `${pathLine}\n${nextSteps}`);
        });
      });
    },
  };
}

function getBundledOpenSrcBinPath(): string {
  const override = process.env[OPENSRC_BIN_ENV]?.trim();
  if (override) return override;

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  // In the desktop esbuild bundle this module lives at sidecar/app-sidecar.mjs
  // and copied externals live directly under sidecar/node_modules. In the npm
  // package it lives at dist/tools/source-path.js, two levels below the package
  // root. Probe both layouts instead of assuming the npm layout — that old
  // assumption escaped the app sandbox and resolved under Contents/node_modules.
  const bundledAppBin = path.join(currentDir, "node_modules", "opensrc", "bin", "opensrc.js");
  if (existsSync(bundledAppBin)) return bundledAppBin;
  return path.resolve(currentDir, "../../node_modules/opensrc/bin/opensrc.js");
}

function getOpenSrcEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TERM: process.env.TERM ?? "dumb",
  };
}
