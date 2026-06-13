#!/usr/bin/env node
/**
 * Fake LSP server for manager tests — speaks JSON-RPC over stdio with
 * Content-Length framing. Zero deps, CI-safe (no real language servers).
 *
 * Behavior: any line containing the token "ERROR" in a synced document
 * produces one error diagnostic; clean content publishes an empty list.
 *
 * Flags:
 *   --pull               advertise pull diagnostics (diagnosticProvider)
 *   --delay-ms=N         delay publishing diagnostics by N milliseconds
 *   --shutdown-file=PATH write PATH when the shutdown request arrives
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const hasPull = args.includes("--pull");
const delayMs = Number(args.find((a) => a.startsWith("--delay-ms="))?.split("=")[1] ?? 0);
const shutdownFile = args.find((a) => a.startsWith("--shutdown-file="))?.split("=")[1];

const documents = new Map(); // uri -> text

function send(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function diagnosticsFor(text) {
  const diagnostics = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const character = lines[i].indexOf("ERROR");
    if (character === -1) continue;
    diagnostics.push({
      range: { start: { line: i, character }, end: { line: i, character: character + 5 } },
      severity: 1,
      message: `fake error on line ${i + 1}`,
      source: "fake",
    });
  }
  return diagnostics;
}

function publish(uri) {
  const text = documents.get(uri) ?? "";
  const fire = () =>
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics: diagnosticsFor(text) },
    });
  if (delayMs > 0) setTimeout(fire, delayMs);
  else fire();
}

function onMessage(msg) {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { capabilities: hasPull ? { diagnosticProvider: {} } : {} },
    });
    return;
  }
  if (msg.method === "textDocument/didOpen") {
    const { uri, text } = msg.params.textDocument;
    documents.set(uri, text);
    publish(uri);
    return;
  }
  if (msg.method === "textDocument/didChange") {
    const { uri } = msg.params.textDocument;
    documents.set(uri, msg.params.contentChanges[0].text);
    publish(uri);
    return;
  }
  if (msg.method === "textDocument/diagnostic") {
    const { uri } = msg.params.textDocument;
    const reply = () =>
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { kind: "full", items: diagnosticsFor(documents.get(uri) ?? "") },
      });
    if (delayMs > 0) setTimeout(reply, delayMs);
    else reply();
    return;
  }
  if (msg.method === "shutdown") {
    if (shutdownFile) fs.writeFileSync(shutdownFile, "shutdown-received");
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }
  if (msg.method === "exit") {
    process.exit(0);
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString());
    if (!match) return;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString();
    buffer = buffer.subarray(start + length);
    try {
      onMessage(JSON.parse(body));
    } catch {
      // ignore malformed input
    }
  }
});
process.stdin.on("end", () => process.exit(0));
