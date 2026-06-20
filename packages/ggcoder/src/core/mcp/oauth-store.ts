import fs from "node:fs/promises";
import { getAppPaths } from "@kenkaiiii/gg-core";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { log } from "../logger.js";

/**
 * Persisted OAuth state for ONE remote MCP server (RFC 8414/7591/6749 flow).
 *
 * - `clientInformation` is the dynamic client registration (RFC 7591) result —
 *   reused across logins so the registered `redirect_uri` stays valid.
 * - `tokens` is the access/refresh pair; the MCP SDK refreshes it in place and
 *   calls `saveTokens` so a logged-in server reconnects silently at startup.
 * - `codeVerifier` is the in-flight PKCE verifier, only meaningful between the
 *   authorize redirect and the token exchange (`finishAuth`).
 * - `state` is the in-flight CSRF `state` value the loopback callback validates.
 */
export interface McpOAuthEntry {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
}

interface McpAuthFile {
  version: 1;
  servers: Record<string, McpOAuthEntry>;
}

/**
 * File-backed store for remote-MCP OAuth credentials, living next to the CLI's
 * other auth at `~/.gg/mcp-auth.json`. Keyed by server name (the same identity
 * the config + UI use). Every read re-reads the file so concurrent sidecars /
 * windows see each other's logins; writes are read-modify-write so two servers
 * don't clobber one another.
 */
export class McpOAuthStore {
  constructor(private readonly filePath: string = getAppPaths().mcpAuthFile) {}

  private async readAll(): Promise<McpAuthFile> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<McpAuthFile>;
      return { version: 1, servers: parsed.servers ?? {} };
    } catch {
      return { version: 1, servers: {} };
    }
  }

  private async writeAll(data: McpAuthFile): Promise<void> {
    try {
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
    } catch (err) {
      log("WARN", "mcp", "failed to persist MCP OAuth store", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async get(name: string): Promise<McpOAuthEntry> {
    const all = await this.readAll();
    return all.servers[name] ?? {};
  }

  /** Merge a partial entry into the server's record (read-modify-write). */
  async patch(name: string, patch: Partial<McpOAuthEntry>): Promise<void> {
    const all = await this.readAll();
    all.servers[name] = { ...(all.servers[name] ?? {}), ...patch };
    await this.writeAll(all);
  }

  /** Drop a server's whole OAuth record (used on logout / removal). */
  async clear(name: string): Promise<void> {
    const all = await this.readAll();
    if (all.servers[name]) {
      delete all.servers[name];
      await this.writeAll(all);
    }
  }

  /** Whether this server has saved tokens (i.e. has completed login at least once). */
  async hasTokens(name: string): Promise<boolean> {
    const entry = await this.get(name);
    return !!entry.tokens?.access_token;
  }
}
