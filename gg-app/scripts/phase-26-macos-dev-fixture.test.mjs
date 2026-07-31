import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertIsolatedPhase26MacosPaths,
  preparePhase26MacosDevFixture,
} from "./phase-26-macos-dev-fixture.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Phase 26 macOS dev fixture", () => {
  it("redirects profile, data, project, session, and evidence paths under one temporary root", () => {
    const root = mkdtempSync(join(tmpdir(), "phase26-macos-fixture-test-"));
    roots.push(root);
    const descriptorPath = join(root, "descriptor", "fixture.json");
    const fixture = preparePhase26MacosDevFixture({
      root,
      descriptorPath,
      webdriverPort: 45_321,
      baseEnvironment: {
        PATH: process.env.PATH,
        HOME: "/protected/home",
        GG_SIDECAR_PATH: "/protected/sidecar.mjs",
        TAURI_PRIVATE_KEY: "must-not-survive",
        TAURI_WEBDRIVER_PORT: "must-not-survive",
      },
    });

    expect(() => assertIsolatedPhase26MacosPaths(fixture.paths)).not.toThrow();
    expect(fixture.descriptor.root).toBe(resolve(root));
    for (const path of [
      fixture.descriptor.profileRoot,
      ...fixture.descriptor.dataRoots,
      fixture.descriptor.project,
      fixture.descriptor.evidence,
      fixture.descriptor.screenshots,
      fixture.descriptor.sidecarAudit,
      fixture.descriptor.devLog,
      fixture.descriptor.initialSessionPath,
      fixture.descriptor.boundSessionPath,
    ]) {
      expect(
        resolve(path).startsWith(`${resolve(root)}${process.platform === "win32" ? "\\" : "/"}`),
      ).toBe(true);
    }
    expect(fixture.environment.HOME).toBe(fixture.paths.home);
    expect(fixture.environment.CARGO_HOME).toBe(join("/protected/home", ".cargo"));
    expect(fixture.environment.RUSTUP_HOME).toBe(join("/protected/home", ".rustup"));
    expect(fixture.descriptor.toolRoots).toEqual({
      cargoHome: join("/protected/home", ".cargo"),
      rustupHome: join("/protected/home", ".rustup"),
    });
    expect(fixture.environment.XDG_DATA_HOME).toBe(fixture.paths.data);
    expect(fixture.environment.GG_PHASE21_SMOKE_PREBOUND).toBe("1");
    expect(fixture.environment.GG_PHASE26_MACOS_SMOKE).toBe("1");
    expect(fixture.environment.TAURI_WEBDRIVER_PORT).toBe("45321");
    expect(fixture.descriptor.webdriverPort).toBe(45_321);
    expect(fixture.environment.TAURI_PRIVATE_KEY).toBeUndefined();
    expect(existsSync(descriptorPath)).toBe(true);
    expect(JSON.parse(readFileSync(descriptorPath, "utf8"))).toEqual(fixture.descriptor);
  });

  it("rejects any fixture path outside the temporary root", () => {
    expect(() =>
      assertIsolatedPhase26MacosPaths({
        root: resolve("safe-root"),
        home: resolve("outside-root"),
      }),
    ).toThrow("escaped its temporary root");
  });

  it("requires a fixture-owned WebDriver port", () => {
    expect(() => preparePhase26MacosDevFixture({ webdriverPort: 0 })).toThrow(
      "requires an explicit WebDriver port",
    );
  });
});
