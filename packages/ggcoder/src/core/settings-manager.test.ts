import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "./settings-manager.js";
import { loadSavedSettings } from "../config.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-"));
  file = path.join(dir, "settings.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const readFile = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;

describe("SettingsManager", () => {
  it("keeps every other setting when a local model is saved as the default (#133)", async () => {
    await fs.writeFile(
      file,
      JSON.stringify({ theme: "dark", maxTokens: 9999, autoCompact: false }),
    );
    const first = new SettingsManager(file);
    await first.load();
    await first.set("defaultProvider", "local");
    await first.set("defaultModel", "local/ollama/qwen3:4b");

    // A second load + save (the thinking level is saved right after the model) used to wipe the file.
    const second = new SettingsManager(file);
    await second.load();
    await second.set("thinkingEnabled", true);

    expect(await readFile()).toMatchObject({
      theme: "dark",
      maxTokens: 9999,
      autoCompact: false,
      defaultProvider: "local",
      defaultModel: "local/ollama/qwen3:4b",
      thinkingEnabled: true,
    });
  });

  it("drops only the value it can't read, and writes it back untouched", async () => {
    await fs.writeFile(
      file,
      JSON.stringify({ theme: "dark", maxTokens: 12, futureSetting: { on: true } }),
    );
    const sm = new SettingsManager(file);
    const loaded = await sm.load();
    expect(loaded.theme).toBe("dark");
    expect(loaded.maxTokens).toBe(16384);

    await sm.set("keepAwake", false);
    // The bad value and a newer build's key survive this build's save.
    expect(await readFile()).toMatchObject({
      theme: "dark",
      maxTokens: 12,
      futureSetting: { on: true },
      keepAwake: false,
    });

    await sm.set("maxTokens", 8192);
    expect((await readFile()).maxTokens).toBe(8192);
  });

  it("starts from defaults when there is no file", async () => {
    const sm = new SettingsManager(file);
    expect((await sm.load()).defaultProvider).toBe("anthropic");
    await sm.set("theme", "light");
    expect((await readFile()).theme).toBe("light");
  });
});

describe("loadSavedSettings with a local default", () => {
  it("hands a saved local model only to callers that can discover it", async () => {
    await fs.writeFile(
      file,
      JSON.stringify({ defaultProvider: "local", defaultModel: "local/ollama/qwen3:4b" }),
    );
    // The CLI has no local-endpoint discovery, so it ignores the saved local model.
    expect(loadSavedSettings(file)).not.toHaveProperty("provider");
    expect(loadSavedSettings(file)).not.toHaveProperty("model");
    expect(loadSavedSettings(file, { localModels: true })).toMatchObject({
      provider: "local",
      model: "local/ollama/qwen3:4b",
    });
  });
});
