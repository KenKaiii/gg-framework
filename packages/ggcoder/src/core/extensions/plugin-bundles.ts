import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 500;
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

const PluginBundleSchema = z
  .object({
    format: z.literal("gg-agent-plugin"),
    schemaVersion: z.literal(1),
    manifest: PluginManifestSchema,
    files: z
      .array(
        z
          .object({
            path: z.string().min(1),
            contentBase64: z.string(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_FILES),
  })
  .strict();

export interface InstalledPlugin extends PluginManifest {
  installPath: string;
}

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

function validateManifestPaths(manifest: PluginManifest, files: ReadonlySet<string>): void {
  const entry = validatePluginPath(manifest.entry);
  if (![".js", ".mjs", ".cjs"].includes(path.posix.extname(entry).toLowerCase())) {
    throw new Error("Plugin entry must be a JavaScript module");
  }
  if (!files.has(entry)) throw new Error(`Plugin entry is missing: ${entry}`);
  for (const command of manifest.commands ?? []) {
    const commandPath = validatePluginPath(command);
    if (path.posix.extname(commandPath).toLowerCase() !== ".md") {
      throw new Error(`Plugin command must be Markdown: ${command}`);
    }
    if (!files.has(commandPath)) throw new Error(`Plugin command is missing: ${commandPath}`);
  }
}

async function collectFiles(
  root: string,
  relative = "",
): Promise<Array<{ path: string; data: Buffer }>> {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: Array<{ path: string; data: Buffer }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(root, childRelative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink())
      throw new Error(`Plugin bundles cannot contain symlinks: ${childRelative}`);
    if (stat.isDirectory()) {
      files.push(...(await collectFiles(root, childRelative)));
      continue;
    }
    if (!stat.isFile()) throw new Error(`Unsupported plugin filesystem entry: ${childRelative}`);
    const safePath = validatePluginPath(childRelative);
    files.push({ path: safePath, data: await fs.readFile(absolute) });
    if (files.length > MAX_FILES) throw new Error(`Plugin exceeds ${MAX_FILES} files`);
  }
  return files;
}

export async function readPluginManifest(pluginDir: string): Promise<PluginManifest> {
  const raw = await fs.readFile(path.join(pluginDir, "plugin.json"), "utf8");
  return PluginManifestSchema.parse(JSON.parse(raw));
}

/** Pack a plugin directory into one deterministic, portable .ggplugin JSON artifact. */
export async function packPlugin(sourceDir: string, outputFile: string): Promise<PluginManifest> {
  const sourceStat = await fs.lstat(sourceDir);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Plugin source must be a real directory");
  }
  const manifest = await readPluginManifest(sourceDir);
  const files = await collectFiles(sourceDir);
  validateManifestPaths(manifest, new Set(files.map((file) => file.path)));
  const totalBytes = files.reduce((sum, file) => sum + file.data.length, 0);
  if (totalBytes > MAX_BUNDLE_BYTES) throw new Error("Plugin exceeds the 5 MB bundle limit");

  const bundle = {
    format: "gg-agent-plugin" as const,
    schemaVersion: 1 as const,
    manifest,
    files: files.map((file) => ({ path: file.path, contentBase64: file.data.toString("base64") })),
  };
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, `${JSON.stringify(bundle)}\n`, { mode: 0o600 });
  return manifest;
}

async function parseBundle(bundleFile: string): Promise<z.infer<typeof PluginBundleSchema>> {
  const stat = await fs.lstat(bundleFile);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Plugin bundle must be a regular file");
  if (stat.size > MAX_BUNDLE_BYTES * 2) throw new Error("Plugin bundle is too large");
  const parsed = PluginBundleSchema.parse(JSON.parse(await fs.readFile(bundleFile, "utf8")));
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of parsed.files) {
    const safePath = validatePluginPath(file.path);
    if (paths.has(safePath)) throw new Error(`Duplicate plugin path: ${safePath}`);
    paths.add(safePath);
    const bytes = Buffer.from(file.contentBase64, "base64");
    if (bytes.toString("base64") !== file.contentBase64) {
      throw new Error(`Invalid base64 content: ${safePath}`);
    }
    totalBytes += bytes.length;
  }
  if (totalBytes > MAX_BUNDLE_BYTES) throw new Error("Plugin exceeds the 5 MB bundle limit");
  validateManifestPaths(parsed.manifest, paths);
  const manifestFile = parsed.files.find((file) => file.path === "plugin.json");
  if (!paths.has("plugin.json") || !manifestFile) {
    throw new Error("Plugin bundle is missing plugin.json");
  }
  const embeddedManifest = PluginManifestSchema.parse(
    JSON.parse(Buffer.from(manifestFile.contentBase64, "base64").toString("utf8")),
  );
  if (!isDeepStrictEqual(embeddedManifest, parsed.manifest)) {
    throw new Error("Bundle manifest does not match plugin.json");
  }
  return parsed;
}

/** Install atomically; an invalid bundle never damages the currently installed version. */
export async function installPlugin(
  bundleFile: string,
  extensionsDir: string,
): Promise<InstalledPlugin> {
  const bundle = await parseBundle(bundleFile);
  await fs.mkdir(extensionsDir, { recursive: true, mode: 0o700 });
  const destination = path.join(extensionsDir, bundle.manifest.id);
  const staging = path.join(extensionsDir, `.${bundle.manifest.id}.install-${randomUUID()}`);
  const backup = path.join(extensionsDir, `.${bundle.manifest.id}.backup-${randomUUID()}`);
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const file of bundle.files) {
      const relative = validatePluginPath(file.path);
      const target = path.join(staging, ...relative.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, Buffer.from(file.contentBase64, "base64"), { mode: 0o600 });
    }
    let hadPrevious = false;
    try {
      await fs.rename(destination, backup);
      hadPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(staging, destination);
    } catch (error) {
      if (hadPrevious) await fs.rename(backup, destination).catch(() => {});
      throw error;
    }
    if (hadPrevious) await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  return { ...bundle.manifest, installPath: destination };
}

export async function listInstalledPlugins(extensionsDir: string): Promise<InstalledPlugin[]> {
  let entries;
  try {
    entries = await fs.readdir(extensionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const plugins: InstalledPlugin[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const installPath = path.join(extensionsDir, entry.name);
    try {
      const manifest = await readPluginManifest(installPath);
      if (manifest.id !== entry.name) continue;
      plugins.push({ ...manifest, installPath });
    } catch {
      // Legacy extension directories and partially-copied external files are not plugins.
    }
  }
  return plugins;
}

export async function removePlugin(id: string, extensionsDir: string): Promise<void> {
  const validatedId = PluginManifestSchema.shape.id.parse(id);
  await fs.rm(path.join(extensionsDir, validatedId), { recursive: true, force: true });
}
