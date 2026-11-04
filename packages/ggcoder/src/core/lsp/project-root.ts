import path from "node:path";
import { z } from "zod";
import { readFileBounded } from "../../tools/operations.js";
import { log } from "../logger.js";
import { findProjectRoot, type LspServerSpec } from "./servers.js";

const referencesSchema = z.object({
  references: z.array(z.object({ path: z.string().min(1) })).min(1),
});
const MAX_CONFIG_BYTES = 64 * 1024;

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/**
 * A TS server rooted at a leaf project cannot discover its enclosing solution's
 * unopened consumers. Use the outermost enclosing solution that references this
 * project, within the session workspace. tsserver still owns files/include/exclude
 * and reference-graph semantics; this does not create or rewrite any config.
 * Other languages and standalone/configless projects keep their nearest root.
 */
export async function findServerProjectRoot(
  filePath: string,
  spec: LspServerSpec,
  workspace: string,
  signal?: AbortSignal,
): Promise<string> {
  const nearest = findProjectRoot(filePath, spec.rootMarkers, workspace);
  const ceiling = path.resolve(workspace);
  if (spec.id !== "typescript" || nearest === ceiling || !contains(ceiling, nearest))
    return nearest;
  const started = performance.now();
  let root = nearest;
  for (let dir = path.dirname(nearest); contains(ceiling, dir); dir = path.dirname(dir)) {
    if (signal?.aborted) return nearest;
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const configPath = path.join(dir, name);
      try {
        const text = (await readFileBounded(configPath, MAX_CONFIG_BYTES)).toString("utf8");
        if (signal?.aborted) return nearest;
        // Lazy: plain/configless projects do not pay to load TypeScript's parser.
        const { parseConfigFileTextToJson } = await import("typescript");
        const parsed = parseConfigFileTextToJson(configPath, text);
        if (parsed.error) continue;
        const raw: unknown = parsed.config;
        const config = referencesSchema.safeParse(raw);
        if (!config.success) continue;
        if (
          config.data.references.some((reference) => {
            const target = path.resolve(dir, reference.path);
            const project = path.extname(target) === ".json" ? path.dirname(target) : target;
            return contains(dir, project) && contains(project, nearest);
          })
        )
          root = dir;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        log("DEBUG", "lsp", "Solution config unavailable", {
          configPath,
          ms: Math.round(performance.now() - started),
        });
      }
    }
    if (dir === ceiling || path.dirname(dir) === dir) break;
  }
  if (root !== nearest)
    log("DEBUG", "lsp", "Using enclosing TypeScript solution", {
      filePath,
      nearest,
      root,
      ms: Math.round(performance.now() - started),
    });
  return root;
}
