import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "setup-history-"));
  // Re-point os.homedir() at our tmp dir. Done via a spy so the change is
  // reverted after each test via vi.restoreAllMocks().
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  // setup-history.ts captures HISTORY_PATH at module load via os.homedir().
  // We must re-import after the mock is in place to pick up the tmp path.
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function loadModule() {
  return await import("./setup-history.js");
}

describe("setup-history", () => {
  it("getAnnouncedLanguages returns [] when never announced", async () => {
    const { getAnnouncedLanguages } = await loadModule();
    expect(getAnnouncedLanguages("/tmp/fresh")).toEqual([]);
  });

  it("tolerates corrupt history files (treats as empty)", async () => {
    const ggDir = path.join(tmpHome, ".gg");
    fs.mkdirSync(ggDir, { recursive: true });
    fs.writeFileSync(path.join(ggDir, "setup-history.json"), "{ not valid json");
    const { getAnnouncedLanguages } = await loadModule();
    expect(getAnnouncedLanguages("/tmp/anywhere")).toEqual([]);
  });

  it("markLanguagesAnnounced persists and dedupes across calls", async () => {
    const { getAnnouncedLanguages, markLanguagesAnnounced } = await loadModule();
    const cwd = "/tmp/proj";
    markLanguagesAnnounced(cwd, ["typescript"]);
    expect(getAnnouncedLanguages(cwd)).toEqual(["typescript"]);
    markLanguagesAnnounced(cwd, ["typescript", "rust"]);
    expect(getAnnouncedLanguages(cwd).sort()).toEqual(["rust", "typescript"]);
  });

  it("preserves legacy lastAuditedAt entries without clobbering", async () => {
    const ggDir = path.join(tmpHome, ".gg");
    fs.mkdirSync(ggDir, { recursive: true });
    const cwd = "/tmp/coexist";
    fs.writeFileSync(
      path.join(ggDir, "setup-history.json"),
      JSON.stringify({ [cwd]: { lastAuditedAt: "2026-01-01T00:00:00.000Z" } }),
    );
    const { getAnnouncedLanguages, markLanguagesAnnounced } = await loadModule();
    markLanguagesAnnounced(cwd, ["python"]);
    expect(getAnnouncedLanguages(cwd)).toEqual(["python"]);
    const raw = JSON.parse(fs.readFileSync(path.join(ggDir, "setup-history.json"), "utf-8")) as {
      [k: string]: { lastAuditedAt?: string };
    };
    expect(raw[cwd].lastAuditedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("markLanguagesAnnounced is a no-op for empty input", async () => {
    const { getAnnouncedLanguages, markLanguagesAnnounced } = await loadModule();
    markLanguagesAnnounced("/tmp/noop", []);
    expect(getAnnouncedLanguages("/tmp/noop")).toEqual([]);
  });
});
