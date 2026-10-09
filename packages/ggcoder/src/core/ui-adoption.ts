import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { compatibilityPatch } from "./ui-compatibility.js";
import { localOperations, readFileBounded, type ToolOperations } from "../tools/operations.js";
import { registryPath, type UiRegistry, payloadHash } from "./ui-registry.js";

export interface AdoptionFile {
  sourceId: string;
  sourcePath: string;
  target: string;
  content: string;
  status: "new" | "reuse" | "conflict";
}
export interface AdoptionPlan {
  entry: string;
  framework: string;
  packageManager: string;
  tailwind: string | null;
  files: AdoptionFile[];
  missingPackages: string[];
  blockers: string[];
  styles: unknown[];
  attribution: string[];
  instructions: string[];
  hash: string;
}

async function contained(root: string, target: string): Promise<string> {
  if (path.isAbsolute(target) || target.includes("\\"))
    throw new Error("Absolute adoption target refused");
  const safe = registryPath(target);
  if (
    safe !== target ||
    safe
      .split("/")
      .some(
        (p) =>
          p.startsWith(".") ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p) ||
          /[. ]$/.test(p),
      )
  )
    throw new Error("Reserved adoption path");
  const resolved = path.resolve(root, safe);
  if (!path.relative(root, resolved) || path.relative(root, resolved).startsWith(".."))
    throw new Error("Target escapes workspace");
  let current = root;
  for (const part of safe.split("/")) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("Symlink adoption path refused");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return resolved;
}

async function readOptional(root: string, target: string): Promise<string | undefined> {
  try {
    return (await readFileBounded(await contained(root, target), 1000000)).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function moduleSpecifiers(
  content: string,
): Array<{ start: number; end: number; value: string }> {
  const source = ts.createSourceFile(
    "component.tsx",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const specs: Array<{ start: number; end: number; value: string }> = [];
  const visit = (node: ts.Node): void => {
    let spec: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = node.moduleSpecifier;
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      spec = node.arguments[0];
    if (spec && ts.isStringLiteralLike(spec))
      specs.push({ start: spec.getStart(source) + 1, end: spec.getEnd() - 1, value: spec.text });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specs;
}

const withoutExtension = (value: string): string => value.replace(/\.(tsx?|jsx?)$/, "");

export function relocateImports(content: string, resolve: (specifier: string) => string): string {
  for (const spec of moduleSpecifiers(content).reverse()) {
    const relocated = resolve(spec.value);
    content = content.slice(0, spec.start) + relocated + content.slice(spec.end);
  }
  return content;
}

export async function planAdoption(
  cwd: string,
  registry: UiRegistry,
  entry: string,
  signal?: AbortSignal,
): Promise<AdoptionPlan> {
  const root = await fs.realpath(cwd);
  const pkg = JSON.parse((await readOptional(root, "package.json")) ?? "{}");
  const installed: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
  const framework = installed.next
    ? "next"
    : installed.vite && installed.react
      ? "vite-react"
      : "unsupported";
  const blockers: string[] =
    framework === "unsupported"
      ? ["Only existing React Vite and Next projects are supported."]
      : [];
  const packageManager =
    (await readOptional(root, "pnpm-lock.yaml")) !== undefined
      ? "pnpm"
      : (await readOptional(root, "yarn.lock")) !== undefined
        ? "yarn"
        : (await readOptional(root, "bun.lock")) !== undefined
          ? "bun"
          : "npm";
  const components = JSON.parse((await readOptional(root, "components.json")) ?? "{}");
  const configText =
    (await readOptional(root, "tsconfig.json")) ??
    (await readOptional(root, "jsconfig.json")) ??
    "{}";
  const parsed = ts.parseConfigFileTextToJson("tsconfig.json", configText);
  if (parsed.error) throw new Error("Cannot parse project aliases");
  const config = parsed.config;
  const paths: Record<string, string[]> = config.compilerOptions?.paths ?? {};
  const baseUrl = config.compilerOptions?.baseUrl ?? ".";
  const hasSrc = await fs.stat(path.join(root, "src")).then(
    (s) => s.isDirectory(),
    () => false,
  );
  const defaultRoot = hasSrc ? "src" : "";
  const aliasTarget = (alias: string): string => {
    const matches = Object.entries(paths).flatMap(([pattern, targets]) => {
      const prefix = pattern.replace(/\*$/, "");
      if (alias === pattern || (pattern.endsWith("*") && alias.startsWith(prefix))) {
        return targets.map((target) =>
          path.posix.join(baseUrl, target.replace(/\*$/, "") + alias.slice(prefix.length)),
        );
      }
      return [];
    });
    if (matches.length > 1) throw new Error(`Ambiguous alias: ${alias}`);
    if (matches.length === 1) return registryPath(matches[0]);
    if (alias.startsWith("@/")) return path.posix.join(defaultRoot, alias.slice(2));
    throw new Error(`Unresolved alias: ${alias}. Configure project paths first.`);
  };
  const aliases = {
    ui: "@/components/ui",
    components: "@/components",
    hooks: "@/hooks",
    lib: "@/lib",
    utils: "@/lib/utils",
    ...components.aliases,
  };
  const sources = await registry.closure(entry, signal);
  const files: AdoptionFile[] = [];
  const targetSet = new Set<string>();
  const styles: unknown[] = [];
  const compatibility: string[] = [];
  const missing = new Set<string>();
  for (const source of sources) {
    for (const dep of [
      ...(source.item.dependencies ?? []),
      ...(source.item.devDependencies ?? []),
    ]) {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-zA-Z0-9.^~<>=|*+ -]+)?$/.test(dep))
        throw new Error(`Unsupported package specifier: ${dep}`);
      const name = dep.replace(/(?<!^)@[^/]*$/, "");
      if (!installed[name]) missing.add(dep);
      if (/iconist/i.test(name))
        blockers.push(`Review nonstandard/unknown license for ${name} before production use.`);
    }
    if (source.item.css || source.item.cssVars || source.item.tailwind)
      styles.push({
        id: source.id,
        css: source.item.css,
        cssVars: source.item.cssVars,
        tailwind: source.item.tailwind,
      });
    for (const [index, file] of source.item.files.entries()) {
      const sourcePath = registryPath(file.path);
      let target: string;
      if (file.target) {
        if (file.target.startsWith("/")) throw new Error("Absolute installation target refused");
        target = file.target.replace(/^~\//, `${defaultRoot ? `${defaultRoot}/` : ""}`);
      } else {
        const type = file.type ?? source.item.type;
        const directory =
          type === "registry:hook"
            ? aliases.hooks
            : type === "registry:lib"
              ? aliases.lib
              : type === "registry:ui"
                ? aliases.ui
                : aliases.components;
        target = path.posix.join(aliasTarget(directory), path.posix.basename(sourcePath));
      }
      if (
        !/\.(tsx?|jsx?|css)$/.test(target) ||
        /(?:^|\/)(?:page|layout|route|middleware|instrumentation|.*\.config)\.[^.]+$/.test(
          target,
        ) ||
        /(?:^|\/)(?:node_modules|public|dist|scripts|app|pages)(?:\/|$)/.test(target)
      )
        throw new Error(`Reserved or non-component target: ${target}`);
      await contained(root, target);
      if (targetSet.has(target.toLowerCase()))
        throw new Error(`Ambiguous installation target: ${target}`);
      targetSet.add(target.toLowerCase());
      if (file.content === undefined)
        throw new Error(`Registry file has no content: ${sourcePath}`);
      const patched = compatibilityPatch(source.id, sourcePath, file.content);
      if (patched.notice) compatibility.push(patched.notice);
      files.push({
        sourceId: `${source.id}#${index}`,
        sourcePath,
        target,
        content: patched.content,
        status: "new",
      });
    }
  }
  for (const file of files) {
    file.content = relocateImports(file.content, (specifier) => {
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
        if (specifier.startsWith("next/") && framework !== "next")
          blockers.push(
            `${file.sourceId} requires Next.js (${specifier}); no framework shims are installed.`,
          );
        return specifier;
      }
      const candidate = specifier.startsWith(".")
        ? path.posix.normalize(path.posix.join(path.posix.dirname(file.sourcePath), specifier))
        : specifier.slice(2);
      const matches = files.filter(
        (f) =>
          withoutExtension(f.sourcePath) === withoutExtension(candidate) ||
          withoutExtension(f.sourcePath).endsWith(`/${withoutExtension(candidate)}`),
      );
      if (matches.length > 1) throw new Error(`Ambiguous source import: ${specifier}`);
      let destination = matches[0]?.target;
      if (!destination && specifier === "@/lib/utils")
        destination = aliasTarget(aliases.utils) + ".ts";
      if (!destination && specifier.startsWith("@/")) destination = aliasTarget(specifier);
      if (!destination) return specifier;
      let relative = path.posix.relative(
        path.posix.dirname(file.target),
        withoutExtension(destination),
      );
      if (!relative.startsWith(".")) relative = `./${relative}`;
      return relative;
    });
    const existing = await readOptional(root, file.target);
    if (existing !== undefined) {
      // Existing shadcn primitives are authoritative, not silently replaced.
      file.status =
        existing === file.content || file.sourceId.startsWith("shadcn:") ? "reuse" : "conflict";
    }
  }
  for (const file of files) {
    for (const spec of moduleSpecifiers(file.content)) {
      if (!spec.value.startsWith(".")) continue;
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(file.target), spec.value),
      );
      const available = files.some((f) => withoutExtension(f.target) === withoutExtension(target));
      if (!available) {
        const candidates = [
          target,
          `${target}.ts`,
          `${target}.tsx`,
          `${target}.js`,
          `${target}.jsx`,
          `${target}/index.ts`,
          `${target}/index.tsx`,
        ];
        let exists = false;
        for (const candidate of candidates)
          if ((await readOptional(root, candidate)) !== undefined) {
            exists = true;
            break;
          }
        if (!exists)
          blockers.push(
            `Missing local prerequisite: ${spec.value} consumed by ${file.target}. Resolve it before adoption.`,
          );
      }
    }
  }
  const plan = {
    entry,
    framework,
    packageManager,
    tailwind: installed.tailwindcss ?? null,
    files,
    missingPackages: [...missing].sort(),
    blockers: [...new Set(blockers)],
    styles,
    attribution: [
      ...sources.map(
        (s) =>
          `${s.id}: ${s.attribution} Hosted SHA256 ${s.payloadHash}; inventory revision ${s.inventoryRevision ?? "unknown"}; equivalence not verified.`,
      ),
      ...compatibility,
    ],
    instructions: [
      "Install missing packages only through normal authorized dependency changes; this tool never runs install scripts.",
      "Review required CSS/providers against existing theme tokens. Preserve notices and library styling. Build a real consumer and verify callbacks, keyboard behavior, reduced motion and repeated cleanup.",
      "Existing shadcn primitives take precedence. Reused files may have different contracts: inspect their exports before integrating.",
    ],
  };
  return { ...plan, hash: payloadHash(JSON.stringify(plan)) };
}

/** Same write tool pipeline, but the final filesystem operation exclusively creates new files. */
export function adoptionOperations(cwd: string): ToolOperations {
  return {
    ...localOperations,
    writeFile: async (target, content) => {
      const root = await fs.realpath(cwd);
      const relative = path.relative(path.resolve(cwd), target).split(path.sep).join("/");
      const resolved = await contained(root, relative);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await contained(root, relative);
      await fs.writeFile(resolved, content, { encoding: "utf8", flag: "wx" });
    },
  };
}

export async function preflightAdoption(cwd: string, plan: AdoptionPlan): Promise<void> {
  if (plan.blockers.length || plan.files.some((f) => f.status === "conflict"))
    throw new Error("Adoption blocked: resolve prerequisites and file conflicts first");
  const root = await fs.realpath(cwd);
  for (const file of plan.files) {
    await contained(root, file.target);
    const existing = await readOptional(root, file.target);
    if (file.status === "new" && existing !== undefined)
      throw new Error(`File appeared after planning: ${file.target}`);
    if (file.status === "reuse" && existing === undefined)
      throw new Error(`Reused file disappeared: ${file.target}`);
  }
}
