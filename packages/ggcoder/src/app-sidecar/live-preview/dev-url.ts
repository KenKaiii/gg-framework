// Finds the window's dev server: a local URL its background processes printed
// (Vite's "Local:", Next's "- Local:", etc.), or a server the user started in
// the project themselves; one serving a web page beats an API.
import fs from "node:fs/promises";
import type { BackgroundProcess } from "../../core/process-manager.js";
import type { Probe } from "./servers.js";

export type DevUrlResult =
  | { kind: "found"; url: string; command: string }
  | { kind: "https"; url: string; command: string }
  | { kind: "none" };

const TAIL_BYTES = 64 * 1024;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const LOCAL_URL =
  /\b(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(\/[^\s'"<>`)\]]*)?/gi;

/** The last local URL in some log text, normalised to localhost; null when none. */
export function lastLocalUrl(text: string): { url: string; https: boolean } | null {
  let last: RegExpExecArray | null = null;
  for (const m of text.replace(ANSI, "").matchAll(LOCAL_URL)) last = m as RegExpExecArray;
  if (!last) return null;
  const [, scheme, , port, rest] = last;
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  // 0.0.0.0 and ::1 are the same machine; a browser reaches either as localhost.
  const pathPart = (rest ?? "/").replace(/[.,;:]+$/, "") || "/";
  return {
    url: `${scheme.toLowerCase()}://localhost:${p}${pathPart}`,
    https: /^https$/i.test(scheme),
  };
}

async function readTail(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

interface Candidate {
  url: string;
  https: boolean;
  command: string;
  /** Its process still runs: an exited one's port may belong to something else now. */
  live: boolean;
  /** Printed in a background process log, rather than found running in the project. */
  printed: boolean;
}

/** One local URL per background process that printed one: running first, newest first. */
async function logCandidates(
  processes: readonly BackgroundProcess[],
  read: (file: string) => Promise<string>,
): Promise<Candidate[]> {
  const ordered = [...processes].sort(
    (a, b) =>
      Number(a.exitCode !== null) - Number(b.exitCode !== null) || b.startedAt - a.startedAt,
  );
  const found: Candidate[] = [];
  for (const p of ordered) {
    const text = await read(p.logFile).catch(() => "");
    const url = lastLocalUrl(text);
    if (url) found.push({ ...url, command: p.command, live: p.exitCode === null, printed: true });
  }
  return found;
}

export interface DetectOptions {
  /** The window's project. */
  cwd?: string;
  /** Ports of servers running from inside `cwd` that GG didn't start (servers.ts). */
  scan?: (cwd: string) => Promise<number[]>;
  /** What answers on a port; without it the newest printed URL wins unchecked. */
  probe?: (port: number) => Promise<Probe>;
}

const portOf = (url: string): number => Number(new URL(url).port || 80);
// Only a web page (or one still compiling) can be previewed: an API never is. An https dev
// server is reported rather than skipped.
const RANK: Record<Probe | "https", number> = { html: 0, https: 1, slow: 2, http: 9, none: 9 };

/**
 * The project's dev server: from the window's background process logs, then from
 * servers running inside the project that the user started themselves. With a
 * probe, only one serving a web page counts (a frontend, never its API).
 */
export async function detectDevUrl(
  processes: readonly BackgroundProcess[],
  read: (file: string) => Promise<string> = readTail,
  opts: DetectOptions = {},
): Promise<DevUrlResult> {
  const candidates = await logCandidates(processes, read);
  if (opts.scan && opts.cwd) {
    const seen = new Set(candidates.map((c) => portOf(c.url)));
    for (const port of await opts.scan(opts.cwd).catch(() => [])) {
      if (seen.has(port)) continue;
      seen.add(port);
      candidates.push({
        url: `http://localhost:${port}/`,
        https: false,
        command: "a dev server started outside GG Coder",
        live: true,
        printed: false,
      });
    }
  }
  const result = (c: Candidate): DevUrlResult => ({
    kind: c.https ? "https" : "found",
    url: c.url,
    command: c.command,
  });
  const probe = opts.probe;
  if (!probe) return candidates[0] ? result(candidates[0]) : { kind: "none" };
  const ranked = await Promise.all(
    candidates
      .filter((c) => c.live)
      .slice(0, 12)
      .map(async (c) => ({ c, rank: RANK[c.https ? "https" : await probe(portOf(c.url))] })),
  );
  const best = ranked.reduce<(typeof ranked)[number] | null>(
    (a, b) => (b.rank < RANK.none && (!a || b.rank < a.rank) ? b : a),
    null,
  );
  if (best) return result(best.c);
  // Nothing answers: the newest printed address, so the preview shows "start your dev server".
  const printed = candidates.find((c) => c.printed);
  return printed ? result(printed) : { kind: "none" };
}
