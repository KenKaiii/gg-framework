import { describe, expect, it } from "vitest";
import { buildGitBootstrapPrompt, DEFAULT_GIT_BOOTSTRAP_OPTIONS } from "./init-git-prompt";
import { recoverPromptLabel } from "./prompt-labels";

const CHECKLIST_OPENING =
  "Check this project for one item of its health checklist and report in plain words.";

describe("recoverPromptLabel", () => {
  it.each(["Git & GitHub", "Lint, format & type checks", "README & setup docs"])(
    "recovers the checklist title %s without showing its expanded body",
    (title) => {
      const prompt = `# Checklist: ${title}\n\n${CHECKLIST_OPENING}\n\nFull report-only instructions.`;
      expect(recoverPromptLabel(prompt)).toBe(`Checking ${title}`);
      expect(recoverPromptLabel(`  \n${prompt.replace(/\n/g, "\r\n")}`)).toBe(`Checking ${title}`);
    },
  );

  it.each([
    "Please check the project",
    "# Checklist: Security\n\nThese are my own notes.",
    `Explain this example:\n# Checklist: Tests\n\n${CHECKLIST_OPENING}`,
    `# Checklist: \n\n${CHECKLIST_OPENING}`,
    `# Checklist: ${"x".repeat(201)}\n\n${CHECKLIST_OPENING}`,
    `# Checklist: First line\nSecond line\n\n${CHECKLIST_OPENING}`,
  ])("leaves ordinary messages and malformed headings unchanged: %s", (text) => {
    expect(recoverPromptLabel(text)).toBeNull();
  });

  it("preserves the existing Git setup label", () => {
    const prompt = buildGitBootstrapPrompt({
      slug: "my-app",
      visibility: "private",
      options: DEFAULT_GIT_BOOTSTRAP_OPTIONS,
    });
    expect(recoverPromptLabel(prompt)).toBe("Initializing Git…");
  });
});
