import { describe, expect, it } from "vitest";
import { CRITTER_CELLS, CRITTERS, pickCritter, renderCritterFrame } from "./critter-sprites";

describe("critter roster", () => {
  it("has 15 critters with unique ids", () => {
    expect(CRITTERS).toHaveLength(15);
    expect(new Set(CRITTERS.map((c) => c.id)).size).toBe(15);
  });

  it.each(CRITTERS.map((c) => [c.id, c] as const))(
    "%s is a full 18×18 grid with every colour defined in both frames",
    (_id, critter) => {
      expect(critter.rows).toHaveLength(CRITTER_CELLS);
      const rows = [...critter.rows, ...Object.values(critter.alt)];
      for (const row of rows) {
        expect(row).toHaveLength(CRITTER_CELLS);
        for (const ch of row) {
          if (ch !== ".") expect(critter.palette[ch], `${critter.id} "${ch}"`).toBeDefined();
        }
      }
      expect(critter.palette.B).toBeDefined();
    },
  );
});

describe("renderCritterFrame", () => {
  const bee = CRITTERS.find((c) => c.id === "bee");
  if (!bee) throw new Error("bee missing");

  it("renders an SVG data URL using the critter's colours", () => {
    const svg = decodeURIComponent(renderCritterFrame(bee, 0));
    expect(svg.startsWith('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('viewBox="0 0 18 18"');
    expect(svg).toContain(bee.palette.B);
  });

  it("is deterministic, and the second walk frame differs", () => {
    expect(renderCritterFrame(bee, 0)).toBe(renderCritterFrame(bee, 0));
    expect(renderCritterFrame(bee, 1)).not.toBe(renderCritterFrame(bee, 0));
  });

  it("paints every opaque cell the fill colour for the summon silhouette", () => {
    const svg = decodeURIComponent(renderCritterFrame(bee, 0, "#ffffff"));
    const fills = new Set([...svg.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]));
    expect([...fills]).toEqual(["#ffffff"]);
  });
});

describe("pickCritter", () => {
  const none = new Set<string>();

  it("gives named agents their own critter", () => {
    expect(pickCritter("bee", "k1", none).id).toBe("bee");
    expect(pickCritter("researcher", "k1", none).id).toBe("wizard");
    expect(pickCritter("worker", "k1", none).id).toBe("builder");
  });

  it("keeps the same critter for the same agent id", () => {
    expect(pickCritter(undefined, "agent-42", none).id).toBe(
      pickCritter(undefined, "agent-42", none).id,
    );
  });

  it("avoids critters already on the floor until all 15 are out", () => {
    const taken = new Set<string>();
    for (let i = 0; i < CRITTERS.length; i++) {
      const critter = pickCritter("bee", `agent-${i}`, taken);
      expect(taken.has(critter.id)).toBe(false);
      taken.add(critter.id);
    }
    expect(taken.size).toBe(15);
    // Everyone is out: repeats are allowed, and a named agent keeps its own.
    expect(pickCritter("bee", "agent-99", taken).id).toBe("bee");
  });
});
