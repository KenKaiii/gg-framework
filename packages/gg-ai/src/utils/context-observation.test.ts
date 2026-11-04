import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Message, PreparedContext, StreamOptions } from "../types.js";
import { stream } from "../stream.js";
import { providerRegistry } from "../provider-registry.js";
import { observePreparedContext } from "./context-observation.js";

const image = (data: string) => ({ type: "image" as const, mediaType: "image/png", data });

describe("prepared-context observation", () => {
  it("counts user/tool images and resolves tool schemas without exposing tool executors", () => {
    const before: Message[] = [
      { role: "system", content: "fixed" },
      { role: "user", content: [image("old")] },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "t", content: [image("new")] }],
      },
    ];
    const after: Message[] = [
      { role: "system", content: "fixed" },
      { role: "user", content: "omitted" },
      ...before.slice(2),
    ];
    const observation = observePreparedContext(before, after, [
      {
        name: "read",
        description: "read a file",
        parameters: z.object({ path: z.string() }),
      },
    ]);
    expect(observation).toMatchObject({
      imagesBefore: 2,
      imagesAfter: 1,
      firstImageDropMessage: 1,
    });
    expect(observation.messages).toBe(after);
    expect(observation.tools[0]?.parameters).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
    });
    expect(observation.tools[0]).not.toHaveProperty("execute");
  });

  it("observes real unified-stream image limiting without changing messages or signed reasoning", () => {
    let sent: StreamOptions | undefined;
    let observed: PreparedContext | undefined;
    const stop = new Error("capture without a network call");
    providerRegistry.register("observation-test", {
      stream: (options) => {
        sent = options;
        throw stop;
      },
    });
    const messages: Message[] = [
      { role: "user", content: Array.from({ length: 8 }, (_, i) => image(String(i))) },
      { role: "assistant", content: [{ type: "thinking", text: "original", signature: "signed" }] },
      { role: "user", content: "continue" },
    ];
    const original = structuredClone(messages);
    try {
      expect(() =>
        stream({
          provider: "observation-test" as StreamOptions["provider"],
          model: "test",
          messages,
          onContextPrepared: (value) => {
            observed = value;
          },
        }),
      ).toThrow(stop);
      expect(observed).toMatchObject({ imagesBefore: 8, imagesAfter: 5, firstImageDropMessage: 0 });
      expect(observed?.messages).toBe(sent?.messages);
      expect(sent?.messages[1]).toEqual(original[1]);
      expect(messages).toEqual(original);
    } finally {
      providerRegistry.unregister("observation-test");
    }
  });

  it("still sends the same request when an observer fails", () => {
    let sent = false;
    const stop = new Error("provider reached");
    providerRegistry.register("observation-test", {
      stream: () => {
        sent = true;
        throw stop;
      },
    });
    try {
      expect(() =>
        stream({
          provider: "observation-test" as StreamOptions["provider"],
          model: "test",
          messages: [{ role: "user", content: "hi" }],
          onContextPrepared: () => {
            throw new Error("diagnostics failed");
          },
        }),
      ).toThrow(stop);
      expect(sent).toBe(true);
    } finally {
      providerRegistry.unregister("observation-test");
    }
  });
});
