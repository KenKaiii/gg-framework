import { describe, expect, it } from "vitest";
import {
  dirForKey,
  dotLevel,
  estimateProgress,
  newSnake,
  phraseFor,
  stepSnake,
  turn,
  type Snake,
} from "./board";

const first = (): number => 0;

describe("estimateProgress", () => {
  it("climbs over time but never claims done", () => {
    expect(estimateProgress(0, false)).toBe(0);
    const samples = [2_000, 6_000, 12_000, 30_000, 120_000].map((ms) =>
      estimateProgress(ms, false),
    );
    expect(samples).toEqual([...samples].sort((a, b) => a - b));
    expect(Math.max(...samples)).toBeLessThanOrEqual(95);
    // A GIF takes longer, so its estimate climbs slower.
    expect(estimateProgress(12_000, true)).toBeLessThan(estimateProgress(12_000, false));
  });
});

describe("phraseFor", () => {
  it("names what is being made and moves through the steps", () => {
    expect(phraseFor(0, false)).toBe("Creating image");
    expect(phraseFor(0, true)).toBe("Creating GIF");
    expect(phraseFor(30_000, true)).toBe("Stitching the GIF");
  });
});

describe("dotLevel", () => {
  it("lights every dot once the board is fully developed, and rests without time", () => {
    for (let x = 0; x < 6; x++) {
      expect(dotLevel(x, 2, 100, null)).toBe(0.5);
      expect(dotLevel(x, 2, 0, null)).toBe(0.16);
    }
  });
});

describe("snake", () => {
  it("moves one cell a step in its direction", () => {
    const snake = newSnake(10, 10, first);
    const head = snake.body[0]!;
    const next = stepSnake(snake, first);
    expect(next.body[0]).toEqual({ x: head.x + 1, y: head.y });
    expect(next.body).toHaveLength(3);
  });

  it("ignores a turn straight back into its neck", () => {
    const snake = newSnake(10, 10, first);
    expect(turn(snake, "left")).toBe(snake);
    expect(turn(snake, "up").queued).toEqual(["up"]);
  });

  it("grows and scores when it eats", () => {
    const snake = newSnake(10, 10, first);
    const head = snake.body[0]!;
    const fed: Snake = { ...snake, food: { x: head.x + 1, y: head.y } };
    const next = stepSnake(fed, first);
    expect(next.score).toBe(1);
    expect(next.body).toHaveLength(4);
    expect(next.food).not.toBeNull();
  });

  it("dies on the wall and on itself", () => {
    const atWall: Snake = { ...newSnake(5, 5, first), body: [{ x: 4, y: 2 }], dir: "right" };
    expect(stepSnake(atWall, first).alive).toBe(false);
    const coiled: Snake = {
      ...newSnake(10, 10, first),
      body: [
        { x: 2, y: 2 },
        { x: 3, y: 2 },
        { x: 3, y: 3 },
        { x: 2, y: 3 },
        { x: 1, y: 3 },
      ],
      dir: "down",
    };
    expect(stepSnake(coiled, first).alive).toBe(false);
  });

  it("can follow its own tail, which moves out of the way", () => {
    const loop: Snake = {
      ...newSnake(10, 10, first),
      body: [
        { x: 2, y: 2 },
        { x: 3, y: 2 },
        { x: 3, y: 3 },
        { x: 2, y: 3 },
      ],
      dir: "down",
      food: { x: 8, y: 8 },
    };
    expect(stepSnake(loop, first).alive).toBe(true);
  });

  it("maps arrow keys and WASD", () => {
    expect(dirForKey("ArrowUp")).toBe("up");
    expect(dirForKey("a")).toBe("left");
    expect(dirForKey("Enter")).toBeUndefined();
  });
});
