import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export const PHASE20_PROMPT = "PHASE20_NATIVE_FRESH_SEND_CANARY";

function fail(message) {
  throw new Error(message);
}

export async function reserveTcpPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port) fail("could not reserve a WebView2 debugging port");
  return port;
}

export function preparePhase20Scenario({ home, projectDir, scenario }) {
  mkdirSync(projectDir, { recursive: true });
  const agentDir = join(home, ".gg");
  mkdirSync(agentDir, { recursive: true });

  let sessionPath;
  if (scenario === "success") {
    const sessionId = randomUUID();
    const timestamp = new Date().toISOString();
    sessionPath = join(projectDir, "phase-20-native-seed.jsonl");
    const header = {
      type: "session",
      version: 2,
      id: sessionId,
      conversationId: sessionId,
      timestamp,
      cwd: projectDir,
      provider: "openrouter",
      model: "qwen/qwen3.6-plus",
      leafId: null,
    };
    const kenTurn = {
      type: "custom",
      kind: "ken_turn",
      id: randomUUID(),
      parentId: null,
      timestamp,
      data: {
        version: 1,
        question: "Prepare the deterministic native smoke prompt.",
        reply: `Native smoke fixture\n\n\`\`\`prompt\n${PHASE20_PROMPT}\n\`\`\``,
        afterMessageCount: 0,
      },
    };
    writeFileSync(sessionPath, `${JSON.stringify(header)}\n${JSON.stringify(kenTurn)}\n`);
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify({
        openrouter: {
          accessToken: "phase-20-native-smoke-key",
          refreshToken: "",
          expiresAt: Date.UTC(2100, 0, 1),
          baseUrl: "http://127.0.0.1:9/v1",
        },
      }),
    );
  }

  writeFileSync(
    join(agentDir, "gg-app-workspace.json"),
    JSON.stringify(
      {
        windows: [
          {
            mode: "code",
            cwd: projectDir,
            ...(sessionPath ? { sessionPath } : {}),
            width: 1024,
            height: 720,
          },
        ],
      },
      null,
      2,
    ),
  );
  return { sessionPath };
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("WebView2 debugging connection closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("could not connect to WebView2 CDP")),
        {
          once: true,
        },
      );
    });
    return new CdpClient(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      fail(
        `WebView evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

export async function connectToPackagedWebview(cdpPort, waitFor) {
  const target = await waitFor("packaged WebView2 debugging target", async () => {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    if (!response.ok) return null;
    const targets = await response.json();
    return targets.find(
      (candidate) =>
        candidate.type === "page" &&
        typeof candidate.webSocketDebuggerUrl === "string" &&
        !String(candidate.url).startsWith("devtools://"),
    );
  });
  return CdpClient.connect(target.webSocketDebuggerUrl);
}

const INSTALL_PROBE = `
(async () => {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals?.invoke || !internals?.transformCallback) {
    throw new Error("Tauri internals are unavailable in the packaged webview");
  }
  const evidence = {
    sequence: [],
    invokes: [],
    events: [],
    mutations: [],
    initial: {
      oldPromptCount: document.querySelectorAll(".ken-prompt-block").length,
      sentRowCount: document.querySelectorAll(".user-ken-sent").length,
      transcriptText: document.querySelector(".transcript")?.textContent ?? "",
    },
  };
  let sequence = 0;
  const mark = (type, details = {}) => {
    const entry = { sequence: ++sequence, type, ...details };
    evidence.sequence.push(entry);
    return entry;
  };
  const originalInvoke = internals.invoke.bind(internals);
  internals.invoke = async (command, args, options) => {
    const tracked = command === "agent_new_session" || command === "agent_prompt";
    const call = tracked
      ? mark("invoke:start", { command, args: JSON.parse(JSON.stringify(args ?? {})) })
      : null;
    if (call) evidence.invokes.push(call);
    try {
      const result = await originalInvoke(command, args, options);
      if (tracked) {
        const settled = mark("invoke:resolved", {
          command,
          callSequence: call.sequence,
          result: result === undefined ? null : JSON.parse(JSON.stringify(result)),
        });
        evidence.invokes.push(settled);
      }
      return result;
    } catch (error) {
      if (tracked) {
        const settled = mark("invoke:rejected", {
          command,
          callSequence: call.sequence,
          error: String(error),
        });
        evidence.invokes.push(settled);
      }
      throw error;
    }
  };

  const eventCallback = internals.transformCallback((event) => {
    const envelope = event?.payload;
    if (envelope?.paneId !== "primary" || envelope?.type !== "session_reset") return;
    const entry = mark("event:session_reset", {
      paneId: envelope.paneId,
      sessionId: envelope.sessionId,
      operationId: envelope.data?.operationId ?? null,
    });
    evidence.events.push(entry);
  });
  await originalInvoke("plugin:event|listen", {
    event: "agent-event",
    target: { kind: "Any" },
    handler: eventCallback,
  });

  let oldPromptPresent = document.querySelectorAll(".ken-prompt-block").length > 0;
  let sentRowCount = document.querySelectorAll(".user-ken-sent").length;
  const observer = new MutationObserver(() => {
    const oldPromptNow = document.querySelectorAll(".ken-prompt-block").length > 0;
    const sentRowsNow = document.querySelectorAll(".user-ken-sent").length;
    if (oldPromptPresent && !oldPromptNow) {
      const entry = mark("dom:old-transcript-removed", {
        transcriptText: document.querySelector(".transcript")?.textContent ?? "",
      });
      evidence.mutations.push(entry);
    }
    if (sentRowsNow > sentRowCount) {
      const entry = mark("dom:ken-sent-added", {
        count: sentRowsNow,
        transcriptText: document.querySelector(".transcript")?.textContent ?? "",
      });
      evidence.mutations.push(entry);
    }
    oldPromptPresent = oldPromptNow;
    sentRowCount = sentRowsNow;
  });
  observer.observe(document.querySelector(".transcript"), { childList: true, subtree: true });
  window.__GG_PHASE20_SMOKE__ = { evidence, observer };
  return evidence.initial;
})()
`;

export function clickExpression(label) {
  return `(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)},
    );
    if (!button) throw new Error(${JSON.stringify(`button not found: ${label}`)});
    button.click();
    return true;
  })()`;
}

function evidenceEntry(evidence, type, command) {
  return evidence.sequence.find(
    (entry) => entry.type === type && (command === undefined || entry.command === command),
  );
}

function readBackendEvidence(auditPath, scenario) {
  const raw = readFileSync(auditPath, "utf8");
  if (scenario === "success") {
    const newSessions = raw
      .split(/\r?\n/)
      .filter((line) => line.includes("[app-sidecar] new session accepted"))
      .map((line) => ({
        route: "/new-session",
        status: 200,
        operationId: line.match(/operationId=([^\s]+)/)?.[1] ?? null,
      }));
    const prompts = raw
      .split(/\r?\n/)
      .filter((line) => line.includes("[app-sidecar] prompt accepted"))
      .map((line) => ({
        route: "/prompt",
        status: 202,
        kenSent: line.includes("kenSent=true"),
      }));
    return { newSessions, prompts };
  }
  const entries = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    newSessions: entries.filter((entry) => entry.route === "/new-session"),
    prompts: entries.filter((entry) => entry.route === "/prompt"),
  };
}

export function validatePhase20Evidence(evidence, scenario) {
  if (evidence.initial.oldPromptCount !== 1) fail("expected one hydrated Ken prompt before action");
  if (!evidence.initial.transcriptText.includes(PHASE20_PROMPT)) {
    fail("hydrated transcript did not contain the Phase 20 prompt canary");
  }

  const newSessions = evidence.backend?.newSessions ?? [];
  const prompts = evidence.backend?.prompts ?? [];
  if (newSessions.length !== 1) {
    fail(`expected one backend new-session request, found ${newSessions.length}`);
  }

  if (scenario === "success") {
    const reset = evidenceEntry(evidence, "event:session_reset");
    const oldRemoved = evidenceEntry(evidence, "dom:old-transcript-removed");
    const sentAdded = evidenceEntry(evidence, "dom:ken-sent-added");
    if (!reset || !oldRemoved || !sentAdded) {
      fail("success evidence is missing reset or transcript mutation markers");
    }
    if (newSessions[0].operationId !== reset.operationId) {
      fail("authoritative session_reset did not match the accepted new-session operationId");
    }
    if (prompts.length !== 1 || prompts[0].status !== 202 || prompts[0].kenSent !== true) {
      fail(`expected one accepted kenSent /prompt request, found ${prompts.length}`);
    }
    if (reset.sequence >= sentAdded.sequence) fail("sent row appeared before authoritative reset");
    if (oldRemoved.sequence >= sentAdded.sequence)
      fail("sent row appeared before old transcript removal");
    if (evidence.final.oldPromptCount !== 0 || evidence.final.sentRowCount !== 1) {
      fail("final transcript did not contain exactly one fresh-session sent row");
    }
  } else if (scenario === "reject-409") {
    if (newSessions[0].status !== 409) fail("fault fixture did not return HTTP 409");
    if (prompts.length !== 0) fail("409 rejection reached /prompt");
    if (evidence.final.oldPromptCount !== 1 || evidence.final.sentRowCount !== 0) {
      fail("409 rejection changed the old transcript");
    }
    if (!evidence.final.alertText.includes("current session is unchanged")) {
      fail("409 rejection did not expose recoverable inline error text");
    }
  } else if (scenario === "drop-reset") {
    if (newSessions[0].status !== 200 || !newSessions[0].operationId)
      fail("event-loss fixture did not accept new-session");
    if (evidence.events.some((entry) => entry.type === "event:session_reset")) {
      fail("event-loss fixture unexpectedly delivered session_reset");
    }
    if (prompts.length !== 0) fail("event-loss recovery reached /prompt");
    if (evidence.final.composerValue !== PHASE20_PROMPT) {
      fail("event-loss recovery did not restore the exact prompt to the composer");
    }
    if (evidence.final.sentRowCount !== 0) fail("event-loss recovery rendered a sent row");
  } else {
    fail(`unknown Phase 20 smoke scenario: ${scenario}`);
  }
  return evidence;
}

export async function runPhase20Scenario({
  scenario,
  cdpPort,
  waitFor,
  evidenceDir,
  projectDir,
  sessionPath,
  sidecarAuditPath,
}) {
  const client = await connectToPackagedWebview(cdpPort, waitFor);
  try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    const layout = {
      version: 9,
      root: { type: "leaf", paneId: "primary" },
      focusedPaneId: "primary",
      panes: {
        primary: {
          kind: "agent",
          mode: "code",
          cwd: projectDir,
          sessionPath: sessionPath ?? null,
        },
      },
    };
    await client.evaluate(`(() => {
      localStorage.setItem("gg-workspace-layout-recursive:main", ${JSON.stringify(
        JSON.stringify(layout),
      )});
      location.reload();
      return true;
    })()`);
    await waitFor(`${scenario} hydrated Ken prompt`, async () => {
      const state = await client.evaluate(`({
        promptCount: document.querySelectorAll(".ken-prompt-block").length,
        text: document.querySelector(".transcript")?.textContent ?? "",
      })`);
      return state.promptCount === 1 && state.text.includes(PHASE20_PROMPT);
    });

    const initial = await client.evaluate(INSTALL_PROBE);
    if (initial.oldPromptCount !== 1 || initial.sentRowCount !== 0) {
      fail(`${scenario} probe installed against an unexpected initial transcript`);
    }
    await client.evaluate(
      `document.querySelector('button[aria-label="More prompt actions"]')?.click()`,
    );
    await waitFor(`${scenario} fresh-send action`, () =>
      client.evaluate(
        `[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "New session + send")`,
      ),
    );
    await client.evaluate(clickExpression("New session + send"));

    if (scenario === "success") {
      await waitFor("fresh-session sent row", () =>
        client.evaluate(`document.querySelectorAll(".user-ken-sent").length === 1`),
      );
    } else if (scenario === "reject-409") {
      await waitFor("native 409 recovery", () =>
        client.evaluate(
          `document.querySelector('[role="alert"]')?.textContent?.includes("current session is unchanged") === true`,
        ),
      );
    } else {
      await waitFor(
        "lost-reset recovery",
        () =>
          client.evaluate(
            `document.querySelector("textarea.input")?.value === ${JSON.stringify(PHASE20_PROMPT)}`,
          ),
        { timeoutMs: 20_000 },
      );
    }

    const backend = await waitFor(`${scenario} backend audit`, () => {
      try {
        const audit = readBackendEvidence(sidecarAuditPath, scenario);
        const complete =
          audit.newSessions.length === 1 && (scenario !== "success" || audit.prompts.length === 1);
        return complete ? audit : null;
      } catch {
        return null;
      }
    });
    const evidence = await client.evaluate(`(() => {
      const evidence = window.__GG_PHASE20_SMOKE__.evidence;
      evidence.final = {
        oldPromptCount: document.querySelectorAll(".ken-prompt-block").length,
        sentRowCount: document.querySelectorAll(".user-ken-sent").length,
        transcriptText: document.querySelector(".transcript")?.textContent ?? "",
        composerValue: document.querySelector("textarea.input")?.value ?? "",
        alertText: document.querySelector('[role="alert"]')?.textContent ?? "",
      };
      return evidence;
    })()`);
    evidence.backend = backend;
    validatePhase20Evidence(evidence, scenario);

    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, `${scenario}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    const screenshot = await client.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(evidenceDir, `${scenario}.png`), Buffer.from(screenshot.data, "base64"));
    return evidence;
  } finally {
    client.close();
  }
}
