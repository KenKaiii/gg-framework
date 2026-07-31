import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { preparePhase21Scenario } from "./phase-21-native-smoke.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");

function normalized(path) {
  return resolve(path).replaceAll("\\", "/");
}

function isInside(path, parent) {
  const normalizedPath = normalized(path);
  const normalizedParent = normalized(parent);
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

export function assertIsolatedPhase26MacosPaths(paths) {
  for (const [name, path] of Object.entries(paths)) {
    if (name === "root") continue;
    if (!isInside(path, paths.root)) {
      throw new Error(`Phase 26 macOS fixture path escaped its temporary root: ${path}`);
    }
  }
}

function sanitizedEnvironment(baseEnvironment, fixtureVariables) {
  const environment = {};
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (/^(GG_|TAURI_|WEBVIEW2_)/i.test(key)) continue;
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...fixtureVariables };
}

export function preparePhase26MacosDevFixture({
  root = mkdtempSync(join(tmpdir(), "gg-app-phase26-macos-")),
  descriptorPath = null,
  webdriverPort,
  baseEnvironment = process.env,
} = {}) {
  if (!Number.isInteger(webdriverPort) || webdriverPort < 1 || webdriverPort > 65_535) {
    throw new Error("Phase 26 macOS fixture requires an explicit WebDriver port");
  }
  const resolvedRoot = resolve(root);
  const paths = {
    root: resolvedRoot,
    home: join(resolvedRoot, "home"),
    temp: join(resolvedRoot, "temp"),
    cache: join(resolvedRoot, "cache"),
    config: join(resolvedRoot, "config"),
    data: join(resolvedRoot, "data"),
    project: join(resolvedRoot, "project"),
    evidence: join(resolvedRoot, "evidence"),
    screenshots: join(resolvedRoot, "evidence", "screenshots"),
    sidecarAudit: join(resolvedRoot, "evidence", "sidecar-audit.jsonl"),
    devLog: join(resolvedRoot, "evidence", "tauri-dev.log"),
  };
  assertIsolatedPhase26MacosPaths(paths);
  for (const path of [
    paths.home,
    paths.temp,
    paths.cache,
    paths.config,
    paths.data,
    paths.project,
    paths.evidence,
    paths.screenshots,
  ]) {
    mkdirSync(path, { recursive: true });
  }

  const scenario = preparePhase21Scenario({ home: paths.home, projectDir: paths.project });
  writeFileSync(join(paths.home, ".gg", "auth.json"), "{}\n");

  const hostHome = baseEnvironment.HOME ?? baseEnvironment.USERPROFILE;
  const cargoHome = baseEnvironment.CARGO_HOME ?? (hostHome ? join(hostHome, ".cargo") : null);
  const rustupHome = baseEnvironment.RUSTUP_HOME ?? (hostHome ? join(hostHome, ".rustup") : null);
  if (!cargoHome || !rustupHome) {
    throw new Error("Phase 26 macOS fixture requires host Cargo and rustup tool roots");
  }
  const fixtureVariables = {
    HOME: paths.home,
    USERPROFILE: paths.home,
    CARGO_HOME: cargoHome,
    RUSTUP_HOME: rustupHome,
    TMPDIR: paths.temp,
    TEMP: paths.temp,
    TMP: paths.temp,
    XDG_CACHE_HOME: paths.cache,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    GG_APP_CWD: paths.project,
    GG_SIDECAR_PATH: join(appDir, "scripts", "phase-21-sidecar-fixture.mjs"),
    GG_PHASE21_SMOKE_AUDIT_FILE: paths.sidecarAudit,
    GG_PHASE21_SMOKE_PREBOUND: "1",
    GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP: "1",
    GG_PHASE26_MACOS_SMOKE: "1",
    TAURI_WEBDRIVER_PORT: String(webdriverPort),
  };
  const environment = sanitizedEnvironment(baseEnvironment, fixtureVariables);
  const descriptor = {
    version: 1,
    root: paths.root,
    profileRoot: paths.home,
    dataRoots: [paths.cache, paths.config, paths.data, paths.temp],
    toolRoots: { cargoHome, rustupHome },
    project: paths.project,
    evidence: paths.evidence,
    screenshots: paths.screenshots,
    sidecarAudit: paths.sidecarAudit,
    devLog: paths.devLog,
    webdriverPort,
    initialSessionPath: scenario.initialSessionPath,
    boundSessionPath: scenario.boundSessionPath,
  };
  const resolvedDescriptorPath = resolve(descriptorPath ?? join(paths.evidence, "fixture.json"));
  if (!isInside(resolvedDescriptorPath, paths.root)) {
    throw new Error(
      `Phase 26 macOS fixture descriptor escaped its temporary root: ${resolvedDescriptorPath}`,
    );
  }
  mkdirSync(dirname(resolvedDescriptorPath), { recursive: true });
  writeFileSync(resolvedDescriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

  return { paths, descriptor, descriptorPath: resolvedDescriptorPath, environment };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = argument("--root");
  const descriptor = argument("--descriptor");
  const webdriverPort = Number(argument("--webdriver-port"));
  if (root && !isAbsolute(root)) throw new Error("--root must be absolute");
  const fixture = preparePhase26MacosDevFixture({
    ...(root ? { root } : {}),
    ...(descriptor ? { descriptorPath: descriptor } : {}),
    webdriverPort,
  });
  process.stdout.write(`${JSON.stringify(fixture.descriptor, null, 2)}\n`);
  process.stderr.write(
    `Phase 26 isolated macOS dev fixture: ${relative(process.cwd(), fixture.descriptorPath)}\n`,
  );
}
