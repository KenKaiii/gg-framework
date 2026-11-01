import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "./openai.js";

describe("OpenAI SDK client retries", () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("sends one HTTP attempt per call: the agent loop owns retries", async () => {
    let hits = 0;
    server = http.createServer((req, res) => {
      hits += 1;
      req.resume();
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":{"message":"boom"}}');
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const client = createClient({
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "retry-test",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      messages: [],
    });
    await expect(
      client.chat.completions.create({ model: "deepseek-chat", messages: [] }),
    ).rejects.toThrow();
    expect(hits).toBe(1);
  });
});
