import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectToDevWebview } from "./phase-25-windows-smoke-helpers.mjs";
import { validatePhase25FixtureAudit } from "./phase-25-sidecar-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const defaultDescriptorPath = join(appDir, ".gg", "evidence", "phase-25-dev", "fixture.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readAuditEntries(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(label, check, { timeoutMs = 30_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(
    `${label} timed out${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`,
  );
}

async function captureScreenshot(client, path) {
  const screenshot = await client.send("Page.captureScreenshot", { format: "png" });
  if (!screenshot.data) throw new Error(`CDP returned no screenshot data for ${path}`);
  writeFileSync(path, Buffer.from(screenshot.data, "base64"));
}

function assertDescriptor(descriptor) {
  if (
    descriptor?.version !== 1 ||
    !descriptor.root ||
    !descriptor.profileRoot ||
    !descriptor.armFile ||
    !descriptor.auditFile ||
    !descriptor.screenshots ||
    !Number.isInteger(descriptor.cdpPort)
  ) {
    throw new Error("Invalid Phase 25 dev fixture descriptor");
  }
  const normalizedRoot = resolve(descriptor.root).toLowerCase();
  for (const path of [
    descriptor.profileRoot,
    ...descriptor.dataRoots,
    descriptor.project,
    descriptor.seedFile,
    descriptor.auditFile,
    descriptor.armFile,
    descriptor.screenshots,
  ]) {
    const normalizedPath = resolve(path).toLowerCase();
    if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}\\`)) {
      throw new Error(`Phase 25 evidence path escaped the isolated root: ${path}`);
    }
  }
}

export async function capturePhase25DevEvidence(descriptorPath = defaultDescriptorPath) {
  const descriptor = readJson(resolve(descriptorPath));
  assertDescriptor(descriptor);
  mkdirSync(descriptor.screenshots, { recursive: true });
  const client = await connectToDevWebview(descriptor.cdpPort, waitFor);
  const alertScreenshot = join(descriptor.screenshots, "reminder-alert.png");
  const detailScreenshot = join(descriptor.screenshots, "reminder-detail.png");
  const evidencePath = join(descriptor.screenshots, "evidence.json");

  try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Page.bringToFront");
    await client.evaluate(`(() => {
      if (document.querySelector(".agent-pane")) return false;
      const layout = {
        version: 9,
        root: { type: "leaf", paneId: "primary" },
        focusedPaneId: "primary",
        panes: {
          primary: {
            kind: "agent",
            mode: "code",
            cwd: ${JSON.stringify(descriptor.project)},
            sessionPath: null,
          },
        },
      };
      localStorage.setItem("gg-workspace-layout-recursive:main", JSON.stringify(layout));
      location.reload();
      return true;
    })()`);
    await waitFor("focused isolated dev pane", () =>
      client.evaluate(`Boolean(
        document.hasFocus() &&
        document.querySelector(".agent-pane.window-focused") &&
        document.querySelector('[aria-label^="Notes"]')
      )`),
    );
    await waitFor("authoritative fixture Notes", () =>
      readAuditEntries(descriptor.auditFile).some(
        (entry) => entry.action === "authoritative-notes-ready",
      ),
    );

    writeFileSync(descriptor.armFile, "focused-in-app-evidence\n");
    const alert = await waitFor("in-app reminder alert", () =>
      client.evaluate(`(() => {
        const region = document.querySelector(".roadmap-reminder-alert");
        if (!region) return null;
        const heading = region.querySelector("h2")?.textContent?.trim() ?? "";
        const buttons = [...region.querySelectorAll("button")].map((button) => button.textContent?.trim());
        return { heading, text: region.textContent, buttons };
      })()`),
    );
    if (
      alert.heading !== descriptor.reminder.title ||
      !alert.text.includes(descriptor.reminder.note) ||
      !alert.buttons.includes("Open phase")
    ) {
      throw new Error(`Unexpected reminder alert: ${JSON.stringify(alert)}`);
    }
    await captureScreenshot(client, alertScreenshot);

    await client.evaluate(`(() => {
      const button = [...document.querySelectorAll(".roadmap-reminder-alert button")]
        .find((candidate) => candidate.textContent?.trim() === "Open phase");
      if (!button) throw new Error("Open phase action is missing");
      button.click();
      return true;
    })()`);
    const detail = await waitFor("reminder phase detail", () =>
      client.evaluate(`(() => {
        const detail = document.querySelector(".notes-phase-detail");
        if (!detail) return null;
        return {
          heading: detail.querySelector("h3")?.textContent?.trim() ?? "",
          text: detail.textContent ?? "",
          roadmapSelected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? "",
        };
      })()`),
    );
    if (
      detail.heading !== descriptor.reminder.title ||
      !detail.text.includes("Due now") ||
      !detail.text.includes(descriptor.reminder.note) ||
      !detail.roadmapSelected.startsWith("Roadmap")
    ) {
      throw new Error(`Unexpected reminder detail: ${JSON.stringify(detail)}`);
    }
    await captureScreenshot(client, detailScreenshot);

    const audit = await waitFor("focused in-app reminder claim", () => {
      const entries = readAuditEntries(descriptor.auditFile);
      return entries.some((entry) => entry.action === "claim") ? entries : null;
    });
    validatePhase25FixtureAudit(audit, {
      focused: true,
      channel: "in-app",
      permission: "not-required",
    });
    if (audit.some((entry) => entry.action === "background-reserve-blocked")) {
      throw new Error("The dev fixture attempted a background reminder reservation");
    }

    const evidence = {
      status: "passed",
      fixtureRoot: descriptor.root,
      profileRoot: descriptor.profileRoot,
      dataRoots: descriptor.dataRoots,
      reminder: descriptor.reminder,
      alert,
      detail,
      audit: audit.filter((entry) =>
        ["authenticated-session", "authoritative-notes-ready", "arm", "reserve", "claim"].includes(
          entry.action,
        ),
      ),
      screenshots: { alert: alertScreenshot, detail: detailScreenshot },
      nativeToastAttempted: false,
    };
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(
      `PHASE25 DEV UI PASS: alert=${alertScreenshot} detail=${detailScreenshot}\n`,
    );
    return evidence;
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const descriptorIndex = process.argv.indexOf("--descriptor");
  const descriptorPath =
    descriptorIndex < 0 ? defaultDescriptorPath : process.argv[descriptorIndex + 1];
  capturePhase25DevEvidence(descriptorPath).catch((error) => {
    console.error(`PHASE25 DEV UI FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
