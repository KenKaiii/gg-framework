import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { restoredGifPreview, restoredWorkerRows } from "./history-routes.js";

const spawn = {
  name: "spawn_agent",
  args: {
    tasks: [
      { agent: "builder", task_name: "heat-pumps", prompt: "a" },
      { agent: "builder", task_name: "ev-batteries", prompt: "b" },
    ],
  },
};

describe("restoredWorkerRows", () => {
  it("shows one row per worker a spawn started", () => {
    expect(restoredWorkerRows(spawn, false).map((row) => row.agentName)).toEqual([
      "heat-pumps",
      "ev-batteries",
    ]);
  });

  it("shows no workers for a refused spawn, which started none", () => {
    // Live bug: a spawn blocked during a goal's briefing came back after a
    // restart as "critters didn't make it back".
    expect(restoredWorkerRows(spawn, true)).toEqual([]);
  });

  it("keeps a failed synchronous subagent, which did run", () => {
    expect(restoredWorkerRows({ name: "subagent", args: { agent: "scout" } }, true)).toEqual([
      { agentName: "scout", status: "error", toolUseCount: 0 },
    ]);
  });
});

describe("restoredGifPreview", () => {
  it("replays a generated GIF from its file so a reopened chat still animates", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gg-history-gif-"));
    try {
      const frames = await Promise.all(
        [255, 0].map((r) =>
          sharp({ create: { width: 64, height: 32, channels: 3, background: { r, g: 0, b: 0 } } })
            .png()
            .toBuffer(),
        ),
      );
      const gif = await sharp(frames, { join: { animated: true } })
        .gif()
        .toBuffer();
      const gifPath = path.join(dir, "loop.gif");
      await writeFile(gifPath, gif);

      const src = await restoredGifPreview("generate_image", gifPath);
      expect(src?.startsWith("data:image/gif;base64,")).toBe(true);
      const meta = await sharp(Buffer.from(src!.split(",")[1]!, "base64"), {
        animated: true,
      }).metadata();
      expect(meta.pages).toBe(2);

      // Other tools, still images and missing files keep the persisted still.
      expect(await restoredGifPreview("read", gifPath)).toBeNull();
      expect(await restoredGifPreview("generate_image", path.join(dir, "a.png"))).toBeNull();
      expect(await restoredGifPreview("generate_image", path.join(dir, "gone.gif"))).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
