import { describe, expect, it } from "vitest";
import { OUTCOME_PHRASES, outcomePhrase } from "./activity-copy";

describe("GG outcome wording", () => {
  it.each(Object.entries(OUTCOME_PHRASES))(
    "keeps %s concise, varied and stable",
    (label, phrases) => {
      expect(new Set(phrases).size).toBeGreaterThanOrEqual(6);
      for (const phrase of phrases) {
        expect(phrase.length).toBeGreaterThanOrEqual(12);
        expect(phrase.length).toBeLessThanOrEqual(26);
        expect(phrase).not.toMatch(/[\n\r]|shipped|production.ready|all done|everything passed/i);
      }
      expect(
        Math.max(...phrases.map((p) => p.length)) - Math.min(...phrases.map((p) => p.length)),
      ).toBeLessThanOrEqual(10);
      for (let seed = 0; seed < phrases.length; seed++) {
        const plain = phrases[seed]!.replace("{checks}", "checks");
        expect(outcomePhrase(label, seed)).toBe(plain.charAt(0).toUpperCase() + plain.slice(1));
        expect(outcomePhrase(label, seed)).toBe(outcomePhrase(label, seed));
      }
    },
  );
  it("leaves event labels outside the outcome pools alone", () => {
    expect(outcomePhrase("Retrying…", 42)).toBeUndefined();
    expect(outcomePhrase("Working…", 42)).toBeUndefined();
  });
  it("never substitutes green language for failure or missing verification", () => {
    for (const label of [
      "Checks failed",
      "Verification incomplete",
      "Task failed",
      "Ken’s review failed",
    ]) {
      for (const phrase of OUTCOME_PHRASES[label]!)
        expect(phrase).not.toMatch(/passed|green|ready|success/i);
    }
  });
  it("says how many checks passed, so one lint never reads as a full suite", () => {
    expect(outcomePhrase("Done · checks passed", 0, 1)).toBe("1 check passed. Nice.");
    expect(outcomePhrase("Done · checks passed", 5, 3)).toBe("Green: 3 checks passed");
    expect(outcomePhrase("Done · checks passed", 1)).toBe("Checks came back green");
  });
  it("never words a failed check, a stop or a broken review as more than is known", () => {
    for (const phrase of [
      ...OUTCOME_PHRASES["Checks failed"]!,
      ...OUTCOME_PHRASES["Verification incomplete"]!,
      ...OUTCOME_PHRASES["Stopped · unfinished"]!,
      ...OUTCOME_PHRASES["Ken’s review failed"]!,
      ...OUTCOME_PHRASES["Done · checks passed"]!,
    ])
      expect(phrase).not.toMatch(/fix|another look|this time|work remains|review failed|rejected/i);
  });
});
