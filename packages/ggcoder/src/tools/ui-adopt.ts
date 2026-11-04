import { z } from "zod";
import type { AgentTool } from "@kleio/agent";
import type { UiRegistry } from "../core/ui-registry.js";
import { planAdoption, preflightAdoption } from "../core/ui-adoption.js";
import type { createWriteTool } from "./write.js";
import { isPlanModeActive } from "../core/runtime-mode.js";

const params = z.object({
  action: z.enum(["plan", "apply"]),
  id: z.string().max(300).describe("Bklit, Kokonut or supporting shadcn registry item ID"),
  planHash: z
    .string()
    .optional()
    .describe("Exact hash returned by plan, required to apply the reviewed plan"),
});

export function createUiAdoptTool(
  cwd: string,
  registry: UiRegistry,
  writer: ReturnType<typeof createWriteTool>,
  planModeRef?: { current: boolean },
): AgentTool<typeof params> {
  return {
    name: "ui_adopt",
    // Apply writes several files; a steering message must not leave it half-done.
    interruptible: false,
    description:
      "Plan then adopt real public Bklit/Kokonut registry source into an existing React project. Reports dependency closure, relocated imports, missing packages/styles, attribution and conflicts. Apply requires the unchanged plan hash, only creates new component files through normal write controls, and never installs packages or overwrites user files.",
    parameters: params,
    executionMode: "sequential",
    async execute(args, context) {
      const plan = await planAdoption(cwd, registry, args.id, context.signal);
      if (args.action === "plan") return JSON.stringify(plan);
      if (isPlanModeActive(planModeRef))
        throw new Error("ui_adopt apply is unavailable in plan mode");
      if (!args.planHash || args.planHash !== plan.hash)
        throw new Error("Adoption plan changed or missing; inspect a fresh plan before applying");
      await preflightAdoption(cwd, plan);
      const created: string[] = [];
      const results: string[] = [];
      let attempted: string | undefined;
      try {
        for (const file of plan.files) {
          context.signal.throwIfAborted();
          if (file.status === "reuse") continue;
          attempted = file.target;
          const result = await writer.execute(
            { file_path: file.target, content: file.content },
            context,
          );
          if (typeof result !== "string" || result.startsWith("Error:"))
            throw new Error(String(result));
          created.push(file.target);
          results.push(result);
        }
      } catch (error) {
        return JSON.stringify({
          error: String(error),
          created,
          attempted,
          partial: true,
          instructions:
            "Inspect the attempted file as I/O or notification failures may occur after creation. No files were rolled back or overwritten.",
        });
      }
      return JSON.stringify({
        created,
        results,
        reused: plan.files.filter((f) => f.status === "reuse").map((f) => f.target),
        missingPackages: plan.missingPackages,
        styles: plan.styles,
        attribution: plan.attribution,
        instructions: plan.instructions,
      });
    },
  };
}
