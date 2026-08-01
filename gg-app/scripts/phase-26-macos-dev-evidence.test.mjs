import { describe, expect, it } from "vitest";
import { inspectPhase26DevLog } from "./phase-26-macos-dev-evidence.mjs";

const remoteActiveFixtureError =
  "[ERROR] set_remote_active failed: invalid args `active` for command `set_remote_active`: command set_remote_active missing required key active";
const reminderFixtureError = "[ERROR] roadmap reminder delivery failed: invalid reminder response";
const listenerCleanupError =
  "[ERROR] unhandledrejection: TypeError: undefined is not an object (evaluating 'listeners[eventId].handlerId')";

describe("Phase 26 dev-log evidence", () => {
  it("classifies the known remote-active and reminder fixture limitations", () => {
    const audit = inspectPhase26DevLog(
      [
        remoteActiveFixtureError,
        remoteActiveFixtureError,
        reminderFixtureError,
        "normal output",
      ].join("\n"),
    );

    expect(audit).toEqual({
      status: "passed",
      listenerCleanup: {
        classification: "regression-guard",
        count: 0,
        issue: "https://github.com/tauri-apps/tauri/issues/15799",
      },
      fixtureOnly: [
        {
          kind: "remote-active",
          classification: "expected-fixture-limitation",
          count: 2,
          reason:
            "The Phase 21 sidecar fixture returns 200 {} for GET /serve; production returns boolean running/configured fields.",
        },
        {
          kind: "reminder",
          classification: "expected-fixture-limitation",
          count: 1,
          reason:
            "The Phase 21 sidecar fixture returns 200 {} for POST /reminders/reserve; production returns a typed reminder status.",
        },
      ],
    });
  });

  it("fails evidence on the exact Tauri listener-cleanup regression", () => {
    expect(() =>
      inspectPhase26DevLog(
        [remoteActiveFixtureError, listenerCleanupError, listenerCleanupError].join("\n"),
      ),
    ).toThrow(
      "Phase 26 detected 2 Tauri listener cleanup error(s): undefined is not an object (evaluating 'listeners[eventId].handlerId')",
    );
  });

  it("fails on errors outside the two documented fixture limitations", () => {
    expect(() =>
      inspectPhase26DevLog("[ERROR] unhandledrejection: Error: another listener failure"),
    ).toThrow(
      "Phase 26 detected 1 unexpected error log(s): [ERROR] unhandledrejection: Error: another listener failure",
    );
  });
});
