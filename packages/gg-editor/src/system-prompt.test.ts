import { describe, expect, it } from "vitest";
import { NoneAdapter } from "./core/hosts/none/adapter.js";
import {
  buildEditorHostBlock,
  buildEditorStaticBody,
  buildEditorSystemPrompt,
  spliceHostBlock,
} from "./system-prompt.js";

/**
 * The system prompt is split into:
 *   - a static body (cached for the session — host-independent)
 *   - a host block (rebuilt on host changes)
 * spliceHostBlock joins them. These tests pin that contract so future
 * edits don't accidentally bake host state into the static body or drop
 * the {HOST_BLOCK} sentinel.
 */

describe("buildEditorStaticBody", () => {
  it("contains the {HOST_BLOCK} sentinel exactly once", () => {
    const body = buildEditorStaticBody("/tmp", { skills: [], styles: [] });
    const occurrences = body.match(/\{HOST_BLOCK\}/g) ?? [];
    expect(occurrences.length).toBe(1);
  });

  it("does not bake host name / capabilities into static body", () => {
    const body = buildEditorStaticBody("/tmp", { skills: [], styles: [] });
    // Templated host strings would match these patterns; descriptive prose
    // (e.g. "Resolve only") is fine, but a literal "host=resolve  ok=true"
    // line means the dynamic snapshot leaked into the static body.
    expect(body).not.toMatch(/host=resolve\s+ok=/);
    expect(body).not.toMatch(/host=premiere\s+ok=/);
    expect(body).not.toMatch(/host=none\s+ok=/);
    // No `caps: move=... color=...` line either — that's host-block territory.
    expect(body).not.toMatch(/caps:\s*move=/);
  });

  it("includes cwd (it's per-session, but doesn't change mid-session)", () => {
    const body = buildEditorStaticBody("/Users/test/project", {
      skills: [],
      styles: [],
    });
    expect(body).toContain("cwd=/Users/test/project");
  });

  it("renders skill descriptions when provided", () => {
    const body = buildEditorStaticBody("/tmp", {
      skills: [
        {
          name: "test-skill",
          description: "a fake skill for testing",
          content: "...",
          origin: "bundled",
        },
      ],
      styles: [],
    });
    expect(body).toContain("test-skill");
    expect(body).toContain("a fake skill for testing");
  });
});

describe("buildEditorHostBlock", () => {
  it("emits a host=none block for NoneAdapter (ok=true — file-only ops still work)", async () => {
    const block = await buildEditorHostBlock(new NoneAdapter());
    expect(block).toContain("host=none");
    expect(block).toContain("ok=true");
    expect(block).toContain("# Host");
    expect(block).toContain("caps: move=");
  });

  it("notes that host identity is dynamic (so the agent doesn't anchor to it)", async () => {
    const block = await buildEditorHostBlock(new NoneAdapter());
    expect(block).toMatch(/dynamic|re-detect|host_info/i);
  });

  it("surfaces capability warnings from the host", async () => {
    const host = new NoneAdapter();
    const original = host.capabilities.bind(host);
    host.capabilities = async () => ({ ...(await original()), warnings: ["test warning"] });
    const block = await buildEditorHostBlock(host);
    expect(block).toContain("warnings:");
    expect(block).toContain("- test warning");
  });
});

describe("spliceHostBlock", () => {
  it("replaces the sentinel with the host block", () => {
    const fakeStatic = "above\n{HOST_BLOCK}\nbelow";
    const fakeHost = "# Host\nhost=resolve";
    expect(spliceHostBlock(fakeStatic, fakeHost)).toBe("above\n# Host\nhost=resolve\nbelow");
  });

  it("throws if the sentinel is missing (refuses to ship a prompt without a host section)", () => {
    expect(() => spliceHostBlock("no sentinel here", "# Host")).toThrow(/sentinel/);
  });
});

describe("buildEditorSystemPrompt — backward-compat one-shot", () => {
  it("produces a prompt with both static body and live host block", async () => {
    const prompt = await buildEditorSystemPrompt(new NoneAdapter(), "/tmp", {
      skills: [],
      styles: [],
    });
    expect(prompt).toContain("# Host");
    expect(prompt).toContain("host=none");
    expect(prompt).toContain("# Tool tiers");
    expect(prompt).not.toContain("{HOST_BLOCK}");
  });
});
