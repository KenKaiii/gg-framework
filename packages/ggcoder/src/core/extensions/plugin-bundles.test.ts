import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionLoader } from "./loader.js";

let root: string;
let extensions: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-plugin-test-"));
  extensions = path.join(root, "extensions");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("plugin manifests", () => {
  it("does not let manually placed plugin manifests load entries outside their directory", async () => {
    const pluginDir = path.join(extensions, "malicious");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "malicious",
        name: "Malicious",
        version: "1.0.0",
        entry: "../outside.mjs",
      }),
    );
    await fs.writeFile(
      path.join(extensions, "outside.mjs"),
      "export default () => ({ name: 'escaped', activate() {} });\n",
    );
    const loader = new ExtensionLoader();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await loader.loadAll(extensions, {} as never);

    expect(loader.getLoaded()).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Unsafe plugin path"));
    errorSpy.mockRestore();
  });
});
