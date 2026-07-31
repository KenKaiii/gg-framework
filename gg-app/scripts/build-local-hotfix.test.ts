import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  freshInstallerForPlatform,
  runWithCargoTomlRestored,
  tauriBuildArgs,
} from "./build-local-hotfix.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function fixture(): { root: string; nsis: string } {
  const root = mkdtempSync(join(tmpdir(), "gg-local-installer-"));
  temporaryDirectories.push(root);
  const nsis = join(root, "target", "release", "bundle", "nsis");
  mkdirSync(nsis, { recursive: true });
  return { root, nsis };
}

describe("local installer freshness", () => {
  it("selects a Windows NSIS installer with an explicit post-build-start timestamp", () => {
    const { root, nsis } = fixture();
    const startedAt = Date.now();
    const installer = join(nsis, "Supah-Coder_1.2.3_x64-setup.exe");
    writeFileSync(installer, "installer");
    const completedAt = new Date(startedAt + 1_000);
    utimesSync(installer, completedAt, completedAt);

    expect(freshInstallerForPlatform(root, "win32", startedAt)).toBe(installer);
  });

  it("rejects a stale Windows installer from an earlier build", () => {
    const { root, nsis } = fixture();
    const installer = join(nsis, "old-setup.exe");
    writeFileSync(installer, "old installer");
    const old = new Date(Date.now() - 60_000);
    utimesSync(installer, old, old);

    expect(freshInstallerForPlatform(root, "win32", Date.now())).toBeNull();
  });
});

describe("Tauri build arguments", () => {
  it("selects only NSIS on Windows and preserves non-Windows bundles", () => {
    const configPath = "local-config.json";

    expect(tauriBuildArgs("win32", configPath)).toEqual([
      "--filter",
      "gg-app",
      "tauri",
      "build",
      "--bundles",
      "nsis",
      "--no-sign",
      "--config",
      configPath,
    ]);
    expect(tauriBuildArgs("darwin", configPath)).toEqual([
      "--filter",
      "gg-app",
      "tauri",
      "build",
      "--no-sign",
      "--config",
      configPath,
    ]);
  });
});

describe("Cargo.toml restoration", () => {
  const originalCargoToml = Buffer.from(
    '[package]\r\nname = "gg-app"\r\nversion = "1.2.3"\r\n',
    "utf8",
  );

  function cargoFixture(): string {
    const root = mkdtempSync(join(tmpdir(), "gg-local-cargo-"));
    temporaryDirectories.push(root);
    const cargoTomlPath = join(root, "Cargo.toml");
    writeFileSync(cargoTomlPath, originalCargoToml);
    return cargoTomlPath;
  }

  it("restores the original CRLF bytes after a successful build", () => {
    const cargoTomlPath = cargoFixture();

    const result = runWithCargoTomlRestored(cargoTomlPath, () => {
      writeFileSync(cargoTomlPath, '[package]\nversion = "9.9.9"\n');
      return 0;
    });

    expect(result).toBe(0);
    expect(readFileSync(cargoTomlPath)).toEqual(originalCargoToml);
  });

  it("restores the original CRLF bytes after a throwing build", () => {
    const cargoTomlPath = cargoFixture();
    const buildError = new Error("Tauri failed");

    expect(() =>
      runWithCargoTomlRestored(cargoTomlPath, () => {
        writeFileSync(cargoTomlPath, '[package]\nversion = "9.9.9"\n');
        throw buildError;
      }),
    ).toThrow(buildError);
    expect(readFileSync(cargoTomlPath)).toEqual(originalCargoToml);
  });
});
