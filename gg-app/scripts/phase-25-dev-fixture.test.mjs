import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureShellEnvironment, preparePhase25DevFixture } from "./phase-25-dev-fixture.mjs";
import {
  createPhase25FixtureServer,
  validatePhase25FixtureAudit,
} from "./phase-25-sidecar-fixture.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "phase25-dev-fixture-test-"));
  temporaryDirectories.push(root);
  return root;
}

async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("fixture condition timed out");
}

function auditEntries(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("Phase 25 isolated dev fixture", () => {
  it("redirects every profile/data hook and leaves the real-profile sentinel untouched", () => {
    const root = temporaryRoot();
    const realProfile = join(root, "real-profile");
    const realAgentDir = join(realProfile, ".gg");
    const realAppData = join(realProfile, "AppData", "Roaming");
    const realLocalAppData = join(realProfile, "AppData", "Local");
    mkdirSync(realAgentDir, { recursive: true });
    mkdirSync(realAppData, { recursive: true });
    mkdirSync(realLocalAppData, { recursive: true });
    const sentinel = join(realAgentDir, "real-notes-must-not-change.json");
    writeFileSync(sentinel, '{"protected":true}\n');

    const fixture = preparePhase25DevFixture({
      root: join(root, "isolated"),
      cdpPort: 19_925,
      descriptorPath: join(root, "descriptor.json"),
      baseEnvironment: {
        PATH: process.env.PATH,
        HOME: realProfile,
        USERPROFILE: realProfile,
        APPDATA: realAppData,
        LOCALAPPDATA: realLocalAppData,
        GG_PHASE25_SMOKE_SEED_FILE: sentinel,
        WEBVIEW2_USER_DATA_FOLDER: join(realLocalAppData, "protected-webview"),
      },
    });

    expect(readFileSync(sentinel, "utf8")).toBe('{"protected":true}\n');
    expect(readdirSync(realAgentDir)).toEqual(["real-notes-must-not-change.json"]);
    expect(fixture.environment.HOME).toBe(fixture.paths.home);
    expect(fixture.environment.USERPROFILE).toBe(fixture.paths.home);
    expect(fixture.environment.APPDATA).toBe(fixture.paths.appData);
    expect(fixture.environment.LOCALAPPDATA).toBe(fixture.paths.localAppData);
    expect(fixture.environment.WEBVIEW2_USER_DATA_FOLDER).toBe(fixture.paths.webview2);
    expect(fixture.environment.GG_PHASE25_SMOKE_SEED_FILE).toBe(fixture.descriptor.seedFile);
    expect(fixture.environment.GG_PHASE25_DEV_FIXTURE_CDP_PORT).toBe("19925");
    expect(fixture.environment.GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP).toBe("1");
    expect(fixture.seed.document.phases).toHaveLength(1);
    expect(fixture.seed.document.phases[0].reminder).toMatchObject({
      occurrenceKey: "occurrence-phase-25",
      lastDelivery: null,
    });
    expect(Date.parse(fixture.seed.document.phases[0].reminder.dueAt)).toBeLessThan(Date.now());

    const shell = fixtureShellEnvironment(fixture, {
      GG_UNSAFE_INHERITED_VALUE: "blocked",
      TAURI_CONFIG: "blocked",
      WEBVIEW2_USER_DATA_FOLDER: "blocked",
    });
    expect(shell).toContain("unset 'GG_UNSAFE_INHERITED_VALUE'");
    expect(shell).toContain(`export HOME='${fixture.paths.home.replaceAll("'", "'\\''")}'`);
    expect(shell).not.toContain("blocked");
  });

  it("blocks background delivery and permits exactly one focused in-app claim", async () => {
    const root = temporaryRoot();
    const fixtureFiles = preparePhase25DevFixture({
      root: join(root, "isolated"),
      cdpPort: 19_926,
      descriptorPath: join(root, "descriptor.json"),
      baseEnvironment: {},
    });
    const fixture = createPhase25FixtureServer({
      projectDir: fixtureFiles.paths.project,
      auditFile: fixtureFiles.descriptor.auditFile,
      armFile: fixtureFiles.descriptor.armFile,
      seedSnapshot: fixtureFiles.seed,
      focusedOnly: true,
    });
    await new Promise((resolveListen) => fixture.server.listen(0, "127.0.0.1", resolveListen));
    const address = fixture.server.address();
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const created = await fetch(`${base}/session`, {
        method: "POST",
        body: JSON.stringify({ cwd: fixtureFiles.paths.project }),
      }).then((response) => response.json());
      const headers = { "x-gg-session": created.sessionId, "content-type": "application/json" };
      await fetch(`${base}/notes`, { headers });
      writeFileSync(fixtureFiles.descriptor.armFile, "focused-only\n");
      await waitFor(() => fixture.state.armed);

      expect(
        await fetch(`${base}/reminders/reserve`, {
          method: "POST",
          headers,
          body: JSON.stringify({ focused: false }),
        }).then((response) => response.json()),
      ).toEqual({ status: "none" });
      const reserved = await fetch(`${base}/reminders/reserve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ focused: true }),
      }).then((response) => response.json());
      expect(reserved).toMatchObject({ status: "reserved" });
      await fetch(`${base}/reminders/claim`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          leaseToken: reserved.leaseToken,
          channel: "in-app",
          permission: "not-required",
        }),
      });

      const entries = auditEntries(fixtureFiles.descriptor.auditFile);
      expect(entries.filter((entry) => entry.action === "background-reserve-blocked")).toHaveLength(
        1,
      );
      expect(() =>
        validatePhase25FixtureAudit(entries, {
          focused: true,
          channel: "in-app",
          permission: "not-required",
        }),
      ).not.toThrow();
      expect(fixture.state.nativeAttempts).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});
