import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "./agent-session.js";

const sessions: AgentSession[] = [];

async function systemPrompt(model: string, thinkingLevel: "high" | "ultra") {
  const session = new AgentSession({
    provider: "openai",
    model,
    cwd: process.cwd(),
    systemPrompt: "base prompt",
    thinkingLevel,
    transient: true,
  });
  sessions.push(session);
  await session.initialize();
  return String(session.getMessages()[0]?.content ?? "");
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
});

// `AgentSession.initialize()` does real startup work (project scan, prompt
// assembly) and lands ~4s per case — close enough to vitest's 5s default that
// these flaked intermittently on a busy machine. Give them honest headroom.
const INIT_TIMEOUT_MS = 30_000;

describe("Sol/Terra async orchestration policy", () => {
  it(
    "injects proactive named-tool guidance only at Ultra",
    async () => {
      const prompt = await systemPrompt("gpt-5.6-sol", "ultra");
      expect(prompt).toContain("Proactively use spawn_agent");
      expect(prompt).toContain("Start every independent child before calling wait_agent");
      expect(prompt).toContain("disjoint files or subsystems");
    },
    INIT_TIMEOUT_MS,
  );

  it(
    "injects explicit-request-only guidance below Ultra",
    async () => {
      const prompt = await systemPrompt("gpt-5.6-terra", "high");
      expect(prompt).toContain(
        "only when the user or applicable project/skill instructions explicitly request",
      );
      expect(prompt).not.toContain("Proactively use spawn_agent");
    },
    INIT_TIMEOUT_MS,
  );

  it(
    "leaves other models unchanged",
    async () => {
      await expect(systemPrompt("gpt-5.5-codex", "ultra")).resolves.toBe("base prompt");
    },
    INIT_TIMEOUT_MS,
  );
});
