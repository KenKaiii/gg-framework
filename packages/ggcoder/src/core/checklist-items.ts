// The built-in project health checklist: one definition list shared by the
// `checklist` tool, the run prompt (`checklist-prompt.ts`) and the app's
// Checklist screen, so the three can never drift apart.

/** Days after which a recorded check comes back as due. */
export const CHECKLIST_STALE_DAYS = 30;

/** The record lives at the project root (not under `.gg/`, which many projects ignore). */
export const CHECKLIST_FILE = ".gg-checklist.json";

export const CHECKLIST_GROUPS = [
  "Foundations",
  "Source control",
  "Code quality",
  "Design & UX",
  "Safety",
  "Performance",
  "Shipping",
] as const;

export type ChecklistGroup = (typeof CHECKLIST_GROUPS)[number];

export interface ChecklistItem {
  readonly id: string;
  readonly group: ChecklistGroup;
  readonly title: string;
  /** A short, first-person purpose hint shown as the item's tooltip. */
  readonly description: string;
  /** What the agent should inspect, written as instructions. */
  readonly check: string;
  /** Bundled skill to load before checking, when one fits. */
  readonly skill?: string;
  /** Built-in setup command that fixes most gaps, when one exists. */
  readonly setupCommand?: string;
}

/** In recommended run order. */
export const CHECKLIST_ITEMS = [
  {
    id: "agent-setup",
    group: "Foundations",
    title: "Agent setup",
    description:
      "I start here so the agent knows the project. /init can create or update project instructions.",
    check:
      "A context file (AGENTS.md or CLAUDE.md) exists, its commands and architecture notes match the code today, and the project has the skills its recurring work needs.",
    setupCommand: "init",
  },
  {
    id: "docs",
    group: "Foundations",
    title: "README & setup docs",
    description: "I check this so someone new can get the project running without asking me.",
    check:
      "The README says what the project is and how to install, run and test it; an example env file lists required settings; a licence file exists.",
  },
  {
    id: "naming",
    group: "Foundations",
    title: "Shared vocabulary",
    description: "I use this to keep names consistent and big decisions written down.",
    check:
      "Each domain concept has one name across code and docs, a glossary (CONTEXT.md or similar) exists for non-trivial domains, and hard-to-reverse decisions are recorded (ADRs).",
    skill: "shared-language",
  },
  {
    id: "git-github",
    group: "Source control",
    title: "Git & GitHub",
    description: "I use this to check the repo setup, ignore rules and protection for main.",
    check:
      "The project is a Git repo with a GitHub remote, .gitignore covers build output and local files, the main branch is protected (ruleset or branch protection, via `gh` when available), and no large binaries are committed.",
    setupCommand: "setup-ci",
  },
  {
    id: "secrets",
    group: "Source control",
    title: "Secrets kept out",
    description: "I check this for keys and passwords that slipped into the code or Git history.",
    check:
      "No API keys, tokens, passwords or private keys in tracked files or Git history; env files are ignored; secrets are read from the environment or a secret store.",
    skill: "bulletproof",
  },
  {
    id: "quality-tools",
    group: "Code quality",
    title: "Lint, format & type checks",
    description: "I use this to catch formatting, lint and type errors before they pile up.",
    check:
      "A linter, formatter and type checker (where the language has one) are configured, have scripts to run them, and pass when run now.",
  },
  {
    id: "tests",
    group: "Code quality",
    title: "Tests",
    description: "I use this to check that tests pass and cover the parts that really matter.",
    check:
      "A test suite exists, runs green now, and covers the critical paths with real code paths rather than mocks alone.",
    skill: "tdd",
  },
  {
    id: "ci",
    group: "Code quality",
    title: "CI",
    description: "I use this to check that every pull request gets built and tested automatically.",
    check:
      "CI runs build, lint and tests on every pull request and push to main, and the workflows are hardened (pinned actions, least-privilege permissions, no untrusted input in run steps).",
    setupCommand: "setup-ci",
  },
  {
    id: "commit-gate",
    group: "Code quality",
    title: "Commit checks",
    description:
      "I use this to check that /commit runs checks and a review before saving a commit.",
    check:
      "A project /commit command exists that runs the project's checks and a review before committing.",
    setupCommand: "setup-commit",
  },
  {
    id: "code-health",
    group: "Code quality",
    title: "Code health",
    description:
      "I use this to spot dead code, repetition and files that are getting hard to work with.",
    check:
      "Look for duplicated logic, dead code, unused exports and very large files or functions that are hard to change safely.",
    skill: "refactoring",
  },
  {
    id: "errors-logging",
    group: "Code quality",
    title: "Errors & logging",
    description:
      "I use this to catch swallowed errors, confusing messages and leftover debug logs.",
    check:
      "Errors are handled at I/O boundaries with clear user-facing messages, nothing swallows errors silently, and there are no stray debug prints in shipped code.",
  },
  {
    id: "dependencies",
    group: "Code quality",
    title: "Dependencies",
    description: "I check this for risky, unused or abandoned packages.",
    check:
      "A lockfile is committed, the package manager's audit reports no known vulnerabilities, and there are no unused or abandoned packages.",
    skill: "bulletproof",
  },
  {
    id: "design-system",
    group: "Design & UX",
    title: "Design system",
    description:
      "I use this to check that colours, spacing and components come from one shared place.",
    check:
      "Colour, type, spacing and radius tokens are defined in one place and shared components exist for repeated UI. Not applicable without a UI.",
    skill: "evidence-led-ui",
  },
  {
    id: "styling-consistency",
    group: "Design & UX",
    title: "Consistent styling",
    description: "I use this to catch one-off styles that don't match the rest of the app.",
    check:
      "Find hard-coded colours and sizes and one-off styles where shared tokens or components already exist. Not applicable without a UI.",
    skill: "evidence-led-ui",
  },
  {
    id: "motion-consistency",
    group: "Design & UX",
    title: "Consistent animation",
    description: "I use this to keep animations consistent and check they respect reduced motion.",
    check:
      "Animations use shared durations and easings, and reduced-motion preferences are respected. Not applicable without a UI.",
    skill: "evidence-led-ui",
  },
  {
    id: "accessibility",
    group: "Design & UX",
    title: "Accessibility",
    description:
      "I use this to catch things that make the app hard to read or use without a mouse.",
    check:
      "Text contrast is sufficient, everything works by keyboard with visible focus, and controls and images have labels or alt text. Not applicable without a UI.",
    skill: "evidence-led-ui",
  },
  {
    id: "ui-states",
    group: "Design & UX",
    title: "Loading, empty & error states",
    description:
      "I check what people see while loading, when there's nothing to show or when things break.",
    check:
      "Every screen handles loading, empty and error states, and layouts survive small screens and long text. Not applicable without a UI.",
    skill: "evidence-led-ui",
  },
  {
    id: "security",
    group: "Safety",
    title: "Security audit",
    description: "I use this to look for security holes before shipping.",
    check: "Run a full security audit of the project following the skill.",
    skill: "bulletproof",
  },
  {
    id: "data-safety",
    group: "Safety",
    title: "Data safety",
    description: "I use this to check backups and catch changes that could lose someone's data.",
    check:
      "Migrations are reversible or guarded, backups exist for real data, and destructive operations are confirmed and recoverable. Not applicable without stored data.",
    skill: "durable",
  },
  {
    id: "compliance",
    group: "Safety",
    title: "Compliance",
    description: "I check this for gaps around privacy, cookies, payments and licences.",
    check:
      "Privacy policy and terms exist where users or personal data are involved, cookies and payments follow the rules, and dependency licences are compatible.",
    skill: "compliance-guard",
  },
  {
    id: "performance",
    group: "Performance",
    title: "Performance audit",
    description: "I use this to catch slow spots and things wasting memory.",
    check: "Run a full performance audit of the project following the skill.",
    skill: "lean",
  },
  {
    id: "build-release",
    group: "Shipping",
    title: "Build & release",
    description: "I use this to check that a fresh copy builds and the release steps are clear.",
    check:
      "The project builds from a clean clone with documented steps, versions are tracked, a changelog exists, and releases are documented or automated.",
  },
  {
    id: "monitoring",
    group: "Shipping",
    title: "Error reporting",
    description: "I use this to check that I'll hear about crashes and know where to look.",
    check:
      "Crashes and errors are reported somewhere the team sees them, logs can be found, and services have health checks where relevant. Not applicable for code with no running deployment.",
  },
] as const satisfies readonly ChecklistItem[];

export type ChecklistId = (typeof CHECKLIST_ITEMS)[number]["id"];

export const CHECKLIST_IDS = CHECKLIST_ITEMS.map((item) => item.id) as [
  ChecklistId,
  ...ChecklistId[],
];

const ITEMS_BY_ID: ReadonlyMap<string, ChecklistItem> = new Map(
  CHECKLIST_ITEMS.map((item) => [item.id, item]),
);

export function getChecklistItem(id: string): ChecklistItem | undefined {
  return ITEMS_BY_ID.get(id);
}
