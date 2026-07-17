import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSavedSettings } from "./config.js";

const tempDirs: string[] = [];

function tempSettingsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ggcoder-config-"));
  tempDirs.push(dir);
  return path.join(dir, "settings.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadSavedSettings", () => {
  it("defaults ideal review to enabled", () => {
    const settings = loadSavedSettings(tempSettingsPath());

    expect(settings.idealReviewEnabled).toBe(true);
  });

  it("honors an explicit ideal review disable", () => {
    const settingsPath = tempSettingsPath();
    fs.writeFileSync(settingsPath, JSON.stringify({ idealReviewEnabled: false }), "utf-8");

    const settings = loadSavedSettings(settingsPath);

    expect(settings.idealReviewEnabled).toBe(false);
  });

  it("accepts xai as a saved provider", () => {
    const settingsPath = tempSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ defaultProvider: "xai", defaultModel: "grok-4.5" }),
      "utf-8",
    );

    const settings = loadSavedSettings(settingsPath);

    expect(settings.provider).toBe("xai");
    expect(settings.model).toBe("grok-4.5");
  });
});
