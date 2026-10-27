import type http from "node:http";
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
      excludeRoots: [path.join("/home/u/.gg", "goals"), path.join("/home/u/.gg", "worktrees")],
    });
  });
});
