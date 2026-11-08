import http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KLEIO_PRODUCT_PROFILE } from "@kleio/core";
import { MCPClientManager, resolveMcpClientName } from "./client.js";
import type * as McpClient from "@modelcontextprotocol/client";

const sdkMocks = vi.hoisted(() => ({
  clientConstructor: vi.fn(),
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
  streamableTransport: vi.fn(),
  sseTransport: vi.fn(),
  stdioTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/client", async (importOriginal) => ({
  ...(await importOriginal<typeof McpClient>()),
  Client: class ClientMock {
    constructor(clientInfo: unknown) {
      sdkMocks.clientConstructor(clientInfo);
    }

    connect = sdkMocks.connect;
    listTools = sdkMocks.listTools;
    callTool = sdkMocks.callTool;
    close = sdkMocks.close;
    // The safety tool guard pins tools by server version; these servers report none.
    getServerVersion = (): undefined => undefined;
  },
  StreamableHTTPClientTransport: class StreamableHTTPClientTransportMock {
    constructor(url: URL, options: unknown) {
      sdkMocks.streamableTransport(url, options);
    }
  },
  SSEClientTransport: class SSEClientTransportMock {
    constructor(url: URL, options: unknown) {
      sdkMocks.sseTransport(url, options);
    }
  },
}));

vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: class StdioClientTransportMock {
    stderr = undefined;

    constructor(options: unknown) {
      sdkMocks.stdioTransport(options);
    }
  },
}));

vi.mock("../logger.js", () => ({ log: vi.fn() }));

beforeEach(() => {
  for (const mock of Object.values(sdkMocks)) mock.mockReset();
  sdkMocks.connect.mockResolvedValue(undefined);
  sdkMocks.listTools.mockResolvedValue({ tools: [] });
  sdkMocks.close.mockResolvedValue(undefined);
});

describe("resolveMcpClientName", () => {
  it("uses the branded product-profile name by default", () => {
    expect(KLEIO_PRODUCT_PROFILE.coder.mcpClientName).toBe("kleio-coder");
    expect(resolveMcpClientName(undefined, {})).toBe(KLEIO_PRODUCT_PROFILE.coder.mcpClientName);
  });

  it("prefers the environment override over the default", () => {
    expect(
      resolveMcpClientName(undefined, {
        KLEIO_CODER_MCP_CLIENT_NAME: "environment-client",
      }),
    ).toBe("environment-client");
  });

  it("prefers an explicit name over the environment override", () => {
    expect(
      resolveMcpClientName("explicit-client", {
        KLEIO_CODER_MCP_CLIENT_NAME: "environment-client",
      }),
    ).toBe("explicit-client");
  });

  it("accepts the legacy client name explicitly or from the environment", () => {
    expect(KLEIO_PRODUCT_PROFILE.coder.legacyMcpClientName).toBe("ggcoder");
    expect(resolveMcpClientName("ggcoder", {})).toBe("ggcoder");
    expect(
      resolveMcpClientName(undefined, {
        KLEIO_CODER_MCP_CLIENT_NAME: "ggcoder",
      }),
    ).toBe("ggcoder");
  });
});

describe("MCPClientManager client identity wiring", () => {
  it("uses the default name for Streamable HTTP clients", async () => {
    const manager = new MCPClientManager({ environment: {} });

    const result = await manager.connectAllDetailed([
      { name: "remote", url: "https://example.com/mcp" },
    ]);

    expect(result).toEqual([{ name: "remote", ok: true, toolCount: 0, tools: [] }]);
    expect(sdkMocks.clientConstructor).toHaveBeenCalledWith({
      name: "kleio-coder",
      version: "1.0.0",
    });
  });

  it("uses an explicit legacy name for stdio clients even when the environment differs", async () => {
    const manager = new MCPClientManager({
      clientName: KLEIO_PRODUCT_PROFILE.coder.legacyMcpClientName,
      environment: { KLEIO_CODER_MCP_CLIENT_NAME: "environment-client" },
    });

    const result = await manager.connectAllDetailed([
      { name: "local", command: "node", args: ["server.js"] },
    ]);

    expect(result).toEqual([{ name: "local", ok: true, toolCount: 0, tools: [] }]);
    expect(sdkMocks.stdioTransport).toHaveBeenCalledOnce();
    expect(sdkMocks.clientConstructor).toHaveBeenCalledWith({
      name: "ggcoder",
      version: "1.0.0",
    });
  });

  it("uses an environment-provided legacy name for Streamable HTTP and SSE fallback clients", async () => {
    sdkMocks.connect
      .mockRejectedValueOnce(new Error("streamable unavailable"))
      .mockResolvedValueOnce(undefined);
    const manager = new MCPClientManager({
      environment: {
        KLEIO_CODER_MCP_CLIENT_NAME: KLEIO_PRODUCT_PROFILE.coder.legacyMcpClientName,
      },
    });

    const result = await manager.connectAllDetailed([
      { name: "remote", url: "https://example.com/mcp" },
    ]);

    expect(result).toEqual([{ name: "remote", ok: true, toolCount: 0, tools: [] }]);
    expect(sdkMocks.streamableTransport).toHaveBeenCalledOnce();
    expect(sdkMocks.sseTransport).toHaveBeenCalledOnce();
    expect(sdkMocks.clientConstructor).toHaveBeenCalledTimes(2);
    expect(sdkMocks.clientConstructor).toHaveBeenNthCalledWith(1, {
      name: "ggcoder",
      version: "1.0.0",
    });
    expect(sdkMocks.clientConstructor).toHaveBeenNthCalledWith(2, {
      name: "ggcoder",
      version: "1.0.0",
    });
  });
});

/** A local HTTP server on a free port, and its origin. */
async function listen(
  handler: http.RequestListener,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Server has no port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Builds the SDK's real transports from the options the manager passes, and
 * connects a real client over the latest one, so a test runs the SDK's own
 * redirect handling on the manager's own settings.
 */
async function useRealTransports(): Promise<void> {
  const sdk = await vi.importActual<typeof McpClient>("@modelcontextprotocol/client");
  let connect = (): Promise<void> => Promise.reject(new Error("No transport was built."));
  const over = (transport: McpClient.Transport) => () =>
    new sdk.Client({ name: "test", version: "1.0.0" }).connect(transport);
  sdkMocks.streamableTransport.mockImplementation(
    (url: URL, options: McpClient.StreamableHTTPClientTransportOptions) => {
      connect = over(new sdk.StreamableHTTPClientTransport(url, options));
    },
  );
  sdkMocks.sseTransport.mockImplementation(
    (url: URL, options: McpClient.SSEClientTransportOptions) => {
      connect = over(new sdk.SSEClientTransport(url, options));
    },
  );
  sdkMocks.connect.mockImplementation(() => connect());
}

describe("MCPClientManager redirects", () => {
  it.each([
    { transport: undefined, over: "Streamable HTTP, then SSE" },
    { transport: "sse" as const, over: "SSE" },
  ])(
    "refuses one to another origin over $over, sends it nothing, and names it",
    async ({ transport }) => {
      await useRealTransports();
      const reached: string[] = [];
      const elsewhere = await listen((req, res) => {
        reached.push(`${req.method} ${req.url}`);
        res.writeHead(404).end();
      });
      // The 401 in the path: a text match on "401" must not take this for a login prompt.
      const moved = `${elsewhere.origin}/moved/401/mcp`;
      const server = await listen((_req, res) => {
        res.writeHead(307, { Location: `${moved}?key=secret` }).end();
      });
      try {
        const manager = new MCPClientManager({ environment: {} });
        const [result] = await manager.connectAllDetailed([
          {
            name: "moved",
            url: `${server.origin}/mcp`,
            transport,
            headers: { Authorization: "Bearer token" },
          },
        ]);

        expect(result).toMatchObject({
          ok: false,
          requiresAuth: false,
          error: `Server redirected to ${moved}, a different origin, so the redirect wasn't followed. If that is the right server, use that URL instead.`,
        });
        expect(reached).toEqual([]);
      } finally {
        await Promise.all([server.close(), elsewhere.close()]);
      }
    },
  );

  it("reports a same-origin redirect it refused, not what the SSE fallback met next", async () => {
    await useRealTransports();
    // A POST redirected with 301 would turn into a GET, so the SDK refuses it
    // even on the same origin; the SSE fallback's GET follows it, then fails.
    const server = await listen((req, res) => {
      if (req.url === "/mcp") res.writeHead(301, { Location: "/mcp/" }).end();
      else res.writeHead(405).end();
    });
    try {
      const manager = new MCPClientManager({ environment: {} });
      const [result] = await manager.connectAllDetailed([
        { name: "slash", url: `${server.origin}/mcp` },
      ]);

      expect(result).toMatchObject({
        ok: false,
        error: `Server redirected to ${server.origin}/mcp/, which wasn't followed. If that is the right server, use that URL instead.`,
      });
    } finally {
      await server.close();
    }
  });
});
