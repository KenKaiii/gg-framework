// Keep only the build runner's onnxruntime-node binaries in the sidecar. The npm
// tarball ships every OS/arch (~200 MB); dormant Intel Mach-O files also make an
// arm64 app look Intel-based to macOS inventory scanners.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export function pruneOnnxRuntimePayloads(
  nodeModulesDir,
  platform = process.platform,
  arch = process.arch,
) {
  const pkg = join(nodeModulesDir, "onnxruntime-node");
  if (!existsSync(pkg)) return [];
  const bin = join(pkg, "bin");
  const abiDirs = existsSync(bin) ? readdirSync(bin).filter((name) => /^napi-v\d+$/.test(name)) : [];
  // A silent no-op here once shipped every platform's binaries; fail instead.
  if (abiDirs.length === 0) {
    throw new Error(
      `onnxruntime-node has no bin/napi-v* folder in ${pkg}; its layout changed, update prune-native-payloads.mjs`,
    );
  }
  for (const abi of abiDirs) {
    const runtimes = join(bin, abi);
    if (!existsSync(join(runtimes, platform, arch))) {
      throw new Error(`onnxruntime-node ${abi} has no native payload for ${platform}/${arch}`);
    }
    for (const os of readdirSync(runtimes)) {
      if (os !== platform) {
        rmSync(join(runtimes, os), { recursive: true, force: true });
        continue;
      }
      for (const cpu of readdirSync(join(runtimes, os))) {
        if (cpu !== arch) rmSync(join(runtimes, os, cpu), { recursive: true, force: true });
      }
    }
  }
  return abiDirs;
}
