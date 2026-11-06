import { describe, expect, it } from "vitest";
import { BUNDLED_AGENTS } from "./bundled-agents.js";
import { isReadOnlyAgent } from "./runtime-mode.js";

describe("isReadOnlyAgent", () => {
  it("allows only agents limited to tools that can't edit or run commands", () => {
    expect(isReadOnlyAgent({ tools: ["read", "grep", "steroids", "web_search"] })).toBe(true);
    expect(isReadOnlyAgent({ tools: ["read", "bash"] })).toBe(false);
    expect(isReadOnlyAgent({ tools: ["read", "edit"] })).toBe(false);
    // An empty allow-list inherits the full toolset.
    expect(isReadOnlyAgent({ tools: [] })).toBe(false);
    expect(isReadOnlyAgent(undefined)).toBe(false);
  });

  it("treats the bundled owl and researcher as read-only, and bee/worker/auditor as not", () => {
    const readOnly = BUNDLED_AGENTS.filter(isReadOnlyAgent).map((agent) => agent.name);
    expect(readOnly).toEqual(expect.arrayContaining(["owl", "researcher"]));
    for (const name of ["bee", "worker", "auditor", "skeptic"])
      expect(readOnly).not.toContain(name);
  });
});
