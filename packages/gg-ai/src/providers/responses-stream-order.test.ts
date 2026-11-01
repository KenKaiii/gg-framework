import { describe, expect, it } from "vitest";
import { consumeResponsesEvents } from "./responses-stream.js";

describe("consumeResponsesEvents parallel tool order", () => {
  it("keeps server output order when parallel calls finish out of order", async () => {
    async function* events(): AsyncGenerator<Record<string, unknown>> {
      for (const n of [1, 2]) {
        yield {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: `fc_${n}`,
            call_id: `call_${n}`,
            name: "read",
            arguments: "",
          },
        };
      }
      for (const n of [2, 1]) {
        yield {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: `fc_${n}`,
            call_id: `call_${n}`,
            name: "read",
            arguments: "{}",
          },
        };
      }
      yield {
        type: "response.completed",
        response: { usage: { input_tokens: 1, output_tokens: 1 } },
      };
    }
    const gen = consumeResponsesEvents(events(), {
      provider: "openai",
      label: "t",
      diagPrefix: "t",
      thinking: false,
    });
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    const content = step.value.message.content;
    const ids =
      typeof content === "string"
        ? []
        : content.flatMap((p) => (p.type === "tool_call" ? [p.id] : []));
    expect(ids).toEqual(["call_1|fc_1", "call_2|fc_2"]);
  });
});
