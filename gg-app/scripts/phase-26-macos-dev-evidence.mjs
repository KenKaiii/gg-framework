import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { preparePhase26MacosDevFixture } from "./phase-26-macos-dev-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "..", "..");

function readAudit(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(label, check, { timeoutMs = 60_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`${label} timed out${detail}`);
}

async function requestWebDriver(port, pathname, { method = "GET", body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${pathname} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function availableLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  if (!Number.isInteger(port)) throw new Error("Could not allocate a fixture WebDriver port");
  return port;
}

async function connectWebDriver(port, unexpectedExit) {
  await Promise.race([
    waitFor(
      "embedded macOS WebDriver",
      async () => {
        const status = await requestWebDriver(port, "/status");
        return status?.value?.ready === false ? null : status;
      },
      { timeoutMs: 20 * 60_000, intervalMs: 500 },
    ),
    unexpectedExit,
  ]);
  const session = await requestWebDriver(port, "/session", {
    method: "POST",
    body: {
      capabilities: {
        alwaysMatch: {
          browserName: "tauri",
          "wdio:tauriServiceOptions": { windowLabel: "main" },
        },
        firstMatch: [{}],
      },
    },
  });
  const sessionId = session?.value?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(`WebDriver did not create a session: ${JSON.stringify(session)}`);
  }
  return {
    port,
    sessionId,
    async execute(script) {
      const result = await requestWebDriver(port, `/session/${sessionId}/execute/sync`, {
        method: "POST",
        body: { script, args: [] },
      });
      return result?.value;
    },
    async screenshot(path) {
      const result = await requestWebDriver(port, `/session/${sessionId}/screenshot`);
      if (typeof result?.value !== "string" || result.value.length === 0) {
        throw new Error(`WebDriver returned no screenshot data for ${path}`);
      }
      writeFileSync(path, Buffer.from(result.value, "base64"));
    },
    async close() {
      await requestWebDriver(port, `/session/${sessionId}`, { method: "DELETE" });
    },
  };
}

function exactHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function macosVersion() {
  const productVersion = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
  const buildVersion = execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim();
  const architecture = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim();
  return { productVersion, buildVersion, architecture };
}

function writeGithubOutput(root) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `evidence_root=${root}\n`);
}

async function processGroupAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopFixtureProcessGroup(processGroupId) {
  const cleanup = { processGroupId, signal: "SIGTERM", forced: false, processGroupAlive: true };
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!(await processGroupAlive(processGroupId))) {
      cleanup.processGroupAlive = false;
      return cleanup;
    }
    await delay(100);
  }
  cleanup.signal = "SIGKILL";
  cleanup.forced = true;
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await delay(250);
  cleanup.processGroupAlive = await processGroupAlive(processGroupId);
  return cleanup;
}

export async function capturePhase26MacosDevEvidence({ fixture, webdriver, startedAt }) {
  const { descriptor } = fixture;
  const inspectScreenshot = join(descriptor.screenshots, "notes-bound-phase.png");
  const resumeScreenshot = join(descriptor.screenshots, "notes-resumed-session.png");

  await waitFor("isolated macOS dev origin", async () => {
    const href = await webdriver.execute("return window.location.href");
    return typeof href === "string" && href.startsWith("http://localhost:1420") ? href : null;
  });
  await webdriver.execute(
    `const layout={version:9,root:{type:"leaf",paneId:"primary"},focusedPaneId:"primary",panes:{primary:{kind:"agent",mode:"code",cwd:${JSON.stringify(descriptor.project)},sessionPath:${JSON.stringify(descriptor.initialSessionPath)}}}};localStorage.setItem("gg-workspace-layout-recursive:main",JSON.stringify(layout));location.reload();return true;`,
  );
  await waitFor("hydrated isolated macOS pane", () =>
    webdriver.execute(
      'const button=document.querySelector(\'button[aria-label^="Notes"]\');return Boolean(document.querySelector(".agent-pane") && button && !button.disabled)',
    ),
  );

  await webdriver.execute(
    'const button=document.querySelector(\'button[aria-label^="Notes"]\');if(!button||button.disabled)throw new Error("enabled Notes control is missing");button.click();return true;',
  );
  await waitFor("Notes dialog", () =>
    webdriver.execute("return document.querySelector('[role=\"dialog\"]') !== null"),
  );
  await waitFor("Roadmap tab", () =>
    webdriver.execute('return document.querySelector("#notes-tab-roadmap") !== null'),
  );
  await webdriver.execute(
    'const tab=document.querySelector("#notes-tab-roadmap");if(!tab)throw new Error("Roadmap tab is missing");tab.click();return true;',
  );
  await waitFor("selected Roadmap tab", () =>
    webdriver.execute(
      'return document.querySelector("#notes-tab-roadmap")?.getAttribute("aria-selected") === "true"',
    ),
  );
  await waitFor("bound phase Inspect control", () =>
    webdriver.execute(
      "return document.querySelector('button[aria-label=\"Inspect phase: Bound phase\"]') !== null",
    ),
  );
  await webdriver.execute(
    "document.querySelector('button[aria-label=\"Inspect phase: Bound phase\"]')?.click();return true;",
  );

  const inspected = await waitFor("bound phase detail", () =>
    webdriver.execute(
      `const detail=document.querySelector(".notes-phase-detail");if(!detail)return null;const action=[...detail.querySelectorAll("button")].find((button)=>button.textContent?.trim()==="Resume phase");return action?{heading:detail.querySelector("h3")?.textContent?.trim()??"",text:detail.textContent??"",action:action.textContent?.trim()??"",roadmapSelected:document.querySelector("#notes-tab-roadmap")?.getAttribute("aria-selected")}:null;`,
    ),
  );
  if (
    inspected.heading !== "Bound phase" ||
    inspected.action !== "Resume phase" ||
    inspected.roadmapSelected !== "true" ||
    !inspected.text.includes("Saved prompt") ||
    !inspected.text.includes("Session") ||
    !inspected.text.includes("Linked")
  ) {
    throw new Error(`Unexpected bound phase detail: ${JSON.stringify(inspected)}`);
  }
  await webdriver.screenshot(inspectScreenshot);

  await webdriver.execute(
    `const button=[...document.querySelectorAll(".notes-phase-detail button")].find((candidate)=>candidate.textContent?.trim()==="Resume phase");if(!button)throw new Error("Resume phase action is missing");button.click();return true;`,
  );
  const resumed = await waitFor("bound phase Resume", async () => {
    const dom = await webdriver.execute(
      `return {dialogOpen:document.querySelector('[role="dialog"]')!==null,planModeText:document.querySelector(".footer-plan")?.textContent??"",planReason:document.querySelector(".plan-logo-reason")?.textContent??"",transcriptText:document.querySelector(".transcript")?.textContent??""};`,
    );
    const audit = readAudit(descriptor.sidecarAudit);
    const restored = audit.some(
      (entry) =>
        entry.route === "/session" && entry.requestedSessionPath === descriptor.boundSessionPath,
    );
    return !dom.dialogOpen && dom.planModeText.toLowerCase().includes("plan mode") && restored
      ? { dom, audit }
      : null;
  });
  if (!resumed.dom.planReason.includes("Plan Roadmap phase: Bound phase")) {
    throw new Error(
      `Resume did not restore the bound phase reason: ${JSON.stringify(resumed.dom)}`,
    );
  }
  await webdriver.screenshot(resumeScreenshot);

  return {
    status: "passed",
    sha: exactHead(),
    os: macosVersion(),
    command: "pnpm --filter gg-app tauri dev",
    startedAt: new Date(startedAt).toISOString(),
    interactionCompletedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    fixtureRoot: descriptor.root,
    fixtureDescriptor: fixture.descriptorPath,
    profileRoot: descriptor.profileRoot,
    dataRoots: descriptor.dataRoots,
    toolRoots: descriptor.toolRoots,
    webdriver: { port: webdriver.port, sessionId: webdriver.sessionId },
    project: descriptor.project,
    initialSessionPath: descriptor.initialSessionPath,
    boundSessionPath: descriptor.boundSessionPath,
    inspected,
    resumed: resumed.dom,
    sidecarAudit: resumed.audit,
    screenshots: { inspected: inspectScreenshot, resumed: resumeScreenshot },
    github: process.env.GITHUB_RUN_ID
      ? {
          runId: process.env.GITHUB_RUN_ID,
          runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
        }
      : null,
  };
}

export async function runPhase26MacosDevEvidence() {
  if (process.platform !== "darwin") {
    throw new Error("Phase 26 macOS dev evidence must run on an isolated macOS host");
  }
  const startedAt = Date.now();
  const webdriverPort = await availableLoopbackPort();
  const fixture = preparePhase26MacosDevFixture({ webdriverPort });
  writeGithubOutput(fixture.paths.root);
  const evidencePath = join(fixture.paths.evidence, "evidence.json");
  const cleanupPath = join(fixture.paths.evidence, "cleanup.json");
  const logFd = openSync(fixture.paths.devLog, "a");
  let child = null;
  let webdriver = null;
  let evidence = null;
  let failure = null;
  let cleanup = {
    processGroupId: null,
    signal: null,
    forced: false,
    processGroupAlive: false,
  };
  try {
    child = spawn("pnpm", ["--filter", "gg-app", "tauri", "dev"], {
      cwd: repositoryRoot,
      env: fixture.environment,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    if (!Number.isInteger(child.pid)) throw new Error("Tauri dev did not expose a process id");
    const unexpectedExit = new Promise((_, rejectExit) => {
      child.once("exit", (code, signal) => {
        rejectExit(
          new Error(`Tauri dev exited before evidence capture: code=${code} signal=${signal}`),
        );
      });
    });
    writeFileSync(
      join(fixture.paths.evidence, "process.json"),
      `${JSON.stringify({ pid: child.pid, processGroupId: child.pid, command: "pnpm --filter gg-app tauri dev" }, null, 2)}\n`,
    );
    webdriver = await connectWebDriver(webdriverPort, unexpectedExit);
    evidence = await capturePhase26MacosDevEvidence({ fixture, webdriver, startedAt });
  } catch (error) {
    failure = error;
    writeFileSync(
      join(fixture.paths.evidence, "failure.json"),
      `${JSON.stringify(
        {
          status: "failed",
          sha: exactHead(),
          error:
            error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
          elapsedMs: Date.now() - startedAt,
          fixture: fixture.descriptor,
          fixtureDescriptor: fixture.descriptorPath,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    let webdriverSessionClosed = false;
    try {
      if (webdriver) {
        await webdriver.close();
        webdriverSessionClosed = true;
      }
    } catch (error) {
      if (!failure) failure = error;
    }
    try {
      if (Number.isInteger(child?.pid)) cleanup = await stopFixtureProcessGroup(child.pid);
      cleanup.webdriverPort = webdriverPort;
      cleanup.webdriverSessionId = webdriver?.sessionId ?? null;
      cleanup.webdriverSessionClosed = webdriverSessionClosed;
      cleanup.completedAt = new Date().toISOString();
      cleanup.elapsedMs = Date.now() - startedAt;
      cleanup.ownedPaths = [fixture.paths.root];
      writeFileSync(cleanupPath, `${JSON.stringify(cleanup, null, 2)}\n`);
    } finally {
      closeSync(logFd);
    }
  }
  if (cleanup.processGroupAlive) {
    throw new Error(`Fixture-owned process group ${cleanup.processGroupId} survived cleanup`);
  }
  if (failure) throw failure;
  evidence.cleanup = cleanup;
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(
    `PHASE26 MACOS DEV UI PASS: sha=${evidence.sha} elapsed=${evidence.elapsedMs}ms evidence=${evidencePath}\n`,
  );
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPhase26MacosDevEvidence().catch((error) => {
    console.error(
      `PHASE26 MACOS DEV UI FAIL: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
