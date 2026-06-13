import path from "node:path";
import { log } from "../logger.js";
import { LspClient } from "./client.js";
import { formatDiagnostics } from "./format.js";
import {
  LSP_SERVER_CATALOG,
  findProjectRoot,
  serverForFile,
  type LspServerSpec,
} from "./servers.js";

export interface LspManagerOptions {
  /** Server catalog override — tests inject a fake-server spec here. */
  catalog?: readonly LspServerSpec[];
  /** Hard diagnostics budget once a client has served at least one file. */
  warmBudgetMs?: number;
  /** Hard budget for a client's very first file (spawn + init + indexing). */
  firstBudgetMs?: number;
}

const DEFAULT_WARM_BUDGET_MS = 3000;
const DEFAULT_FIRST_BUDGET_MS = 8000;
const INIT_TIMEOUT_MS = 10_000;

/**
 * Lazily spawns and pools language servers keyed by (serverId, projectRoot).
 * Nothing runs until the first edit/write of a matching file. Every failure
 * path degrades to an empty string — diagnostics are an enhancement, never a
 * tool-breaking dependency. A failed spawn/init marks the (server, root) pair
 * broken for the session so a missing binary costs one attempt, not one per
 * edit.
 */
export class LspManager {
  private readonly catalog: readonly LspServerSpec[];
  private readonly warmBudgetMs: number;
  private readonly firstBudgetMs: number;
  /** (serverId\0root) → in-flight or settled client; null = broken for session. */
  private readonly clients = new Map<string, Promise<LspClient | null>>();
  /** Keys that have completed at least one diagnostics pass (warm). */
  private readonly warmKeys = new Set<string>();
  private shutDown = false;

  constructor(
    private readonly cwd: string,
    options?: LspManagerOptions,
  ) {
    this.catalog = options?.catalog ?? LSP_SERVER_CATALOG;
    this.warmBudgetMs = options?.warmBudgetMs ?? DEFAULT_WARM_BUDGET_MS;
    this.firstBudgetMs = options?.firstBudgetMs ?? DEFAULT_FIRST_BUDGET_MS;
  }

  /**
   * Diagnostics for `filePath` after its content became `content` on disk.
   * Returns a formatted informational block, or "" when the file is clean,
   * unsupported, or anything at all goes wrong (silent graceful degradation).
   */
  async diagnosticsAfterWrite(filePath: string, content: string): Promise<string> {
    if (this.shutDown) return "";
    try {
      const spec = serverForFile(filePath, this.catalog);
      if (!spec) return "";
      const root = findProjectRoot(filePath, spec.rootMarkers, this.cwd);
      const key = `${spec.id}\u0000${root}`;
      const budgetMs = this.warmKeys.has(key) ? this.warmBudgetMs : this.firstBudgetMs;

      const work = this.collect(key, spec, root, filePath, content, budgetMs);
      // On budget overrun the work keeps running in the background so the
      // now-warm server can serve the next edit; swallow its eventual outcome.
      return await withBudget(work, budgetMs);
    } catch (error) {
      log("WARN", "lsp", `diagnostics failed for ${filePath}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return "";
    }
  }

  /** Shut down every pooled server. Safe in process exit handlers. */
  shutdownAll(): void {
    this.shutDown = true;
    for (const pending of this.clients.values()) {
      void pending.then((client) => client?.shutdown()).catch(() => {});
    }
    this.clients.clear();
    this.warmKeys.clear();
  }

  private async collect(
    key: string,
    spec: LspServerSpec,
    root: string,
    filePath: string,
    content: string,
    budgetMs: number,
  ): Promise<string> {
    const client = await this.ensureClient(key, spec, root);
    if (!client) return "";
    if (!client.isAlive) {
      // Crashed after init — mark broken for the session, never respawn loops.
      this.clients.set(key, Promise.resolve(null));
      log("WARN", "lsp", `${spec.id} server died`, { root });
      return "";
    }

    const uri = client.syncDocument(path.resolve(this.cwd, filePath), content);
    const diagnostics = await client.collectDiagnostics(uri, budgetMs);
    this.warmKeys.add(key);
    if (diagnostics === null) return "";

    const relPath = path.relative(this.cwd, path.resolve(this.cwd, filePath));
    return formatDiagnostics(relPath, diagnostics);
  }

  private ensureClient(key: string, spec: LspServerSpec, root: string): Promise<LspClient | null> {
    const existing = this.clients.get(key);
    if (existing) return existing;

    const pending = (async (): Promise<LspClient | null> => {
      const command = spec.resolveCommand(root);
      if (!command) {
        log("INFO", "lsp", `${spec.id} language server not available`, { root });
        return null;
      }
      try {
        const startedAt = Date.now();
        const client = new LspClient(spec, root, command);
        await client.initialize(INIT_TIMEOUT_MS);
        log("INFO", "lsp", `${spec.id} server initialized`, {
          root,
          ms: String(Date.now() - startedAt),
        });
        return client;
      } catch (error) {
        log("WARN", "lsp", `${spec.id} server failed to start`, {
          root,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })();

    this.clients.set(key, pending);
    return pending;
  }
}

/** Race `work` against the budget; overrun resolves "" and lets work finish. */
function withBudget(work: Promise<string>, budgetMs: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve(""), budgetMs);
    timer.unref();
    work
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve("");
      });
  });
}
