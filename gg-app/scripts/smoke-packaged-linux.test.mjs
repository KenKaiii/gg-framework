// Cross-platform unit tests for the PURE helpers of the packaged Linux smoke.
// The PID-ownership rules are safety-critical: getting them wrong means
// SIGKILLing a developer's real GG Coder or an unrelated recycled PID.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectOwnedProcessIds,
  discoverChangedDeb,
  discoverPackagedLayout,
  parseProcStat,
  snapshotDebArtifacts,
} from "./smoke-packaged-linux.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "gg-app-packaged-linux-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("packaged Linux smoke artifact discovery", () => {
  it("selects only the .deb created or replaced by the current build", () => {
    const root = temporaryDirectory();
    const stale = join(root, "GG Coder_0.1.0_amd64.deb");
    writeFileSync(stale, "old");
    writeFileSync(join(root, "notes.txt"), "ignored");
    const before = snapshotDebArtifacts(root);
    const fresh = join(root, "GG Coder_0.2.0_amd64.deb");
    writeFileSync(fresh, "new");
    expect(discoverChangedDeb(before, snapshotDebArtifacts(root))).toBe(fresh);
  });

  it("refuses to guess when nothing or several .debs changed", () => {
    const root = temporaryDirectory();
    const before = snapshotDebArtifacts(root);
    expect(() => discoverChangedDeb(before, snapshotDebArtifacts(root))).toThrow(/found 0/);
    writeFileSync(join(root, "a.deb"), "a");
    writeFileSync(join(root, "b.deb"), "b");
    expect(() => discoverChangedDeb(before, snapshotDebArtifacts(root))).toThrow(/found 2/);
  });

  it("treats a rewritten .deb at the same path as changed", () => {
    const root = temporaryDirectory();
    const deb = join(root, "app.deb");
    writeFileSync(deb, "one");
    utimesSync(deb, 1, 1);
    const before = snapshotDebArtifacts(root);
    writeFileSync(deb, "two!");
    expect(discoverChangedDeb(before, snapshotDebArtifacts(root))).toBe(deb);
  });
});

describe("packaged Linux smoke layout", () => {
  function unpack(root, { node = true, sidecar = true } = {}) {
    mkdirSync(join(root, "usr", "bin"), { recursive: true });
    writeFileSync(join(root, "usr", "bin", "gg-app"), "");
    if (node) writeFileSync(join(root, "usr", "bin", "ggnode"), "");
    const resources = join(root, "usr", "lib", "GG Coder", "sidecar");
    mkdirSync(resources, { recursive: true });
    if (sidecar) writeFileSync(join(resources, "app-sidecar.mjs"), "");
  }

  it("finds the app, Node runtime and sidecar where Tauri resolves them", () => {
    const root = temporaryDirectory();
    unpack(root);
    const real = realpathSync(root);
    expect(discoverPackagedLayout(root, "GG Coder")).toEqual({
      executable: join(real, "usr", "bin", "gg-app"),
      installDir: join(real, "usr", "bin"),
      node: join(real, "usr", "bin", "ggnode"),
      sidecar: join(real, "usr", "lib", "GG Coder", "sidecar", "app-sidecar.mjs"),
    });
  });

  it("fails when the Node runtime or sidecar is missing", () => {
    const noNode = temporaryDirectory();
    unpack(noNode, { node: false });
    expect(() => discoverPackagedLayout(noNode, "GG Coder")).toThrow(/Node runtime missing/);
    const noSidecar = temporaryDirectory();
    unpack(noSidecar, { sidecar: false });
    expect(() => discoverPackagedLayout(noSidecar, "GG Coder")).toThrow(/sidecar resource missing/);
  });
});

describe("packaged Linux smoke process ownership", () => {
  it("parses ppid even when the command name has spaces and parens", () => {
    expect(parseProcStat("4242 (GG (Coder) x) S 4100 4242 4242 0 -1")).toEqual({ ppid: 4100 });
    expect(parseProcStat("garbage")).toBeUndefined();
  });

  it("owns processes under the smoke root and their descendants only", () => {
    const root = "/tmp/gg-app-packaged-smoke-abc";
    const processes = [
      { pid: 10, ppid: 1, exe: `${root}/package/usr/bin/gg-app`, cmdline: "gg-app" },
      { pid: 11, ppid: 10, exe: `${root}/package/usr/bin/ggnode`, cmdline: "ggnode x" },
      { pid: 12, ppid: 11, exe: "/usr/bin/git", cmdline: "git status" },
      // Reparented MCP child: only its command line points at us.
      { pid: 13, ppid: 1, exe: "/usr/bin/python3", cmdline: `python3 ${root}/project/mcp.py` },
      { pid: 20, ppid: 1, exe: "/usr/bin/gg-app", cmdline: "gg-app" },
      { pid: 21, ppid: 20, exe: "/usr/bin/ggnode", cmdline: "ggnode" },
    ];
    expect(collectOwnedProcessIds(processes, [root])).toEqual([10, 11, 12, 13]);
  });

  it("never owns a recycled PID without path evidence", () => {
    const processes = [{ pid: 10, ppid: 1, exe: "/usr/bin/bash", cmdline: "bash" }];
    expect(collectOwnedProcessIds(processes, ["/tmp/gg-app-packaged-smoke-abc"])).toEqual([]);
  });
});
