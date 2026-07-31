import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clickExpression, connectToPackagedWebview } from "./phase-20-native-smoke.mjs";

export const PHASE21_ID = "phase-21";
export const PHASE21_OPERATION_ID = "phase21-operation-1";
export const PHASE21_PLAN_REASON = "Plan Roadmap phase: Bound phase";

function fail(message) {
  throw new Error(message);
}

export function preparePhase21Scenario({ home, projectDir }) {
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(home, ".gg"), { recursive: true });
  const initialSessionPath = join(projectDir, "phase-21-initial.jsonl");
  const boundSessionPath = join(projectDir, "phase-21-bound.jsonl");
  writeFileSync(
    initialSessionPath,
    `${JSON.stringify({ type: "session", id: "phase21-initial" })}\n`,
  );
  writeFileSync(boundSessionPath, `${JSON.stringify({ type: "session", id: "phase21-bound" })}\n`);
  writeFileSync(
    join(home, ".gg", "gg-app-workspace.json"),
    JSON.stringify(
      {
        windows: [
          {
            mode: "code",
            cwd: projectDir,
            sessionPath: initialSessionPath,
            width: 1024,
            height: 720,
          },
        ],
      },
      null,
      2,
    ),
  );
  return { initialSessionPath, boundSessionPath };
}

const INSTALL_PROBE = `
(async () => {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals?.invoke || !internals?.transformCallback) {
    throw new Error("Tauri internals are unavailable in the packaged webview");
  }
  const evidence = { sequence: [], events: [], initial: {} };
  let sequence = 0;
  const mark = (type, details = {}) => {
    const entry = { sequence: ++sequence, type, ...details };
    evidence.sequence.push(entry);
    return entry;
  };
  const originalInvoke = internals.invoke.bind(internals);

  const eventCallback = internals.transformCallback((event) => {
    const envelope = event?.payload;
    if (envelope?.paneId !== "primary") return;
    if (!["session_reset", "notes_change", "plan_enter"].includes(envelope?.type)) return;
    const entry = mark("event:" + envelope.type, {
      paneId: envelope.paneId,
      sessionId: envelope.sessionId,
      data: JSON.parse(JSON.stringify(envelope.data ?? null)),
    });
    evidence.events.push(entry);
  });
  await originalInvoke("plugin:event|listen", {
    event: "agent-event",
    target: { kind: "Any" },
    handler: eventCallback,
  });
  evidence.initial = {
    notesButtonCount: document.querySelectorAll('button[aria-label="Notes"]').length,
    planModeText: document.querySelector(".footer-plan")?.textContent ?? "",
  };
  window.__GG_PHASE21_SMOKE__ = { evidence, originalInvoke };
  return evidence.initial;
})()
`;

function readAuditEntries(auditPath) {
  return readFileSync(auditPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readBackendEvidence(auditPath) {
  const entries = readAuditEntries(auditPath);
  return {
    sessions: entries.filter((entry) => entry.route === "/session"),
    phaseStarts: entries.filter((entry) => entry.route?.startsWith("/phases/")),
    prompts: entries.filter((entry) => entry.route === "phase-prompt"),
  };
}

function readNativeEvidence(auditPath) {
  return readAuditEntries(auditPath).filter((entry) => entry.route === "agent_phase_start");
}

export function validatePhase21Evidence(evidence, expectedBoundSessionPath) {
  const backend = evidence.backend;
  const native = evidence.native ?? [];
  const busy = evidence.probes?.busy;
  const alreadyBound = evidence.probes?.alreadyBound;
  const acceptedNative = native.find((entry) => entry.httpStatus === 202);
  const accepted = acceptedNative?.outcome?.response;
  const acceptedAudit = backend.phaseStarts.find(
    (entry) => entry.status === 202 && entry.result === "accepted",
  );

  if (busy?.status !== "failed" || busy.code !== "session-busy") {
    fail("native Phase 21 busy response was not a typed session-busy failure");
  }
  if (accepted?.operationId !== PHASE21_OPERATION_ID) {
    fail("native Phase 21 accepted response did not contain the deterministic operationId");
  }
  if (accepted?.session?.sessionPath !== expectedBoundSessionPath) {
    fail("native Phase 21 accepted response did not bind the expected session path");
  }
  if (alreadyBound?.status !== "already-bound" || alreadyBound.packageTokenCount !== 0) {
    fail("native Phase 21 already-bound response was not typed");
  }
  const nativeHttpStatuses = native.map((entry) => entry.httpStatus);
  const nativeResultStatuses = native.map((entry) => entry.outcome?.response?.status);
  if (
    JSON.stringify(nativeHttpStatuses) !== JSON.stringify([409, 202, 200]) ||
    JSON.stringify(nativeResultStatuses) !== JSON.stringify(["failed", "accepted", "already-bound"])
  ) {
    fail(
      `Phase 21 native proxy did not return typed 409/202/200 outcomes: ${nativeHttpStatuses.join(",")}`,
    );
  }
  const nativePhaseIds = native.map((entry) => entry.phaseId);
  if (
    JSON.stringify(nativePhaseIds) !== JSON.stringify(["phase-busy", PHASE21_ID, PHASE21_ID]) ||
    native.some((entry) => entry.paneId !== "primary" || entry.authenticated !== true)
  ) {
    fail("Phase 21 Start did not cross the authenticated primary-pane native command boundary");
  }
  if (
    acceptedAudit?.operationId !== accepted.operationId ||
    acceptedAudit?.boundSessionPath !== accepted.session.sessionPath
  ) {
    fail("native Phase 21 typed 202 response did not match the authenticated sidecar result");
  }

  const resets = evidence.events.filter((entry) => entry.type === "event:session_reset");
  if (resets.length !== 1 || resets[0].data?.operationId !== accepted.operationId) {
    fail("Phase 21 did not forward exactly one matching session_reset operationId");
  }
  const notesChanges = evidence.events.filter((entry) => entry.type === "event:notes_change");
  const boundPhases = notesChanges
    .flatMap((entry) => entry.data?.document?.phases ?? [])
    .filter((phase) => phase.session !== null && phase.session !== undefined);
  if (
    boundPhases.length !== 1 ||
    boundPhases[0].id !== PHASE21_ID ||
    boundPhases[0].session.sessionPath !== expectedBoundSessionPath
  ) {
    fail("Phase 21 Notes change did not contain exactly one bound phase session");
  }

  const statuses = backend.phaseStarts.map((entry) => entry.status);
  if (JSON.stringify(statuses) !== JSON.stringify([409, 202, 200])) {
    fail(`Phase 21 backend did not record typed 409/202/200 responses: ${statuses.join(",")}`);
  }
  if (
    backend.phaseStarts.length !== 3 ||
    backend.phaseStarts.some((entry) => !entry.authenticated)
  ) {
    fail("Phase 21 route was not invoked three times through authenticated pane sessions");
  }
  if (
    backend.prompts.length !== 1 ||
    backend.prompts[0].operationId !== accepted.operationId ||
    backend.prompts[0].status !== 202
  ) {
    fail("Phase 21 did not record exactly one prompt operation matching the reset");
  }

  const restoredSessions = backend.sessions.filter(
    (entry) => entry.requestedSessionPath === expectedBoundSessionPath,
  );
  if (restoredSessions.length !== 1) {
    fail("Phase 21 sidecar did not restart the bound session path exactly once");
  }
  if (
    evidence.final.nativeState?.sessionPath !== expectedBoundSessionPath ||
    evidence.final.nativeState?.planMode !== true
  ) {
    fail("Phase 21 bound session did not restore as the active Plan Mode session");
  }
  const restoredPhases =
    evidence.final.nativeNotes?.snapshot?.document?.phases?.filter(
      (phase) =>
        phase.id === PHASE21_ID &&
        phase.status === "planning" &&
        phase.session?.sessionPath === expectedBoundSessionPath,
    ) ?? [];
  if (restoredPhases.length !== 1) {
    fail("Phase 21 active phase was not restored from authenticated Project Notes");
  }
  if (!evidence.final.transcriptText.includes(PHASE21_PLAN_REASON)) {
    fail("Phase 21 active phase reason was not restored from session history");
  }
  if (!evidence.final.planModeText.toLowerCase().includes("plan mode")) {
    fail("Phase 21 Plan Mode footer was not restored");
  }
  return evidence;
}

async function openPhaseDetail(client, waitFor, action) {
  await client.evaluate(clickExpression("Notes"));
  await waitFor("Phase 21 Notes modal", () =>
    client.evaluate(`document.querySelector('[role="dialog"]') !== null`),
  );
  await waitFor("Phase 21 Roadmap tab", () =>
    client.evaluate(
      `document.querySelector('button[role="tab"][aria-controls="notes-panel-roadmap"]') !== null`,
    ),
  );
  await client.evaluate(
    `document.querySelector('button[role="tab"][aria-controls="notes-panel-roadmap"]')?.click()`,
  );
  await waitFor(`Phase 21 ${action} row`, () =>
    client.evaluate(
      `[...document.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === ${JSON.stringify(`${action} phase: Bound phase`)})`,
    ),
  );
  await client.evaluate(
    `document.querySelector('button[aria-label=${JSON.stringify(`${action} phase: Bound phase`)}]')?.click()`,
  );
  await waitFor(`Phase 21 ${action} detail`, () =>
    client.evaluate(
      `[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === ${JSON.stringify(`${action} phase`)})`,
    ),
  );
}

export async function runPhase21Scenario({
  cdpPort,
  waitFor,
  evidenceDir,
  projectDir,
  initialSessionPath,
  boundSessionPath,
  sidecarAuditPath,
  nativeAuditPath,
}) {
  const client = await connectToPackagedWebview(cdpPort, waitFor);
  try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    const layout = {
      version: 9,
      root: { type: "leaf", paneId: "primary" },
      focusedPaneId: "primary",
      panes: {
        primary: {
          kind: "agent",
          mode: "code",
          cwd: projectDir,
          sessionPath: initialSessionPath,
        },
      },
    };
    await client.evaluate(`(() => {
      localStorage.setItem("gg-workspace-layout-recursive:main", ${JSON.stringify(JSON.stringify(layout))});
      location.reload();
      return true;
    })()`);
    await waitFor("Phase 21 hydrated packaged pane", () =>
      client.evaluate(`document.querySelector('button[aria-label="Notes"]') !== null`),
    );
    const initial = await client.evaluate(INSTALL_PROBE);
    if (initial.notesButtonCount !== 1) fail("Phase 21 probe did not find one Notes control");

    const busy = await client.evaluate(
      `window.__TAURI_INTERNALS__.invoke("agent_phase_start", { paneId: "primary", phaseId: "phase-busy" })`,
    );
    if (busy?.status !== "failed") fail("Phase 21 busy probe did not return a typed value");
    await client.evaluate(
      `window.__GG_PHASE21_SMOKE__.evidence.probes = { busy: ${JSON.stringify(busy)} }`,
    );

    await openPhaseDetail(client, waitFor, "Start");
    await client.evaluate(clickExpression("Start phase"));
    await waitFor("Phase 21 accepted Start and reset", () =>
      client.evaluate(`(() => {
        const evidence = window.__GG_PHASE21_SMOKE__.evidence;
        const reset = evidence.events.some(
          (entry) => entry.type === "event:session_reset" && entry.data?.operationId === ${JSON.stringify(PHASE21_OPERATION_ID)},
        );
        return reset && document.querySelector('[role="dialog"]') === null;
      })()`),
    );

    const alreadyBound = await client.evaluate(
      `window.__TAURI_INTERNALS__.invoke("agent_phase_start", { paneId: "primary", phaseId: ${JSON.stringify(PHASE21_ID)} })`,
    );
    if (alreadyBound?.status !== "already-bound") {
      fail("Phase 21 already-bound probe did not return a typed value");
    }
    await client.evaluate(
      `window.__GG_PHASE21_SMOKE__.evidence.probes.alreadyBound = ${JSON.stringify(alreadyBound)}`,
    );

    await openPhaseDetail(client, waitFor, "Resume");
    await client.evaluate(clickExpression("Resume phase"));
    await waitFor("Phase 21 bound session Plan Mode restoration", () =>
      client.evaluate(`(async () => {
        const state = await window.__GG_PHASE21_SMOKE__.originalInvoke("agent_state", { paneId: "primary" });
        const planReason = document.querySelector(".plan-logo-reason")?.textContent ?? "";
        const planMode = document.querySelector(".footer-plan")?.textContent ?? "";
        return (
          state.sessionPath === ${JSON.stringify(boundSessionPath)} &&
          state.planMode === true &&
          planReason.includes(${JSON.stringify(PHASE21_PLAN_REASON)}) &&
          planMode.toLowerCase().includes("plan mode")
        );
      })()`),
    );

    const backend = await waitFor("Phase 21 backend audit", () => {
      try {
        const audit = readBackendEvidence(sidecarAuditPath);
        const complete =
          audit.phaseStarts.length === 3 &&
          audit.prompts.length === 1 &&
          audit.sessions.some((entry) => entry.requestedSessionPath === boundSessionPath);
        return complete ? audit : null;
      } catch {
        return null;
      }
    });
    const native = await waitFor("Phase 21 native proxy audit", () => {
      try {
        const audit = readNativeEvidence(nativeAuditPath);
        return audit.length === 3 ? audit : null;
      } catch {
        return null;
      }
    });
    const nativeState = await client.evaluate(
      `window.__GG_PHASE21_SMOKE__.originalInvoke("agent_state", { paneId: "primary" })`,
    );
    const nativeNotes = await client.evaluate(
      `window.__GG_PHASE21_SMOKE__.originalInvoke("agent_notes_get", { paneId: "primary" })`,
    );
    const evidence = await client.evaluate(`(() => {
      const evidence = window.__GG_PHASE21_SMOKE__.evidence;
      evidence.final = {
        transcriptText: document.querySelector(".transcript")?.textContent ?? "",
        planModeText: document.querySelector(".footer-plan")?.textContent ?? "",
      };
      return evidence;
    })()`);
    evidence.final.nativeState = nativeState;
    evidence.final.nativeNotes = nativeNotes;
    evidence.backend = backend;
    evidence.native = native;
    validatePhase21Evidence(evidence, boundSessionPath);

    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, "start-resume.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    const screenshot = await client.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(evidenceDir, "start-resume.png"), Buffer.from(screenshot.data, "base64"));
    return evidence;
  } catch (error) {
    mkdirSync(evidenceDir, { recursive: true });
    const failure = {
      error:
        error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
      evidence: null,
      backend: null,
      native: null,
    };
    try {
      failure.evidence = await client.evaluate(`(() => ({
        ...window.__GG_PHASE21_SMOKE__?.evidence,
        final: {
          transcriptText: document.querySelector(".transcript")?.textContent ?? "",
          planModeText: document.querySelector(".footer-plan")?.textContent ?? "",
          dialogText: document.querySelector('[role="dialog"]')?.textContent ?? "",
        },
      }))()`);
    } catch {
      // The webview may have exited; backend audit still provides route evidence.
    }
    try {
      failure.backend = readBackendEvidence(sidecarAuditPath);
    } catch {
      // The fixture may have failed before its first audited request.
    }
    try {
      failure.native = readNativeEvidence(nativeAuditPath);
    } catch {
      // The native proxy may have failed before its first audited response.
    }
    writeFileSync(join(evidenceDir, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`);
    try {
      const screenshot = await client.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(evidenceDir, "failure.png"), Buffer.from(screenshot.data, "base64"));
    } catch {
      // Keep the structured failure artifact when screenshot capture is unavailable.
    }
    throw error;
  } finally {
    client.close();
  }
}
