/**
 * The bundled `gg-guide` skill tells the agent how the desktop app works. A
 * guide that names a renamed button, a removed command or a moved file is
 * worse than none, so this fails when the app drifts away from it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROMPT_COMMANDS } from "./prompt-commands.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const GUIDE = path.resolve(HERE, "../../assets/skills/gg-guide");
const REFS = path.join(GUIDE, "references");

function sourceText(dirs: string[], exts: string[]): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith("__")) walk(full);
      } else if (exts.some((e) => entry.name.endsWith(e)) && !/\.test\.[a-z]+$/.test(entry.name)) {
        out.push(fs.readFileSync(full, "utf8"));
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return out.join("\n");
}

/** Compare UI text the way it reads on screen: entities, escapes and line wraps undone. */
function normalise(text: string): string {
  return text
    .replace(/&apos;|&#39;|&rsquo;|’/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;|[“”]/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|\{" "\}/g, " ")
    .replace(/\\u2026|&hellip;/g, "…")
    .replace(/\\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const references = fs
  .readdirSync(REFS)
  .filter((f) => f.endsWith(".md"))
  .map((file) => ({ file, text: fs.readFileSync(path.join(REFS, file), "utf8") }));
const skill = fs.readFileSync(path.join(GUIDE, "SKILL.md"), "utf8");
const appSource = normalise(sourceText([path.join(REPO, "gg-app/src")], [".ts", ".tsx"]));
const engineSource = sourceText(
  [
    path.join(REPO, "packages/gg-core/src"),
    path.join(REPO, "packages/ggcoder/src"),
    path.join(REPO, "gg-app/src-tauri/src"),
  ],
  [".ts", ".rs"],
);

describe("gg-guide skill", () => {
  it("lists every reference page, and every listed page exists", () => {
    const listed = [...skill.matchAll(/`references\/([\w-]+\.md)`/g)].map((m) => m[1]);
    expect(new Set(listed)).toEqual(new Set(references.map((r) => r.file)));
  });

  it("names only UI labels the app still shows", () => {
    const missing: string[] = [];
    for (const { file, text } of references) {
      for (const [, label] of text.matchAll(/\*\*([^*]+?)\*\*/g)) {
        if (!appSource.includes(normalise(label!))) missing.push(`${file}: ${label}`);
      }
    }
    expect(missing, "bold = a UI label; reword or unbold these").toEqual([]);
  });

  it("names only slash commands the app offers", () => {
    const known = new Set(PROMPT_COMMANDS.flatMap((c) => [c.name, ...c.aliases]));
    const missing: string[] = [];
    for (const { file, text } of [...references, { file: "SKILL.md", text: skill }]) {
      for (const [, name] of text.matchAll(/`\/([a-z][a-z0-9-]*)(?=[\s`])/g)) {
        const offered =
          known.has(name!) ||
          appSource.includes(`"/${name}`) ||
          appSource.includes(`"${name}"`) ||
          engineSource.includes(`name: "${name}"`) ||
          engineSource.includes(`aliases: ["${name}"]`);
        if (!offered) missing.push(`${file}: /${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("names only ~/.gg paths the code still uses", () => {
    const missing: string[] = [];
    for (const { file, text } of [...references, { file: "SKILL.md", text: skill }]) {
      for (const [, rest] of text.matchAll(/`~\/\.gg\/([^`]+)`/g)) {
        const first = rest!.split(/[/<]/)[0]!;
        if (first && !engineSource.includes(first)) missing.push(`${file}: ~/.gg/${rest}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

/**
 * Where each app UI file is explained. A new screen or control fails this test
 * until it is mapped to a guide page (and documented there) or marked internal,
 * so the guide can't silently fall behind the app.
 */
const COVERAGE: Record<string, string> = {
  // getting-started.md
  HomeScreen: "getting-started.md",
  HomeTitle: "getting-started.md",
  HomeScenery: "getting-started.md",
  HomeCritters: "getting-started.md",
  HomeBackgroundButton: "getting-started.md",
  HomeUpdateButton: "getting-started.md",
  UpdateBanner: "getting-started.md",
  UpdateKeyParts: "getting-started.md",
  WhatsNewLounge: "getting-started.md",
  WhatsNewModal: "getting-started.md",
  WhatsNewParts: "getting-started.md",
  WhatsNewWindow: "getting-started.md",
  AboutPage: "getting-started.md",
  ProjectPicker: "getting-started.md",
  NewProjectModal: "getting-started.md",
  WindowLayoutButton: "getting-started.md",
  ZoomController: "getting-started.md",
  WakeScreen: "getting-started.md",
  BackButton: "getting-started.md",
  // sessions-and-history.md
  Deck: "sessions-and-history.md",
  WorkspaceHeader: "sessions-and-history.md",
  WorkspaceHeaderActions: "sessions-and-history.md",
  TranscriptRow: "sessions-and-history.md",
  TranscriptJumpControls: "sessions-and-history.md",
  ReferencedFiles: "sessions-and-history.md",
  LiveToolPanel: "sessions-and-history.md",
  ImageCard: "sessions-and-history.md",
  "image-gen/ImageGenCard": "sessions-and-history.md",
  AskBand: "sessions-and-history.md",
  CompactionNotice: "sessions-and-history.md",
  CacheExpiryNotice: "sessions-and-history.md",
  ConfirmModal: "sessions-and-history.md",
  StreamingMarkdown: "sessions-and-history.md",
  Markdown: "sessions-and-history.md",
  // code-mode.md
  Composer: "code-mode.md",
  FileMentionMenu: "code-mode.md",
  AttachmentBar: "code-mode.md",
  SlashMenu: "code-mode.md",
  ShellBlock: "code-mode.md",
  ShellCommandMenu: "code-mode.md",
  ScheduleHint: "code-mode.md",
  RunningSchedulesButton: "code-mode.md",
  PromptEnhancement: "code-mode.md",
  EnhanceDissolve: "code-mode.md",
  PlanReviewModal: "code-mode.md",
  PlanModeLogo: "code-mode.md",
  PlanCritters: "code-mode.md",
  TasksModal: "code-mode.md",
  NotesModal: "code-mode.md",
  CIIndicator: "code-mode.md",
  InitGitModal: "code-mode.md",
  HookNotice: "code-mode.md",
  ActivityBar: "code-mode.md",
  WorkingBeam: "code-mode.md",
  FoldersPanel: "code-mode.md",
  // ken-and-autopilot.md
  KenActivityBar: "ken-and-autopilot.md",
  KenFace: "ken-and-autopilot.md",
  KenPowerBanner: "ken-and-autopilot.md",
  PlanDecisionNotice: "ken-and-autopilot.md",
  SubAgentFeed: "ken-and-autopilot.md",
  CritterFloor: "ken-and-autopilot.md",
  CritterLine: "ken-and-autopilot.md",
  CritterTerrain: "ken-and-autopilot.md",
  CritterBackdrop: "ken-and-autopilot.md",
  PopCritter: "ken-and-autopilot.md",
  Confetti: "ken-and-autopilot.md",
  TrophiesPanel: "ken-and-autopilot.md",
  TrophyUnlock: "ken-and-autopilot.md",
  RadioButton: "ken-and-autopilot.md",
  Scorecard: "ken-and-autopilot.md",
  // chat-motion-goals.md
  ChatPicker: "chat-motion-goals.md",
  MemoryModal: "chat-motion-goals.md",
  MotionStarters: "chat-motion-goals.md",
  GoalPicker: "chat-motion-goals.md",
  NewGoalModal: "chat-motion-goals.md",
  GoalWorld: "chat-motion-goals.md",
  GoalSettingsModal: "chat-motion-goals.md",
  GoalInstructionsField: "chat-motion-goals.md",
  GoalContextPicker: "chat-motion-goals.md",
  GoalFinishCard: "chat-motion-goals.md",
  GoalAskNotice: "chat-motion-goals.md",
  KenDialogue: "chat-motion-goals.md",
  KenStatus: "chat-motion-goals.md",
  // checklist-and-safety.md
  ChecklistScreen: "checklist-and-safety.md",
  ProjectHealthBadge: "checklist-and-safety.md",
  SecurityNotice: "checklist-and-safety.md",
  // models-and-sign-in.md
  ModelPanel: "models-and-sign-in.md",
  ModelSelect: "models-and-sign-in.md",
  ProvidersBay: "models-and-sign-in.md",
  ProviderLoginModal: "models-and-sign-in.md",
  LocalModelsModal: "models-and-sign-in.md",
  HfPullModal: "models-and-sign-in.md",
  TitleUsageMeter: "models-and-sign-in.md",
  LoginScreen: "models-and-sign-in.md",
  "thinking-display": "models-and-sign-in.md",
  // settings.md
  SettingsScreen: "settings.md",
  SettingsModal: "settings.md",
  SettingsTabBar: "settings.md",
  "settings-header": "settings.md",
  TelegramSettingsModal: "settings.md",
  SteroidsModal: "settings.md",
  KeepAwakeButton: "settings.md",
  SoundButton: "settings.md",
  AppearancePicker: "settings.md",
  // mcp-and-skills.md
  McpModal: "mcp-and-skills.md",
  McpElicitModal: "mcp-and-skills.md",
  // troubleshooting-and-data.md
  AppErrorBoundary: "troubleshooting-and-data.md",
  ChatErrorNotice: "troubleshooting-and-data.md",
  Toaster: "troubleshooting-and-data.md",
  // Building blocks with no behaviour of their own to explain.
  App: "internal",
  main: "internal",
  icons: "internal",
  Badge: "internal",
  Dropdown: "internal",
  FloatingSurface: "internal",
  Modal: "internal",
  "modal-embed": "internal",
  PixelGlyph: "internal",
  PixelIconButton: "internal",
  PixelTip: "internal",
  PlateButton: "internal",
  ShimmerText: "internal",
  Skeleton: "internal",
  TooltipLayer: "internal",
  DeckPanelHead: "internal",
  "settings-ready": "internal",
  "settings-section": "internal",
  // Not rendered anywhere at the moment.
  HomePoll: "internal",
};

describe("gg-guide coverage", () => {
  it("maps every app UI file to a guide page (or marks it internal)", () => {
    const appDir = path.join(REPO, "gg-app/src");
    const uiFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
          uiFiles.push(
            path
              .relative(appDir, full)
              .replace(/\\/g, "/")
              .replace(/\.tsx$/, ""),
          );
        }
      }
    };
    walk(appDir);
    const unmapped = uiFiles.filter((f) => !(f in COVERAGE));
    expect(unmapped, "document these in gg-guide, then map them here").toEqual([]);
    const stale = Object.keys(COVERAGE).filter((f) => !uiFiles.includes(f));
    expect(stale, "these UI files are gone; drop them from the map").toEqual([]);
    const pages = new Set(references.map((r) => r.file));
    const badPages = Object.values(COVERAGE).filter((p) => p !== "internal" && !pages.has(p));
    expect(badPages).toEqual([]);
  });

  it("ends every page with common questions in the user's own words", () => {
    for (const { file, text } of references) {
      const section = text.split(/^## Common questions\s*$/m)[1];
      expect(section, `${file} has no "## Common questions"`).toBeDefined();
      expect((section!.match(/^Q: /gm) ?? []).length, file).toBeGreaterThanOrEqual(8);
    }
  });

  it("answers the questions users ask most", () => {
    const asked: Array<[string, RegExp]> = [
      ["code-mode.md", /^Q: How do I enhance my prompt\?/m],
      ["models-and-sign-in.md", /^Q: Where do I change models\?/m],
      ["sessions-and-history.md", /^Q: How do I start a new session\?/m],
      ["checklist-and-safety.md", /^Q: How do I make sure my app is safe\?/m],
      ["mcp-and-skills.md", /^Q: How do I add an MCP server\?/m],
      ["troubleshooting-and-data.md", /^Q: Where are the logs\?/m],
    ];
    for (const [file, question] of asked) {
      expect(references.find((r) => r.file === file)?.text, file).toMatch(question);
    }
  });
});
