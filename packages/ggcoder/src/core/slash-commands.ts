import { isGgApp } from "./runtime-mode.js";

// ── Types ──────────────────────────────────────────────────

export interface SlashCommandContext {
  // These will be wired by AgentSession
  switchModel: (provider: string, model: string) => Promise<void>;
  /** Compact now. `focus` is the user's `/compact <focus>` text: a short
   * description of what must survive the summary verbatim. */
  compact: (focus?: string) => Promise<void>;
  newSession: () => Promise<void>;
  listSessions: () => Promise<string>;
  getSettings: () => Record<string, unknown>;
  setSetting: (key: string, value: unknown) => Promise<void>;
  getModelList: () => string;
  quit: () => void;
  /** Create a branch (rewind N messages and fork). */
  branch: (stepsBack?: number) => Promise<string>;
  /** List all branches in the current session. */
  listBranches: () => Promise<string>;
  /** Add another workspace root (tools + write guard + system prompt). */
  addDirectory: (dir: string) => Promise<{ ok: true; root: string } | { ok: false; error: string }>;
  /** Remove an exact workspace root previously added this session. */
  removeDirectory: (
    dir: string,
  ) => Promise<{ ok: true; root: string } | { ok: false; error: string }>;
  /** Extra workspace roots added this session. */
  getAdditionalRoots: () => string[];
}

export interface SlashCommand {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
  execute: (args: string, context: SlashCommandContext) => Promise<string> | string;
}

// ── Registry ───────────────────────────────────────────────

export class SlashCommandRegistry {
  private commands = new Map<string, SlashCommand>();

  register(command: SlashCommand): void {
    this.commands.set(command.name, command);
    for (const alias of command.aliases) {
      this.commands.set(alias, command);
    }
  }

  unregister(name: string): void {
    const cmd = this.commands.get(name);
    if (!cmd) return;
    this.commands.delete(cmd.name);
    for (const alias of cmd.aliases) {
      this.commands.delete(alias);
    }
  }

  get(name: string): SlashCommand | undefined {
    return this.commands.get(name);
  }

  getAll(): SlashCommand[] {
    // Deduplicate (aliases point to same command)
    const seen = new Set<string>();
    const result: SlashCommand[] = [];
    for (const cmd of this.commands.values()) {
      if (!seen.has(cmd.name)) {
        seen.add(cmd.name);
        result.push(cmd);
      }
    }
    return result;
  }

  parse(input: string): { name: string; args: string } | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return null;
    const spaceIndex = trimmed.indexOf(" ");
    const name = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
    const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
    return { name, args };
  }

  async execute(input: string, context: SlashCommandContext): Promise<string | null> {
    const parsed = this.parse(input);
    if (!parsed) return null;

    const command = this.get(parsed.name);
    if (!command) return `Unknown command: /${parsed.name}. Type /help for available commands.`;

    return command.execute(parsed.args, context);
  }
}

// ── Built-in Commands ──────────────────────────────────────

export function createBuiltinCommands(): SlashCommand[] {
  return [
    {
      name: "model",
      aliases: ["m", "models"],
      description: "Switch model or list available models",
      usage: "/model [provider:model]",
      async execute(args, ctx) {
        if (!args) {
          return ctx.getModelList();
        }
        const parts = args.split(":");
        if (parts.length === 2) {
          await ctx.switchModel(parts[0], parts[1]);
          return `Switched to ${parts[0]}:${parts[1]}`;
        }
        // Assume it's just a model name with current provider
        await ctx.switchModel("", args);
        return `Switched to model: ${args}`;
      },
    },
    {
      name: "compact",
      aliases: ["c"],
      description: "Compact conversation to reduce context usage",
      usage: "/compact [focus]",
      async execute(args, ctx) {
        await ctx.compact(args.trim() || undefined);
        return args.trim()
          ? `Conversation compacted (focus: ${args.trim()}).`
          : "Conversation compacted.";
      },
    },
    {
      name: "settings",
      aliases: ["config"],
      description: "Show or modify settings",
      usage: "/settings [key] [value]",
      async execute(args, ctx) {
        if (!args) {
          const settings = ctx.getSettings();
          return Object.entries(settings)
            .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
            .join("\n");
        }
        const [key, ...rest] = args.split(" ");
        if (rest.length === 0) {
          const settings = ctx.getSettings();
          const val = (settings as Record<string, unknown>)[key];
          return val !== undefined ? `${key}: ${JSON.stringify(val)}` : `Unknown setting: ${key}`;
        }
        const value = rest.join(" ");
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          parsed = value;
        }
        await ctx.setSetting(key, parsed);
        return `Set ${key} = ${JSON.stringify(parsed)}`;
      },
    },
    {
      name: "session",
      aliases: ["s"],
      description: "List sessions (use /new for a new session)",
      usage: "/session",
      async execute(_args, ctx) {
        return ctx.listSessions();
      },
    },
    {
      name: "new",
      aliases: ["n"],
      description: "Start a new session",
      usage: "/new",
      async execute(_args, ctx) {
        await ctx.newSession();
        return "New session created.";
      },
    },
    {
      name: "branch",
      aliases: ["b"],
      description: "Create a branch (rewind and fork the conversation)",
      usage: "/branch [steps_back] — rewind N messages and fork (default: 2)",
      async execute(args, ctx) {
        const stepsBack = args ? parseInt(args, 10) : 2;
        if (isNaN(stepsBack) || stepsBack < 1) {
          return "Usage: /branch [N] — rewind N messages (default: 2)";
        }
        return ctx.branch(stepsBack);
      },
    },
    {
      name: "branches",
      aliases: [],
      description: "List all branches in the current session",
      usage: "/branches",
      async execute(_args, ctx) {
        return ctx.listBranches();
      },
    },
    {
      name: "add-dir",
      aliases: ["adddir"],
      description: "Add another project folder to this workspace",
      usage: "/add-dir [path] — no path lists the current roots",
      async execute(args, ctx) {
        const roots = ctx.getAdditionalRoots();
        if (!args) {
          return roots.length === 0
            ? "No additional roots. Use /add-dir <path> to add one."
            : `Additional roots:\n${roots.map((r) => `  ${r}`).join("\n")}`;
        }
        const result = await ctx.addDirectory(args);
        return result.ok ? `Added workspace root: ${result.root}` : result.error;
      },
    },
    {
      name: "remove-dir",
      aliases: ["removedir"],
      description: "Remove an added project folder from this workspace",
      usage: "/remove-dir [path] — no path lists roots available to remove",
      async execute(args, ctx) {
        const roots = ctx.getAdditionalRoots();
        if (!args) {
          return roots.length === 0
            ? "No additional roots to remove."
            : `Choose a root to remove:\n${roots.map((r) => `  ${r}`).join("\n")}`;
        }
        const result = await ctx.removeDirectory(args);
        return result.ok ? `Removed workspace root: ${result.root}` : result.error;
      },
    },
    {
      name: "rewind",
      aliases: [],
      description: "Restore files/conversation to an earlier checkpoint",
      usage: "/rewind — pick a checkpoint, then code / conversation / both",
      execute() {
        // The real implementation lives in App.tsx (it needs React state to
        // drive the picker) and intercepts before the registry, so this only
        // runs where no picker exists — today that's the gg-app sidecar.
        return isGgApp()
          ? "/rewind is only available in the ggcoder terminal app — the desktop app has no checkpoint picker yet."
          : "Checkpoint picker unavailable in this context.";
      },
    },
    {
      name: "help",
      aliases: ["h", "?"],
      description: "Show available commands",
      usage: "/help",
      execute() {
        // This will be populated dynamically by the registry
        return "Use /help to see available slash commands.";
      },
    },
    {
      name: "quit",
      aliases: ["q", "exit"],
      description: "Exit the agent",
      usage: "/quit",
      execute(_args, ctx) {
        ctx.quit();
        return "Goodbye!";
      },
    },
  ];
}
