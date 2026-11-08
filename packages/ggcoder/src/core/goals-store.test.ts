import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAskUserTool } from "../tools/ask-user.js";
import { encodeCwd } from "./encode-cwd.js";
import {
  GOAL_HOLD_OPTION,
  GOAL_START_OPTION,
  createGoal,
  deleteGoal,
  goalKickoffPrompt,
  goalPhase,
  isGoalStartAnswer,
  isGoalStartMessage,
  startGoalOnAnswer,
  markGoalStarted,
  setGoalCritterModel,
  goalSlug,
  isGoalDir,
  listGoals,
  markGoalKickoff,
  readGoal,
  readGoalMemory,
  renderGoalPrompt,
  goalWasInterrupted,
  goalResumePrompt,
  setGoalPaused,
  updateGoal,
  GOAL_MEMORY_FILE,
  GOAL_MEMORY_MAX,
} from "./goals-store.js";

const NOW = new Date("2026-10-10T12:00:00.000Z");

describe("goals store", () => {
  let tmp: string;
  let root: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-goals-"));
    root = path.join(tmp, "goals");
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("creates a goal folder with a validated record and resolved context kinds", async () => {
    const repo = path.join(tmp, "api");
    const spec = path.join(tmp, "spec.md");
    await fs.mkdir(repo);
    await fs.writeFile(spec, "# spec");

    const created = await createGoal(
      root,
      { name: "  API Latency ", goal: "Bring p95 under 200 ms", context: [repo, spec, repo] },
      NOW,
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.dir).toBe(path.join(root, "api-latency"));
    expect(created.value.record).toEqual({
      schemaVersion: 1,
      id: "api-latency",
      name: "API Latency",
      goal: "Bring p95 under 200 ms",
      context: [
        { path: repo, kind: "folder" },
        { path: spec, kind: "file" },
      ],
      createdAt: NOW.toISOString(),
    });
    expect(await readGoal(created.value.dir)).toEqual(created.value.record);
  });

  it("suffixes a taken folder name instead of overwriting the first goal", async () => {
    const first = await createGoal(root, { name: "Perf", goal: "a" }, NOW);
    const second = await createGoal(root, { name: "perf!", goal: "b" }, NOW);
    expect(first.ok && first.value.record.id).toBe("perf");
    expect(second.ok && second.value.record.id).toBe("perf-2");
    expect((await listGoals(root)).map((g) => g.record.goal)).toEqual(["a", "b"]);
  });

  it("rejects missing fields and relative or missing context paths", async () => {
    expect(await createGoal(root, { name: " ", goal: "x" }, NOW)).toEqual({
      ok: false,
      error: "Give the goal a name",
    });
    expect(await createGoal(root, { name: "x", goal: "" }, NOW)).toEqual({
      ok: false,
      error: "Describe the goal",
    });
    const relative = await createGoal(root, { name: "x", goal: "y", context: ["src"] }, NOW);
    expect(relative.ok).toBe(false);
    const missing = path.join(tmp, "nope");
    expect(await createGoal(root, { name: "x", goal: "y", context: [missing] }, NOW)).toEqual({
      ok: false,
      error: `Not found: ${missing}`,
    });
    expect(await listGoals(root)).toEqual([]);
  });

  it("caps new names at 15 characters but still reads older, longer ones", async () => {
    expect(await createGoal(root, { name: "x".repeat(16), goal: "g" }, NOW)).toEqual({
      ok: false,
      error: "Keep the name to 15 characters",
    });
    const dir = path.join(root, "legacy");
    await fs.mkdir(dir, { recursive: true });
    const legacy = {
      schemaVersion: 1,
      id: "legacy",
      name: "A much longer name than fifteen",
      goal: "g",
      context: [],
      createdAt: NOW.toISOString(),
    };
    await fs.writeFile(path.join(dir, "goal.json"), JSON.stringify(legacy));
    expect((await readGoal(dir))?.name).toBe(legacy.name);
  });

  it("deletes a goal's folder and its sessions but never its context", async () => {
    const repo = path.join(tmp, "repo");
    await fs.mkdir(repo);
    const sessionsDir = path.join(tmp, "sessions");
    const created = await createGoal(root, { name: "Gone", goal: "g", context: [repo] }, NOW);
    if (!created.ok) throw new Error(created.error);
    const sessions = path.join(sessionsDir, encodeCwd(created.value.dir));
    await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(path.join(sessions, "s.jsonl"), "{}\n");

    expect(await deleteGoal(root, sessionsDir, "gone")).toEqual({
      ok: true,
      value: { dir: created.value.dir },
    });

    await expect(fs.stat(created.value.dir)).rejects.toThrow();
    await expect(fs.stat(sessions)).rejects.toThrow();
    expect((await fs.stat(repo)).isDirectory()).toBe(true);
  });

  it("refuses to delete anything that is not a goal folder", async () => {
    const sessionsDir = path.join(tmp, "sessions");
    await fs.mkdir(path.join(root, "plain"), { recursive: true });
    for (const id of ["", "..", "../goals", "plain", "missing", "a/b"]) {
      expect(await deleteGoal(root, sessionsDir, id)).toEqual({
        ok: false,
        error: "Unknown goal",
      });
    }
    expect((await fs.stat(path.join(root, "plain"))).isDirectory()).toBe(true);
  });

  it("starts a goal only on the start answer, and only once", async () => {
    const created = await createGoal(root, { name: "Go", goal: "g" }, NOW);
    if (!created.ok) throw new Error(created.error);
    expect(goalPhase(created.value.record)).toBe("briefing");

    expect(isGoalStartAnswer({ action: "answer", answers: { q: GOAL_START_OPTION } })).toBe(true);
    expect(
      isGoalStartAnswer({
        action: "answer",
        answers: { q: [` ${GOAL_START_OPTION.toUpperCase()}`] },
      }),
    ).toBe(true);
    expect(isGoalStartAnswer({ action: "answer", answers: { q: GOAL_HOLD_OPTION } })).toBe(false);
    // Live run: Kleio Goals gave the start option a value, and the answer came back as it.
    const asked = [
      {
        id: "start",
        question: "Ready to begin?",
        kind: "choice" as const,
        options: [
          { label: GOAL_START_OPTION, value: "start" },
          { label: GOAL_HOLD_OPTION, value: "discuss" },
        ],
      },
    ];
    expect(isGoalStartAnswer({ action: "answer", answers: { start: "start" } }, asked)).toBe(true);
    expect(isGoalStartAnswer({ action: "answer", answers: { start: "discuss" } }, asked)).toBe(
      false,
    );
    expect(isGoalStartAnswer({ action: "answer", answers: { start: "start" } })).toBe(false);
    expect(isGoalStartAnswer({ action: "cancel" })).toBe(false);

    const started = await markGoalStarted(created.value.dir, NOW);
    expect(started && goalPhase(started)).toBe("active");
    expect(await markGoalStarted(created.value.dir, NOW)).toBeNull();
    expect((await readGoal(created.value.dir))?.startedAt).toBe(NOW.toISOString());
  });

  it("starts a goal from the start option however a local model words it (#133)", () => {
    const yes = (answer: string, asked?: Parameters<typeof isGoalStartAnswer>[1]) =>
      isGoalStartAnswer({ action: "answer", answers: { q: answer } }, asked);
    expect(yes(`${GOAL_START_OPTION} (recommended)`)).toBe(true);
    expect(yes(`✅ ${GOAL_START_OPTION}!`)).toBe(true);
    expect(yes("Yes, start the goal now")).toBe(true);
    expect(yes("Start goal")).toBe(true);
    expect(yes("Don't start the goal yet")).toBe(false);
    expect(yes("Not yet, start the goal later")).toBe(false);
    expect(yes(GOAL_HOLD_OPTION)).toBe(false);
    expect(yes("Start with the homepage")).toBe(false);

    const valued = [
      {
        id: "q",
        question: "Ready?",
        kind: "choice" as const,
        options: [
          { label: `🚀 ${GOAL_START_OPTION} (recommended)`, value: "go" },
          { label: GOAL_HOLD_OPTION, value: "wait" },
        ],
      },
    ];
    expect(yes("go", valued)).toBe(true);
    expect(yes("wait", valued)).toBe(false);

    const confirm = [{ id: "q", question: "Start the goal now?", kind: "confirm" as const }];
    expect(yes("yes", confirm)).toBe(true);
    expect(yes("no", confirm)).toBe(false);
    // A yes to some other question never starts the goal.
    expect(
      isGoalStartAnswer({ action: "answer", answers: { other: "yes" } }, [
        ...confirm,
        { id: "other", question: "Use TypeScript?", kind: "confirm" as const },
      ]),
    ).toBe(false);
  });

  it("takes a typed instruction to start, never a question or a conditional (#133)", () => {
    for (const text of [
      "Start the goal now",
      "Yes, start the goal now.",
      "ok start goal",
      "  START THE GOAL ",
    ]) {
      expect(isGoalStartMessage(text)).toBe(true);
    }
    for (const text of [
      "Should we start the goal now?",
      "Don't start the goal yet",
      "Before you start the goal, use TypeScript",
      "Start the goal tomorrow",
      "If it looks fine, start the goal",
      "Yes",
      "Start with the homepage",
      `Start the goal now. ${"Also remember this detail. ".repeat(10)}`,
    ]) {
      expect(isGoalStartMessage(text)).toBe(false);
    }
  });

  it("keeps every write when two goal updates land at once", async () => {
    const created = await createGoal(root, { name: "Race", goal: "g" }, NOW);
    if (!created.ok) throw new Error(created.error);
    const { dir } = created.value;
    // Both writes used to share one temp file, so one rename failed.
    const results = await Promise.allSettled([
      markGoalStarted(dir, NOW),
      markGoalKickoff(dir, NOW),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    // And neither overwrites the other: a lost startedAt sent the goal back to its briefing.
    const record = await readGoal(dir);
    expect(record?.startedAt).toBe(NOW.toISOString());
    expect(record?.kickoffAt).toBe(NOW.toISOString());
  });

  it("starts a goal from a start answer that arrives after the question's deadline", async () => {
    // Regression: past ask_user's soft deadline the answer comes back as a
    // late answer (only its answers, no "answer" action), which never
    // started the goal, leaving Kleio Goals unable to hand out any work.
    const created = await createGoal(root, { name: "Late", goal: "g" }, NOW);
    if (!created.ok) throw new Error(created.error);
    const { dir, record } = created.value;
    const late = { answers: { start: [GOAL_START_OPTION] } };

    expect(
      await startGoalOnAnswer(
        dir,
        record,
        { action: "answer", answers: { q: GOAL_HOLD_OPTION } },
        NOW,
      ),
    ).toBeNull();
    const started = await startGoalOnAnswer(dir, record, { action: "answer", ...late }, NOW);
    expect(started && goalPhase(started)).toBe("active");
    expect((await readGoal(dir))?.startedAt).toBe(NOW.toISOString());
    // Once started, a second start answer changes nothing.
    if (!started) throw new Error("expected the goal to start");
    expect(await startGoalOnAnswer(dir, started, { action: "answer", ...late }, NOW)).toBeNull();
  });

  it("pins and clears the workers' model on the goal", async () => {
    const created = await createGoal(root, { name: "Pick", goal: "g" }, NOW);
    if (!created.ok) throw new Error(created.error);
    const pinned = await setGoalCritterModel(created.value.dir, {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    });
    expect(pinned?.critterModel).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect((await readGoal(created.value.dir))?.critterModel?.model).toBe("claude-sonnet-5-5");
    const cleared = await setGoalCritterModel(created.value.dir, null);
    expect(cleared && "critterModel" in cleared).toBe(false);
    expect(await setGoalCritterModel(path.join(root, "missing"), null)).toBeNull();
  });

  it("marks the kickoff exactly once", async () => {
    const created = await createGoal(root, { name: "Once", goal: "g" }, NOW);
    if (!created.ok) throw new Error(created.error);
    const later = new Date("2026-10-10T12:01:00.000Z");
    const first = await markGoalKickoff(created.value.dir, later);
    expect(first?.kickoffAt).toBe(later.toISOString());
    expect(await markGoalKickoff(created.value.dir, later)).toBeNull();
  });

  it("skips folders without a valid goal record", async () => {
    await fs.mkdir(path.join(root, "junk"), { recursive: true });
    await fs.writeFile(path.join(root, "junk", "goal.json"), "{not json");
    expect(await listGoals(root)).toEqual([]);
  });

  it("only treats a direct child of the goals root as a goal folder", () => {
    expect(isGoalDir(root, path.join(root, "perf"))).toBe(true);
    expect(isGoalDir(root, root)).toBe(false);
    expect(isGoalDir(root, path.join(root, "perf", "nested"))).toBe(false);
    expect(isGoalDir(root, path.join(tmp, "elsewhere"))).toBe(false);
  });

  it("slugs names into safe folder names", () => {
    expect(goalSlug("Site Performance!")).toBe("site-performance");
    expect(goalSlug("../../etc")).toBe("etc");
    expect(goalSlug("???")).toBe("");
  });

  it("renders a brief that carries the goal and its context", async () => {
    const created = await createGoal(root, { name: "Brief", goal: "Ship it" }, NOW);
    if (!created.ok) throw new Error(created.error);
    const brief = renderGoalPrompt(created.value.dir, created.value.record);
    expect(brief).toContain('coordinating the goal "Brief"');
    expect(brief).toContain("Ship it");
    expect(brief).toContain("(none attached yet)");
    // goals-vs-coder bench: a bare `npm test` ran in the goal folder (no
    // package.json) and left a failed check the passing `cd … &&` rerun
    // could not clear, so the brief says where commands start.
    expect(brief).toContain("Your own commands start in the goal folder, not in an attached one");
    expect(goalKickoffPrompt(created.value.record)).toContain("Brief");
  });

  it("keeps standing instructions, and lets context and instructions change later", async () => {
    const ctxDir = path.join(tmp, "site");
    const other = path.join(tmp, "docs");
    await fs.mkdir(ctxDir);
    await fs.mkdir(other);
    const created = await createGoal(
      root,
      { name: "Rules", goal: "g", context: [ctxDir], instructions: "Don't touch CI." },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);
    expect(created.value.record.instructions).toBe("Don't touch CI.");
    expect(renderGoalPrompt(created.value.dir, created.value.record)).toContain(
      "## Standing instructions from the user\nThey hold for the whole goal and override your own defaults.\nDon't touch CI.",
    );

    // Attach another folder and change the rules after creating it.
    const updated = await updateGoal(created.value.dir, {
      context: [ctxDir, other],
      instructions: "Ask before deleting anything.",
    });
    if (!updated.ok) throw new Error(updated.error);
    expect(updated.value.context.map((c) => c.path)).toEqual([ctxDir, other]);
    expect((await readGoal(created.value.dir))?.instructions).toBe("Ask before deleting anything.");
    // An empty string clears them; a missing path is refused, nothing written.
    const cleared = await updateGoal(created.value.dir, { instructions: "" });
    expect(cleared.ok && cleared.value.instructions).toBeUndefined();
    const bad = await updateGoal(created.value.dir, { context: [path.join(tmp, "gone")] });
    expect(bad.ok).toBe(false);
    expect((await readGoal(created.value.dir))?.context).toHaveLength(2);
  });

  it("carries the goal's memory and its projects' rules in the brief", async () => {
    const created = await createGoal(root, { name: "Mem", goal: "g" }, NOW);
    if (!created.ok) throw new Error(created.error);
    const { dir, record } = created.value;
    // No memory yet: the brief says where to keep it.
    expect(await readGoalMemory(dir)).toBe("");
    expect(renderGoalPrompt(dir, record)).toContain(`${path.join(dir, GOAL_MEMORY_FILE)}`);
    expect(renderGoalPrompt(dir, record)).toContain("Nothing written yet.");

    await fs.writeFile(path.join(dir, GOAL_MEMORY_FILE), "- The user wants plain HTML.\n");
    const memory = await readGoalMemory(dir);
    const brief = renderGoalPrompt(dir, record, {
      memory,
      projectRules: [
        { folder: "/p/site", rules: ["### AGENTS.md\n\nRun npm test before you finish."] },
      ],
    });
    expect(brief).toContain("Current memory:\n- The user wants plain HTML.");
    expect(brief).toContain("## Project rules: /p/site");
    expect(brief).toContain("Run npm test before you finish.");

    // A long memory is cut, with a note to keep it short.
    await fs.writeFile(path.join(dir, GOAL_MEMORY_FILE), "x".repeat(GOAL_MEMORY_MAX + 500));
    const long = await readGoalMemory(dir);
    expect(long.length).toBeLessThan(GOAL_MEMORY_MAX + 200);
    expect(long).toContain("keep MEMORY.md short");
  });

  it("knows when a started goal was cut off mid-work, and not when it's paused or idle", async () => {
    const created = await createGoal(root, { name: "Cut", goal: "g" }, NOW);
    if (!created.ok) throw new Error(created.error);
    const started = await markGoalStarted(created.value.dir, NOW);
    if (!started) throw new Error("not started");
    const toolCall = { role: "assistant", content: [{ type: "tool_call", id: "1", name: "bash" }] };
    const replied = { role: "assistant", content: [{ type: "text", text: "Done." }] };
    // Kleio Goals' own turn stopped mid-tool: resume.
    expect(goalWasInterrupted(started, [toolCall], [])).toBe(true);
    expect(goalWasInterrupted(started, [toolCall, { role: "tool" }], [])).toBe(true);
    // A message it never got to answer.
    expect(goalWasInterrupted(started, [replied, { role: "user", content: "go" }], [])).toBe(true);
    // A worker the restart stopped: resume.
    expect(
      goalWasInterrupted(started, [replied], [{ state: "interrupted", recovered: true }]),
    ).toBe(true);
    // Finished cleanly, still briefing, or paused: nothing to resume.
    expect(goalWasInterrupted(started, [replied], [{ state: "completed", recovered: true }])).toBe(
      false,
    );
    // Still briefing and never kicked off: nothing to resume.
    expect(goalWasInterrupted(created.value.record, [toolCall], [])).toBe(false);
    // Briefing, its question cut off when the window switched away (live
    // run, "Page load"): resume, and ask again rather than carry on working.
    const briefing = { ...created.value.record, kickoffAt: NOW.toISOString() };
    expect(goalWasInterrupted(briefing, [toolCall, { role: "tool" }], [])).toBe(true);
    expect(goalWasInterrupted(briefing, [replied], [])).toBe(false);
    expect(goalResumePrompt(briefing)).toMatch(/Ask it again now, in one ask_user card/);
    const paused = await setGoalPaused(created.value.dir, true, NOW);
    if (!paused) throw new Error("not paused");
    expect(goalWasInterrupted(paused, [toolCall], [])).toBe(false);
    expect((await setGoalPaused(created.value.dir, false, NOW))?.pausedAt).toBeUndefined();
    expect(goalResumePrompt(started)).toMatch(/Don't redo finished work/);
  });

  it("briefs before working and ends on a start question ask_user accepts", async () => {
    const created = await createGoal(root, { name: "Gate", goal: "g" }, NOW);
    if (!created.ok) throw new Error(created.error);
    const brief = renderGoalPrompt(created.value.dir, created.value.record);
    expect(brief).toContain(`"${GOAL_START_OPTION}"`);
    expect(brief).toContain(`"${GOAL_HOLD_OPTION}"`);
    expect(goalKickoffPrompt(created.value.record)).toContain("Do not start the work");
    // Everything the work needs is asked up front, in one card with the start
    // question, so the goal can then run while the user is away.
    expect(brief).toMatch(/the user may walk away until it's done, so ask now/);
    expect(brief).toMatch(/Decide small details yourself/);
    expect(brief).toMatch(/One card, so the user answers once/);
    // Live run: its first look was a bash command, refused during the briefing.
    expect(goalKickoffPrompt(created.value.record)).toMatch(
      /with read, ls and find only \(bash, edit and write stay locked/,
    );

    // Neither label may trip ask_user's "defers back to the user" guard.
    const asked: unknown[] = [];
    const tool = createAskUserTool(async (request) => {
      asked.push(request);
      return { action: "answer", answers: { start: GOAL_START_OPTION } };
    });
    const result = await tool.execute(
      {
        questions: [
          {
            id: "start",
            question: "Ready to start?",
            kind: "choice",
            options: [{ label: GOAL_START_OPTION, recommended: true }, { label: GOAL_HOLD_OPTION }],
          },
        ],
      },
      {} as Parameters<typeof tool.execute>[1],
    );
    expect(asked).toHaveLength(1);
    expect(String(result)).not.toMatch(/^Error/);
  });
});
