import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PHASE25_PACKAGED_SMOKE_DISABLED_MESSAGE,
  runPhase25PackagedSmoke,
} from "./phase-25-native-smoke.mjs";
import {
  assertDistinctPorts,
  createIsolatedProfile,
  reserveHeldTcpPort,
  sanitizedSmokeEnvironment,
  selectExactToast,
} from "./phase-25-windows-smoke-helpers.mjs";
import {
  PHASE25_DUE_EVENT,
  armPhase25Fixture,
  claimFixtureReminder,
  createPhase25FixtureServer,
  createPhase25FixtureState,
  reserveFixtureReminder,
  validatePhase25FixtureAudit,
} from "./phase-25-sidecar-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryFixture() {
  const root = mkdtempSync(join(tmpdir(), "phase25-fixture-test-"));
  temporaryDirectories.push(root);
  return {
    root,
    projectDir: join(root, "project"),
    auditFile: join(root, "audit.jsonl"),
    armFile: join(root, "arm"),
  };
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("fixture condition timed out");
}

function exactToast() {
  return {
    title: { text: "Roadmap reminder due" },
    body: { text: "Open GG Coder to review it." },
    ancestor: {
      processId: 400,
      ownerName: "ShellExperienceHost",
      isOffscreen: false,
    },
    bounds: { x: 10, y: 10, width: 300, height: 100 },
  };
}

describe("Phase 25 automation safety and pure helpers", () => {
  it("hard-disables the retired packaged runner and removes its package command", async () => {
    await expect(runPhase25PackagedSmoke()).rejects.toThrow(
      PHASE25_PACKAGED_SMOKE_DISABLED_MESSAGE,
    );
    const packageManifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    expect(packageManifest.scripts["smoke:phase25-packaged-windows"]).toBeUndefined();
  });

  it("contains no host process, installer, shortcut, or registry integration", () => {
    const source = readdirSync(here)
      .filter((name) => /^phase-25-.*\.mjs$/.test(name) && !name.endsWith(".test.mjs"))
      .map((name) => readFileSync(join(here, name), "utf8"))
      .join("\n");
    for (const forbidden of [
      "node:child_process",
      "msiexec",
      "Stop-Process",
      "Get-CimInstance",
      "WScript.Shell",
      "RegistrySearch",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("routes reminder permission exclusively through the OS-backed Tauri command", () => {
    const frontend = readFileSync(join(here, "..", "src", "roadmap-reminders.ts"), "utf8");
    const rust = readFileSync(join(here, "..", "src-tauri", "src", "lib.rs"), "utf8");
    const capability = JSON.parse(
      readFileSync(join(here, "..", "src-tauri", "capabilities", "default.json"), "utf8"),
    );

    expect(frontend).toContain('invoke<unknown>("roadmap_reminder_notification_permission")');
    expect(frontend).not.toContain("isPermissionGranted");
    expect(frontend).not.toContain("requestPermission");
    expect(capability.permissions).not.toContain("notification:allow-is-permission-granted");
    expect(capability.permissions).not.toContain("notification:allow-request-permission");
    expect(rust).toContain("async fn roadmap_reminder_notification_permission(");
    expect(rust).toContain("roadmap_reminder_notification_permission,");
  });

  it("redirects profile and data variables into one temporary root", () => {
    const paths = createIsolatedProfile(temporaryFixture().root);
    const environment = sanitizedSmokeEnvironment(
      {
        PATH: "safe",
        GG_LIVE_SECRET: "remove",
        TAURI_CONFIG: "remove",
        WEBVIEW2_USER_DATA_FOLDER: "remove",
      },
      paths,
      { GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP: "1" },
    );
    expect(environment).toMatchObject({
      PATH: "safe",
      HOME: paths.home,
      USERPROFILE: paths.home,
      APPDATA: paths.appData,
      LOCALAPPDATA: paths.localAppData,
      WEBVIEW2_USER_DATA_FOLDER: paths.webview2,
      GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP: "1",
    });
    expect(environment.GG_LIVE_SECRET).toBeUndefined();
    expect(environment.TAURI_CONFIG).toBeUndefined();
  });

  it("holds distinct loopback fixture ports until release", async () => {
    const first = await reserveHeldTcpPort();
    const second = await reserveHeldTcpPort();
    try {
      expect(() => assertDistinctPorts([first.port, second.port])).not.toThrow();
      expect(first.port).not.toBe(second.port);
    } finally {
      await Promise.all([first.release(), second.release()]);
    }
  });

  it("rejects duplicate and malformed fixture ports", () => {
    expect(() => assertDistinctPorts([19_925, 19_925])).toThrow(/duplicate/);
    expect(() => assertDistinctPorts([0, 65_536])).toThrow(/invalid/);
  });

  it("selects one exact visible shell-owned toast from supplied data", () => {
    const exact = exactToast();
    expect(selectExactToast([exact], { hiddenAppPid: 300, protectedPids: [100] })).toEqual(exact);
  });

  it("rejects hidden-app, protected, and offscreen toast candidates", () => {
    const exact = exactToast();
    expect(selectExactToast([exact], { hiddenAppPid: 400 })).toBeNull();
    expect(selectExactToast([exact], { hiddenAppPid: 300, protectedPids: [400] })).toBeNull();
    expect(
      selectExactToast([{ ...exact, ancestor: { ...exact.ancestor, isOffscreen: true } }], {
        hiddenAppPid: 300,
      }),
    ).toBeNull();
  });

  it("rejects duplicate exact toast candidates", () => {
    const exact = exactToast();
    expect(() => selectExactToast([exact, structuredClone(exact)], { hiddenAppPid: 300 })).toThrow(
      /duplicate/,
    );
  });
});

describe("Phase 25 arm-gated sidecar fixture", () => {
  it("keeps the due event content-free", () => {
    expect(PHASE25_DUE_EVENT).toEqual({ type: "roadmap_reminder_due", data: {} });
    expect(JSON.stringify(PHASE25_DUE_EVENT)).not.toContain("Private fixture");
  });

  it("requires arming before one native claim can increment the revision", () => {
    const state = createPhase25FixtureState();
    expect(reserveFixtureReminder(state, "session", false)).toEqual({ status: "none" });
    expect(armPhase25Fixture(state)).toBe(true);
    const reserved = reserveFixtureReminder(state, "session", false);
    expect(reserved.status).toBe("reserved");
    expect(
      claimFixtureReminder(state, "session", reserved.leaseToken, "native", "granted"),
    ).toMatchObject({ status: "ok", snapshot: { revision: 2 } });
    expect(state.nativeAttempts).toBe(1);
    expect(reserveFixtureReminder(state, "session", false)).toEqual({
      status: "already-delivered",
    });
  });

  it("authenticates routes and records the exact background delivery order", async () => {
    const paths = temporaryFixture();
    const fixture = createPhase25FixtureServer(paths);
    await new Promise((resolveListen) => fixture.server.listen(0, "127.0.0.1", resolveListen));
    const address = fixture.server.address();
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${base}/notes`)).status).toBe(401);
      const created = await fetch(`${base}/session`, {
        method: "POST",
        body: JSON.stringify({ cwd: paths.projectDir }),
      }).then((response) => response.json());
      const headers = { "x-gg-session": created.sessionId, "content-type": "application/json" };
      expect(
        await fetch(`${base}/notes`, { headers }).then((response) => response.json()),
      ).toMatchObject({ status: "ok", snapshot: { revision: 1 } });
      expect(
        await fetch(`${base}/reminders/reserve`, {
          method: "POST",
          headers,
          body: JSON.stringify({ focused: false }),
        }).then((response) => response.json()),
      ).toEqual({ status: "none" });

      writeFileSync(paths.armFile, "armed\n");
      await waitFor(() => fixture.state.armed);
      const reserved = await fetch(`${base}/reminders/reserve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ focused: false }),
      }).then((response) => response.json());
      const claimed = await fetch(`${base}/reminders/claim`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          leaseToken: reserved.leaseToken,
          channel: "native",
          permission: "granted",
        }),
      }).then((response) => response.json());
      expect(claimed).toMatchObject({ status: "ok", snapshot: { revision: 2 } });

      const entries = readFileSync(paths.auditFile, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      expect(validatePhase25FixtureAudit(entries).map((entry) => entry.action)).toEqual([
        "authenticated-session",
        "authoritative-notes-ready",
        "arm",
        "reserve",
        "claim",
      ]);
      expect(entries.filter((entry) => entry.action === "claim")).toHaveLength(1);

      expect(
        (
          await fetch(`${base}/session/${encodeURIComponent(created.sessionId)}`, {
            method: "DELETE",
          })
        ).status,
      ).toBe(200);
    } finally {
      await fixture.close();
    }
  });
});
