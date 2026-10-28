import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSavedSettings,
  projectScopeAllowed,
  removeRetiredSeededSkills,
  RETIRED_SEEDED_SKILL_HASHES,
  seedDefaultAgents,
  SHADOWING_SEEDED_AGENT_HASHES,
} from "./config.js";
import { BUNDLED_AGENTS } from "./core/agents.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

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
  it("defaults trustedProjects to an empty array", () => {
    const settings = loadSavedSettings(tempSettingsPath());
    expect(settings.trustedProjects).toEqual([]);
  });

  it("parses trustedProjects from settings JSON", () => {
    const settingsPath = tempSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ trustedProjects: ["/tmp/proj-a", "/tmp/proj-b"] }),
      "utf-8",
    );
    const settings = loadSavedSettings(settingsPath);
    expect(settings.trustedProjects).toEqual(["/tmp/proj-a", "/tmp/proj-b"]);
  });

  it("filters non-string entries from trustedProjects", () => {
    const settingsPath = tempSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ trustedProjects: ["/tmp/ok", 42, null, { bad: true }] }),
      "utf-8",
    );
    const settings = loadSavedSettings(settingsPath);
    expect(settings.trustedProjects).toEqual(["/tmp/ok"]);
  });
  it("defaults ideal review and shared compaction policy", () => {
    const settings = loadSavedSettings(tempSettingsPath());

    expect(settings.idealReviewEnabled).toBe(true);
    expect(settings.autoCompact).toBe(true);
    expect(settings.compactThreshold).toBe(0.85);
  });

  it("honors an explicit ideal review disable", () => {
    const settingsPath = tempSettingsPath();
    fs.writeFileSync(settingsPath, JSON.stringify({ idealReviewEnabled: false }), "utf-8");

    const settings = loadSavedSettings(settingsPath);

    expect(settings.idealReviewEnabled).toBe(false);
  });

  it("loads the configured compaction policy used by CLI resume", () => {
    const settingsPath = tempSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ autoCompact: false, compactThreshold: 0.72 }),
      "utf-8",
    );

    const settings = loadSavedSettings(settingsPath);
    expect(settings.autoCompact).toBe(false);
    expect(settings.compactThreshold).toBe(0.72);
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

// ggcoder used to seed agent files into the user agents dir, where they
// silently shadowed the richer BUNDLED_AGENTS of the same name and froze at
// whatever version wrote them. Nothing is seeded anymore, and seedDefaultAgents
// cleans up the old copies on next launch — but only when the file is untouched.
//
// These call seedDefaultAgents(dir) directly: getAppPaths() resolves
// os.homedir() inside gg-core's prebuilt dist, which vitest does not transform,
// so going via ensureAppDirs would ignore a homedir spy and mutate the real
// ~/.gg.
describe("seedDefaultAgents shadowing-agent cleanup", () => {
  // Byte-exact copies of what v5.22.6 wrote, so the deletion path is tested
  // against the real thing rather than a paraphrase.
  const SEEDED_AUDITOR = fs.readFileSync(
    path.join(fixturesDir, "seeded-auditor-v5.22.6.md"),
    "utf-8",
  );
  const SEEDED_OWL = fs.readFileSync(path.join(fixturesDir, "seeded-owl-v5.37.0.md"), "utf-8");

  it("the recorded hashes match the real seed files", () => {
    for (const [name, fixture] of [
      ["auditor.md", "seeded-auditor-v5.22.6.md"],
      ["skeptic.md", "seeded-skeptic-v5.22.6.md"],
      ["owl.md", "seeded-owl-v5.37.0.md"],
      ["bee.md", "seeded-bee-v5.37.0.md"],
    ]) {
      const content = fs.readFileSync(path.join(fixturesDir, fixture), "utf-8");
      const hash = createHash("sha256").update(content, "utf-8").digest("hex");
      expect(SHADOWING_SEEDED_AGENT_HASHES[name], name).toContain(hash);
    }
  });

  function tempAgentsDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ggcoder-agents-"));
    tempDirs.push(dir);
    return dir;
  }

  it("deletes an untouched seeded auditor.md so the bundled agent wins again", async () => {
    const dir = tempAgentsDir();
    fs.writeFileSync(path.join(dir, "auditor.md"), SEEDED_AUDITOR, "utf-8");

    await seedDefaultAgents(dir);

    expect(fs.existsSync(path.join(dir, "auditor.md"))).toBe(false);
    expect(BUNDLED_AGENTS.some((a) => a.name === "auditor")).toBe(true);
  });

  it("keeps a user-modified auditor.md", async () => {
    const dir = tempAgentsDir();
    const mine = SEEDED_AUDITOR + "\nMy own extra rule.\n";
    fs.writeFileSync(path.join(dir, "auditor.md"), mine, "utf-8");

    await seedDefaultAgents(dir);

    expect(fs.readFileSync(path.join(dir, "auditor.md"), "utf-8")).toBe(mine);
  });

  it("seeds nothing at all", async () => {
    const dir = tempAgentsDir();

    await seedDefaultAgents(dir);

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("deletes a previously seeded owl.md so the bundled owl wins again", async () => {
    const dir = tempAgentsDir();
    fs.writeFileSync(path.join(dir, "owl.md"), SEEDED_OWL, "utf-8");

    await seedDefaultAgents(dir);

    expect(fs.existsSync(path.join(dir, "owl.md"))).toBe(false);
    expect(BUNDLED_AGENTS.some((a) => a.name === "owl")).toBe(true);
  });

  it("keeps a user's own owl.md", async () => {
    const dir = tempAgentsDir();
    fs.writeFileSync(path.join(dir, "owl.md"), "mine", "utf-8");

    await seedDefaultAgents(dir);

    expect(fs.readFileSync(path.join(dir, "owl.md"), "utf-8")).toBe("mine");
  });
});

describe("projectScopeAllowed", () => {
  it("returns true when the global trust toggle is on", () => {
    expect(projectScopeAllowed(true, [], "/some/path")).toBe(true);
  });

  it("returns true when the cwd is in trustedProjects", () => {
    const trusted = path.resolve("/trusted/repo");
    expect(projectScopeAllowed(false, [trusted], trusted)).toBe(true);
  });

  it("returns false when neither global nor per-repo trust applies", () => {
    const other = path.resolve("/other/repo");
    const here = path.resolve("/this/repo");
    expect(projectScopeAllowed(false, [other], here)).toBe(false);
    expect(projectScopeAllowed(false, [], here)).toBe(false);
  });

  it("resolves relative paths before checking trustedProjects", () => {
    const abs = path.resolve("relative/dir");
    expect(projectScopeAllowed(false, [abs], "relative/dir")).toBe(true);
  });
});

// find-skills was seeded into ~/.gg/skills and has since been retired; the
// untouched seeded copy must go, an edited one must stay.
describe("removeRetiredSeededSkills", () => {
  const fixtures = ["seeded-find-skills-original.md", "seeded-find-skills-trimmed.md"];

  function tempSkillsDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "ggcoder-skills-"));
  }

  it("the recorded hashes match the real seed files", () => {
    for (const fixture of fixtures) {
      const content = fs.readFileSync(path.join(fixturesDir, fixture), "utf-8");
      const hash = createHash("sha256").update(content, "utf-8").digest("hex");
      expect(RETIRED_SEEDED_SKILL_HASHES["find-skills.md"], fixture).toContain(hash);
    }
  });

  it("deletes every untouched seeded find-skills copy", async () => {
    for (const fixture of fixtures) {
      const dir = tempSkillsDir();
      try {
        const file = path.join(dir, "find-skills.md");
        fs.copyFileSync(path.join(fixturesDir, fixture), file);
        await removeRetiredSeededSkills(dir);
        expect(fs.existsSync(file), fixture).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("keeps a find-skills copy the user edited", async () => {
    const dir = tempSkillsDir();
    try {
      const file = path.join(dir, "find-skills.md");
      const seeded = fs.readFileSync(path.join(fixturesDir, fixtures[0] ?? ""), "utf-8");
      fs.writeFileSync(file, `${seeded}\nMy own note.\n`);
      await removeRetiredSeededSkills(dir);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
