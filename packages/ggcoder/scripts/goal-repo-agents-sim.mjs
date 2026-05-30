// Run "Ensure the agents we have are production grade ready" in SETUP mode against
// the REAL ggcoder repo (a genuine multi-agent system), so we can judge the
// agent's thought process on: (1) speed of scoping, (2) simplicity of approach,
// (3) whether the proof is the perfected one for THIS system.
//
// Runs inside a throwaway detached git worktree of HEAD so the agent cannot
// touch the user's working tree even if it ignores setup-mode read-only rules.

import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createInterface } from "node:readline";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cliPath = join(here, "..", "dist", "cli.js");
const { buildSystemPrompt } = await import(join(here, "..", "dist", "system-prompt.js"));

const PROMPT = "Ensure the agents we have are production grade ready.";
const TOOLS = ["read", "grep", "find", "ls", "bash", "goals"];
const MODELS = [
  { provider: "anthropic", model: "claude-opus-4-8" },
  { provider: "openai", model: "gpt-5.5" },
];
const OUT = join(repoRoot, ".gg", "goal-sim", `repo-agents-${Date.now()}`);

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function run(model, worktree) {
  const systemPrompt = await buildSystemPrompt(
    worktree,
    undefined,
    false,
    undefined,
    TOOLS,
    undefined,
    "setup",
    model.provider,
  );
  const goalsBase = await mkdtemp(join(tmpdir(), "repo-agents-store-"));
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "--json",
      "--provider",
      model.provider,
      "--model",
      model.model,
      "--max-turns",
      "18",
      "--system-prompt",
      systemPrompt,
      PROMPT,
    ],
    { cwd: worktree, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GG_GOALS_BASE: goalsBase } },
  );

  let text = "";
  let stderr = "";
  const tools = [];
  const raw = [];
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    raw.push(line);
    try {
      const ev = JSON.parse(line);
      if (ev.type === "text_delta" && typeof ev.text === "string") text += ev.text;
      else if (ev.type === "tool_call_start") tools.push({ name: ev.name, args: ev.args });
      else if (ev.type === "error") stderr += `\n[error] ${ev.message}`;
    } catch {
      /* ignore */
    }
  });
  child.stderr.on("data", (c) => (stderr += c.toString("utf-8")));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(124);
    }, 8 * 60 * 1000);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve(c ?? 1);
    });
  });

  const goalsCalls = tools.filter((t) => t.name === "goals");
  const dir = join(OUT, `${model.provider}-${model.model}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "raw.ndjson"), raw.join("\n") + "\n", "utf-8");
  await writeFile(
    join(dir, "output.md"),
    [
      `# ${model.model} — "${PROMPT}"`,
      `\nexit ${code} · textChars ${text.length} · tools ${tools.length} · goalsCalls ${goalsCalls.length}`,
      `\n## Discovery tool calls (non-goals)\n`,
      tools
        .filter((t) => t.name !== "goals")
        .map((t) => `- ${t.name}: ${JSON.stringify(t.args).slice(0, 240)}`)
        .join("\n") || "(none)",
      `\n## goals calls\n`,
      goalsCalls.map((t) => `- ${JSON.stringify(t.args).slice(0, 6000)}`).join("\n\n") || "(none)",
      `\n## Final text\n\n${text.trim() || "(none)"}`,
      stderr.trim() ? `\n## stderr\n\n${stderr.trim().slice(0, 1500)}` : "",
    ].join("\n"),
    "utf-8",
  );
  await rm(goalsBase, { recursive: true, force: true });
  console.log(
    `\n=== [${model.model}] exit=${code} text=${text.length} discovery=${tools.length - goalsCalls.length} goalsCalls=${goalsCalls.length} ===`,
  );
  console.log(text.trim().slice(0, 2200) || "(no text)");
  return { model: model.model, code, goalsCalls: goalsCalls.length };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const worktree = await mkdtemp(join(tmpdir(), "repo-agents-wt-"));
  await rm(worktree, { recursive: true, force: true }); // worktree add needs a non-existent path
  await git(repoRoot, ["worktree", "add", "--detach", worktree, "HEAD"]);
  try {
    const results = [];
    for (const model of MODELS) results.push(await run(model, worktree));
    console.log(`\nOutputs: ${OUT}`);
    console.table(results);
  } finally {
    await git(repoRoot, ["worktree", "remove", "--force", worktree]).catch(() => {});
  }
}

await main();
