// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main", setTitle: vi.fn() }),
}));

import { hasModelSource } from "./agent";

afterEach(() => clearMocks());

function respond(payload: unknown): void {
  mockIPC((command) => {
    if (command === "app_auth_status") return payload;
    throw new Error(`unexpected command ${command}`);
  });
}

const anthropic = (connected: boolean): Record<string, unknown> => ({
  value: "anthropic",
  label: "Anthropic",
  description: "",
  methods: ["oauth"],
  connected,
  connectedMethods: connected ? ["oauth"] : [],
});

describe("hasModelSource", () => {
  it("counts a local-only setup as ready", async () => {
    respond({ providers: [anthropic(false)], localConnected: true });
    expect(await hasModelSource()).toBe(true);
  });

  it("counts a connected provider", async () => {
    respond({ providers: [anthropic(true)], localConnected: false });
    expect(await hasModelSource()).toBe(true);
  });

  it("is false with nothing connected, or from an older build without the flag", async () => {
    respond({ providers: [anthropic(false)], localConnected: false });
    expect(await hasModelSource()).toBe(false);
    respond({ providers: [anthropic(false)] });
    expect(await hasModelSource()).toBe(false);
  });
});
