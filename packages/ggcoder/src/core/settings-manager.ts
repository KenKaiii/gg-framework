import fs from "node:fs/promises";
import { z } from "zod";
import { getAppPaths } from "../config.js";

// ── Settings Schema ────────────────────────────────────────

const SettingsSchema = z.object({
  autoCompact: z.boolean().default(true),
  compactThreshold: z.number().min(0.1).max(1.0).default(0.8),
  defaultProvider: z.enum(["anthropic", "openai", "glm", "moonshot"]).default("anthropic"),
  defaultModel: z.string().optional(),
  maxTokens: z.number().int().min(256).default(16384),
  thinkingEnabled: z.boolean().default(false),
  thinkingLevel: z.enum(["low", "medium", "high", "max"]).optional(),
  theme: z.enum(["auto", "dark", "light"]).default("auto"),
  showTokenUsage: z.boolean().default(true),
  showThinking: z.boolean().default(true),
  enabledTools: z.array(z.string()).optional(),
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
  showThinking: true,
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
