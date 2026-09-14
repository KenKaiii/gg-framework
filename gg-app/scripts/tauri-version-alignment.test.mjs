import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cargoPackages = readFileSync(new URL("../src-tauri/Cargo.lock", import.meta.url), "utf8")
  .split("[[package]]")
  .map((entry) => ({
    name: entry.match(/^name = "([^"]+)"$/m)?.[1],
    version: entry.match(/^version = "([^"]+)"$/m)?.[1],
  }));

// Tauri refuses to package when the installed JS bindings and locked Rust
// crates differ in major/minor version. Catch that before the MSI build.
describe("Tauri binding versions", () => {
  it.each([
    ["api", "tauri"],
    ["plugin-dialog", "tauri-plugin-dialog"],
    ["plugin-log", "tauri-plugin-log"],
    ["plugin-opener", "tauri-plugin-opener"],
    ["plugin-process", "tauri-plugin-process"],
    ["plugin-updater", "tauri-plugin-updater"],
  ])("aligns @tauri-apps/%s with %s", (binding, crate) => {
    const manifest = JSON.parse(
      readFileSync(
        new URL(`../node_modules/@tauri-apps/${binding}/package.json`, import.meta.url),
        "utf8",
      ),
    );
    const locked = cargoPackages.find((entry) => entry.name === crate);
    expect(locked?.version).toBeDefined();
    expect(manifest.version.split(".").slice(0, 2)).toEqual(locked.version.split(".").slice(0, 2));
  });
});
