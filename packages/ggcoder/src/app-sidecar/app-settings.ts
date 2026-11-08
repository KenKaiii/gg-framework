import type { Provider, ThinkingLevel } from "@kleio/ai";
import type { KenModelPref } from "../core/ken-model.js";
import { resolveAppSettingsPaths } from "../core/app-settings-paths.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { SettingsManager, type Settings } from "../core/settings-manager.js";
import { log } from "../core/logger.js";
import { atomicWrite } from "../core/session-storage.js";
import { withFileLock, withoutPaidTier } from "@kleio/core";

export const ALL_PROVIDERS: Provider[] = [
  // US
  "anthropic",
  "openai",
  "gemini",
  "xai",
  // China
  "moonshot",
  "glm",
  "minimax",
  "xiaomi",
  "deepseek",
  // Open-community gateway, before the provider-agnostic one
  "huggingface",
  // Japan, then provider-agnostic gateway last
  "sakana",
  "openrouter",
];

// ── gg-app settings (~/.gg/gg-app.json) ────────────────────
// App-specific, separate from the shared ggcoder settings file so the desktop
// app's preferences never collide with the CLI's.

/** Per-project model + thinking preferences. Persisted so each window (one
 *  project cwd) restores its OWN model across app restarts — instead of every
 *  window reading the same single global slot that the last writer clobbered. */
interface ProjectModelPrefs {
  provider: Provider;
  model: string;
  thinkingEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
}

interface AppSettings {
  /** Folder new projects are created inside. Defaults to ~/gg-projects. */
  projectsRoot: string;
  /** Model + thinking prefs keyed by normalized project cwd. A window restores
   *  its own entry on boot; absent → global settings.json → provider default. */
  projectModels?: Record<string, ProjectModelPrefs>;
  /** Autopilot (auto-review) on/off keyed by normalized project cwd. Per-window
   *  (one window = one cwd); absent/false → off. Restored on boot. */
  autopilot?: Record<string, boolean>;
  /** Ken's model override keyed by normalized project cwd. Absent → Ken follows
   *  GG Coder's model (the historical behavior). Set → Ken (chat + autopilot)
   *  uses this model regardless of GG Coder's. */
  kenModels?: Record<string, KenModelPref>;
  /** Extra folders scanned for projects alongside `projectsRoot`. */
  projectRoots?: string[];
  /** Project paths dismissed from the picker, as normalized cwds. */
  hiddenProjects?: string[];
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

// An embedder (the Kleio host) may give this sidecar its own settings file and
// projects folder, apart from the upstream app's — see core/app-settings-paths.ts.
export function appSettingsFile(): string {
  return resolveAppSettingsPaths(process.env, os.homedir()).settingsFile;
}

function defaultProjectsRoot(): string {
  return resolveAppSettingsPaths(process.env, os.homedir()).defaultProjectsRoot;
}

/** Normalize a project cwd to a stable settings key so trailing slashes /
 *  relative segments collapse — the same project always maps to one entry. */
function projectModelKey(cwd: string): string {
  return path.resolve(cwd);
}

export async function loadAppSettings(): Promise<AppSettings> {
  try {
    const parsed = JSON.parse(await fs.readFile(appSettingsFile(), "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { projectsRoot: defaultProjectsRoot() };
    }
    const raw = parsed as Partial<AppSettings>;
    return {
      // Keep every key this function doesn't validate. gg-app.json is shared:
      // local-endpoint-store keeps custom endpoints (with their API keys) under
      // `localEndpoints`, and saveAppSettings rewrites the whole file — so
      // listing only known keys here erased them on every model switch, and
      // the next local scan then deleted the endpoint's credential.
      ...raw,
      projectsRoot:
        typeof raw.projectsRoot === "string" && raw.projectsRoot.trim()
          ? raw.projectsRoot
          : defaultProjectsRoot(),
      // Preserve the per-project map verbatim (validated + written by the
      // model/thinking handlers below).
      projectModels:
        raw.projectModels && typeof raw.projectModels === "object" ? raw.projectModels : undefined,
      autopilot: raw.autopilot && typeof raw.autopilot === "object" ? raw.autopilot : undefined,
      kenModels: raw.kenModels && typeof raw.kenModels === "object" ? raw.kenModels : undefined,
      projectRoots: stringArray(raw.projectRoots),
      hiddenProjects: stringArray(raw.hiddenProjects),
    };
  } catch {
    return { projectsRoot: defaultProjectsRoot() };
  }
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
  await fs.mkdir(path.dirname(appSettingsFile()), { recursive: true });
  await atomicWrite(appSettingsFile(), JSON.stringify(settings, null, 2));
}

/**
 * Read-modify-write gg-app.json under the shared file lock, so two windows
 * saving at once (or a local-endpoint save racing a model save) can't lose
 * each other's change. Every settings write in the sidecar goes through here.
 */
export async function updateAppSettings<T = void>(
  mutate: (settings: AppSettings) => T | Promise<T>,
): Promise<T> {
  await fs.mkdir(path.dirname(appSettingsFile()), { recursive: true });
  return withFileLock(appSettingsFile(), async () => {
    const s = await loadAppSettings();
    const result = await mutate(s);
    await saveAppSettings(s);
    return result;
  });
}

/** Read this project's persisted model/thinking prefs, if any. */
export async function loadProjectModelPrefs(cwd: string): Promise<ProjectModelPrefs | undefined> {
  const s = await loadAppSettings();
  const prefs = s.projectModels?.[projectModelKey(cwd)];
  // A paid tier (Claude fast mode) never comes back on its own: a restored or
  // new session starts on the standard model and the user opts in again.
  return prefs ? { ...prefs, model: withoutPaidTier(prefs.model) } : undefined;
}

/** Persist this project's model/thinking prefs via read-modify-write so the rest
 *  of the settings file (projectsRoot, other projects' entries) is preserved. */
export async function saveProjectModelPrefs(cwd: string, prefs: ProjectModelPrefs): Promise<void> {
  const key = projectModelKey(cwd);
  const safe = { ...prefs, model: withoutPaidTier(prefs.model) };
  await updateAppSettings((s) => {
    s.projectModels = { ...(s.projectModels ?? {}), [key]: safe };
  });
}

/** Read this project's persisted Ken model override, if any. */
export async function loadKenModelPref(cwd: string): Promise<KenModelPref | undefined> {
  const s = await loadAppSettings();
  const pref = s.kenModels?.[projectModelKey(cwd)];
  return pref ? { ...pref, model: withoutPaidTier(pref.model) } : undefined;
}

/** Persist (or with null, clear) this project's Ken model override via
 *  read-modify-write so the rest of the settings file is preserved. */
export async function saveKenModelPref(cwd: string, pref: KenModelPref | null): Promise<void> {
  const key = projectModelKey(cwd);
  await updateAppSettings((s) => {
    const next = { ...(s.kenModels ?? {}) };
    if (pref) next[key] = pref;
    else delete next[key];
    s.kenModels = next;
  });
}

/** Read this project's persisted autopilot flag (default off). */
export async function loadAutopilot(cwd: string): Promise<boolean> {
  const s = await loadAppSettings();
  return s.autopilot?.[projectModelKey(cwd)] ?? false;
}

/** Persist this project's autopilot flag via read-modify-write so the rest of
 *  the settings file (projectsRoot, model map, other projects) is preserved. */
export async function saveAutopilot(cwd: string, enabled: boolean): Promise<void> {
  const key = projectModelKey(cwd);
  await updateAppSettings((s) => {
    s.autopilot = { ...(s.autopilot ?? {}), [key]: enabled };
  });
}

/**
 * Persist the active model selection to ~/.gg/settings.json so it survives app
 * restarts. Mirrors the CLI's handleModelSelect persistence (App.tsx).
 */
export async function persistModelSelection(
  settingsFile: string,
  provider: Provider,
  model: string,
): Promise<void> {
  try {
    const sm = new SettingsManager(settingsFile);
    await sm.load();
    await sm.set("defaultProvider", provider as Settings["defaultProvider"]);
    // Never persist a paid tier as the default every new session boots with.
    await sm.set("defaultModel", withoutPaidTier(model));
  } catch (err) {
    log("WARN", "app-sidecar", "failed to persist model selection", { err: String(err) });
  }
}

/**
 * Persist the thinking level to ~/.gg/settings.json so it survives app restarts.
 * Mirrors the CLI's handleToggleThinking persistence (App.tsx).
 */
export async function persistThinkingLevel(
  settingsFile: string,
  level: ThinkingLevel | undefined,
): Promise<void> {
  try {
    const sm = new SettingsManager(settingsFile);
    await sm.load();
    await sm.set("thinkingEnabled", !!level);
    if (level) await sm.set("thinkingLevel", level);
  } catch (err) {
    log("WARN", "app-sidecar", "failed to persist thinking level", { err: String(err) });
  }
}

/** Validate a project folder name: lowercase letters, digits, dashes only. */
export function isValidProjectName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}
