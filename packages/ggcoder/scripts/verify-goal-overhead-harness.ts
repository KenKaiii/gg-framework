import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runGoalOverheadHarness } from "../src/core/goal-overhead-harness.js";

const outPath = resolve(process.cwd(), "packages/ggcoder/.goal-evidence/goal-overhead-harness.json");
const result = await runGoalOverheadHarness();

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

const simple = result.scenarios.find((scenario) => scenario.scenario === "simple");
const complex = result.scenarios.find((scenario) => scenario.scenario === "complex");
if (!simple || !complex) {
  throw new Error("Harness did not produce both simple and complex scenarios.");
}

const requiredSignals = [
  "stageCount",
  "promptChars",
  "taskCount",
  "blockerCount",
  "requiredProofGates",
];
for (const signal of requiredSignals) {
  if (!result.observedSignals.includes(signal)) {
    throw new Error(`Harness is missing required signal: ${signal}`);
  }
}

if (!result.intendedExperience.includes("original-goal-prompt")) {
  throw new Error("Harness did not preserve the mandatory original-goal-prompt reference.");
}

if (complex.stageCount <= simple.stageCount) {
  throw new Error("Complex scenario should expose more stages than the simple scenario.");
}
if (complex.promptChars <= simple.promptChars) {
  throw new Error("Complex scenario should expose more prompt characters than the simple scenario.");
}
if (complex.taskCount <= simple.taskCount) {
  throw new Error("Complex scenario should expose more task overhead than the simple scenario.");
}
if (complex.blockerCount <= simple.blockerCount) {
  throw new Error("Complex scenario should expose more blocker overhead than the simple scenario.");
}
if (complex.requiredProofGates <= simple.requiredProofGates) {
  throw new Error("Complex scenario should expose more proof gates than the simple scenario.");
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      artifact: outPath,
      simple: {
        stageCount: simple.stageCount,
        promptChars: simple.promptChars,
        taskCount: simple.taskCount,
        blockerCount: simple.blockerCount,
        requiredProofGates: simple.requiredProofGates,
      },
      complex: {
        stageCount: complex.stageCount,
        promptChars: complex.promptChars,
        taskCount: complex.taskCount,
        blockerCount: complex.blockerCount,
        requiredProofGates: complex.requiredProofGates,
      },
      comparisons: result.comparisons,
    },
    null,
    2,
  ),
);
