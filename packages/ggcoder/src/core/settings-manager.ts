import fs from "node:fs/promises";
import { z } from "zod";
import { getAppPaths } from "../config.js";

// ── Settings Schema ────────────────────────────────────────

const SettingsSchema = z.object({
  autoCompact: z.boolean().default(true),
  compactThreshold: z.number().min(0.1).max(1.0).default(0.8),
  defaultProvider: z
    .enum([
      "anthropic",
      "openai",
      "gemini",
      "glm",
      "moonshot",
      "minimax",
      "xiaomi",
      "deepseek",
      "openrouter",
    ])
    .default("anthropic"),
  defaultModel: z.string().optional(),
  maxTokens: z.number().int().min(256).default(16384),
  thinkingEnabled: z.boolean().default(false),
  thinkingLevel: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  theme: z
    .enum([
      "auto",
      "dark",
      "light",
      "dark-ansi",
      "light-ansi",
      "dark-daltonized",
      "light-daltonized",
    ])
    .default("auto"),
  showTokenUsage: z.boolean().default(true),
  idealReviewEnabled: z.boolean().default(true),
  /** Append LSP diagnostics to edit/write tool results. */
  lspDiagnostics: z.boolean().default(true),
  enabledTools: z.array(z.string()).optional(),
  /** Delete session transcripts older than this many days at startup. 0 disables pruning. */
  sessionRetentionDays: z.number().int().min(0).default(30),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  autoCompact: true,
  compactThreshold: 0.8,
  defaultProvider: "anthropic",
  maxTokens: 16384,
  thinkingEnabled: false,
  theme: "auto",
  showTokenUsage: true,
  idealReviewEnabled: true,
  lspDiagnostics: true,
  sessionRetentionDays: 30,
};

// ── Settings Manager ───────────────────────────────────────

export class SettingsManager {
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private filePath: string;
  private loaded = false;

  constructor(filePath?: string) {
    this.filePath = filePath ?? getAppPaths().settingsFile;
  }

  async load(): Promise<Settings> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const raw = JSON.parse(content);
      // Merge with defaults so new fields get default values
      this.settings = SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...raw });
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
    this.loaded = true;
    return this.settings;
  }

  async save(): Promise<void> {
    const content = JSON.stringify(this.settings, null, 2);
    await fs.writeFile(this.filePath, content, "utf-8");
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.settings[key];
  }

  async set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    this.settings[key] = value;
    await this.save();
  }

  getAll(): Settings {
    return { ...this.settings };
  }
}
