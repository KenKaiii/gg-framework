import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appCss = readFileSync(new URL("./App.css", import.meta.url), "utf8");
const asciiLogoSource = readFileSync(new URL("./AsciiLogo.tsx", import.meta.url), "utf8");

describe("narrow-window layout contracts", () => {
  it("fits every Supah Coder logo column inside the home gutters", () => {
    const logoLines = [...asciiLogoSource.matchAll(/^\s+"([^"]+)",$/gm)].map((match) => match[1]);
    expect(logoLines).toHaveLength(6);
    expect(Math.max(...logoLines.map((line) => [...line].length))).toBe(86);

    const responsiveSize = appCss.match(
      /\.ascii-logo\s*\{[\s\S]*?font-size:\s*min\(12px,\s*calc\(\(100vw - (\d+)px\) \/ ([\d.]+)\)\)/,
    );
    expect(responsiveSize).not.toBeNull();
    const horizontalGutter = Number(responsiveSize?.[1]);
    const logoWidthEm = Number(responsiveSize?.[2]);

    for (const viewportWidth of [320, 484, 1164]) {
      const fontSize = Math.min(12, (viewportWidth - horizontalGutter) / logoWidthEm);
      expect(fontSize * logoWidthEm).toBeLessThanOrEqual(viewportWidth - horizontalGutter);
    }
    expect(Math.min(12, (1164 - horizontalGutter) / logoWidthEm)).toBe(12);
  });

  it("keeps the portaled model menu fixed above responsive footer clipping", () => {
    expect(appCss).toMatch(
      /\.model-menu\s*\{[\s\S]*?responsive footer overflow cannot clip[\s\S]*?position:\s*fixed;/,
    );
  });
});
