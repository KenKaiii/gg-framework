import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: vi.fn(() => (async function* emptyLoop() {})()) };
});

vi.mock("./mcp/index.js", async () => {
  const actual = await vi.importActual<typeof McpModule>("./mcp/index.js");
  return {
    ...actual,
    MCPClientManager: vi.fn(function MCPClientManagerMock() {
      return { connectAll: vi.fn(async () => []), dispose: vi.fn(async () => {}) };
    }),
  };
});

let restoreHome: (() => void) | undefined;
let tempHome: string;
let tempProject: string;

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "attach-home-"));
  tempProject = await fs.mkdtemp(path.join(os.tmpdir(), "attach-project-"));
  restoreHome = useFakeHome(tempHome);
  await fs.mkdir(path.join(tempHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tempHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "test-anthropic-token",
        refreshToken: "test-anthropic-refresh",
        expiresAt: Date.now() + 3_600_000,
      },
      glm: { accessToken: "test-glm-token", refreshToken: "", expiresAt: Date.now() + 3_600_000 },
    }),
  );
});

afterEach(async () => {
  restoreHome?.();
  await Promise.all([
    fs.rm(tempHome, { recursive: true, force: true }),
    fs.rm(tempProject, { recursive: true, force: true }),
  ]);
  vi.clearAllMocks();
});

const image = {
  kind: "image" as const,
  mediaType: "image/png",
  data: "iVBORw0KGgo=",
  name: "screenshot.png",
  path: "/tmp/ggcoder-img-123.png",
};

async function createSession(provider: "anthropic" | "glm", model: string) {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider,
    model,
    cwd: tempProject,
    transient: true,
    projectCustomization: false,
    loadExtensions: false,
    orchestrationPrompt: false,
    selfCorrectionHooks: false,
  });
  await session.initialize();
  return session;
}

/** The last user message's content blocks (attachments land there). */
function lastUserParts(session: { getMessages: () => { role: string; content: unknown }[] }) {
  const messages = session.getMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user")
      return messages[i]!.content as { type: string; text?: string }[];
  }
  throw new Error("no user message found");
}

describe("AgentSession attachment routing (app/sidecar path)", () => {
  it("routes GLM image attachments to the zai vision MCP tool, not inline pixels", async () => {
    const session = await createSession("glm", "glm-5.3");
    try {
      await session.promptWithAttachments("What is this?", [image]);
      const parts = lastUserParts(session);
      const hint = parts.find((p) => p.type === "text" && p.text?.includes("attached an image"));
      // GLM-5.3 has no native image input; the session must name the REAL MCP
      // tool (zai_vision connects only for GLM) plus the tool_search unlock path.
      expect(hint?.text).toContain("mcp__zai_vision__analyze_image");
      expect(hint?.text).toContain("tool_search");
      expect(hint?.text).toContain(image.path!);
      // No inline image part for GLM — the provider layer would blank it.
      expect(parts.some((p) => p.type === "image")).toBe(false);
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("sends inline pixels to GLM-5.3-Flash, which sees images natively", async () => {
    const session = await createSession("glm", "glm-5.3-flash");
    try {
      await session.promptWithAttachments("What is this?", [image]);
      const parts = lastUserParts(session);
      // Flash is natively multimodal, so the zai_vision detour would waste a
      // round trip and lose fidelity: the pixels ride along with the prompt.
      expect(parts.some((p) => p.type === "image")).toBe(true);
      expect(parts.some((p) => p.text?.includes("zai_vision"))).toBe(false);
      expect(parts.some((p) => p.text === `[Image saved at ${image.path}]`)).toBe(true);
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("tells the model about files, even one that could not be saved", async () => {
    const session = await createSession("anthropic", "claude-test");
    try {
      await session.promptWithAttachments("", [
        {
          kind: "file",
          name: "book.epub",
          mediaType: "application/epub+zip",
          data: "",
          path: "/p/book.epub",
        },
        { kind: "file", name: "lost.pdf", mediaType: "application/pdf", data: "" },
      ]);
      const texts = lastUserParts(session).map((p) => p.text);
      expect(texts).toContain(
        "Attached files (inspect with your tools):\n- book.epub (saved at /p/book.epub)\nThe read tool opens PDF and EPUB files as text.",
      );
      expect(texts).toContain(
        `[User attached a file "lost.pdf" but it could not be saved, so it can't be opened.]`,
      );
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("keeps inline image parts for non-GLM providers (untouched behavior)", async () => {
    const session = await createSession("anthropic", "claude-test");
    try {
      await session.promptWithAttachments("What is this?", [image]);
      const parts = lastUserParts(session);
      expect(parts.some((p) => p.type === "image")).toBe(true);
      expect(parts.some((p) => p.text === `[Image saved at ${image.path}]`)).toBe(true);
      // The GLM-only zai hint must never leak into other providers.
      expect(
        parts.some((p) => p.text?.includes("zai_vision") || p.text?.includes("tool_search")),
      ).toBe(false);
    } finally {
      await session.dispose();
    }
  }, 20_000);
});
