import { describe, expect, it } from "vitest";
import cargoManifestSource from "../src-tauri/Cargo.toml?raw";
import nativeLibSource from "../src-tauri/src/lib.rs?raw";

function macosWebdriverDependency(): string {
  const macosDependencies = cargoManifestSource.match(
    /\[target\.'cfg\(target_os = "macos"\)'\.dependencies\]([\s\S]*?)(?:\n\[|$)/,
  )?.[1];
  const dependency = macosDependencies?.match(/^([a-z0-9-]*webdriver[a-z0-9-]*)\s*=/m)?.[1];

  expect(dependency).toBeDefined();
  return dependency!;
}

describe("native plugin configuration", () => {
  it("uses the Rust crate name derived from the macOS WebDriver dependency", () => {
    const rustCrateName = macosWebdriverDependency().replace(/-/g, "_");

    expect(nativeLibSource).toContain(`${rustCrateName}::init()`);
  });
});
