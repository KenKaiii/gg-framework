import { describe, expect, it } from "vitest";
import { anchorDir, buildBrain } from "./brain-model";

describe("buildBrain", () => {
  it("gives every provider a region and fills it from its anchor outward", () => {
    const brain = buildBrain(["anthropic", "openai", "deepseek"], 3000);
    expect(brain.anchors).toHaveLength(3);
    const regions = new Set<number>();
    for (let i = 0; i < brain.count; i++) {
      const r = brain.region[i]!;
      regions.add(r);
      if (r >= 0) {
        expect(brain.dA[i]).toBeGreaterThanOrEqual(0);
        expect(brain.dA[i]).toBeLessThanOrEqual(1);
      }
    }
    // Three provider regions plus the core (cerebellum and stem).
    expect([...regions].sort()).toEqual([-1, 0, 1, 2]);
  });

  it("is deterministic, so the brain looks the same every time the page opens", () => {
    const a = buildBrain(["anthropic"], 500);
    const b = buildBrain(["anthropic"], 500);
    expect(Array.from(a.position)).toEqual(Array.from(b.position));
  });

  it("places a provider the table doesn't know instead of failing", () => {
    const [x, y, z] = anchorDir("newlab", 3);
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5);
    expect(buildBrain(["newlab"], 200).anchors).toHaveLength(1);
  });
});
