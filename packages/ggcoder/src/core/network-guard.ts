/**
 * Network egress allowlist.
 *
 * Two layers, with very different strength:
 *
 * 1. **Real enforcement** — the agent's own egress paths (`web-fetch`,
 *    `web-search`) check every request URL and every redirect hop against the
 *    allowlist. Nothing gets out of those tools to a disallowed host.
 *
 * 2. **Defence in depth (bypassable by design)** — {@link extractCommandHosts}
 *    recognises the common network command shapes (`curl`, `wget`, `git`,
 *    `ssh`/`scp`, package installs) so `bash` can refuse an obvious egress to a
 *    disallowed host. It is *not* a sandbox: `python -c`, a shell variable, a
 *    base64'd URL, or any unrecognised tool walks straight past it. It exists
 *    to catch accidents, not to contain a hostile model. Real containment needs
 *    OS-level enforcement (sandbox-exec, Landlock/seccomp, a netns proxy).
 *
 * Deliberately allow-shaped, not deny-shaped: a command with no recognised host
 * is never blocked, so ordinary work is unaffected.
 */

/** Host pattern match: exact, or `*.example.com` matching any subdomain. */
export function isHostAllowed(host: string, allow: readonly string[]): boolean {
  const target = host.trim().toLowerCase().replace(/\.$/, "");
  if (!target) return false;
  for (const raw of allow) {
    const pattern = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!pattern) continue;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      if (target.endsWith(suffix) && target.length > suffix.length) return true;
      continue;
    }
    if (target === pattern) return true;
  }
  return false;
}

/** Hostname of a URL-ish token, or undefined when it isn't one. */
export function hostFromUrl(value: string): string | undefined {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const host = new URL(candidate).hostname.toLowerCase();
    return host || undefined;
  } catch {
    return undefined;
  }
}

/** Default registry hosts for package managers that install from the network. */
const REGISTRY_HOSTS: Record<string, string> = {
  npm: "registry.npmjs.org",
  pnpm: "registry.npmjs.org",
  yarn: "registry.yarnpkg.com",
  bun: "registry.npmjs.org",
  pip: "pypi.org",
  pip3: "pypi.org",
};

const INSTALL_SUBCOMMANDS = new Set(["install", "i", "add", "ci", "update", "upgrade", "dlx", "x"]);
const GIT_NETWORK_SUBCOMMANDS = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);

function stripQuotes(token: string): string {
  const trimmed = token.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Host part of an `scp`/`ssh` target: `[user@]host[:path]`.
 * `requireRemoteMarker` distinguishes `scp file.txt host:/tmp` (only the second
 * token is remote) from `ssh host` (a bare host is the target).
 */
function hostFromSshTarget(token: string, requireRemoteMarker = false): string | undefined {
  if (requireRemoteMarker && !token.includes("@") && !token.includes(":")) return undefined;
  const withoutUser = token.includes("@") ? token.slice(token.lastIndexOf("@") + 1) : token;
  const host = withoutUser.split(":")[0];
  if (!host || host.startsWith("-") || !/^[a-z0-9._-]+$/i.test(host)) return undefined;
  // A bare local path (`./dir`, `dir`) has no dots-as-domain shape.
  if (!host.includes(".") && host !== "localhost") return undefined;
  return host.toLowerCase();
}

/**
 * Best-effort extraction of the hosts a shell command would contact.
 * Returns an empty array when nothing recognisable is found — never guesses.
 */
export function extractCommandHosts(command: string): string[] {
  const hosts = new Set<string>();
  // Split on shell separators so `cd x && curl https://…` is inspected too.
  for (const segment of command.split(/(?:&&|\|\||[;|\n])/)) {
    const tokens = segment
      .trim()
      .split(/\s+/)
      .map(stripQuotes)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) continue;

    let index = 0;
    if (tokens[index] === "sudo") index++;
    const program = (tokens[index] ?? "").split("/").pop() ?? "";
    const args = tokens.slice(index + 1);

    if (program === "curl" || program === "wget" || program === "http" || program === "https") {
      for (const arg of args) {
        if (arg.startsWith("-")) continue;
        const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ? hostFromUrl(arg) : undefined;
        if (host) hosts.add(host);
      }
      continue;
    }

    if (program === "git") {
      const sub = args.find((a) => !a.startsWith("-"));
      if (!sub || !GIT_NETWORK_SUBCOMMANDS.has(sub)) continue;
      for (const arg of args.slice(args.indexOf(sub) + 1)) {
        if (arg.startsWith("-")) continue;
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
          const host = hostFromUrl(arg);
          if (host) hosts.add(host);
          continue;
        }
        // scp-style remote: git@github.com:owner/repo.git
        if (arg.includes("@") && arg.includes(":")) {
          const host = hostFromSshTarget(arg);
          if (host) hosts.add(host);
        }
      }
      continue;
    }

    if (program === "ssh" || program === "scp" || program === "sftp" || program === "rsync") {
      // Only `ssh`'s first bare operand is a host; file-copy tools mark the
      // remote side with `user@` or `host:path`.
      const requireRemoteMarker = program !== "ssh";
      for (const arg of args) {
        if (arg.startsWith("-")) continue;
        const host = hostFromSshTarget(arg, requireRemoteMarker);
        if (host) {
          hosts.add(host);
          break;
        }
      }
      continue;
    }

    const registry = REGISTRY_HOSTS[program];
    if (registry) {
      const sub = args.find((a) => !a.startsWith("-"));
      if (sub && INSTALL_SUBCOMMANDS.has(sub)) hosts.add(registry);
      continue;
    }
  }

  return [...hosts];
}

/**
 * Check a shell command against the allowlist.
 * @returns an error string when a recognised host is disallowed, else null.
 */
export function checkCommandNetwork(
  command: string,
  mode: "off" | "allowlist",
  allow: readonly string[],
): string | null {
  if (mode !== "allowlist") return null;
  const blocked = extractCommandHosts(command).filter((host) => !isHostAllowed(host, allow));
  if (blocked.length === 0) return null;
  const allowed = allow.length > 0 ? allow.join(", ") : "(none)";
  return (
    `Blocked by the network allowlist: ${blocked.join(", ")}. ` +
    `Allowed hosts: ${allowed}. Ask the user to add the host to the networkAllow setting, ` +
    `or accomplish the task without network access.`
  );
}

/** Check a URL the agent is about to fetch (or a redirect target). */
export function checkUrlNetwork(
  url: string,
  mode: "off" | "allowlist",
  allow: readonly string[],
): string | null {
  if (mode !== "allowlist") return null;
  const host = hostFromUrl(url);
  if (!host) return `Blocked by the network allowlist: ${url} has no resolvable host.`;
  if (isHostAllowed(host, allow)) return null;
  const allowed = allow.length > 0 ? allow.join(", ") : "(none)";
  return (
    `Blocked by the network allowlist: ${host}. Allowed hosts: ${allowed}. ` +
    `Ask the user to add the host to the networkAllow setting.`
  );
}

/** Resolved egress policy, read lazily so a settings change applies live. */
export interface NetworkPolicy {
  mode: "off" | "allowlist";
  allow: readonly string[];
}

export type GetNetworkPolicy = () => NetworkPolicy | undefined;

/** Check a URL against a possibly-absent policy. */
export function checkUrlPolicy(url: string, getPolicy?: GetNetworkPolicy): string | null {
  const policy = getPolicy?.();
  if (!policy) return null;
  return checkUrlNetwork(url, policy.mode, policy.allow);
}

/** Check a shell command against a possibly-absent policy. */
export function checkCommandPolicy(command: string, getPolicy?: GetNetworkPolicy): string | null {
  const policy = getPolicy?.();
  if (!policy) return null;
  return checkCommandNetwork(command, policy.mode, policy.allow);
}

/** Enforce a live egress policy until the response has been fully consumed. */
export async function withNetworkPolicy<T>(
  url: string,
  getPolicy: GetNetworkPolicy | undefined,
  signal: AbortSignal,
  run: (signal: AbortSignal, onHop: (url: string) => void) => Promise<T>,
): Promise<T> {
  if (!getPolicy) return run(signal, () => undefined);
  let currentUrl = url;
  let denial: string | null = null;
  const revoked = new AbortController();
  const check = () => {
    const blocked = checkUrlPolicy(currentUrl, getPolicy);
    if (blocked && !denial) {
      denial = blocked;
      revoked.abort();
    }
  };
  check();
  if (denial) throw new Error(denial);
  const timer = setInterval(check, 100);
  try {
    const result = await run(AbortSignal.any([signal, revoked.signal]), (nextUrl) => {
      currentUrl = nextUrl;
      check();
    });
    check();
    if (denial) throw new Error(denial);
    return result;
  } catch (error) {
    if (denial) throw new Error(denial, { cause: error });
    throw error;
  } finally {
    clearInterval(timer);
  }
}
