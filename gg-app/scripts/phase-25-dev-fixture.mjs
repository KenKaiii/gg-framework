import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPhase25FixtureState, notesFixtureSnapshot } from "./phase-25-sidecar-fixture.mjs";
import {
  createIsolatedProfile,
  sanitizedSmokeEnvironment,
} from "./phase-25-windows-smoke-helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const defaultDescriptorPath = join(appDir, ".gg", "evidence", "phase-25-dev", "fixture.json");

function normalizePath(path) {
  return resolve(path).replaceAll("\\", "/").toLowerCase();
}

function isInside(path, parent) {
  const normalizedPath = normalizePath(path);
  const normalizedParent = normalizePath(parent);
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

function protectedProfilePaths(environment) {
  const values = [];
  for (const home of [environment.HOME, environment.USERPROFILE]) {
    if (home) values.push(join(home, ".gg"));
  }
  for (const dataRoot of [environment.APPDATA, environment.LOCALAPPDATA]) {
    if (!dataRoot) continue;
    values.push(join(dataRoot, "com.ggcoder.app"));
    values.push(join(dataRoot, "GG Coder"));
  }
  return [...new Set(values.map((value) => resolve(value)))];
}

export function assertIsolatedPhase25Paths(paths, baseEnvironment) {
  const fixturePaths = [
    paths.home,
    paths.appData,
    paths.localAppData,
    paths.temp,
    paths.webview2,
    paths.project,
    paths.audit,
    paths.screenshots,
  ];
  for (const fixturePath of fixturePaths) {
    if (!isInside(fixturePath, paths.root)) {
      throw new Error(`Phase 25 fixture path escaped its temporary root: ${fixturePath}`);
    }
  }
  for (const protectedPath of protectedProfilePaths(baseEnvironment)) {
    if (fixturePaths.some((fixturePath) => isInside(fixturePath, protectedPath))) {
      throw new Error(`Phase 25 fixture overlaps protected profile data: ${protectedPath}`);
    }
  }
}

export function preparePhase25DevFixture({
  root = mkdtempSync(join(tmpdir(), "gg-app-phase25-dev-")),
  cdpPort,
  descriptorPath = defaultDescriptorPath,
  baseEnvironment = process.env,
} = {}) {
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65_535) {
    throw new Error("Phase 25 dev fixture requires an explicit CDP port");
  }
  const paths = createIsolatedProfile(resolve(root));
  assertIsolatedPhase25Paths(paths, baseEnvironment);

  const agentDir = join(paths.home, ".gg");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}\n");
  writeFileSync(
    join(agentDir, "gg-app.json"),
    `${JSON.stringify({ projectsRoot: paths.project }, null, 2)}\n`,
  );
  writeFileSync(
    join(agentDir, "gg-app-workspace.json"),
    `${JSON.stringify(
      {
        windows: [
          {
            mode: "code",
            cwd: paths.project,
            sessionPath: null,
            width: 1024,
            height: 720,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const fixtureState = createPhase25FixtureState(paths.project);
  const seed = notesFixtureSnapshot(fixtureState);
  const reminders = seed.document.phases.flatMap((phase) =>
    phase.reminder ? [{ phase, reminder: phase.reminder }] : [],
  );
  if (
    reminders.length !== 1 ||
    Date.parse(reminders[0].reminder.dueAt) >= Date.now() ||
    reminders[0].reminder.lastDelivery !== null
  ) {
    throw new Error("Phase 25 dev fixture must seed exactly one undelivered overdue reminder");
  }

  const seedFile = join(paths.audit, "overdue-reminder.json");
  const auditFile = join(paths.audit, "fixture-audit.jsonl");
  const armFile = join(paths.audit, "arm");
  const sidecarPath = join(appDir, "scripts", "phase-25-sidecar-fixture.mjs");
  writeFileSync(seedFile, `${JSON.stringify(seed, null, 2)}\n`);

  const fixtureVariables = {
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    TEMP: paths.temp,
    TMP: paths.temp,
    WEBVIEW2_USER_DATA_FOLDER: paths.webview2,
    GG_APP_CWD: paths.project,
    GG_PHASE25_DEV_FIXTURE_CDP_PORT: String(cdpPort),
    GG_SIDECAR_PATH: sidecarPath,
    GG_PHASE25_SMOKE_AUDIT_FILE: auditFile,
    GG_PHASE25_SMOKE_ARM_FILE: armFile,
    GG_PHASE25_SMOKE_SEED_FILE: seedFile,
    GG_PHASE25_SMOKE_FOCUSED_ONLY: "1",
    GG_PHASE25_DEV_FIXTURE_SKIP_ORPHAN_SWEEP: "1",
  };
  const environment = sanitizedSmokeEnvironment(baseEnvironment, paths, fixtureVariables);
  const descriptor = {
    version: 1,
    root: paths.root,
    profileRoot: paths.home,
    dataRoots: [paths.appData, paths.localAppData, paths.webview2],
    project: paths.project,
    seedFile,
    auditFile,
    armFile,
    screenshots: paths.screenshots,
    cdpPort,
    reminder: {
      phaseId: reminders[0].phase.id,
      title: reminders[0].phase.title,
      occurrenceKey: reminders[0].reminder.occurrenceKey,
      dueAt: reminders[0].reminder.dueAt,
      note: reminders[0].reminder.note,
    },
  };
  const resolvedDescriptorPath = resolve(descriptorPath);
  mkdirSync(dirname(resolvedDescriptorPath), { recursive: true });
  writeFileSync(resolvedDescriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

  return {
    paths,
    seed,
    descriptor,
    descriptorPath: resolvedDescriptorPath,
    fixtureVariables,
    environment,
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function fixtureShellEnvironment(fixture, baseEnvironment = process.env) {
  const inheritedFixtureKeys = Object.keys(baseEnvironment).filter((key) =>
    /^(GG_|TAURI_|WEBVIEW2_)/i.test(key),
  );
  const lines = inheritedFixtureKeys.map((key) => `unset ${shellQuote(key)}`);
  for (const [key, value] of Object.entries(fixture.fixtureVariables)) {
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  lines.push(`export GG_PHASE25_DEV_FIXTURE_DESCRIPTOR=${shellQuote(fixture.descriptorPath)}`);
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const cdpPort = Number(argument("--cdp-port"));
  const rootArgument = argument("--root");
  const descriptorArgument = argument("--descriptor");
  if (rootArgument && !isAbsolute(rootArgument)) {
    throw new Error("--root must be absolute");
  }
  const fixture = preparePhase25DevFixture({
    ...(rootArgument ? { root: rootArgument } : {}),
    cdpPort,
    ...(descriptorArgument ? { descriptorPath: descriptorArgument } : {}),
  });
  process.stdout.write(fixtureShellEnvironment(fixture));
  process.stderr.write(
    `Phase 25 isolated dev fixture: ${relative(process.cwd(), fixture.descriptorPath)}\n`,
  );
}
