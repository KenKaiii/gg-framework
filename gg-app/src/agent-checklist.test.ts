// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main", setTitle: vi.fn() }),
}));

import { getChecklist, type ChecklistSnapshot } from "./agent";

afterEach(() => clearMocks());

function snapshot(): ChecklistSnapshot {
  return {
    staleAfterDays: 30,
    items: [
      {
        id: "tests",
        group: "Code quality",
        title: "Tests",
        description: "The real tests",
        check: "Run tests",
        skill: null,
        setupCommand: null,
        status: "passed",
        checkedAt: "2026-10-05T12:00:00.000Z",
        commit: "a".repeat(64),
        uncommittedChanges: false,
        result: "pass",
        summary: "Tests passed",
        findings: [],
        evidence: ["Ran the test suite"],
        detection: null,
        runPrompt: "Report only",
      },
    ],
  };
}
function respond(payload: unknown): void {
  mockIPC((command) => {
    if (command === "sidecar_port") return 12345;
    if (command === "agent_checklist") return payload;
    return null;
  });
}

describe("getChecklist boundary", () => {
  it("accepts the same SHA-256 commit length as the shared record store", async () => {
    const value = snapshot();
    respond(value);
    expect(await getChecklist()).toEqual({ ...value, detectionWarnings: [] });
  });

  const invalid: [string, (value: ChecklistSnapshot) => unknown][] = [
    ["duplicate ids", (value) => ({ ...value, items: [...value.items, ...value.items] })],
    [
      "invalid date",
      (value) => ({
        ...value,
        items: value.items.map((item) => ({ ...item, checkedAt: "not a date" })),
      }),
    ],
    [
      "unknown status",
      (value) => ({
        ...value,
        items: value.items.map((item) => ({ ...item, status: "probably" })),
      }),
    ],
    [
      "oversized accepted finding",
      (value) => ({
        ...value,
        items: value.items.map((item) => ({ ...item, accepted: ["x".repeat(301)] })),
      }),
    ],
    [
      "oversized evidence",
      (value) => ({
        ...value,
        items: value.items.map((item) => ({ ...item, evidence: ["x".repeat(201)] })),
      }),
    ],
    [
      "non-boolean changes flag",
      (value) => ({
        ...value,
        items: value.items.map((item) => ({ ...item, uncommittedChanges: "false" })),
      }),
    ],
  ];
  it.each(invalid)(
    "rejects %s without handing an invalid snapshot to the UI",
    async (_name, change) => {
      respond(change(snapshot()));
      expect(await getChecklist()).toBeNull();
    },
  );

  it("returns null for a failed native request", async () => {
    mockIPC((command) => {
      if (command === "sidecar_port") return 12345;
      if (command === "agent_checklist") throw new Error("snapshot unavailable");
      return null;
    });
    expect(await getChecklist()).toBeNull();
  });
});
