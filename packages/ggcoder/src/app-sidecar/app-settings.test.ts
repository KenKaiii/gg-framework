import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// os.homedir() reads USERPROFILE on Windows, so a HOME override would write to
// the real profile. Point homedir() at a temp dir instead.
let home = "";
vi.mock("node:os", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => home } };
});

const { appSettingsFile, saveAutopilot, saveProjectModelPrefs, updateAppSettings } =
  await import("./app-settings.js");

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-app-settings-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function readFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(appSettingsFile(), "utf-8")) as Record<string, unknown>;
}

describe("gg-app.json writes from the sidecar", () => {
  it("keep keys owned by other writers (local endpoints, newer versions)", async () => {
    await fs.mkdir(path.dirname(appSettingsFile()), { recursive: true });
    await fs.writeFile(
      appSettingsFile(),
      JSON.stringify({
        projectsRoot: "/root",
        localEndpoints: [{ id: "lan", baseUrl: "http://h:1" }],
        someFutureKey: 7,
      }),
    );

    await saveAutopilot("/proj", true);

    const saved = await readFile();
    expect(saved.projectsRoot).toBe("/root");
    expect(saved.localEndpoints).toEqual([{ id: "lan", baseUrl: "http://h:1" }]);
    expect(saved.someFutureKey).toBe(7);
    expect(saved.autopilot).toEqual({ [path.resolve("/proj")]: true });
  });

  it("don't lose either change when two saves race", async () => {
    await Promise.all([
      saveAutopilot("/a", true),
      saveProjectModelPrefs("/b", { provider: "anthropic", model: "m" }),
      updateAppSettings((s) => {
        s.hiddenProjects = ["/c"];
      }),
    ]);

    const saved = await readFile();
    expect(saved.autopilot).toEqual({ [path.resolve("/a")]: true });
    expect(saved.projectModels).toEqual({
      [path.resolve("/b")]: { provider: "anthropic", model: "m" },
    });
    expect(saved.hiddenProjects).toEqual(["/c"]);
    await expect(fs.access(`${appSettingsFile()}.lock`)).rejects.toThrow();
  });
});
