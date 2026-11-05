import { describe, expect, it } from "vitest";
import css from "./ProvidersBay.css?raw";

const WIDE = "(min-width: 820px) and (min-aspect-ratio: 5/4)";

/** Every `@container providers` block: its condition and its body. */
function containerBlocks(sheet: string): { condition: string; body: string }[] {
  const blocks: { condition: string; body: string }[] = [];
  for (const m of sheet.matchAll(/@container providers ([^{]*)\{/g)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    while (depth > 0 && i < sheet.length) {
      if (sheet[i] === "{") depth++;
      if (sheet[i] === "}") depth--;
      i++;
    }
    blocks.push({ condition: (m[1] ?? "").trim(), body: sheet.slice(start, i - 1) });
  }
  return blocks;
}

describe("ProvidersBay layout rules", () => {
  it("never lets a short-window rule re-row the wide layout", () => {
    // Regression: a max-height rule set two rows on .providers-bay after the
    // wide rule, squeezing the brain and both banks into the top 42% of a wide
    // but short window and clipping the cards.
    const blocks = containerBlocks(css);
    expect(blocks.some((b) => b.condition === WIDE)).toBe(true);
    const rerows = blocks.filter(
      (b) => b.condition !== WIDE && /\.providers-bay\s*\{[^}]*grid-template-rows/.test(b.body),
    );
    expect(rerows.length).toBeGreaterThan(0);
    for (const b of rerows) expect(b.condition).toContain(`not (${WIDE})`);
  });

  it("runs the wide banks to the window's bottom, scrolling under the tab capsule", () => {
    // Regression: the wide layout padded the whole bay above the capsule, so
    // the banks stopped short and cut their last cards off mid-card.
    const wide = containerBlocks(css).find((b) => b.condition === WIDE)?.body ?? "";
    const rule = (selector: string): string =>
      wide.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule(".providers-bay")).not.toMatch(/padding-bottom/);
    expect(rule(".bay-bank")).toMatch(/padding:[^;]*var\(--bay-foot\)/);
    expect(rule(".bay-stage")).toMatch(/margin-bottom:\s*var\(--bay-foot\)/);
  });
});
