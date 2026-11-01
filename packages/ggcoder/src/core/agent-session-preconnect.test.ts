import { describe, expect, it, vi } from "vitest";
import { preconnectProvider } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./agent-session.js";

vi.mock("@kenkaiiii/gg-ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  preconnectProvider: vi.fn(() => undefined),
}));

interface PreconnectInternals {
  authStorage: { resolveCredentials: (provider: string) => Promise<Record<string, unknown>> };
  preconnect(): void;
}

function session(preconnect: boolean | undefined, transient = false): PreconnectInternals {
  const s = new AgentSession({
    provider: "openai",
    model: "gpt-5.5",
    cwd: "/project",
    transient,
    systemPrompt: "t",
    ...(preconnect === undefined ? {} : { preconnect }),
  }) as unknown as PreconnectInternals;
  s.authStorage = {
    resolveCredentials: async () => ({ accessToken: "t", accountId: "acct" }),
  };
  return s;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("AgentSession connection pre-open", () => {
  it("pre-opens the active route (Codex login -> accountId) without sending credentials", async () => {
    vi.mocked(preconnectProvider).mockClear();
    session(true).preconnect();
    await flush();
    expect(preconnectProvider).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(preconnectProvider).mock.calls[0]?.[0];
    expect(arg).toMatchObject({ provider: "openai", accountId: "acct" });
    expect(arg).not.toHaveProperty("apiKey");
  });

  it("stays off for transient sessions and under the test runner by default", async () => {
    vi.mocked(preconnectProvider).mockClear();
    session(undefined).preconnect();
    session(undefined, true).preconnect();
    await flush();
    expect(preconnectProvider).not.toHaveBeenCalled();
  });

  it("ignores missing credentials", async () => {
    vi.mocked(preconnectProvider).mockClear();
    const s = session(true);
    s.authStorage = {
      resolveCredentials: async () => {
        throw new Error("not logged in");
      },
    };
    s.preconnect();
    await flush();
    expect(preconnectProvider).not.toHaveBeenCalled();
  });
});
