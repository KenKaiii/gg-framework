import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Boots the REAL daemon and drives the Brain routes voice Kleio uses (through
 * the Kleio host): GET /brain gives the block text chat's system prompt gets
 * plus the tools' schemas, and POST /brain/tool runs those very tools, so a
 * memory saved by voice is the one text chat reads (~/.gg/chat-memories.json).
 */
const SIDECAR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "app-sidecar.js",
);

let tmpHome: string;
let tmpProject: string;
let daemon: ChildProcessByStdio<null, Readable, Readable> | undefined;
let port = 0;
let token = "";

async function startDaemon(): Promise<void> {
  daemon = spawn(process.execPath, [SIDECAR], {
    cwd: tmpProject,
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      GG_APP_CWD: tmpProject,
      GG_APP_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stderr.on("data", () => {});
  port = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`daemon never listened: ${out}`)), 60_000);
    daemon!.stdout.on("data", (chunk) => {
      out += chunk;
      const match = /GG_APP_LISTENING (\d+) (\S+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        token = match[2]!;
        resolve(Number(match[1]));
      }
    });
    daemon!.on("error", reject);
    daemon!.on("exit", (code) => reject(new Error(`daemon exited (${code}): ${out}`)));
  });
}

async function stopDaemon(): Promise<void> {
  const d = daemon;
  daemon = undefined;
  if (d && d.exitCode === null && d.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      d.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      d.kill("SIGTERM");
    });
  }
}

function request(
  method: string,
  urlPath: string,
  /**
   * `raw` is sent as it is, for bodies that aren't JSON. `ownSocket` keeps the
   * request off the shared keep-alive pool, for answers that drop the connection.
   */
  opts: {
    body?: unknown;
    raw?: string;
    token?: string;
    session?: string;
    ownSocket?: boolean;
  } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        ...(opts.ownSocket ? { agent: false } : {}),
        headers: {
          "content-type": "application/json",
          "x-gg-token": opts.token ?? token,
          ...(opts.session ? { "x-gg-session": opts.session } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: {} });
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-brain-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-brain-project-"));
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "settings.json"),
    JSON.stringify({ autoCompact: false }),
  );
  await startDaemon();
});
afterEach(async () => {
  await stopDaemon();
  // Windows keeps the project folder locked while the killed sidecar's git children finish.
  const removeOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
  await fs.rm(tmpHome, removeOptions);
  await fs.rm(tmpProject, removeOptions);
});

describe("app sidecar: the Brain for voice Kleio", () => {
  it("gives text chat's memory block and the Brain tools, and saves to the same memory", async () => {
    const empty = await request("GET", "/brain");
    expect(empty.status).toBe(200);
    expect(String(empty.json.prompt)).toContain("# Durable memory");
    expect(String(empty.json.prompt)).toContain("# Jiwa");
    const tools = empty.json.tools as { name: string; parameters: { type?: string } }[];
    expect(tools.map((t) => t.name)).toEqual([
      "remember",
      "update_memory",
      "forget",
      "set_jiwa",
      "update_jiwa",
      "forget_jiwa",
    ]);
    expect(tools.every((t) => t.parameters.type === "object")).toBe(true);

    const saved = await request("POST", "/brain/tool", {
      body: {
        name: "remember",
        args: { content: "Has a dog called Biscuit.", category: "relationship", importance: 4 },
      },
    });
    expect(saved.status).toBe(200);
    expect(String(saved.json.result)).toMatch(/^Remembered as [\w-]+\. 1 memory stored\.$/);

    // Text chat reads the same file; the next call's block carries it.
    const file = JSON.parse(
      await fs.readFile(path.join(tmpHome, ".gg", "chat-memories.json"), "utf8"),
    ) as { memories: { text: string }[] };
    expect(file.memories.map((m) => m.text)).toEqual(["Has a dog called Biscuit."]);
    expect(String((await request("GET", "/brain")).json.prompt)).toContain(
      "Has a dog called Biscuit.",
    );

    const jiwa = await request("POST", "/brain/tool", {
      body: { name: "set_jiwa", args: { content: "Keep answers short." } },
    });
    expect(jiwa.status).toBe(200);
    expect(String((await request("GET", "/brain")).json.prompt)).toContain("Keep answers short.");
  });

  it("refuses anything but the Brain tools, bad arguments and strangers", async () => {
    expect(
      (await request("POST", "/brain/tool", { body: { name: "bash", args: {} } })).status,
    ).toBe(404);
    const bad = await request("POST", "/brain/tool", { body: { name: "remember", args: {} } });
    expect(bad.status).toBe(422);
    expect(typeof bad.json.error).toBe("string");
    // Text chat's own answer, words the model can act on.
    const missing = await request("POST", "/brain/tool", {
      body: { name: "forget", args: { id: "m-nope" } },
    });
    expect(missing.status).toBe(200);
    expect(String(missing.json.result)).toMatch(/was not found/);
    expect((await request("GET", "/brain", { token: "wrong" })).status).toBe(401);
  });
});

/** A chat window's session, as the Brain window's calls carry one. */
async function chatSession(): Promise<string> {
  const created = await request("POST", "/session", {
    body: { mode: "chat", chatAgent: "general", cwd: tmpProject },
  });
  expect(created.status).toBe(200);
  return String(created.json.sessionId);
}

interface StoredEntry {
  id: string;
  text: string;
  category: string;
  importance: number;
}

async function brainFile(name: "chat-memories.json" | "chat-jiwa.json"): Promise<StoredEntry[]> {
  const file = JSON.parse(await fs.readFile(path.join(tmpHome, ".gg", name), "utf8")) as {
    memories?: StoredEntry[];
    jiwa?: StoredEntry[];
  };
  return file.memories ?? file.jiwa ?? [];
}

const shape = (entries: StoredEntry[]) =>
  entries.map(({ text, category, importance }) => ({ text, category, importance }));

describe("app sidecar: adding and editing in the Brain window", () => {
  it("adds and edits memories and Jiwa in the files text chat and voice read", async () => {
    const session = await chatSession();

    const added = await request("POST", "/memories", {
      session,
      body: { text: "  Works as a GP in Leeds.  ", category: "identity", importance: 4 },
    });
    expect(added.status).toBe(200);
    const memory = added.json.memory as StoredEntry;
    expect(memory).toMatchObject({
      text: "Works as a GP in Leeds.",
      category: "identity",
      importance: 4,
    });
    expect(added.json).toMatchObject({ memories: [memory], softLimit: 60, hardLimit: 90 });

    const edited = await request("PATCH", `/memories/${encodeURIComponent(memory.id)}`, {
      session,
      body: {
        text: "Works as a GP in Leeds, three days a week.",
        category: "project",
        importance: 5,
      },
    });
    expect(edited.status).toBe(200);
    expect(edited.json.memory).toMatchObject({ id: memory.id, category: "project", importance: 5 });
    expect(shape(await brainFile("chat-memories.json"))).toEqual([
      { text: "Works as a GP in Leeds, three days a week.", category: "project", importance: 5 },
    ]);

    const set = await request("POST", "/jiwa", {
      session,
      body: { text: "Keep answers short.", category: "interaction", importance: 3 },
    });
    expect(set.status).toBe(200);
    const entry = set.json.entry as StoredEntry;
    expect(set.json).toMatchObject({ jiwa: [entry], softLimit: 60, hardLimit: 90 });

    const changed = await request("PATCH", `/jiwa/${encodeURIComponent(entry.id)}`, {
      session,
      body: {
        text: "Keep answers short unless I ask for detail.",
        category: "voice",
        importance: 4,
      },
    });
    expect(changed.status).toBe(200);
    expect(changed.json.entry).toMatchObject({ id: entry.id, category: "voice", importance: 4 });
    expect(shape(await brainFile("chat-jiwa.json"))).toEqual([
      { text: "Keep answers short unless I ask for detail.", category: "voice", importance: 4 },
    ]);

    // The block every chat and voice call gets carries the edits.
    const block = String((await request("GET", "/brain")).json.prompt);
    expect(block).toContain("Works as a GP in Leeds, three days a week.");
    expect(block).toContain("Keep answers short unless I ask for detail.");
    expect(block).not.toContain("Keep answers short.");
    // And the Brain window's own list does too.
    expect((await request("GET", "/memories", { session })).json.memories).toEqual([
      edited.json.memory,
    ]);
  }, 90_000);

  it("refuses duplicates, missing entries, bad bodies, big bodies and strangers", async () => {
    const session = await chatSession();
    const body = { text: "Has a dog called Biscuit.", category: "relationship", importance: 4 };
    const first = await request("POST", "/memories", { session, body });
    expect(first.status).toBe(200);

    const duplicate = await request("POST", "/memories", { session, body });
    expect(duplicate).toEqual({
      status: 409,
      json: {
        error: "Brain already has one like this: “Has a dog called Biscuit.”",
        duplicateOf: first.json.memory,
      },
    });

    expect(await request("PATCH", "/memories/m-gone", { session, body })).toEqual({
      status: 404,
      json: { error: "That memory isn't in Brain any more." },
    });
    const instruction = { text: "Keep it brief.", category: "interaction", importance: 3 };
    expect(await request("PATCH", "/jiwa/j-gone", { session, body: instruction })).toEqual({
      status: 404,
      json: { error: "That Jiwa instruction isn't in Brain any more." },
    });

    const notJson = await request("POST", "/memories", { session, raw: "{" });
    expect(notJson.status).toBe(400);
    expect(String(notJson.json.error)).toMatch(/^Invalid Brain entry: /);
    const extra = await request("POST", "/jiwa", {
      session,
      body: { ...instruction, forgetIds: ["j-1"] },
    });
    expect(extra).toEqual({
      status: 400,
      json: { error: "Invalid Brain entry: forgetIds: not a field of a Brain entry" },
    });
    for (const id of ["m".repeat(201), "%E0%A4%A"]) {
      expect(await request("PATCH", `/memories/${id}`, { session, body })).toEqual({
        status: 400,
        json: { error: "That isn't a valid memory id." },
      });
    }
    expect((await request("PATCH", "/jiwa/%", { session, body: instruction })).status).toBe(400);

    // Just over the 16 KiB cap. The 413 closes its connection, so it gets its own.
    const big = await request("POST", "/memories", {
      session,
      body: { ...body, text: "x".repeat(17_000) },
      ownSocket: true,
    });
    expect(big).toEqual({ status: 413, json: { error: "request body too large" } });

    expect(await request("POST", "/memories", { body })).toEqual({
      status: 404,
      json: { error: "unknown session" },
    });
    expect(
      (await request("POST", "/jiwa", { session, body: instruction, token: "x" })).status,
    ).toBe(401);

    // Nothing refused reached the files.
    expect((await brainFile("chat-memories.json")).map((m) => m.text)).toEqual([
      "Has a dog called Biscuit.",
    ]);
    expect((await request("GET", "/jiwa", { session })).json.jiwa).toEqual([]);
  }, 90_000);
});
