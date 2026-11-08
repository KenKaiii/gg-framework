// `steroids` tool — Agent Steroids' local corpus of real repos, wrapped as one
// native tool with an `action` discriminator. Every action is an argv array
// through execFile (never a shell string). Reads come back as the CLI's text
// (line-numbered, and smaller than its JSON); a failure becomes the tool error.
import { execFile } from "node:child_process";
import { z } from "zod";
import type { AgentTool } from "@kleio/agent";
import { steroidsEnv } from "../core/steroids.js";

const TIMEOUT_MS = 30_000;
/** discover/recent hit GitHub; give them longer. */
const NETWORK_TIMEOUT_MS = 60_000;
/** add downloads whole repos; a batch of ten can take minutes. */
const INGEST_TIMEOUT_MS = 10 * 60_000;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const MAX_STDOUT = 1024 * 1024;

// Highest output budget a call may ask for. A search above it is mostly
// matches the model never reads, so it is capped low; a read the model chose
// (symbols) may run to steroids' own 16,000-character ceiling, because cutting
// it short only sends the model back for the rest; ranges stop at 6,000.
const MAX_TOKENS = { search: 1500, read: 4000 };

const SteroidsParams = z.object({
  action: z
    .enum(["search", "define", "show", "changes", "files", "repos", "discover", "recent", "add"])
    .describe("Which corpus query to run"),
  pattern: z
    .string()
    .optional()
    .describe("search: regex (or literal with fixed=true); changes: only the items it matches"),
  fixed: z.boolean().optional().describe("search: match pattern literally"),
  symbol: z
    .string()
    .optional()
    .describe("define: a name, or several comma-separated (forEach,isPlainObject)"),
  version: z.string().optional().describe("changes: release to show, e.g. 1.21.0 (default latest)"),
  full: z
    .boolean()
    .optional()
    .describe(
      "show: from the top instead of the outline, 6,000 chars at a time (outline then symbols reads less); changes: the whole entry",
    ),
  query: z.string().optional().describe("discover: 'topic:X language:Y' or 2-3 keywords"),
  repo: z
    .string()
    .optional()
    .describe(
      "owner/name: search/define/recent filter; required for show/files; repos: part of a name",
    ),
  path: z.string().optional().describe("show: file path; search/define/files: glob or prefix"),
  symbols: z.array(z.string()).optional().describe("show: print only these definitions' bodies"),
  outline: z
    .boolean()
    .optional()
    .describe("show: only what the file declares (tests: cases + assertions)"),
  noComments: z.boolean().optional().describe("show: drop comments and blank lines"),
  language: z.string().optional().describe("search/define/discover: language name or alias"),
  tag: z.string().optional().describe("Only repos carrying this label"),
  limit: z.number().int().positive().optional(),
  perRepo: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("search: max hits per repo (1 = breadth)"),
  context: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("search: lines either side of each match; unset, 10+ matches come one line each"),
  includeComments: z.boolean().optional().describe("search: also match inside comments"),
  from: z.number().int().positive().optional().describe("show: first line (1-based)"),
  to: z.number().int().positive().optional().describe("show: last line"),
  hours: z.number().int().positive().optional().describe("recent: look-back window (default 72)"),
  add: z.boolean().optional().describe("discover: index everything found (ask the user first)"),
  repos: z.array(z.string()).optional().describe("add: owner/name list (after the user agrees)"),
  maxTokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Output ceiling: search at most ${MAX_TOKENS.search}, other reads ${MAX_TOKENS.read}. Narrow instead of raising it`,
    ),
});
type Params = z.infer<typeof SteroidsParams>;

class ArgError extends Error {}

const JSON_ACTIONS = new Set<Params["action"]>(["repos", "discover", "recent"]);

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
      positional.push(need(a.symbol, "symbol", a.action));
      flag("repo", a.repo);
      flag("path", a.path);
      flag("language", a.language);
      flag("tag", a.tag);
      flag("limit", a.limit);
      break;
    case "show": {
      positional.push(need(a.repo, "repo", a.action), need(a.path, "path", a.action));
      const symbols = (a.symbols ?? []).map((s) => s.trim()).filter(Boolean);
      if (symbols.length > 0) flag("symbols", symbols.join(","));
      else {
        if (a.outline) args.push("--outline");
        // A range is already the lines asked for; `full` only matters for a
        // plain read, where it means "from the top, not the outline".
        else if (a.full && a.from === undefined && a.to === undefined) args.push("--full");
        flag("from", a.from);
        flag("to", a.to);
        flag("limit", a.limit);
      }
      if (a.noComments) args.push("--no-comments");
      break;
    }
    case "files":
      positional.push(need(a.repo, "repo", a.action));
      flag("path", a.path);
      flag("limit", a.limit);
      break;
    case "repos":
      flag("tag", a.tag);
      flag("limit", a.limit);
      if (a.repo) positional.push(a.repo);
      break;
    case "discover":
      if (a.add) args.push("--add");
      flag("language", a.language);
      flag("tag", a.tag);
      flag("limit", a.limit);
      positional.push(need(a.query, "query", a.action));
      break;
    case "changes":
      positional.push(need(a.repo, "repo", a.action));
      flag("version", a.version);
      if (a.pattern) flag("pattern", a.pattern);
      else if (a.full) args.push("--full");
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
  if (
    a.action === "search" ||
    a.action === "define" ||
    a.action === "show" ||
    a.action === "changes"
  ) {
    const ceiling = a.action === "search" ? MAX_TOKENS.search : MAX_TOKENS.read;
    flag("max-tokens", a.maxTokens === undefined ? undefined : Math.min(a.maxTokens, ceiling));
  }
  // Reads are for the model, so they stay text: line-numbered, and 10-40%
  // fewer tokens than the same answer as JSON. repos/discover/recent are
  // reshaped or summarised from JSON.
  if (JSON_ACTIONS.has(a.action)) args.push("--json");
  if (positional.length > 0) args.push("--", ...positional);
  return args;
}

const DESCRIPTION = `Current open-source code. Use it when local evidence leaves an API, design choice or risk unresolved and the answer may be newer than your training, or you don't know which projects do this; not a default research step. Search literal tokens, then read only what you need. Offline; no rate limits.
- search: regex across all repos (fixed=true literal); filter repo/language/path/tag; perRepo=1 for breadth. 10+ matches: one line each.
- define: where symbols are defined (symbol='a,b,c'). With repo or path: each whole body, no file needed.
- show: a long file gives its outline; then read bodies with symbols=[names], from/to only for code that isn't a definition (6,000 chars a read). path=a folder, every file's outline. Partial reads end with "uses": the same-repo helpers that code calls, so don't look those up again. Put every read you need in one reply.
- changes: a release's contents from the repo's changelog (version, default latest); pattern='form|param' returns those items whole.
- files: one repo's files by folder. repos: repo='axios' finds indexed repos with version.
- discover: find GitHub repos; query 'topic:X language:Y' or 2-3 keywords (4+ words finds nothing). found=0: retry once with 2 words or topic:. add=true indexes all found (ask the user first).
- add: index chosen repos (owner/name); on an indexed one, re-fetches latest (seconds to a minute). Results say when their code is from; refresh only if the task needs later changes. Only NEW repos need the user's agreement.
- recent: upstream changes in the last N hours.
repo/language are case-insensitive; a path without globs is a prefix.
Topic not covered = corpus gap, not a bad query: don't retry variants; discover, propose repos, add once the user agrees.`;

interface RepoRow {
  repo: string;
  version?: string;
  commit?: string;
  language?: string;
  files?: number;
  last_commit?: string;
  indexed_at?: string;
  tags?: string[];
}

/**
 * `repos --json` is ~370 bytes per repo (commit, byte counts, url, ...); a
 * 400-repo corpus came back as 160 KB and blew the tool-result cap. One line
 * per repo keeps the whole list readable.
 */
// Past this many rows an unfiltered list is a summary instead: the full
// 500-repo list was 39,000 characters, re-sent on every later turn, to answer
// "is X indexed?", which repo='X' answers in one line.
const REPO_LIST_MAX = 40;

function summarizeRepos(rows: RepoRow[]): string {
  const count = (values: (string | undefined)[]) => {
    const totals = new Map<string, number>();
    for (const value of values) if (value) totals.set(value, (totals.get(value) ?? 0) + 1);
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, n]) => `${name} ${n}`)
      .join(", ");
  };
  const tags = count(rows.flatMap((r) => r.tags ?? []));
  return [
    `${rows.length} repos indexed; too many to list. Find one with repo='name' (part of a name works), or narrow with tag.`,
    `languages: ${count(rows.map((r) => r.language))}`,
    ...(tags ? [`tags: ${tags}`] : []),
  ].join("\n");
}

export function compactRepos(
  json: string,
  now: number = Date.now(),
  filtered: boolean = true,
): string {
  let parsed: { count?: number; repositories?: RepoRow[] };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return json;
  }
  const rows = parsed.repositories ?? [];
  if (!filtered && rows.length > REPO_LIST_MAX) return summarizeRepos(rows);
  // Age only, no STALE flag or refresh advice: that sent agents into a
  // blocking `add` mid-task; reads say when their code is from instead.
  const lines = rows.map((r) => {
    const tags = r.tags?.length ? ` [${r.tags.join(",")}]` : "";
    const indexed = r.indexed_at ? Date.parse(r.indexed_at) : NaN;
    let age = "";
    if (Number.isFinite(indexed)) {
      const days = Math.max(0, Math.floor((now - indexed) / 86_400_000));
      age = `  indexed ${days}d ago`;
    }
    const snapshot = r.version ? `  v${r.version}` : "";
    return `${r.repo}${snapshot}  ${r.language ?? "?"}  ${r.files ?? "?"} files  ${r.last_commit ?? ""}${age}${tags}`;
  });
  return [`${parsed.count ?? rows.length} repos indexed, ${rows.length} shown`, ...lines].join(
    "\n",
  );
}

// Indexing (`add`, `discover --add`) is deliberately NOT gated on plan mode:
// it writes to the corpus, not the workspace, and the prompt requires user
// approval of the repo list first. A plan needs the corpus filled to be a
// plan from real code rather than memory.
// Helpers a read's "uses" section already showed, per repo, as "path:line".
// Sent back on later reads so the same helper is named instead of repeated.
const MAX_SKIPPED = 300;
const USES_HEADER = /^## (\S+) \S+ (\d+)-\d+/gm;

export function createSteroidsTool(bin: string): AgentTool<typeof SteroidsParams> {
  const shownHelpers = new Map<string, Set<string>>();
  // Reads in one reply run in order, so each sees the helpers the previous
  // one showed. A read takes milliseconds; order costs nothing.
  let reads: Promise<unknown> = Promise.resolve();
  return {
    name: "steroids",
    description: DESCRIPTION,
    parameters: SteroidsParams,
    async execute(args, context) {
      const indexes = args.action === "add" || (args.action === "discover" && args.add === true);
      let argv: string[];
      try {
        argv = buildSteroidsArgs(args);
      } catch (err) {
        if (err instanceof ArgError) return `Error: ${err.message}`;
        throw err;
      }
      if (args.action !== "show" || !args.repo) return run(argv, args, indexes, context.signal);
      const repo = args.repo.toLowerCase();
      const next = reads.then(async () => {
        const seen = [...(shownHelpers.get(repo) ?? [])].slice(-MAX_SKIPPED);
        const at = argv.indexOf("--");
        const withSkip =
          seen.length > 0
            ? [...argv.slice(0, at), "--skip-uses", seen.join(","), ...argv.slice(at)]
            : argv;
        const out = await run(withSkip, args, indexes, context.signal);
        const known = shownHelpers.get(repo) ?? new Set<string>();
        for (const match of out.matchAll(USES_HEADER)) known.add(`${match[1]}:${match[2]}`);
        shownHelpers.set(repo, known);
        return out;
      });
      reads = next.catch(() => undefined);
      return next;
    },
  };

  function run(
    argv: string[],
    args: Params,
    indexes: boolean,
    signal: AbortSignal | undefined,
  ): Promise<string> {
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
          signal,
        },
        (err, stdout, stderr) => {
          const out = String(stdout).trim();
          const note = String(stderr).trim();
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
            // Text mode reports `Error: <message>` on stderr.
            const line = (note.split("\n")[0] || err.message).replace(/^error:\s*/i, "");
            resolve(`Error: steroids ${args.action} failed: ${line}`);
            return;
          }
          if (args.action === "repos") {
            const filtered = Boolean(args.repo || args.tag || args.limit);
            resolve(compactRepos(out, Date.now(), filtered) || "(no output)");
            return;
          }
          // `files` puts its "N of M shown" summary on stderr so pipes stay clean.
          const summary = args.action === "files" && note ? `\n${note}` : "";
          resolve(out ? `${out}${summary}` : note || "(no output)");
        },
      );
    });
  }
}
