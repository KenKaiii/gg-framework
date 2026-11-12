import type http from "node:http";
import { Readable } from "node:stream";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRouteContext } from "./route-context.js";

const discoverProjects = vi.fn(async (_options: Record<string, unknown>) => []);
vi.mock("../core/project-discovery.js", () => ({
  discoverProjects: (options: Record<string, unknown>) => discoverProjects(options),
}));
vi.mock("./app-settings.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAppSettings: vi.fn(async () => ({
    projectsRoot: "/home/u/gg-projects",
    projectRoots: ["/home/u/elsewhere"],
    hiddenProjects: ["/home/u/gg-projects/old"],
  })),
}));

const { handleWorkspaceRoutes } = await import("./workspace-routes.js");

function get(url: string, agentDir: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        return this;
      },
      end(payload: string) {
        resolve({ status, body: JSON.parse(payload) as unknown });
      },
    };
    const ctx = { paths: { agentDir } } as unknown as SessionRouteContext;
    handleWorkspaceRoutes(
      ctx,
      {} as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      url,
      "GET",
    );
  });
}

describe("GET /projects", () => {
  beforeEach(() => discoverProjects.mockClear());

  it("never lists Goal workspaces under Choose a project", async () => {
    const reply = await get("/projects", "/home/u/.gg");
    expect(reply.status).toBe(200);
    expect(discoverProjects).toHaveBeenCalledOnce();
    // Goal folders live under ~/.gg/goals; their sessions look like projects'.
    // Built with the platform's separators (backslashes on Windows).
    expect(discoverProjects.mock.calls[0]?.[0]).toMatchObject({
      projectsRoot: "/home/u/gg-projects",
      excludeRoots: [path.join("/home/u/.gg", "goals")],
    });
  });
});

describe("POST /workspace/add-dir", () => {
  function post(
    ctx: SessionRouteContext,
    body: unknown,
    url = "/workspace/add-dir",
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve) => {
      let status = 0;
      const res = {
        headersSent: false,
        writeHead(code: number) {
          status = code;
          return this;
        },
        end(payload: string) {
          resolve({ status, body: JSON.parse(payload) as Record<string, unknown> });
        },
      };
      const req = Readable.from([
        Buffer.from(JSON.stringify(body)),
      ]) as unknown as http.IncomingMessage;
      handleWorkspaceRoutes(ctx, req, res as unknown as http.ServerResponse, url, "POST");
    });
  }

  type AddResult = { ok: true; root: string } | { ok: false; error: string };
  function ctxFor(
    mode: string,
    addDirectory = vi.fn(async (_dir: string): Promise<AddResult> => ({
      ok: true,
      root: "/w/sdk",
    })),
  ) {
    const broadcast = vi.fn();
    const ctx = {
      mode,
      session: { addDirectory, getAdditionalRoots: () => ["/w/sdk"] },
      broadcast,
      footerExtras: () => ({ additionalRoots: ["/w/sdk"] }),
    } as unknown as SessionRouteContext;
    return { ctx, addDirectory, broadcast };
  }

  it("adds the folder in Code and Chat windows and refreshes the header", async () => {
    for (const mode of ["code", "chat"]) {
      const { ctx, addDirectory, broadcast } = ctxFor(mode);
      const reply = await post(ctx, { path: "/w/sdk" });
      expect(reply).toEqual({ status: 200, body: { root: "/w/sdk", additionalRoots: ["/w/sdk"] } });
      expect(addDirectory).toHaveBeenCalledWith("/w/sdk");
      expect(broadcast).toHaveBeenCalledWith("extras", { additionalRoots: ["/w/sdk"] });
    }
  });

  it("passes on why a folder can't be added", async () => {
    const { ctx, broadcast } = ctxFor(
      "code",
      vi.fn(async (): Promise<AddResult> => ({ ok: false, error: "Already in the workspace: /w" })),
    );
    expect(await post(ctx, { path: "/w" })).toEqual({
      status: 400,
      body: { error: "Already in the workspace: /w" },
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("refuses Motion windows and a missing path", async () => {
    const { ctx, addDirectory } = ctxFor("motion");
    expect((await post(ctx, { path: "/w/sdk" })).status).toBe(403);
    expect((await post(ctxFor("code").ctx, {})).status).toBe(400);
    expect(addDirectory).not.toHaveBeenCalled();
  });

  it("removes an added folder and refreshes the header", async () => {
    const removeDirectory = vi.fn(async (): Promise<AddResult> => ({ ok: true, root: "/w/sdk" }));
    const broadcast = vi.fn();
    const ctx = {
      mode: "chat",
      session: { removeDirectory, getAdditionalRoots: () => [] },
      broadcast,
      footerExtras: () => ({ additionalRoots: [] }),
    } as unknown as SessionRouteContext;
    const reply = await post(ctx, { path: "/w/sdk" }, "/workspace/remove-dir");
    expect(reply).toEqual({ status: 200, body: { root: "/w/sdk", additionalRoots: [] } });
    expect(removeDirectory).toHaveBeenCalledWith("/w/sdk");
    expect(broadcast).toHaveBeenCalledWith("extras", { additionalRoots: [] });
  });
});
