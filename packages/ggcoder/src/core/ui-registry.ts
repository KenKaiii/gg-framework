import { createHash } from "node:crypto";
import { z } from "zod";
import { checkUrlPolicy, type GetNetworkPolicy } from "./network-guard.js";

export const UI_PROVIDERS = {
  bklit: {
    repo: "bklit/bklit-ui",
    revision: "0dfdfc57ca068470ccfb93c4501cebc555c9054d",
    manifest: "packages/ui/registry.json",
    root: "https://ui.bklit.com/r/",
  },
  kokonut: {
    repo: "kokonut-labs/kokonutui",
    revision: "83eec6d982d400a18438001a8efdbac1f159dd43",
    manifest: "registry.json",
    root: "https://kokonutui.com/r/",
  },
} as const;
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
const fileSchema = z
  .object({
    path: z.string().max(240),
    type: z.string().optional(),
    target: z.string().max(240).optional(),
    content: z.string().max(500000).optional(),
  })
  .strict();
const itemSchema = z
  .object({
    name: slug,
    type: z.enum([
      "registry:component",
      "registry:block",
      "registry:example",
      "registry:hook",
      "registry:lib",
      "registry:ui",
      "registry:style",
      "registry:theme",
      "registry:file",
    ]),
    title: z.string().optional(),
    description: z.string().optional(),
    files: z.array(fileSchema).max(150),
    dependencies: z.array(z.string().max(300)).max(100).optional(),
    devDependencies: z.array(z.string().max(300)).max(100).optional(),
    registryDependencies: z.array(z.string().max(300)).max(100).optional(),
    css: z.record(z.string(), z.unknown()).optional(),
    cssVars: z.record(z.string(), z.unknown()).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
    categories: z.array(z.string()).optional(),
    docs: z.string().optional(),
    author: z.string().optional(),
    $schema: z.string().optional(),
    tailwind: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type RegistryItem = z.infer<typeof itemSchema>;
export interface RegistrySource {
  id: string;
  item: RegistryItem;
  url: string;
  payloadHash: string;
  inventoryRevision?: string;
  hostedMatchesRevision: "not-verified";
  dependencies: string[];
  attribution: string;
}
export const payloadHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

export function registryPath(value: string): string {
  // A leading slash in hosted source paths is a registry convention, not an absolute target.
  const normalized = value.replace(/^\//, "");
  if (
    !normalized ||
    !/^(?:[a-zA-Z0-9_@().-]+\/)*[a-zA-Z0-9_@().-]+$/.test(normalized) ||
    normalized.split("/").some((p) => p === "." || p === "..")
  )
    throw new Error("Invalid registry path");
  return normalized;
}

export function registryUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /%|\\/.test(value)
  )
    throw new Error("Blocked registry URL");
  const allowed = Object.values(UI_PROVIDERS).some(
    (p) =>
      url.href === `https://raw.githubusercontent.com/${p.repo}/${p.revision}/${p.manifest}` ||
      url.href === `https://raw.githubusercontent.com/${p.repo}/${p.revision}/LICENSE` ||
      (url.href.startsWith(p.root) && /^[a-z0-9-]+\.json$/.test(url.href.slice(p.root.length))),
  );
  if (
    !allowed &&
    !(
      url.hostname === "ui.shadcn.com" &&
      /^\/r\/styles\/new-york\/[a-z0-9-]+\.json$/.test(url.pathname)
    )
  )
    throw new Error("Blocked registry host/path");
  return url;
}

export function registryKey(value: string): string {
  if (/^(bklit|kokonut|shadcn):/.test(value)) {
    const [provider, name, extra] = value.split(":");
    if (extra !== undefined) throw new Error("Invalid item ID");
    return `${provider}:${slug.parse(name)}`;
  }
  if (value.startsWith("@bklit/")) return `bklit:${slug.parse(value.slice(7))}`;
  if (value.startsWith("@kokonutui/")) return `kokonut:${slug.parse(value.slice(11))}`;
  if (value.startsWith("https://")) {
    const url = registryUrl(value);
    for (const [provider, p] of Object.entries(UI_PROVIDERS)) {
      if (url.href.startsWith(p.root))
        return `${provider}:${slug.parse(url.pathname.slice(3, -5))}`;
    }
    if (url.hostname === "ui.shadcn.com")
      return `shadcn:${slug.parse(url.pathname.slice(url.pathname.lastIndexOf("/") + 1, -5))}`;
    throw new Error("Not an item URL");
  }
  return `shadcn:${slug.parse(value)}`;
}

export function validateRegistryItem(input: unknown, source = false): RegistryItem {
  const item = itemSchema.parse(input);
  const seen = new Set<string>();
  for (const file of item.files) {
    const key = registryPath(file.path);
    if (seen.has(key)) throw new Error("Duplicate registry source path");
    seen.add(key);
    if (file.target) registryPath(file.target);
    if (source && (file.content === undefined || Buffer.byteLength(file.content) > 500000))
      throw new Error("Missing or oversized registry source");
  }
  return item;
}

export function resolveRegistryFile(source: RegistrySource, selector: string) {
  const matches = source.item.files.filter(
    (file, index) =>
      selector === `${source.id}#${index}` ||
      registryPath(file.path) === selector.replace(/^\//, "") ||
      (file.target && registryPath(file.target) === selector.replace(/^\//, "")),
  );
  if (matches.length !== 1)
    throw new Error(
      `File selector matched ${matches.length} files; use a stable item#file-index ID`,
    );
  return matches[0];
}

export const MOTION_GUIDANCE = {
  kind: "animation-api",
  package: "motion",
  import: "motion/react",
  documentation: "https://motion.dev/docs/react",
  guidance:
    "Use motion elements for declarative animation, AnimatePresence for exit transitions, useReducedMotion for user preferences, and useAnimate for scoped imperative animation. Hooks need real consumers. Preserve callbacks, keyboard semantics and teardown; do not mix competing animation owners. Check installed version before selecting APIs. Motion+ paid assets are excluded.",
  families: [
    "animate",
    "exit",
    "layout",
    "gestures",
    "scroll",
    "drag",
    "variants",
    "spring",
    "motion-values",
    "transforms",
    "reduced-motion",
    "imperative",
    "presence",
  ],
};

/** Lazy, bounded per-session cache; every fetch and redirect respects current network policy. */
export class UiRegistry {
  private cache = new Map<string, { text: string; url: string; hash: string }>();
  private cacheBytes = 0;
  constructor(
    private getNetworkPolicy?: GetNetworkPolicy,
    private fetcher: typeof fetch = fetch,
  ) {}

  async fetchText(
    value: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; url: string; hash: string }> {
    let url = registryUrl(value);
    const combined = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
    for (let redirects = 0; redirects < 4; redirects++) {
      combined.throwIfAborted();
      const blocked = checkUrlPolicy(url.href, this.getNetworkPolicy);
      if (blocked) throw new Error(blocked);
      const cached = this.cache.get(url.href);
      if (cached) return cached;
      const response = await this.fetcher(url, { redirect: "manual", signal: combined });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("Registry redirect missing location");
        url = registryUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Registry HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          combined.throwIfAborted();
          const { value: chunk, done } = await reader.read();
          if (done) break;
          size += chunk.byteLength;
          if (size > 3000000) throw new Error("Registry payload exceeds 3 MB");
          chunks.push(chunk);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const result = { text, url: url.href, hash: payloadHash(text) };
      while (this.cache.size >= 32 || this.cacheBytes + size > 12000000) {
        const oldest = this.cache.entries().next().value;
        if (!oldest) break;
        const [oldestUrl, oldestEntry] = oldest;
        this.cacheBytes -= Buffer.byteLength(oldestEntry.text);
        this.cache.delete(oldestUrl);
      }
      this.cache.set(url.href, result);
      this.cacheBytes += Buffer.byteLength(text);
      return result;
    }
    throw new Error("Registry redirect limit");
  }

  async search(query = "", signal?: AbortSignal) {
    const results: Array<{ id: string; name: string; description?: string; type: string }> = [];
    for (const [provider, p] of Object.entries(UI_PROVIDERS)) {
      const raw = await this.fetchText(
        `https://raw.githubusercontent.com/${p.repo}/${p.revision}/${p.manifest}`,
        signal,
      );
      const manifest: unknown = JSON.parse(raw.text);
      const parsed = z.object({ items: z.array(z.unknown()).max(220) }).parse(manifest);
      for (const value of parsed.items) {
        const item = validateRegistryItem(value);
        if (
          `${item.name} ${item.title ?? ""} ${item.description ?? ""}`
            .toLowerCase()
            .includes(query.toLowerCase())
        ) {
          results.push({
            id: `${provider}:${item.name}`,
            name: item.name,
            description: item.description,
            type: item.type,
          });
        }
      }
    }
    return results;
  }

  async inspect(value: string, signal?: AbortSignal): Promise<RegistrySource> {
    const id = registryKey(value);
    const [provider, name] = id.split(":");
    const p = UI_PROVIDERS[provider as keyof typeof UI_PROVIDERS];
    const url = p
      ? `${p.root}${name}.json`
      : `https://ui.shadcn.com/r/styles/new-york/${name}.json`;
    const raw = await this.fetchText(url, signal);
    const item = validateRegistryItem(JSON.parse(raw.text), true);
    if (item.name !== name) throw new Error("Registry name mismatch");
    return {
      id,
      item,
      url: raw.url,
      payloadHash: raw.hash,
      inventoryRevision: p?.revision,
      hostedMatchesRevision: "not-verified",
      dependencies: (item.registryDependencies ?? []).map(registryKey),
      attribution: p
        ? `Public ${provider} source: https://github.com/${p.repo}; preserve notices. License: https://raw.githubusercontent.com/${p.repo}/${p.revision}/LICENSE. Review dependency licenses separately (including Iconists); public availability is not a license grant. Paid assets excluded.`
        : "shadcn/ui supporting registry source; preserve notices and verify dependency licenses.",
    };
  }

  async closure(value: string, signal?: AbortSignal): Promise<RegistrySource[]> {
    const result: RegistrySource[] = [];
    const active = new Set<string>();
    const seen = new Set<string>();
    const visit = async (id: string, depth: number): Promise<void> => {
      if (active.has(id)) throw new Error("Registry dependency cycle");
      if (seen.has(id)) return;
      if (depth > 16 || seen.size >= 180) throw new Error("Registry graph limit");
      seen.add(id);
      active.add(id);
      const source = await this.inspect(id, signal);
      for (const dependency of source.dependencies) await visit(dependency, depth + 1);
      active.delete(id);
      result.push(source);
    };
    await visit(registryKey(value), 0);
    return result;
  }
}
