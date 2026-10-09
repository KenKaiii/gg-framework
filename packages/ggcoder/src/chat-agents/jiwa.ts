import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { withFileLock } from "@kenkaiiii/gg-core";

export const JIWA_SOFT_LIMIT = 60;
export const JIWA_HARD_LIMIT = 90;
export const JIWA_TEXT_LIMIT = 600;
const JIWA_FILE_VERSION = 1;
const DUPLICATE_THRESHOLD = 0.8;

export const JIWA_CATEGORIES = [
  "identity",
  "voice",
  "interaction",
  "boundaries",
  "workflow",
  "other",
] as const;

export type JiwaCategory = (typeof JIWA_CATEGORIES)[number];

export interface JiwaEntry {
  id: string;
  text: string;
  category: JiwaCategory;
  importance: number;
  createdAt: string;
  updatedAt: string;
}

export interface JiwaSnapshot {
  jiwa: JiwaEntry[];
  softLimit: number;
  hardLimit: number;
}

interface JiwaFile {
  version: number;
  jiwa: JiwaEntry[];
}

export interface JiwaMutationResult {
  entry?: JiwaEntry;
  jiwa: JiwaEntry[];
  duplicateOf?: JiwaEntry;
  deleted?: boolean;
  forgotten?: number;
}

export interface JiwaStoreOptions {
  filePath?: string;
  onChange?: (snapshot: JiwaSnapshot) => void | Promise<void>;
  now?: () => Date;
}

const categorySet = new Set<string>(JIWA_CATEGORIES);
const duplicateStopWords = new Set(["a", "an", "and", "by", "for", "has", "is", "the", "to"]);

function validDate(value: unknown, fallback: string): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

function coerceEntry(value: unknown, now: string): JiwaEntry | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const text =
    typeof candidate.text === "string" ? candidate.text.trim().slice(0, JIWA_TEXT_LIMIT) : "";
  if (!text) return null;
  const createdAt = validDate(candidate.createdAt, now);
  return {
    id: typeof candidate.id === "string" && candidate.id ? candidate.id : crypto.randomUUID(),
    text,
    category:
      typeof candidate.category === "string" && categorySet.has(candidate.category)
        ? (candidate.category as JiwaCategory)
        : "other",
    importance:
      typeof candidate.importance === "number" && Number.isFinite(candidate.importance)
        ? Math.max(1, Math.min(5, Math.round(candidate.importance)))
        : 3,
    createdAt,
    updatedAt: validDate(candidate.updatedAt, createdAt),
  };
}

function tokenSet(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (token) => !duplicateStopWords.has(token),
    ),
  );
}

function similarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const uniqueTokens = a.size + b.size - intersection * 2;
  return intersection / (intersection + uniqueTokens * 3);
}

function findDuplicate(
  entries: JiwaEntry[],
  text: string,
  excludeId?: string,
): JiwaEntry | undefined {
  return entries.find(
    (entry) => entry.id !== excludeId && similarity(entry.text, text) >= DUPLICATE_THRESHOLD,
  );
}

function findExactDuplicate(
  entries: JiwaEntry[],
  text: string,
  excludeId: string,
): JiwaEntry | undefined {
  return entries.find((entry) => entry.id !== excludeId && similarity(entry.text, text) === 1);
}

function enforceHardLimit(entries: JiwaEntry[]): JiwaEntry[] {
  if (entries.length <= JIWA_HARD_LIMIT) return entries;
  const removable = entries
    .filter((entry) => entry.category !== "identity")
    .sort(
      (left, right) =>
        left.importance - right.importance ||
        Date.parse(left.updatedAt) - Date.parse(right.updatedAt),
    );
  const removeCount = Math.min(entries.length - JIWA_HARD_LIMIT, removable.length);
  const removedIds = new Set(removable.slice(0, removeCount).map((entry) => entry.id));
  return entries.filter((entry) => !removedIds.has(entry.id));
}

function sortForDisplay(entries: JiwaEntry[]): JiwaEntry[] {
  return [...entries].sort(
    (left, right) =>
      right.importance - left.importance ||
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}

export class JiwaStore {
  readonly filePath: string;
  private readonly onChange?: JiwaStoreOptions["onChange"];
  private readonly now: () => Date;

  constructor(options: JiwaStoreOptions = {}) {
    this.filePath = options.filePath ?? path.join(os.homedir(), ".gg", "chat-jiwa.json");
    this.onChange = options.onChange;
    this.now = options.now ?? (() => new Date());
  }

  async list(): Promise<JiwaEntry[]> {
    return sortForDisplay((await this.readFile()).jiwa);
  }

  async snapshot(): Promise<JiwaSnapshot> {
    return this.toSnapshot(await this.list());
  }

  async set(
    content: string,
    category: JiwaCategory = "other",
    importance = 3,
  ): Promise<JiwaMutationResult> {
    return this.mutate((entries) => {
      const text = this.normalizeText(content);
      const duplicateOf = findDuplicate(entries, text);
      if (duplicateOf) return { jiwa: entries, duplicateOf };
      const timestamp = this.now().toISOString();
      const entry: JiwaEntry = {
        id: crypto.randomUUID(),
        text,
        category,
        importance: this.normalizeImportance(importance),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const next = enforceHardLimit([...entries, entry]);
      if (next.length > JIWA_HARD_LIMIT || !next.some((item) => item.id === entry.id)) {
        throw new Error(
          "Jiwa limit is full of protected identity instructions; forget one before adding another.",
        );
      }
      return { jiwa: next, entry };
    });
  }

  async update(
    id: string,
    content: string,
    category?: JiwaCategory,
    importance?: number,
    forgetIds: string[] = [],
  ): Promise<JiwaMutationResult> {
    return this.mutate((entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error(`Jiwa entry not found: ${id}`);
      const text = this.normalizeText(content);
      const forgetSet = new Set(forgetIds.filter((forgetId) => forgetId !== id));
      const remaining = entries.filter((entry) => !forgetSet.has(entry.id));
      const duplicateOf = findExactDuplicate(remaining, text, id);
      if (duplicateOf) return { jiwa: entries, duplicateOf };
      const current = entries[index]!;
      const entry: JiwaEntry = {
        ...current,
        text,
        category: category ?? current.category,
        importance:
          importance === undefined ? current.importance : this.normalizeImportance(importance),
        updatedAt: this.now().toISOString(),
      };
      const next = remaining.map((item) => (item.id === id ? entry : item));
      return {
        jiwa: next,
        entry,
        forgotten: entries.length - next.length,
      };
    });
  }

  async forget(id: string): Promise<JiwaMutationResult> {
    return this.mutate((entries) => {
      const exists = entries.some((entry) => entry.id === id);
      if (!exists) return { jiwa: entries, deleted: false };
      return { jiwa: entries.filter((entry) => entry.id !== id), deleted: true };
    });
  }

  renderForPrompt(): string {
    const entries = sortForDisplay(this.readFileSync().jiwa);
    if (entries.length === 0) {
      return "# Jiwa\nNo persistent behavior instructions are stored yet. Use set_jiwa only for durable user preferences about how chat agents should act.";
    }
    const lines = [
      "# Jiwa",
      "These user-established instructions define how chat agents should act across sessions. Follow them as active user preferences unless a newer user request or higher-priority instruction conflicts.",
    ];
    for (const category of JIWA_CATEGORIES) {
      const grouped = entries.filter((entry) => entry.category === category);
      if (grouped.length === 0) continue;
      lines.push(`\n## ${category}`);
      for (const entry of grouped) {
        lines.push(`- [${entry.id}] (importance ${entry.importance}) ${entry.text}`);
      }
    }
    if (entries.length >= JIWA_SOFT_LIMIT) {
      lines.push(
        `\nJiwa has reached ${entries.length}/${JIWA_HARD_LIMIT}. Consolidate related instructions with update_jiwa and forget stale or redundant entries with forget_jiwa.`,
      );
    }
    return lines.join("\n");
  }

  private async mutate(
    apply: (entries: JiwaEntry[]) => Omit<JiwaMutationResult, "jiwa"> & { jiwa: JiwaEntry[] },
  ): Promise<JiwaMutationResult> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const { result, changed } = await withFileLock(this.filePath, async () => {
      const current = await this.readFile();
      const mutation = apply(current.jiwa);
      const changed = mutation.jiwa !== current.jiwa;
      if (changed) await this.writeFile(mutation.jiwa);
      return {
        result: { ...mutation, jiwa: sortForDisplay(mutation.jiwa) },
        changed,
      };
    });
    if (changed) await this.onChange?.(this.toSnapshot(result.jiwa));
    return result;
  }

  private normalizeText(content: string): string {
    const text = content.trim();
    if (!text) throw new Error("Jiwa instruction cannot be empty.");
    if (text.length > JIWA_TEXT_LIMIT) {
      throw new Error(`Jiwa instruction must be ${JIWA_TEXT_LIMIT} characters or fewer.`);
    }
    return text;
  }

  private normalizeImportance(importance: number): number {
    if (!Number.isFinite(importance)) return 3;
    return Math.max(1, Math.min(5, Math.round(importance)));
  }

  private toSnapshot(jiwa: JiwaEntry[]): JiwaSnapshot {
    return { jiwa, softLimit: JIWA_SOFT_LIMIT, hardLimit: JIWA_HARD_LIMIT };
  }

  private parse(raw: string): JiwaFile {
    const value = JSON.parse(raw) as unknown;
    const now = this.now().toISOString();
    const candidates =
      value && typeof value === "object" && Array.isArray((value as { jiwa?: unknown }).jiwa)
        ? (value as { jiwa: unknown[] }).jiwa
        : [];
    return {
      version: JIWA_FILE_VERSION,
      jiwa: enforceHardLimit(
        candidates
          .map((candidate) => coerceEntry(candidate, now))
          .filter((item): item is JiwaEntry => item !== null),
      ),
    };
  }

  private async readFile(): Promise<JiwaFile> {
    try {
      return this.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: JIWA_FILE_VERSION, jiwa: [] };
      try {
        return this.parse(await fs.readFile(`${this.filePath}.bak`, "utf8"));
      } catch {
        return { version: JIWA_FILE_VERSION, jiwa: [] };
      }
    }
  }

  private readFileSync(): JiwaFile {
    try {
      return this.parse(requireFileSync(this.filePath));
    } catch {
      try {
        return this.parse(requireFileSync(`${this.filePath}.bak`));
      } catch {
        return { version: JIWA_FILE_VERSION, jiwa: [] };
      }
    }
  }

  private async writeFile(jiwa: JiwaEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const existing = await fs.readFile(this.filePath, "utf8").catch(() => null);
      if (existing !== null) {
        try {
          this.parse(existing);
          await fs.writeFile(`${this.filePath}.bak`, existing, "utf8");
        } catch {
          // Keep the last known-good backup when the primary is malformed.
        }
      }
      await fs.writeFile(
        tempPath,
        `${JSON.stringify({ version: JIWA_FILE_VERSION, jiwa }, null, 2)}\n`,
        "utf8",
      );
      await fs.rename(tempPath, this.filePath);
    } finally {
      await fs.unlink(tempPath).catch(() => {});
    }
  }
}

function requireFileSync(filePath: string): string {
  return fsSync.readFileSync(filePath, "utf8");
}

const setJiwaParameters = z.object({
  content: z
    .string()
    .min(1)
    .max(JIWA_TEXT_LIMIT)
    .describe("One concise, self-contained instruction for how chat agents should act"),
  category: z.enum(JIWA_CATEGORIES).optional().describe("Kind of behavior instruction"),
  importance: z.number().int().min(1).max(5).optional().describe("Ongoing importance from 1 to 5"),
});

const updateJiwaParameters = z.object({
  id: z.string().min(1).describe("Jiwa entry ID shown in the injected Jiwa block"),
  content: z.string().min(1).max(JIWA_TEXT_LIMIT).describe("Replacement behavior instruction"),
  category: z.enum(JIWA_CATEGORIES).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  forget_ids: z
    .array(z.string().min(1))
    .max(JIWA_HARD_LIMIT)
    .optional()
    .describe("Redundant Jiwa entry IDs to delete atomically after merging them into this update"),
});

const forgetJiwaParameters = z.object({
  id: z.string().min(1).describe("Jiwa entry ID shown in the injected Jiwa block"),
});

function jiwaCount(count: number, verb: "stored" | "remain"): string {
  return `${count} Jiwa ${count === 1 ? "entry" : "entries"} ${verb}`;
}

export function buildJiwaTools(store: JiwaStore): AgentTool[] {
  return [
    {
      name: "set_jiwa",
      description:
        "Save one durable user instruction about how chat agents should act, speak, identify themselves, work, or what they should avoid.",
      parameters: setJiwaParameters,
      executionMode: "sequential",
      async execute(args) {
        const { content, category, importance } = setJiwaParameters.parse(args);
        const result = await store.set(content, category, importance);
        if (result.duplicateOf) {
          return `Near-duplicate Jiwa entry already exists as ${result.duplicateOf.id}. Use update_jiwa if that instruction changed.`;
        }
        if (!result.entry) throw new Error("Jiwa store saved nothing and found no duplicate");
        return `Set Jiwa entry ${result.entry.id}. ${jiwaCount(result.jiwa.length, "stored")}.`;
      },
    },
    {
      name: "update_jiwa",
      description:
        "Replace or correct an existing Jiwa instruction. To consolidate, merge related instructions into content and pass their redundant IDs in forget_ids.",
      parameters: updateJiwaParameters,
      executionMode: "sequential",
      async execute(args) {
        const { id, content, category, importance, forget_ids } = updateJiwaParameters.parse(args);
        const result = await store.update(id, content, category, importance, forget_ids);
        if (result.duplicateOf) {
          return `That would duplicate Jiwa entry ${result.duplicateOf.id}. Update or forget the redundant entry instead.`;
        }
        const cleanup = result.forgotten
          ? ` Consolidated ${result.forgotten} redundant ${result.forgotten === 1 ? "entry" : "entries"}.`
          : "";
        return `Updated Jiwa entry ${id}.${cleanup} ${jiwaCount(result.jiwa.length, "stored")}.`;
      },
    },
    {
      name: "forget_jiwa",
      description: "Delete one stale, wrong, redundant, or explicitly unwanted Jiwa instruction.",
      parameters: forgetJiwaParameters,
      executionMode: "sequential",
      async execute(args) {
        const { id } = forgetJiwaParameters.parse(args);
        const result = await store.forget(id);
        return result.deleted
          ? `Forgot Jiwa entry ${id}. ${jiwaCount(result.jiwa.length, "remain")}.`
          : `Jiwa entry ${id} was not found. ${jiwaCount(result.jiwa.length, "remain")}.`;
      },
    },
  ];
}
