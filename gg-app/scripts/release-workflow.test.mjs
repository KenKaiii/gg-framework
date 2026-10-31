import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const buildStep =
  workflow
    .split(/(?=^ {6}- )/m)
    .find((step) => /^ {6}- name: Build framework packages\r?$/m.test(step)) ?? "";

describe("release framework build", () => {
  it("builds all retained packages in dependency order", () => {
    const commands = buildStep.match(/^ {10}pnpm --filter .+$/gm)?.map((line) => line.trim());
    expect(commands).toEqual([
      "pnpm --filter @kenkaiiii/gg-ai build",
      "pnpm --filter @kenkaiiii/gg-agent build",
      "pnpm --filter @kenkaiiii/gg-core build",
      "pnpm --filter @kenkaiiii/ggcoder build",
    ]);
  });

  it("uses bash so intermediate failures stop Windows releases", () => {
    expect(buildStep).toMatch(/^ {8}shell: bash\s*$/m);
  });
});

describe("release platform matrix", () => {
  it("ships Linux deb + rpm from the oldest supported Ubuntu, never AppImage", () => {
    expect(workflow).toMatch(
      /^ {10}- platform: ubuntu-22\.04\r?\n {12}args: "--bundles deb,rpm"\r?$/m,
    );
    expect(workflow).not.toMatch(/--bundles [^"\n]*appimage/i);
  });
});
