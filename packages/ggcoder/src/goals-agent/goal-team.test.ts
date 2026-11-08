import { describe, expect, it } from "vitest";
import { BUNDLED_AGENTS } from "../core/bundled-agents.js";
import { validateAgentTools } from "../core/agents.js";
import { GOAL_TEAM } from "./goal-team.js";

const byName = (name: string) => {
  const agent = GOAL_TEAM.find((a) => a.name === name);
  if (!agent) throw new Error(`no ${name} on the team`);
  return agent;
};

describe("Kleio Goals' team", () => {
  it("is its own roster: builder, scout, researcher and checker, none of Kleio Coder's agents", () => {
    expect(GOAL_TEAM.map((a) => a.name)).toEqual(["builder", "scout", "researcher", "checker"]);
    // Nothing shared with Kleio Coder's bundled agents: a change to one never changes the other.
    for (const agent of GOAL_TEAM) {
      expect(BUNDLED_AGENTS.some((b) => b.systemPrompt === agent.systemPrompt)).toBe(false);
    }
  });

  it("names only real tools", () => {
    for (const agent of GOAL_TEAM) expect(validateAgentTools(agent, "goal-team")).toEqual([]);
  });

  it("lets builders and checkers change files; scouts and researchers change nothing", () => {
    expect(byName("builder").tools).toEqual(expect.arrayContaining(["write", "edit", "bash"]));
    for (const name of ["scout", "researcher"]) {
      const tools = byName(name).tools;
      expect(tools).not.toContain("write");
      expect(tools).not.toContain("edit");
    }
    // The researcher is the one for the web; the scout stays in the folders.
    expect(byName("researcher").tools).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
    expect(byName("scout").tools).not.toContain("web_search");
    // The checker runs the tests that prove a task, and fixes what fails in
    // the same pass instead of sending it back for another builder round.
    expect(byName("checker").tools).toEqual(expect.arrayContaining(["bash", "edit", "write"]));
    expect(byName("checker").systemPrompt).toMatch(/fix what doesn't/);
    expect(byName("checker").systemPrompt).toMatch(/run the checks again until they pass/);
  });

  it("gives the workers that build, check or research real-repo code via steroids", () => {
    for (const name of ["builder", "researcher", "checker"]) {
      expect(byName(name).tools).toContain("steroids");
    }
    for (const name of ["builder", "researcher"]) {
      expect(byName(name).systemPrompt).toMatch(/with steroids \(if you have it\)/);
    }
  });

  it("works in place for the user to review: never branches, commits or pushes", () => {
    // Kleio Coder's `worker` branches and commits; parallel goal workers sharing
    // one checkout would fight over it and hide their changes.
    for (const agent of GOAL_TEAM) {
      expect(agent.systemPrompt).toMatch(/Never create branches, commit, push/);
      expect(agent.systemPrompt).not.toMatch(/git checkout -b/);
      expect(agent.systemPrompt).toMatch(/Start with one line: done, blocked, or failed/);
      // Live run: a builder's `npm test; echo $?` couldn't count as proof, so
      // Kleio Goals sent a whole checker to run the tests again.
      expect(agent.systemPrompt).toMatch(/on its own as the last thing you do, as a plain command/);
      // Live run: a worker ran `npm install -g netlify-cli` on the user's machine.
      expect(agent.systemPrompt).toMatch(/Never change the machine itself: no global installs/);
      expect(agent.systemPrompt).toMatch(/Don't read a file back after editing or writing it/);
    }
  });

  it("keeps every member to the size the brief asks for", () => {
    // Live runs: "at least 1,000 words" came back at 1,400–2,200 words, and
    // writing is most of a worker's cost.
    for (const agent of GOAL_TEAM) {
      expect(agent.systemPrompt).toMatch(/Deliver the size the brief asks for/);
      expect(agent.systemPrompt).toMatch(/landing just past it, not by aiming well beyond it/);
    }
  });
});
