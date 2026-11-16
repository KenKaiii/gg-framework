import { describe, expect, it, vi } from "vitest";
import { FRAME_COMMANDS, frameInvoke } from "./invoke";

const ok = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("frame invoke shim", () => {
  it("allows only the commands the frame uses", () => {
    expect(Object.keys(FRAME_COMMANDS).sort()).toEqual([
      "agent_cancel",
      "agent_enhance_prompt",
      "agent_git_overview",
      "agent_models",
      "agent_prompt",
      "agent_state",
      "agent_switch_model",
      "agent_usage",
      "sidecar_port",
    ]);
  });

  it("fails closed for every other command without a request", async () => {
    const fetchImpl = ok({});
    for (const cmd of [
      "agent_shell_run",
      "open_url",
      "agent_new_session",
      "toString",
      "__proto__",
    ]) {
      await expect(frameInvoke(cmd, {}, fetchImpl)).rejects.toBe(
        `${cmd} isn't available in the live preview`,
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends prompts to the frame route with the frame header and only known fields", async () => {
    const fetchImpl = ok({ ok: true });
    await frameInvoke(
      "agent_prompt",
      {
        text: "make it blue",
        attachments: [],
        meta: { livePreview: { url: "u", element: null } },
        extra: 1,
      },
      fetchImpl,
    );
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe("/api/prompt");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["x-gg-live"]).toBe("1");
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "make it blue",
      attachments: [],
      meta: { livePreview: { url: "u", element: null } },
    });
    expect(await frameInvoke("sidecar_port", {}, fetchImpl)).toBe(1);
  });

  it("rejects with the server's message, like Tauri's string errors", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Live preview has stopped." }), { status: 503 }),
    ) as unknown as typeof fetch;
    await expect(frameInvoke("agent_state", {}, fetchImpl)).rejects.toBe(
      "Live preview has stopped.",
    );
  });
});
