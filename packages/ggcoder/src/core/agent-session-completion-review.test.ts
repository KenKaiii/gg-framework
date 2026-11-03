import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@kleio/agent";
import type { Message } from "@kleio/ai";
import type * as GGAI from "@kleio/ai";
import { AgentSession } from "./agent-session.js";
import type {
  CompletionReview,
  CompletionReviewRequest,
  CompletionReviewResponse,
} from "./completion-review.js";

const transport = vi.hoisted(() => vi.fn());
vi.mock("@kleio/ai", async (original) => ({
  ...(await original<typeof GGAI>()),
  stream: transport,
}));
interface Internals {
  loopMonitor: { text: string };
  settingsManager: { get(key: string): boolean };
  authStorage: {
    resolveCredentials(): Promise<{
      accessToken: string;
      accountId: string;
      projectId: string;
      baseUrl: string;
    }>;
  };
  trackHookEvent(event: AgentEvent): Promise<void>;
  refreshIdealReviewArmed(): void;
  getHookFollowUpMessages(): Promise<Message[] | null>;
  callCompletionReviewer(
    request: CompletionReviewRequest,
    signal: AbortSignal,
  ): Promise<CompletionReviewResponse>;
}
describe("optional completion-review seam", () => {
  it("preserves synchronous event tracking when no completion policy is installed", async () => {
    const session = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: process.cwd(),
      transient: true,
    });
    const internal = session as unknown as Internals;
    const pending = internal.trackHookEvent({ type: "text_delta", text: "unchanged coder timing" });
    expect(internal.loopMonitor.text).toBe("unchanged coder timing");
    await pending;
  });
  it("arms before final text and announces review before disarming even with Coder hooks disabled", async () => {
    let armed = false;
    const policy: CompletionReview = {
      get armed() {
        return armed;
      },
      begin() {},
      async track(event) {
        if (event.type === "tool_call_start") armed = true;
      },
      async followUp() {
        armed = false;
        return "Deliver only a draft";
      },
      snapshot() {
        return {};
      },
      restore() {},
    };
    const session = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: process.cwd(),
      transient: true,
      selfCorrectionHooks: false,
      completionReview: policy,
    });
    const internal = session as unknown as Internals;
    internal.settingsManager = { get: () => false };
    const events: string[] = [];
    session.eventBus.on("hook_armed", (event) => events.push(`armed:${event.armed}`));
    session.eventBus.on("hook", () => events.push("review"));
    await internal.trackHookEvent({
      type: "tool_call_start",
      toolCallId: "w",
      name: "write",
      args: { file_path: "index.html" },
    });
    internal.refreshIdealReviewArmed();
    const messages = await internal.getHookFollowUpMessages();
    expect(messages?.[0]?.content).toBe("Deliver only a draft");
    expect(messages?.[0]?.provenance?.visibility).toBe("hidden");
    expect(events).toEqual(["armed:true", "review", "armed:false"]);
  });
  it("uses active OAuth routing/settings and actual image content without builder history", async () => {
    transport.mockReturnValue({
      response: Promise.resolve({ message: { content: '{"status":"ready","findings":[]}' } }),
    });
    const session = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: process.cwd(),
      thinkingLevel: "high",
      transient: true,
    });
    const internal = session as unknown as Internals;
    internal.authStorage = {
      async resolveCredentials() {
        return {
          accessToken: "test-only-token",
          accountId: "account-route",
          projectId: "project-route",
          baseUrl: "https://example.invalid",
        };
      },
    };
    internal.settingsManager = { get: () => false };
    const controller = new AbortController();
    const images = [{ type: "image" as const, mediaType: "image/jpeg", data: "/9j/" }];
    const response = await internal.callCompletionReviewer(
      { instruction: "review", context: "brief only", images },
      controller.signal,
    );
    expect(response.model).toBe("gpt-6-astra");
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account-route",
        projectId: "project-route",
        apiKey: "test-only-token",
        thinking: "high",
        signal: controller.signal,
        messages: [
          { role: "system", content: "review" },
          { role: "user", content: [{ type: "text", text: "brief only" }, ...images] },
        ],
      }),
    );
    controller.abort();
    await expect(
      internal.callCompletionReviewer(
        { instruction: "review", context: "brief", images },
        controller.signal,
      ),
    ).rejects.toThrow();
  });
  it("does nothing to a chat-style session without the option", async () => {
    const session = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: process.cwd(),
      transient: true,
      selfCorrectionHooks: false,
    });
    const internal = session as unknown as Internals;
    internal.settingsManager = { get: () => false };
    expect(await internal.getHookFollowUpMessages()).toBeNull();
  });
});
