import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PHASE21_OPERATION_ID,
  PHASE21_PLAN_REASON,
  preparePhase21Scenario,
  validatePhase21Evidence,
} from "./phase-21-native-smoke.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "gg-app-phase21-smoke-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function baseEvidence(boundSessionPath) {
  return {
    sequence: [],
    native: [
      {
        route: "agent_phase_start",
        paneId: "primary",
        phaseId: "phase-busy",
        httpStatus: 409,
        authenticated: true,
        outcome: {
          response: {
            status: "failed",
            code: "session-busy",
            operationId: null,
            message: "busy",
          },
        },
      },
      {
        route: "agent_phase_start",
        paneId: "primary",
        phaseId: "phase-21",
        httpStatus: 202,
        authenticated: true,
        outcome: {
          response: {
            status: "accepted",
            operationId: PHASE21_OPERATION_ID,
            session: { sessionId: "phase21-bound-session", sessionPath: boundSessionPath },
            packageTokenCount: 42,
          },
        },
      },
      {
        route: "agent_phase_start",
        paneId: "primary",
        phaseId: "phase-21",
        httpStatus: 200,
        authenticated: true,
        outcome: {
          response: {
            status: "already-bound",
            operationId: "phase21-already-bound-1",
            session: { sessionId: "phase21-bound-session", sessionPath: boundSessionPath },
            packageTokenCount: 0,
          },
        },
      },
    ],
    probes: {
      busy: {
        status: "failed",
        code: "session-busy",
        operationId: null,
        message: "busy",
      },
      alreadyBound: {
        status: "already-bound",
        operationId: "phase21-already-bound-1",
        session: { sessionId: "phase21-bound-session", sessionPath: boundSessionPath },
        packageTokenCount: 0,
      },
    },
    events: [
      {
        sequence: 9,
        type: "event:session_reset",
        data: { operationId: PHASE21_OPERATION_ID },
      },
      {
        sequence: 10,
        type: "event:notes_change",
        data: {
          document: {
            phases: [
              {
                id: "phase-21",
                session: { sessionId: "phase21-bound-session", sessionPath: boundSessionPath },
              },
            ],
          },
        },
      },
    ],
    backend: {
      sessions: [
        { route: "/session", requestedSessionPath: "initial.jsonl" },
        { route: "/session", requestedSessionPath: boundSessionPath },
      ],
      phaseStarts: [
        { route: "/phases/phase-busy/start", status: 409, authenticated: true },
        {
          route: "/phases/phase-21/start",
          status: 202,
          authenticated: true,
          result: "accepted",
          operationId: PHASE21_OPERATION_ID,
          boundSessionPath,
        },
        { route: "/phases/phase-21/start", status: 200, authenticated: true },
      ],
      prompts: [{ route: "phase-prompt", status: 202, operationId: PHASE21_OPERATION_ID }],
    },
    final: {
      nativeState: { sessionPath: boundSessionPath, planMode: true },
      nativeNotes: {
        status: "ok",
        snapshot: {
          document: {
            phases: [
              {
                id: "phase-21",
                status: "planning",
                session: { sessionPath: boundSessionPath },
              },
            ],
          },
        },
      },
      transcriptText: PHASE21_PLAN_REASON,
      planModeText: "◆ plan mode",
    },
  };
}

describe("Phase 21 packaged native smoke scenario", () => {
  it("seeds one unbound phase and distinct initial/bound session paths", () => {
    const root = temporaryDirectory();
    const home = join(root, "home");
    const projectDir = join(root, "project");
    const prepared = preparePhase21Scenario({ home, projectDir });

    expect(existsSync(prepared.initialSessionPath)).toBe(true);
    expect(existsSync(prepared.boundSessionPath)).toBe(true);
    expect(prepared.initialSessionPath).not.toBe(prepared.boundSessionPath);
    const workspace = JSON.parse(readFileSync(join(home, ".gg", "gg-app-workspace.json"), "utf8"));
    expect(workspace.windows[0].sessionPath).toBe(prepared.initialSessionPath);
  });

  it("accepts authenticated typed failures, one matching reset/prompt, and restored Plan Mode", () => {
    const boundSessionPath = "C:\\smoke\\project\\phase-21-bound.jsonl";
    const evidence = baseEvidence(boundSessionPath);

    expect(validatePhase21Evidence(evidence, boundSessionPath)).toBe(evidence);
  });

  it("rejects an accepted backend audit without the matching typed native response", () => {
    const boundSessionPath = "C:\\smoke\\project\\phase-21-bound.jsonl";
    const evidence = baseEvidence(boundSessionPath);
    const accepted = evidence.native.find((entry) => entry.httpStatus === 202);
    accepted.outcome.response.operationId = "wrong-operation";

    expect(() => validatePhase21Evidence(evidence, boundSessionPath)).toThrow(
      "accepted response did not contain the deterministic operationId",
    );
  });

  it("rejects a reset operation that does not match the accepted Start", () => {
    const boundSessionPath = "C:\\smoke\\project\\phase-21-bound.jsonl";
    const evidence = baseEvidence(boundSessionPath);
    evidence.events[0].data.operationId = "wrong-operation";

    expect(() => validatePhase21Evidence(evidence, boundSessionPath)).toThrow(
      "exactly one matching session_reset operationId",
    );
  });

  it("rejects a Resume that does not restore Plan Mode", () => {
    const boundSessionPath = "C:\\smoke\\project\\phase-21-bound.jsonl";
    const evidence = baseEvidence(boundSessionPath);
    evidence.final.nativeState.planMode = false;

    expect(() => validatePhase21Evidence(evidence, boundSessionPath)).toThrow(
      "did not restore as the active Plan Mode session",
    );
  });

  it("rejects duplicate bindings or a missing restored active phase", () => {
    const boundSessionPath = "C:\\smoke\\project\\phase-21-bound.jsonl";
    const duplicateBinding = baseEvidence(boundSessionPath);
    duplicateBinding.events[1].data.document.phases.push({
      id: "phase-duplicate",
      session: { sessionPath: boundSessionPath },
    });
    expect(() => validatePhase21Evidence(duplicateBinding, boundSessionPath)).toThrow(
      "exactly one bound phase session",
    );

    const missingActivePhase = baseEvidence(boundSessionPath);
    missingActivePhase.final.nativeNotes.snapshot.document.phases[0].status = "not-started";
    expect(() => validatePhase21Evidence(missingActivePhase, boundSessionPath)).toThrow(
      "active phase was not restored",
    );
  });
});
