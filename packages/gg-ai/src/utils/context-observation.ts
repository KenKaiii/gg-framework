import type { Message, PreparedContext, Tool } from "../types.js";
import { resolveToolSchema } from "./zod-to-json-schema.js";

function imageCount(message: Message | undefined): number {
  if (!message || !Array.isArray(message.content)) return 0;
  if (message.role === "user")
    return message.content.filter((part) => part.type === "image").length;
  if (message.role !== "tool") return 0;
  return message.content.reduce(
    (count, result) =>
      count +
      (Array.isArray(result.content)
        ? result.content.filter((part) => part.type === "image").length
        : 0),
    0,
  );
}

/** Builds no copy of media data. The observer must consume messages synchronously. */
export function observePreparedContext(
  before: readonly Message[],
  after: readonly Message[],
  tools: readonly Tool[],
): PreparedContext {
  let imagesBefore = 0;
  let imagesAfter = 0;
  let firstImageDropMessage: number | null = null;
  for (let index = 0; index < before.length; index++) {
    const oldCount = imageCount(before[index]);
    const newCount = imageCount(after[index]);
    imagesBefore += oldCount;
    imagesAfter += newCount;
    if (firstImageDropMessage === null && newCount < oldCount) firstImageDropMessage = index;
  }
  return {
    messages: after,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: resolveToolSchema(tool),
    })),
    imagesBefore,
    imagesAfter,
    firstImageDropMessage,
  };
}
