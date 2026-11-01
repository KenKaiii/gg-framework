// `steroids` tool — Agent Steroids' local corpus of real repos, wrapped as one
// native tool with an `action` discriminator. Every action is an argv array
// through execFile (never a shell string); the CLI's own JSON error shape
// (`{"error"}` on stdout, exit 1) becomes the tool error.
import { execFile } from "node:child_process";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { steroidsEnv } from "../core/steroids.js";

const TIMEOUT_MS = 30_000;
/** discover/recent hit GitHub; give them longer. */
const NETWORK_TIMEOUT_MS = 60_000;
/** add downloads whole repos; a batch of ten can take minutes. */
const INGEST_TIMEOUT_MS = 10 * 60_000;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const MAX_STDOUT = 1024 * 1024;

const SteroidsParams = z.object({
  action: z
    .enum(["search", "define", "show", "files", "repos", "discover", "recent", "add"])
    .describe("Which corpus query to run"),
  pattern: z.string().optional().describe("search: regex (or literal with fixed=true)"),
  fixed: z.boolean().optional().describe("search: match pattern literally"),
  symbol: z.string().optional().describe("define: function/class/constant name"),
  query: z.string().optional().describe("discover: 'topic:X language:Y' or 2-3 keywords"),
  repo: z
    .string()
    .optional()
    .describe("owner/name (search/recent filter; required for show/files)"),
  path: z.string().optional().describe("show: file path; search: glob or prefix"),
  language: z.string().optional().describe("search/define/discover: language name or alias"),
  tag: z.string().optional().describe("Only repos carrying this label"),
  limit: z.number().int().positive().optional(),
  perRepo: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("search: max hits per repo (1 = breadth)"),
  context: z.number().int().min(0).optional().describe("search: lines either side of a match"),
  includeComments: z.boolean().optional().describe("search: also match inside comments"),
  from: z.number().int().positive().optional().describe("show: first line (1-based)"),
  to: z.number().int().positive().optional().describe("show: last line"),
  hours: z.number().int().positive().optional().describe("recent: look-back window (default 72)"),
  add: z.boolean().optional().describe("discover: index everything found (ask the user first)"),
  repos: z.array(z.string()).optional().describe("add: owner/name list (after the user agrees)"),
  maxTokens: z.number().int().positive().optional().describe("Output budget (default 6000)"),
});
type Params = z.infer<typeof SteroidsParams>;

class ArgError extends Error {}

function need(v: string | undefined, name: string, action: string): string {
  if (!v) throw new ArgError(`${action} requires \`${name}\``);
  return v;
}

/** Build the CLI argv for one action. Exported for tests; pure. */
export function buildSteroidsArgs(a: Params): string[] {
  const args: string[] = [a.action];
  // Positionals go LAST behind `--` so a pattern like `-foo` is never read as a flag.
  const positional: string[] = [];
  const flag = (name: string, v: string | number | undefined): void => {
    if (v !== undefined) args.push(`--${name}`, String(v));
  };
  switch (a.action) {
    case "search":
      if (a.fixed) args.push("-F");
      positional.push(need(a.pattern, "pattern", a.action));
      flag("repo", a.repo);
      flag("language", a.language);
      flag("path", a.path);
      flag("tag", a.tag);
      flag("limit", a.limit);
      flag("per-repo", a.perRepo);
      flag("context", a.context);
      if (a.includeComments) args.push("--include-comments");
      break;
    case "define":
      // The CLI has no --repo for define; dropping it silently returned
      // matches from unrelated repos. Fail loudly with the working alternative.
      if (a.repo) {
        throw new ArgError(
          `define has no repo filter. Use search with repo="${a.repo}" and a definition pattern instead, e.g. pattern="^type ${a.symbol ?? "Name"}\\b"`,
        );
      }
      positional.push(need(a.symbol, "symbol", a.action));
      flag("language", a.language);
      flag("tag", a.tag);
      flag("limit", a.limit);
      break;
    case "show":
      positional.push(need(a.repo, "repo", a.action), need(a.path, "path", a.action));
      flag("from", a.from);
      flag("to", a.to);
      flag("limit", a.limit);
      break;
    case "files":
      positional.push(need(a.repo, "repo", a.action));
      flag("limit", a.limit);
      break;
    case "repos":
      flag("tag", a.tag);
      flag("limit", a.limit);
      break;
    case "discover":
      if (a.add) args.push("--add");
      flag("language", a.language);
      flag("tag", a.tag);
      flag("limit", a.limit);
      positional.push(need(a.query, "query", a.action));
      break;
    case "recent":
      flag("tag", a.tag);
      flag("repo", a.repo);
      flag("hours", a.hours);
      flag("limit", a.limit);
      break;
    case "add": {
      const repos = a.repos ?? [];
      if (repos.length === 0) throw new ArgError("add requires `repos`");
      const bad = repos.find((r) => !REPO_NAME.test(r));
      if (bad) throw new ArgError(`add: not an owner/name repository: ${bad}`);
      flag("tag", a.tag);
      positional.push(...repos);
      break;
    }
  }
  if (a.action === "search" || a.action === "define") flag("max-tokens", a.maxTokens);
  // `add` reports progress as plain text; every other action speaks JSON.
  if (a.action !== "add") args.push("--json");
  if (positional.length > 0) args.push("--", ...positional);
  return args;
}

const DESCRIPTION = `Read real open-source code from a local corpus when local evidence leaves an API, design choice or risk unresolved. Search literal tokens, then show matches; reuse examples already read. Offline, no limits.
- search: regex across all repos (fixed=true literal); filter repo/language/path/tag; perRepo=1 for breadth.
- define: symbol definition corpus-wide (no repo filter; ts/js/py/go/rust/java). Otherwise search with repo + a definition pattern.
- show: read a file (from/to; search gives line numbers). files: one repo's files. repos: indexed repos (tag/limit).
- discover: find GitHub repos; query 'topic:X language:Y' or 2-3 keywords (4+ words finds nothing). found=0: retry once with 2 words or topic:. add=true indexes all found (ask the user first).
- add: index chosen repos (owner/name); on an indexed repo, re-fetches latest. Rows marked STALE (>7 days): refresh with add before relying on them, no need to ask; only NEW repos need the user's agreement.
- recent: upstream changes in the last N hours.
repo/language are case-insensitive; a path without globs is a prefix. \`omitted\` = cut by maxTokens; \`more_available\` = narrow the query.
Topic not covered = corpus gap, not a bad query: don't retry variants; discover, propose repos, add once the user agrees.`;

interface RepoRow {
  repo: string;
  language?: string;
  files?: number;
  last_commit?: string;
  indexed_at?: string;
  tags?: string[];
}

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `repos --json` is ~370 bytes per repo (commit, byte counts, url, ...); a
 * 400-repo corpus came back as 160 KB and blew the tool-result cap. One line
 * per repo keeps the whole list readable.
 */
export function compactRepos(json: string, now: number = Date.now()): string {
  let parsed: { count?: number; repositories?: RepoRow[] };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return json;
  }
  const rows = parsed.repositories ?? [];
  let stale = 0;
  const lines = rows.map((r) => {
    const tags = r.tags?.length ? ` [${r.tags.join(",")}]` : "";
    const indexed = r.indexed_at ? Date.parse(r.indexed_at) : NaN;
    let age = "";
    if (Number.isFinite(indexed)) {
      const days = Math.max(0, Math.floor((now - indexed) / 86_400_000));
      const isStale = now - indexed > STALE_AFTER_MS;
      if (isStale) stale++;
      age = `  indexed ${days}d ago${isStale ? " STALE" : ""}`;
    }
    return `${r.repo}  ${r.language ?? "?"}  ${r.files ?? "?"} files  ${r.last_commit ?? ""}${age}${tags}`;
  });
  const staleNote = stale > 0 ? `, ${stale} STALE (refresh with add before relying on them)` : "";
  return [
    `${parsed.count ?? rows.length} repos indexed, ${rows.length} shown${staleNote}`,
    ...lines,
  ].join("\n");
}

// Indexing (`add`, `discover --add`) is deliberately NOT gated on plan mode:
// it writes to the corpus, not the workspace, and the prompt requires user
// approval of the repo list first. A plan needs the corpus filled to be a
// plan from real code rather than memory.
export function createSteroidsTool(bin: string): AgentTool<typeof SteroidsParams> {
  return {
    name: "steroids",
    description: DESCRIPTION,
    parameters: SteroidsParams,
    async execute(args, context) {
      const indexes = args.action === "add" || (args.action === "discover" && args.add);
      let argv: string[];
      try {
        argv = buildSteroidsArgs(args);
      } catch (err) {
        if (err instanceof ArgError) return `Error: ${err.message}`;
        throw err;
      }
      const timeout = indexes
        ? INGEST_TIMEOUT_MS
        : args.action === "discover" || args.action === "recent"
          ? NETWORK_TIMEOUT_MS
          : TIMEOUT_MS;
      return new Promise<string>((resolve) => {
        execFile(
          bin,
          argv,
          {
            env: steroidsEnv(),
            timeout,
            maxBuffer: MAX_STDOUT,
            windowsHide: true,
            signal: context.signal,
          },
          (err, stdout, stderr) => {
            const out = String(stdout).trim();
            if (err) {
              // The CLI reports failures as {"error": "..."} on stdout, exit 1.
              try {
                const parsed = JSON.parse(out) as { error?: unknown };
                if (typeof parsed.error === "string") {
                  resolve(`Error: ${parsed.error}`);
                  return;
                }
              } catch {
                /* not JSON — fall through to stderr */
              }
              const line = String(stderr).trim().split("\n")[0] || err.message;
              resolve(`Error: steroids ${args.action} failed: ${line}`);
              return;
            }
            resolve((args.action === "repos" ? compactRepos(out) : out) || "(no output)");
          },
        );
      });
    },
  };
}
