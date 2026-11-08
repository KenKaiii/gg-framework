import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionOptions } from "../core/agent-session.js";
import {
  GOAL_START_OPTION,
  createGoal,
  goalsRoot,
  goalKickoffPrompt,
  goalNeedsKickoff,
} from "../core/goals-store.js";
import { createAskUserTool } from "../tools/ask-user.js";
import {
  BRIEFING_ERROR,
  buildGoalsAgentPrompt,
  createGoalsAgentSession,
  loadGoalBriefExtras,
  goalCritterPick,
  GOALS_START_TOOLS,
  GOALS_WITHOUT_TOOLS,
  GOALS_SYSTEM_PROMPT,
  GOAL_STARTED_NOTE,
  GREET_FIRST_ERROR,
} from "./goals-agent.js";
import { GOAL_TEAM } from "./goal-team.js";
import { goalRunLive } from "../core/goal-run-marker.js";
import type { SubAgentSnapshot } from "../core/subagent-manager.js";

function optionsOf(agent: unknown): AgentSessionOptions {
  return (agent as { opts: AgentSessionOptions }).opts;
}

describe("Kleio Goals agent", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-goals-agent-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function goal() {
    const created = await createGoal(
      path.join(tmp, "goals"),
      { name: "Jobs", goal: "Find remote roles in Malaysia" },
      new Date("2026-10-10T00:00:00.000Z"),
    );
    if (!created.ok) throw new Error(created.error);
    return created.value;
  }

  it("is its own primary agent, not the coding agent, with the goal brief in its prompt", async () => {
    const g = await goal();
    const session = createGoalsAgentSession({
      provider: "anthropic",
      model: "claude-opus-5-5",
      cwd: g.dir,
      goal: g,
      transient: true,
    });
    const opts = optionsOf(session);

    expect(opts.agentPrompt).toBe(buildGoalsAgentPrompt(g));
    expect(opts.agentPrompt?.startsWith("You are Kleio Goals")).toBe(true);
    expect(opts.agentPrompt).toContain("Find remote roles in Malaysia");
    expect(opts.agentPrompt).toContain(GOAL_START_OPTION);
    expect(opts.agentRole).toBe("primary");
    expect(opts.agentContext).toBe("none");
    expect(opts.promptCacheKeyPrefix).toBe("gggoals");
    // Plans in the conversation, not through the coding agent's plan mode.
    expect(opts.onEnterPlan).toBeUndefined();
    expect(opts.onExitPlan).toBeUndefined();
    expect(opts.systemPrompt).toBeUndefined();
    expect(GOALS_SYSTEM_PROMPT).not.toContain("Kleio Coder agent");
  });

  it("reads its attached projects' AGENTS.md and its memory into its brief", async () => {
    // Its cwd is the goal folder, so the project rules of the folders it
    // works in never reached it; it now does most work itself.
    const project = path.join(tmp, "site");
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "AGENTS.md"), "Run `pnpm test` before you finish.\n");
    const created = await createGoal(
      path.join(tmp, "goals"),
      { name: "Site", goal: "Fix it", context: [project] },
      new Date("2026-10-10T00:00:00.000Z"),
    );
    if (!created.ok) throw new Error(created.error);
    await fs.writeFile(path.join(created.value.dir, "MEMORY.md"), "- Plain HTML only.\n");

    const extras = await loadGoalBriefExtras(created.value);
    const session = createGoalsAgentSession({
      provider: "anthropic",
      model: "claude-opus-5-5",
      cwd: created.value.dir,
      goal: created.value,
      extras,
      transient: true,
    });
    const prompt = optionsOf(session).agentPrompt ?? "";
    expect(prompt).toContain(`## Project rules: ${project}`);
    expect(prompt).toContain("Run `pnpm test` before you finish.");
    expect(prompt).toContain("Current memory:\n- Plain HTML only.");
  });

  it("runs with Ideal self-review suppressed, even after an autopilot toggle", async () => {
    const g = await goal();
    const session = createGoalsAgentSession({
      provider: "anthropic",
      model: "claude-opus-5-5",
      cwd: g.dir,
      goal: g,
      transient: true,
    });
    const suppressed = () =>
      (session as unknown as { idealReviewSuppressed: boolean }).idealReviewSuppressed;
    expect(suppressed()).toBe(true);
    // The sidecar resets this when autopilot is off; a goal session keeps it.
    session.setIdealReviewSuppressed(false);
    expect(suppressed()).toBe(true);
  });

  it("still needs its first reply when the conversation holds only the system prompt", async () => {
    const g = await goal();
    // Regression: a session carries its system message before anyone speaks,
    // which used to count as conversation and skip the automatic reply.
    expect(goalNeedsKickoff(g.record, [{ role: "system" }])).toBe(true);
    expect(goalNeedsKickoff(g.record, [{ role: "system" }, { role: "user" }])).toBe(false);
    expect(goalNeedsKickoff({ ...g.record, kickoffAt: "2026-10-10T00:00:00.000Z" }, [])).toBe(
      false,
    );
  });

  it("holds the question card until Kleio Goals has greeted the user", async () => {
    const g = await goal();
    const asked: unknown[] = [];
    const session = createGoalsAgentSession({
      provider: "anthropic",
      model: "claude-opus-5-5",
      cwd: g.dir,
      goal: g,
      transient: true,
      additionalTools: [
        createAskUserTool(async (request) => {
          asked.push(request);
          return { action: "answer", answers: { q: "Yes" } };
        }),
      ],
    });
    const askUser = optionsOf(session).additionalTools?.find((t) => t.name === "ask_user");
    if (!askUser) throw new Error("ask_user missing");
    const args = {
      questions: [
        {
          id: "q",
          question: "Remote only?",
          kind: "choice",
          options: [{ label: "Yes", recommended: true }, { label: "No" }],
        },
      ],
    };
    const ctx = { signal: new AbortController().signal, toolCallId: "t1" } as Parameters<
      typeof askUser.execute
    >[1];

    await expect(askUser.execute(args, ctx)).rejects.toThrow(GREET_FIRST_ERROR);
    expect(asked).toHaveLength(0);

    // Whitespace is not a greeting.
    session.eventBus.emit("text_delta", { text: "  \n" });
    await expect(askUser.execute(args, ctx)).rejects.toThrow(GREET_FIRST_ERROR);

    session.eventBus.emit("text_delta", { text: "Hi! You want remote roles in Malaysia." });
    expect(String(await askUser.execute(args, ctx))).not.toMatch(/^Error/);
    expect(asked).toHaveLength(1);
  });

  it("tells Kleio Goals to start the work when the answer it gets back starts the goal", async () => {
    // Live run ("Add a blog"): the start question rode on the briefing's card,
    // the kickoff said not to start work in that reply, and Kleio Goals stopped
    // right after the user started the goal.
    const g = await goal();
    let active = false;
    const session = createGoalsAgentSession({
      provider: "anthropic",
      model: "claude-opus-5-5",
      cwd: g.dir,
      goal: g,
      transient: true,
      isActive: () => active,
      additionalTools: [
        createAskUserTool(async () => {
          active = true;
          return { action: "answer", answers: { start: "Start the goal now" } };
        }),
      ],
    });
    const askUser = optionsOf(session).additionalTools?.find((t) => t.name === "ask_user");
    if (!askUser) throw new Error("ask_user missing");
    const args = {
      questions: [
        {
          id: "start",
          question: "Ready?",
          kind: "choice",
          options: [{ label: "Start the goal now", recommended: true }, { label: "Hang on" }],
        },
      ],
    };
    const ctx = { signal: new AbortController().signal, toolCallId: "t1" } as Parameters<
      typeof askUser.execute
    >[1];
    session.eventBus.emit("text_delta", { text: "Hi! Ready when you are." });
    expect(String(await askUser.execute(args, ctx))).toContain(GOAL_STARTED_NOTE.trim());
    // Once started, later answers come back as they are.
    expect(String(await askUser.execute(args, ctx))).not.toContain(GOAL_STARTED_NOTE.trim());
  });

  it("asks for the greeting and the goal before any question in the first reply", async () => {
    const g = await goal();
    const kickoff = goalKickoffPrompt(g.record);
    expect(kickoff.indexOf("greet the user")).toBeGreaterThan(-1);
    expect(kickoff.indexOf("ask_user card")).toBeGreaterThan(-1);
    expect(kickoff.indexOf("greet the user")).toBeLessThan(kickoff.indexOf("ask_user card"));
  });

  it("does nothing but read and ask until the goal starts, then works itself and starts workers", async () => {
    const g = await goal();
    let active = false;
    const session = createGoalsAgentSession({
      provider: "anthropic",
      model: "claude-opus-5-5",
      cwd: g.dir,
      goal: g,
      transient: true,
      isActive: () => active,
    });
    const opts = optionsOf(session);
    expect([...(opts.withoutTools ?? [])].sort()).toEqual([...GOALS_WITHOUT_TOOLS].sort());
    // Hybrid: it keeps edit, write and bash (held until the start), so it
    // does small and connected work itself instead of starting a cold worker.
    for (const name of ["edit", "write", "bash"]) {
      expect(opts.withoutTools).not.toContain(name);
      expect(GOALS_START_TOOLS.has(name)).toBe(true);
    }
    // No one-shot subagent either: it can't be sent to an attached folder,
    // so spawn_agent is the only way it starts work.
    expect(opts.withoutTools).toContain("subagent");
    // Its own team, never Kleio Coder's or the user's agents, sharing every
    // attached folder with each worker.
    expect(opts.subAgents).toBe(GOAL_TEAM);
    expect(opts.shareRootsWithSubAgents).toBe(true);
    // A worker spawned without naming an agent is still a team member.
    expect(opts.defaultSubAgent).toBe("builder");
    expect(GOAL_TEAM.map((a) => a.name)).toContain(opts.defaultSubAgent);
    const wrap = opts.wrapTool;
    if (!wrap) throw new Error("wrapTool missing");
    const ran: string[] = [];
    const tool = (name: string) =>
      wrap({
        name,
        description: `${name} tool`,
        parameters: {} as never,
        execute: async () => {
          ran.push(name);
          return "ok";
        },
      });
    const ctx = { signal: new AbortController().signal, toolCallId: "t" } as never;

    // Briefing: read and ask only. No edits, commands or workers yet.
    for (const name of ["edit", "write", "bash", "spawn_agent", "followup_task"]) {
      await expect(tool(name).execute({}, ctx)).rejects.toThrow(BRIEFING_ERROR);
    }
    await tool("read").execute({}, ctx);
    expect(ran).toEqual(["read"]);

    // Started: it works itself, and starts workers for big independent parts.
    active = true;
    for (const name of ["edit", "bash", "spawn_agent", "wait_agent", "web_fetch"]) {
      await tool(name).execute({}, ctx);
    }
    expect(ran).toEqual(["read", "edit", "bash", "spawn_agent", "wait_agent", "web_fetch"]);
    // Schemas never change, so the cached tool block stays stable.
    const wrapped = tool("spawn_agent");
    expect([wrapped.name, wrapped.description]).toEqual(["spawn_agent", "spawn_agent tool"]);
  });

  it("tells Kleio Goals to do the work itself, and start workers only for big independent parts", () => {
    // Live runs: one session beat a single cold worker on every small or
    // connected goal; workers only paid off on separate projects.
    expect(GOALS_SYSTEM_PROMPT).toMatch(/Do the work yourself by default/);
    expect(GOALS_SYSTEM_PROMPT).toMatch(
      /Never start a single worker for work you could do yourself/,
    );
    expect(GOALS_SYSTEM_PROMPT).toMatch(/big and independent of each other, two or more at once/);
    expect(GOALS_SYSTEM_PROMPT).toContain("cwd");
    // Its own work follows the team's rules.
    expect(GOALS_SYSTEM_PROMPT).toMatch(/work like your team does: change files in place/);
    // Hybrid run: its own research named a source but gave no link.
    expect(GOALS_SYSTEM_PROMPT).toMatch(/give the URL of every source you rely on in research/);
    expect(GOAL_STARTED_NOTE).toMatch(
      /do it yourself, or start workers for its big independent parts/,
    );
  });

  it("tells Kleio Goals to handle each worker as it finishes, retry failures once and escalate blockers", () => {
    // Waiting on "all" left early finishers idle until the slowest was done.
    expect(GOALS_SYSTEM_PROMPT).toContain('condition "any"');
    expect(GOALS_SYSTEM_PROMPT).toMatch(/Handle each worker the moment it finishes/);
    expect(GOALS_SYSTEM_PROMPT).toMatch(/retry once/);
    // No back and forth: a checker fixes its own findings, and each task
    // gets one fix round before the user hears about it.
    expect(GOALS_SYSTEM_PROMPT).toMatch(/never send a builder after a checker/);
    expect(GOALS_SYSTEM_PROMPT).toMatch(/at most one fix round/);
    expect(GOALS_SYSTEM_PROMPT).toMatch(/name it in spawn_agent's checks \(command_passed/);
    expect(GOALS_SYSTEM_PROMPT).toMatch(/never send a checker just to re-run a command/);
    // Live run: after the start it asked whether to tidy a test it could decide itself.
    expect(GOALS_SYSTEM_PROMPT).toMatch(/ask them only when work can't go on without a decision/);
    expect(GOALS_SYSTEM_PROMPT).toMatch(/offer optional extras in the summary instead of asking/);
    expect(GOALS_SYSTEM_PROMPT).toMatch(/never have a worker install or sign in on their behalf/);
    // From the live stress run: a follow-up to a crashed worker fails ("worker is closed").
    expect(GOALS_SYSTEM_PROMPT).toMatch(/a crashed worker is closed and can't take a follow-up/);
    expect(GOALS_SYSTEM_PROMPT).toMatch(/Never drop failed work quietly/);
    // Workers stop on blockers by their own rules now (goal-team.ts).
    expect(GOALS_SYSTEM_PROMPT).toMatch(/stop and report a blocker rather than guess/);
    expect(GOAL_TEAM.every((agent) => agent.systemPrompt.includes("Never guess"))).toBe(true);
    // It knows its team and how attached context reaches them.
    for (const name of ["builder", "scout", "researcher", "checker"]) {
      expect(GOALS_SYSTEM_PROMPT).toContain(name);
    }
    expect(GOALS_SYSTEM_PROMPT).toMatch(
      /every worker can also reach the goal's other attached folders/,
    );
    // Live runs vs a plain Kleio Coder session: workers re-read every file Kleio
    // Goals had read, and small goals were split across several workers.
    expect(GOALS_SYSTEM_PROMPT).toMatch(/in its context_files, so it starts with their contents/);
    // Long run (utils library): a final README worker waited for five parallel
    // builders, then spent a third of the run starting from scratch.
    expect(GOALS_SYSTEM_PROMPT).toMatch(
      /rather than saving that for a final worker after the rest/,
    );
    expect(GOALS_SYSTEM_PROMPT).toMatch(
      /When its checks passed and the report is clear, rely on it/,
    );
    // Briefing reads use read, ls and find; commands open at the start.
    expect(GOALS_SYSTEM_PROMPT).toMatch(/Before the goal starts you only read \(read, ls, find/);
    expect(BRIEFING_ERROR).toContain("read, ls, find");
    // Live run: told "go" in chat, it tried to work instead of asking the start question.
    expect(BRIEFING_ERROR).toMatch(/ask the start question now with ask_user/);
    // Spelled out, so a model whose start question wasn't recognised can fix it.
    expect(BRIEFING_ERROR).toContain('"Start the goal now"');
    // From the live stress run: a mid-work question went unanswered until the
    // end, and an uncollected report made it repeat its whole summary.
    expect(GOALS_SYSTEM_PROMPT).toMatch(/answer them first in a short message/);
    expect(GOALS_SYSTEM_PROMPT).toMatch(/write the summary once, complete/);
  });

  it("never runs workers on a paid tier, even one saved before the refusal", async () => {
    const g = await goal();
    expect(
      goalCritterPick({
        ...g.record,
        critterModel: { provider: "anthropic", model: "claude-opus-5-5-fast" },
      }),
    ).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
  });

  it("uses the goal's critter model only while it still names a real model", async () => {
    const g = await goal();
    expect(goalCritterPick(g.record)).toBeUndefined();
    const real = goalCritterPick({
      ...g.record,
      critterModel: { provider: "anthropic", model: "claude-opus-5-5" },
    });
    expect(real).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
    // Gone from the registry, or now another provider's: fall back to Kleio Goals'.
    expect(
      goalCritterPick({ ...g.record, critterModel: { provider: "anthropic", model: "nope-1" } }),
    ).toBeUndefined();
    expect(
      goalCritterPick({
        ...g.record,
        critterModel: { provider: "openai", model: "claude-opus-5-5" },
      }),
    ).toBeUndefined();
  });

  it("asks for no spoken farm line (the fork has no Workers-view dialogue)", () => {
    expect(GOALS_SYSTEM_PROMPT).not.toContain("[ken:");
    // Live runs: a check behind ; or || was rejected and re-run, a wasted turn each time.
    expect(GOALS_SYSTEM_PROMPT).toMatch(/chain checks only with &&/);
    // Live run: a brief raised "at least 1,200 words" to "aim for 1,800-2,500" and
    // turned "state incentives" into a 50-state table, then paid a fix round to fill it.
    expect(GOALS_SYSTEM_PROMPT).toMatch(/never raise a target or widen the scope in a brief/);
  });
});

describe("Kleio Goals run marker", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-goals-marker-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const worker = (state: SubAgentSnapshot["state"]) =>
    ({ agent_id: "w1", state }) as unknown as SubAgentSnapshot;

  it("marks the goal as worked on while its loop runs or a worker is live", async () => {
    const created = await createGoal(goalsRoot(tmp), { name: "Perf", goal: "Fast" }, new Date());
    if (!created.ok) throw new Error(created.error);
    const g = created.value;
    const seen: boolean[] = [];
    const session = createGoalsAgentSession({
      provider: "anthropic",
      model: "claude-opus-5-5",
      cwd: g.dir,
      goal: g,
      transient: true,
      onRunActive: (active) => seen.push(active),
    });
    const onRunActive = optionsOf(session).onRunActive!;

    expect(goalRunLive(g.dir)).toBe(false);
    onRunActive(true);
    expect(goalRunLive(g.dir)).toBe(true);
    // A caller's own listener still hears it.
    expect(seen).toEqual([true]);

    // The turn ends waiting on a worker: still being worked on.
    session.eventBus.emit("subagent_state", worker("running"));
    onRunActive(false);
    expect(goalRunLive(g.dir)).toBe(true);
    session.eventBus.emit("subagent_state", worker("completed"));
    expect(goalRunLive(g.dir)).toBe(false);

    // Disposed mid-run: teardown lets go even though no "closed" arrives.
    onRunActive(true);
    session.eventBus.emit("subagent_state", worker("running"));
    await session.dispose();
    expect(goalRunLive(g.dir)).toBe(false);
  });
});
