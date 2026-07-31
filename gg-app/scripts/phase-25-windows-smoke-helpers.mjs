import { mkdirSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

export const PHASE25_TOAST_TITLE = "Roadmap reminder due";
export const PHASE25_TOAST_BODY = "Open GG Coder to review it.";

class DevCdpClient {
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
        pending.reject(new Error("dev fixture debugging connection closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolveOpen, reject) => {
      socket.addEventListener("open", resolveOpen, { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("could not connect to the dev fixture")),
        { once: true },
      );
    });
    return new DevCdpClient(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
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
      throw new Error(
        `Dev fixture evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

export async function connectToDevWebview(cdpPort, waitFor) {
  const target = await waitFor("dev fixture debugging target", async () => {
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
  return DevCdpClient.connect(target.webSocketDebuggerUrl);
}

export function createIsolatedProfile(root, projectDir = join(root, "project")) {
  const home = join(root, "home");
  const paths = {
    root,
    home,
    appData: join(home, "AppData", "Roaming"),
    localAppData: join(home, "AppData", "Local"),
    temp: join(root, "temp"),
    webview2: join(root, "webview2"),
    project: projectDir,
    audit: join(root, "audit"),
    screenshots: join(root, "screenshots"),
  };
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true });
  return paths;
}

export function sanitizedSmokeEnvironment(baseEnvironment, paths, fixtureVariables = {}) {
  const environment = {};
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (/^(GG_|TAURI_|WEBVIEW2_)/i.test(key)) continue;
    if (value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    TEMP: paths.temp,
    TMP: paths.temp,
    WEBVIEW2_USER_DATA_FOLDER: paths.webview2,
    GG_APP_CWD: paths.project,
    ...fixtureVariables,
  };
}

export async function reserveHeldTcpPort() {
  const server = net.createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to reserve a fixture port");
  }
  let released = false;
  return {
    port: address.port,
    async release() {
      if (released) return;
      released = true;
      await new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    },
  };
}

export function assertDistinctPorts(ports) {
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error(`invalid fixture port: ${ports.join(", ")}`);
  }
  if (new Set(ports).size !== ports.length) {
    throw new Error(`duplicate fixture ports: ${ports.join(", ")}`);
  }
}

export function selectExactToast(candidates, { hiddenAppPid, protectedPids = [] }) {
  const protectedSet = new Set(protectedPids);
  const valid = candidates.filter((candidate) => {
    const bounds = candidate.bounds ?? {};
    const ownerPid = Number(candidate.ancestor?.processId);
    return (
      candidate.title?.text === PHASE25_TOAST_TITLE &&
      candidate.body?.text === PHASE25_TOAST_BODY &&
      Number.isFinite(bounds.x) &&
      Number.isFinite(bounds.y) &&
      bounds.width > 0 &&
      bounds.height > 0 &&
      candidate.ancestor?.isOffscreen === false &&
      /^(?:ShellExperienceHost|explorer|StartMenuExperienceHost)$/i.test(
        candidate.ancestor?.ownerName ?? "",
      ) &&
      ownerPid !== hiddenAppPid &&
      !protectedSet.has(ownerPid)
    );
  });
  if (valid.length > 1) throw new Error(`duplicate matching Windows toasts found: ${valid.length}`);
  return valid[0] ?? null;
}
