import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { environmentSecrets, redactValue } from "@kleio/ai";
import { log } from "./logger.js";
import type { SubAgentSnapshot } from "./subagent-manager.js";

const STORE_VERSION = 1;
const RECORD_LIMIT = 20;
const MAX_STORE_BYTES = 5 * 1024 * 1024;
const MAX_ID_CHARS = 256;
const MAX_TASK_NAME_CHARS = 1_000;
const MAX_TEXT_CHARS = 250_000;
const VALID_STATES = new Set([
  "starting",
  "running",
  "completed",
  "failed",
  "interrupted",
  "closed",
  "reaped",
]);

export interface PersistedSubAgentRecord extends SubAgentSnapshot {
  agent_name?: string;
  provider?: string;
  model?: string;
  child_session_id?: string;
  child_session_path?: string;
  collected?: boolean;
}

interface StoreDocument {
  version: typeof STORE_VERSION;
  project: string;
  parent_session_id: string;
  updated_at: number;
  records: PersistedSubAgentRecord[];
}

function projectKey(cwd: string): string {
  const normalized = path.resolve(cwd);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

function parentKey(parentSessionId: string): string {
  const readable = parentSessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "unknown";
  const digest = createHash("sha256").update(parentSessionId).digest("hex").slice(0, 16);
  return `${readable}-${digest}`;
}

/** Versioned atomic durable state for one project's child-agent workflows. */
export class SubAgentStore {
  constructor(private readonly rootDir: string) {}

  pathFor(cwd: string, parentSessionId: string): string {
    return path.join(this.rootDir, projectKey(cwd), `${parentKey(parentSessionId)}.json`);
  }

  async load(cwd: string, parentSessionId: string): Promise<PersistedSubAgentRecord[]> {
    const filePath = this.pathFor(cwd, parentSessionId);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_STORE_BYTES) throw new Error("subagent store exceeds size limit");
      const parsed = JSON.parse(await fs.readFile(filePath, "utf-8")) as Partial<StoreDocument>;
      if (
        parsed.version !== STORE_VERSION ||
        parsed.project !== path.resolve(cwd) ||
        parsed.parent_session_id !== parentSessionId ||
        !Array.isArray(parsed.records)
      ) {
        throw new Error("unsupported or mismatched subagent store");
      }
      return parsed.records.slice(-RECORD_LIMIT).filter(isPersistedRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log("WARN", "subagent", "Ignoring corrupt subagent state", {
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return [];
    }
  }

  async save(
    cwd: string,
    parentSessionId: string,
    records: readonly PersistedSubAgentRecord[],
  ): Promise<void> {
    const filePath = this.pathFor(cwd, parentSessionId);
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.rootDir, 0o700);
    await fs.chmod(directory, 0o700);
    const document: StoreDocument = {
      version: STORE_VERSION,
      project: path.resolve(cwd),
      parent_session_id: parentSessionId,
      updated_at: Date.now(),
      records: records.slice(-RECORD_LIMIT).map((record) => ({ ...record })),
    };
    const sanitized = redactValue(document, { secrets: environmentSecrets(process.env) });
    const serialized = `${JSON.stringify(sanitized, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) {
      throw new Error("subagent store exceeds size limit");
    }
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, serialized, { mode: 0o600 });
      await fs.chmod(tempPath, 0o600);
      await fs.rename(tempPath, filePath);
      await fs.chmod(filePath, 0o600);
    } finally {
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  /** Child transcripts referenced by every durable parent across every project. */
  async listChildSessionPaths(): Promise<string[]> {
    const sessionPaths = new Set<string>();
    let projectDirectories: Dirent[];
    try {
      projectDirectories = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log("WARN", "subagent", "Failed to enumerate durable subagent state", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return [];
    }

    for (const projectDirectory of projectDirectories) {
      if (!projectDirectory.isDirectory()) continue;
      const directoryPath = path.join(this.rootDir, projectDirectory.name);
      let files: Dirent[];
      try {
        files = await fs.readdir(directoryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".json")) continue;
        const filePath = path.join(directoryPath, file.name);
        try {
          const stat = await fs.stat(filePath);
          if (stat.size > MAX_STORE_BYTES) continue;
          const parsed = JSON.parse(await fs.readFile(filePath, "utf-8")) as Partial<StoreDocument>;
          if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.records)) continue;
          for (const record of parsed.records.slice(-RECORD_LIMIT)) {
            if (isPersistedRecord(record) && record.child_session_path) {
              sessionPaths.add(record.child_session_path);
            }
          }
        } catch {
          // Corrupt records are already handled when their parent is hydrated.
        }
      }
    }
    return [...sessionPaths];
  }
}

function isPersistedRecord(value: unknown): value is PersistedSubAgentRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PersistedSubAgentRecord>;
  const optionalBoundedString = (candidate: unknown): boolean =>
    candidate === undefined ||
    (typeof candidate === "string" && candidate.length <= MAX_TEXT_CHARS);
  return (
    typeof record.agent_id === "string" &&
    record.agent_id.length > 0 &&
    record.agent_id.length <= MAX_ID_CHARS &&
    typeof record.task_name === "string" &&
    record.task_name.length <= MAX_TASK_NAME_CHARS &&
    typeof record.state === "string" &&
    VALID_STATES.has(record.state) &&
    typeof record.started_at === "number" &&
    Number.isFinite(record.started_at) &&
    typeof record.updated_at === "number" &&
    Number.isFinite(record.updated_at) &&
    typeof record.elapsed_ms === "number" &&
    Number.isFinite(record.elapsed_ms) &&
    typeof record.turn_count === "number" &&
    Number.isFinite(record.turn_count) &&
    typeof record.tool_use_count === "number" &&
    Number.isFinite(record.tool_use_count) &&
    !!record.token_usage &&
    typeof record.token_usage.input === "number" &&
    Number.isFinite(record.token_usage.input) &&
    typeof record.token_usage.output === "number" &&
    Number.isFinite(record.token_usage.output) &&
    optionalBoundedString(record.output) &&
    optionalBoundedString(record.error) &&
    optionalBoundedString(record.current_activity) &&
    optionalBoundedString(record.child_session_path) &&
    optionalBoundedString(record.cwd)
  );
}
