import { describe, expect, it } from "vitest";
import { AppSidecarReloadCoordinator } from "./app-sidecar-reload.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function startAcceptedContinuation(
  reload: AppSidecarReloadCoordinator,
  continuation: () => Promise<void>,
): Promise<void> {
  const releaseRequest = reload.tryAcquireSessionMutation("POST");
  expect(releaseRequest).toEqual(expect.any(Function));

  const releaseOperation = reload.tryAcquireOperationMutation();
  expect(releaseOperation).toEqual(expect.any(Function));

  const settled = continuation().finally(releaseOperation!);
  // Models the early 202 response finishing before accepted work settles.
  releaseRequest!();
  return settled;
}

async function expectReloadBlockedUntilSettled(
  reload: AppSidecarReloadCoordinator,
  settled: Promise<void>,
  releasePause: () => void,
): Promise<void> {
  expect(reload.prepare([])).toEqual({ ok: false, reason: "active-runs" });
  releasePause();
  await settled;
  expect(reload.prepare([])).toEqual({ ok: true });
}

describe("app-sidecar early-response reload races", () => {
  it("blocks reload after accepting a prompt while preprocessing is paused", async () => {
    const reload = new AppSidecarReloadCoordinator();
    const preprocessing = deferred();
    const settled = startAcceptedContinuation(reload, () => preprocessing.promise);

    await expectReloadBlockedUntilSettled(reload, settled, preprocessing.resolve);
  });

  it("blocks reload after accepting a task while session startup is paused", async () => {
    const reload = new AppSidecarReloadCoordinator();
    const sessionStartup = deferred();
    const settled = startAcceptedContinuation(reload, () => sessionStartup.promise);

    await expectReloadBlockedUntilSettled(reload, settled, sessionStartup.resolve);
  });

  it("blocks reload while thinking preference persistence is paused", async () => {
    const reload = new AppSidecarReloadCoordinator();
    const persistence = deferred();
    const settled = startAcceptedContinuation(reload, () => persistence.promise);

    await expectReloadBlockedUntilSettled(reload, settled, persistence.resolve);
  });
});
