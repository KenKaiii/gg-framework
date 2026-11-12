import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const SUPPORTED_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
]);

export const PluginManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
    name: z.string().min(1).max(100),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    entry: z.string().min(1),
    description: z.string().max(500).optional(),
    commands: z.array(z.string()).max(100).optional(),
  })
  .strict();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export function validatePluginPath(candidate: string): string {
  const unix = candidate.replaceAll("\\", "/");
  const normalized = path.posix.normalize(unix);
  if (
    normalized !== unix ||
    normalized === "." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    normalized.includes("\0")
  ) {
    throw new Error(`Unsafe plugin path: ${candidate}`);
  }
  const extension = path.posix.extname(normalized).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported plugin file type: ${candidate}`);
  }
  return normalized;
}

export async function readPluginManifest(pluginDir: string): Promise<PluginManifest> {
  const raw = await fs.readFile(path.join(pluginDir, "plugin.json"), "utf8");
  return PluginManifestSchema.parse(JSON.parse(raw));
}
