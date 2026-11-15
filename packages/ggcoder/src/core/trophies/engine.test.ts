import { describe, expect, it } from "vitest";
import { TROPHIES, TROPHY_CATEGORY_IDS } from "./catalog.js";
import {
  EMPTY_PROGRESS_FACTS,
  LONG_RUN_MS,
  applyDelta,
  buildTrophySnapshot,
  evaluateTrophies,
  mentionedPaths,
  promptDelta,
  runDelta,
  slashCommandName,
  type TrophyRunFacts,
} from "./engine.js";
import { createEmptyTrophies } from "./store.js";

const NOW = new Date("2026-10-21T12:00:00Z");

const run = (over: Partial<TrophyRunFacts> = {}): TrophyRunFacts => ({
  mode: "code",
  goal: false,
  provider: "anthropic",
  model: "claude-opus",
  tools: [],
  durationMs: 60_000,
  hour: 14,
  day: 3,
  date: "2026-10-21",
  project: "p1",
  ...over,
});

const calls = (...names: string[]) => names.map((name) => ({ name }));

describe("trophy catalog", () => {
  it("has unique ids, positive goals and known categories", () => {
    const ids = TROPHIES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TROPHIES) {
      expect(t.goal).toBeGreaterThan(0);
      expect(TROPHY_CATEGORY_IDS).toContain(t.category);
      expect(t.hint.length).toBeGreaterThan(0);
    }
  });

  it("uses no em dashes in shown copy", () => {
    for (const t of TROPHIES) {
      expect(`${t.title} ${t.description} ${t.hint}`).not.toContain("\u2014");
    }
  });

  it("ramps from easy to hard: every category starts below its hardest tier", () => {
    const tierRank = { bronze: 0, silver: 1, gold: 2, platinum: 3 } as const;
    const counts = { bronze: 0, silver: 0, gold: 0, platinum: 0 };
    for (const t of TROPHIES) counts[t.tier]++;
    expect(counts.bronze).toBeGreaterThan(counts.platinum);
    expect(Math.max(...TROPHIES.map((t) => tierRank[t.tier]))).toBe(3);
  });

  it("has at least 100 trophies", () => {
    expect(TROPHIES.length).toBeGreaterThanOrEqual(100);
  });

  it("never asks for more distinct things than the app has", () => {
    // Built-in workflows + add-dir/remove-dir, bundled skills, chat agents,
    // radio stations and checklist items, as shipped.
    const limits: Record<string, number> = {
      slashCommandNames: 8,
      skillsUsed: 11,
      chatAgents: 3,
      radioStations: 19,
      checklistItems: 24,
    };
    for (const t of TROPHIES) {
      if (t.stat.kind === "distinct" && limits[t.stat.key] !== undefined) {
        expect(t.goal, t.id).toBeLessThanOrEqual(limits[t.stat.key] ?? 0);
      }
    }
  });

  it("asks Completionist for every other trophy", () => {
    const last = TROPHIES.find((t) => t.id === "completionist");
    expect(last?.goal).toBe(TROPHIES.length - 1);
  });
});

describe("applyDelta", () => {
  it("adds to counters and dedupes set members", () => {
    const file = createEmptyTrophies(NOW);
    applyDelta(file, { count: { slashCommands: 1 }, add: { slashCommandNames: ["commit"] } });
    applyDelta(file, {
      count: { slashCommands: 2 },
      add: { slashCommandNames: ["commit", "init"] },
    });
    expect(file.counters.slashCommands).toBe(3);
    expect(file.sets.slashCommandNames).toEqual(["commit", "init"]);
  });

  it("ignores unknown keys, negatives and non-finite numbers", () => {
    const file = createEmptyTrophies(NOW);
    applyDelta(file, {
      count: { slashCommands: -4, steers: Number.NaN, nope: 3 } as never,
      add: { nope: ["x"] } as never,
    });
    expect(file.counters).toEqual({});
    expect(file.sets).toEqual({});
  });

  it("caps sets", () => {
    const file = createEmptyTrophies(NOW);
    applyDelta(file, { add: { chatAgents: Array.from({ length: 20 }, (_, i) => `a${i}`) } });
    expect(file.sets.chatAgents?.length).toBe(8);
  });
});

describe("evaluateTrophies", () => {
  it("unlocks once the goal is met, and only once", () => {
    const file = createEmptyTrophies(NOW);
    expect(evaluateTrophies(file, EMPTY_PROGRESS_FACTS, NOW)).toEqual([]);
    applyDelta(file, { count: { slashCommands: 1 } });
    expect(evaluateTrophies(file, EMPTY_PROGRESS_FACTS, NOW)).toEqual(["slash"]);
    expect(evaluateTrophies(file, EMPTY_PROGRESS_FACTS, NOW)).toEqual([]);
    expect(file.unlocked.slash).toBe(NOW.toISOString());
  });

  it("starts from zero: XP earned before trophies began doesn't count", () => {
    const file = createEmptyTrophies(NOW);
    const before = { prompts: 5000, commits: 900, linesShipped: 200_000, level: 40 };
    file.baseline = before;
    expect(evaluateTrophies(file, before, NOW)).toEqual([]);
    // With no baseline yet, nothing has happened since trophies began.
    expect(evaluateTrophies(createEmptyTrophies(NOW), before, NOW)).toEqual([]);
  });

  it("counts XP gained since trophies began", () => {
    const file = createEmptyTrophies(NOW);
    file.baseline = { prompts: 5000, commits: 900, linesShipped: 0, level: 40 };
    const ids = evaluateTrophies(
      file,
      { prompts: 5120, commits: 930, linesShipped: 0, level: 50 },
      NOW,
    );
    expect(ids).toEqual(
      expect.arrayContaining(["first-run", "commit", "shipper", "prompts-100", "level-10"]),
    );
    expect(ids).not.toContain("ship-it");
    expect(ids).not.toContain("level-15");
  });

  it("tracks its own day streak from finished runs", () => {
    const file = createEmptyTrophies(NOW);
    file.baseline = EMPTY_PROGRESS_FACTS;
    for (const day of ["2026-10-19", "2026-10-20", "2026-10-20", "2026-10-21"]) {
      applyDelta(file, { activeDay: day });
    }
    expect(file.streak).toEqual({ last: "2026-10-21", current: 3, best: 3 });
    expect(evaluateTrophies(file, EMPTY_PROGRESS_FACTS, NOW)).toContain("streak-3");
    // A missed day restarts the current streak but keeps the best.
    applyDelta(file, { activeDay: "2026-10-23" });
    expect(file.streak).toEqual({ last: "2026-10-23", current: 1, best: 3 });
    // Across a month end, and a clock that moved back changes nothing.
    applyDelta(file, { activeDay: "2026-10-31" });
    applyDelta(file, { activeDay: "2026-11-01" });
    expect(file.streak.current).toBe(2);
    applyDelta(file, { activeDay: "2026-10-30" });
    expect(file.streak.current).toBe(2);
  });

  it("counts projects worked in since trophies began", () => {
    const file = createEmptyTrophies(NOW);
    file.baseline = EMPTY_PROGRESS_FACTS;
    applyDelta(file, runDelta(run({ project: "a" })));
    applyDelta(file, runDelta(run({ project: "a" })));
    expect(evaluateTrophies(file, EMPTY_PROGRESS_FACTS, NOW)).not.toContain("projects-2");
    applyDelta(file, runDelta(run({ project: "b" })));
    expect(evaluateTrophies(file, EMPTY_PROGRESS_FACTS, NOW)).toContain("projects-2");
  });

  it("chains into trophies that count trophies", () => {
    const file = createEmptyTrophies(NOW);
    for (const t of TROPHIES) {
      if (t.id !== "hunter" && t.id !== "completionist") file.unlocked[t.id] = NOW.toISOString();
    }
    expect(evaluateTrophies(file, EMPTY_PROGRESS_FACTS, NOW)).toEqual(["hunter", "completionist"]);
  });
});

describe("buildTrophySnapshot", () => {
  it("redacts unearned secrets and caps progress at the goal", () => {
    const file = createEmptyTrophies(NOW);
    applyDelta(file, { count: { plansApproved: 40 } });
    const snap = buildTrophySnapshot(file, EMPTY_PROGRESS_FACTS);
    const owl = snap.trophies.find((t) => t.id === "night-owl");
    expect(owl).toMatchObject({ title: "Secret trophy", description: "", secret: true });
    const architect = snap.trophies.find((t) => t.id === "architect");
    expect(architect).toMatchObject({ current: 25, goal: 25, unlockedAt: null });
    expect(snap.total).toBe(TROPHIES.length);
    expect(snap.earned).toBe(0);
  });

  it("reveals a secret once earned", () => {
    const file = createEmptyTrophies(NOW);
    file.unlocked["night-owl"] = NOW.toISOString();
    const owl = buildTrophySnapshot(file, EMPTY_PROGRESS_FACTS).trophies.find(
      (t) => t.id === "night-owl",
    );
    expect(owl?.title).toBe("Night owl");
    expect(owl?.current).toBe(owl?.goal);
  });
});

describe("runDelta", () => {
  it("counts each kind of tool once per run and remembers tools and models", () => {
    const delta = runDelta(
      run({
        tools: calls("web_search", "web_fetch", "skill", "mcp__github__issues", "mcp__github__pr"),
      }),
    );
    expect(delta.count).toMatchObject({ webRuns: 1, skillRuns: 1, mcpRuns: 1 });
    expect(delta.add?.toolsUsed).toEqual(["mcp__github", "skill", "web_fetch", "web_search"]);
    expect(delta.add?.modelsUsed).toEqual(["anthropic/claude-opus"]);
  });

  it("counts Goal workers instead of helpers inside a Goal", () => {
    const delta = runDelta(run({ goal: true, tools: calls("spawn_agent", "spawn_agent", "read") }));
    expect(delta.count?.goalWorkers).toBe(2);
    expect(delta.count?.subagentRuns).toBeUndefined();
  });

  it("marks chat, motion, local, late and long runs", () => {
    expect(runDelta(run({ mode: "chat", chatAgent: "therapist" })).add?.chatAgents).toEqual([
      "therapist",
    ]);
    expect(runDelta(run({ mode: "motion" })).count?.motionRuns).toBe(1);
    expect(runDelta(run({ provider: "local" })).count?.localRuns).toBe(1);
    expect(runDelta(run({ hour: 2 })).count?.nightRuns).toBe(1);
    expect(runDelta(run({ hour: 5 })).count?.nightRuns).toBeUndefined();
    expect(runDelta(run({ durationMs: LONG_RUN_MS })).count?.longRuns).toBe(1);
  });
});

describe("runDelta reads tool arguments", () => {
  it("spots pushes and pull requests in shell commands", () => {
    const bash = (command: string) => ({ name: "bash", args: { command } });
    expect(runDelta(run({ tools: [bash("git push origin main")] })).count?.pushes).toBe(1);
    expect(runDelta(run({ tools: [bash("npm test && git -C app push")] })).count?.pushes).toBe(1);
    expect(runDelta(run({ tools: [bash("git push --dry-run")] })).count?.pushes).toBeUndefined();
    expect(runDelta(run({ tools: [bash("echo git pushes")] })).count?.pushes).toBeUndefined();
    expect(runDelta(run({ tools: [bash('gh pr create --title "x"')] })).count?.pullRequests).toBe(
      1,
    );
    expect(runDelta(run({ tools: [bash("gh pr list")] })).count?.pullRequests).toBeUndefined();
  });

  it("counts background shells, distinct files touched and big changes", () => {
    const bg = { name: "bash", args: { command: "npm run dev", run_in_background: true } };
    expect(runDelta(run({ tools: [bg] })).count?.backgroundRuns).toBe(1);
    const files = Array.from({ length: 10 }, (_, i) => ({
      name: "write",
      args: { file_path: `src/f${i}.ts` },
    }));
    const multi = {
      name: "edit",
      args: { files: [{ file_path: "src/f0.ts" }, { file_path: "a.ts" }] },
    };
    const delta = runDelta(run({ tools: [...files, multi] }));
    expect(delta.count?.filesTouched).toBe(11);
    expect(delta.count?.bigRuns).toBe(1);
  });

  it("counts only checklist records, and remembers which items and skills", () => {
    const status = { name: "checklist", args: { action: "status" } };
    expect(runDelta(run({ tools: [status] })).count?.checklistRecords).toBeUndefined();
    const record = { name: "checklist", args: { action: "record", id: "tests" } };
    const skill = { name: "skill", args: { skill: "TDD" } };
    const delta = runDelta(run({ tools: [record, record, skill] }));
    expect(delta.count?.checklistRecords).toBe(2);
    expect(delta.add?.checklistItems).toEqual(["tests"]);
    expect(delta.add?.skillsUsed).toEqual(["tdd"]);
  });

  it("marks early, weekend and chat memory runs", () => {
    expect(runDelta(run({ hour: 6 })).count?.earlyRuns).toBe(1);
    expect(runDelta(run({ day: 6 })).count?.weekendRuns).toBe(1);
    expect(runDelta(run({ day: 2 })).count?.weekendRuns).toBeUndefined();
    const chat = runDelta(
      run({ mode: "chat", tools: calls("remember", "set_jiwa", "delegate_to_agent") }),
    );
    expect(chat.count).toMatchObject({ memoriesSaved: 1, soulNotes: 1, handoffs: 1 });
  });
});

describe("prompt facts", () => {
  it("parses slash commands", () => {
    expect(slashCommandName("/commit fix the thing")).toBe("commit");
    expect(slashCommandName("  /Setup-Commit")).toBe("setup-commit");
    expect(slashCommandName("not /a command")).toBeNull();
    expect(slashCommandName("/")).toBeNull();
  });

  it("reads the app's Referenced files list", () => {
    const sent = "Fix the header\n\nReferenced files:\n- src/App.tsx\n- src/Deck.tsx";
    expect(mentionedPaths(sent)).toEqual(["src/App.tsx", "src/Deck.tsx"]);
    expect(mentionedPaths("Referenced files:\n- a.ts")).toEqual(["a.ts"]);
    expect(mentionedPaths("see Referenced files:\n- a.ts")).toEqual([]);
  });

  it("finds @file mentions but not @Ken or emails", () => {
    expect(
      mentionedPaths("@Ken look at @src/App.tsx and me@example.com, then @README.md."),
    ).toEqual(["src/App.tsx", "README.md"]);
  });

  it("routes /add-dir to its own counter, not slash commands", () => {
    const base = {
      customCommand: false,
      enhanced: false,
      attachments: 0,
      fileMentions: 0,
      steer: false,
    };
    expect(promptDelta({ ...base, command: "add-dir" }).count).toEqual({ addDirs: 1 });
    expect(promptDelta({ ...base, command: "mine", customCommand: true })).toEqual({
      count: { slashCommands: 1, customCommands: 1 },
      add: { slashCommandNames: ["mine"] },
    });
  });
});
