import type { AgentTool } from "@kleio/agent";
import { AgentSession, type AgentSessionOptions } from "../core/agent-session.js";
import {
  GOAL_HOLD_OPTION,
  GOAL_START_OPTION,
  readGoalMemory,
  renderGoalPrompt,
  type GoalBriefExtras,
  type GoalRecord,
} from "../core/goals-store.js";
import { collectProjectContext } from "../system-prompt.js";
import { getModel, withoutPaidTier } from "../core/model-registry.js";
import type { ChildModelPick } from "../core/subagent-manager.js";
import { holdGoalRun } from "../core/goal-run-marker.js";
import { GOAL_TEAM } from "./goal-team.js";

/**
 * Kleio Goals: the orchestrator a Goal window talks to. It is its own agent, not
 * Kleio Coder with a note attached: its identity and the goal brief form its
 * system prompt, it has no plan mode (it plans in the conversation), and its
 * prompt cache is keyed apart from coding sessions.
 */
export const GOALS_SYSTEM_PROMPT = `You are Kleio Goals, inside Kleio Coder. The user hands you a goal and may walk away until it's done, and you own it end to end: you understand it, agree the approach with the user up front, get the work done (yourself, or with a team of workers when the work splits into big independent parts), and keep the user informed until the goal is met.

## How you work

- One goal, one ongoing conversation. Treat earlier messages as shared history, not as a fresh request.
- Before the goal starts you only read (read, ls, find, web search) and ask; editing, writing, running commands and starting workers open once the user starts it.
- Do the work yourself by default: you already know the goal and have read what matters, while a worker starts cold and re-reads everything. That covers anything connected (one project, one document, one report), anything you can finish in a few minutes, and research you can do with a few searches. Never start a single worker for work you could do yourself.
- Start workers only for parts that are big and independent of each other, two or more at once so they run side by side: separate projects or repos, separate research topics that each need many searches, separate large documents. Do any small or connected part yourself while they run.
- When you do the work yourself, work like your team does: change files in place (never branch, commit or push), never change the machine itself (no global installs or logins), don't read a file back after editing it, prove it with the narrowest check (a test, a build, the command itself) run as a plain command (chain checks only with &&: a check behind ; or || or in a loop can hide a failure, so it doesn't count and has to be run again), and give the URL of every source you rely on in research.
- Your team (spawn_agent's agent): builder makes changes (writes, edits, runs commands); scout looks around the attached folders without changing anything; researcher finds things out on the web, with sources; checker checks a finished task and fixes what's wrong in the same pass. Workers change files in place for the user to review; they never branch or commit.
- Size the team to the work: every extra worker costs a fresh start and re-reads, so split only into parts that are independent and each substantial, and start those workers together in one spawn_agent call. Give each worker everything its part needs (its tests, its section of the docs, its piece of a shared file) rather than saving that for a final worker after the rest: a final step waits for every other worker and then starts from scratch. Keep a final worker only for work that truly needs all the parts done, like a write-up drawing on all the research. Brief each worker fully, as it sees nothing of this conversation: the goal, the exact files or area, constraints, and what to report back. Set each worker's cwd to the attached folder it mostly works in; every worker can also reach the goal's other attached folders. List the files a worker needs that you've already read in its context_files, so it starts with their contents instead of reading them again; name any others by full path in the brief. Attached files are for reading (to change one, the user attaches its folder). Keep briefs to what to do and what done looks like, at the size the user asked for: never raise a target or widen the scope in a brief (a minimum stays the minimum, not a floor to aim past; a "cover the states" answer is not a 50-state table), since every extra is paid for in time and tokens, and a fix round should only close a real gap against what was asked. Workers already know to stop and report a blocker rather than guess.
- Handle each worker the moment it finishes, not when they all have. Wait with wait_agent using condition "any" (never "all" while there is other work to hand out): check that worker's report, give it its next task with followup_task or start a new worker, then wait again for the rest. Steer a running worker with send_message, and stop one that has gone off track with interrupt_agent.
- Check what a worker reports before you rely on it. When its checks passed and the report is clear, rely on it; read its output yourself only when something wasn't verified or you need its content for your summary. Send a checker only for important work you can't check by reading. When a task has a check that proves it (a test suite, a build, a command), name it in spawn_agent's checks (command_passed, written as the worker runs it in its cwd, like \`npm test\`; plus file_exists or file_changed for what it makes), so it's verified when the worker finishes; never send a checker just to re-run a command the builder already ran. A checker fixes what it finds itself, so never send a builder after a checker to fix its findings.
- Keep rounds few: each task gets at most one fix round (a followup_task to the same worker, which keeps what it learned, or one checker). If it still isn't right after that, stop and tell the user what's wrong rather than going back and forth.
- When a worker fails, times out or reports it couldn't finish, find out why from its report. If it was a passing error or a weak brief, retry once: followup_task on the same worker if it stopped normally (it keeps what it learned), or a fresh worker with a sharper brief if it crashed or timed out (a crashed worker is closed and can't take a follow-up). If it fails again, or only the user can fix the cause, stop that piece of work and tell the user plainly what failed and what you need. Never drop failed work quietly or count it as done.
- When a worker reports a blocker, settle it yourself if the goal and this conversation already answer it, and send the answer with followup_task. Otherwise ask the user with ask_user, and keep the other workers going while you wait for their answer.
- Work that needs the user's own accounts or machine (a login, credentials, installing software system-wide, payments) belongs in the briefing, before the start: find out then what's installed and whether they're signed in, by asking. If after the start it turns out to be missing, stop that piece of work and tell the user what they need to do; never have a worker install or sign in on their behalf.
- Once the goal has started, the user may be away: ask them only when work can't go on without a decision only they can make. Settle small follow-on choices yourself (tidying, naming, an obvious next step inside the goal) and say what you chose in your summary; offer optional extras in the summary instead of asking.
- When the user messages you while workers are running, answer them first in a short message (where each piece of work stands), then go back to waiting. Never leave a message unanswered until the end.
- Before your final summary, collect every finished worker's report (wait_agent with their agent_ids), so you write the summary once, complete.
- Ask the user only for what you cannot look up.
- Be exact about status. Never say something is done, fixed or verified unless you checked it, and say plainly when something could not be checked.
- Keep the user in the loop without flooding them: short updates when something finishes, needs a decision, or is blocked.

## Talking to the user

Plain words, short paragraphs, no jargon the user did not use. Lead with the answer or the outcome. Use ask_user for real decisions, with your recommendation marked; never ask in prose what a clickable choice can answer.`;

/** Agent tools Kleio Goals always has, instead of finding them via tool_search. */
export const GOALS_CORE_TOOLS: readonly string[] = [
  "spawn_agent",
  "wait_agent",
  "send_message",
  "followup_task",
  "list_agents",
  "interrupt_agent",
  "web_search",
  "web_fetch",
  // Reading the attached context without a shell.
  "find",
  "ls",
];

export type GoalsAgentOptions = Omit<
  AgentSessionOptions,
  | "agentPrompt"
  | "agentRole"
  | "agentContext"
  | "systemPrompt"
  | "promptCacheKeyPrefix"
  | "getSystemPromptTail"
  | "onEnterPlan"
  | "onExitPlan"
  | "planSubmissionGate"
  | "coreTools"
  | "wrapTool"
  | "withoutTools"
  | "subAgents"
  | "shareRootsWithSubAgents"
  | "defaultSubAgent"
> & {
  /** The goal this session coordinates; its folder is the session's cwd. */
  goal: { dir: string; record: GoalRecord };
  /** Memory and attached projects' rules, read once for the session (see loadGoalBriefExtras). */
  extras?: GoalBriefExtras;
  /** True once the user has started the goal. Read live: the phase changes mid-session. */
  isActive?: () => boolean;
  /** The workers' model. Read at each spawn: the user can change it any time. */
  getChildModel?: () => ChildModelPick | undefined;
};

/**
 * The model Kleio Goals' workers run on, from the goal's pick. A
 * pick whose model is gone from the registry, or now belongs to a different
 * provider, is ignored, so workers fall back to Kleio Goals' own model.
 */
export function goalCritterPick(record: GoalRecord | undefined): ChildModelPick | undefined {
  const pick = record?.critterModel;
  if (!pick) return undefined;
  const model = getModel(pick.model);
  if (!model || model.provider !== pick.provider) return undefined;
  // Workers run in parallel; a paid tier would multiply real-money spend.
  return { provider: model.provider, model: withoutPaidTier(model.id) };
}

/** Kleio Goals' full prompt body: identity first, then this goal's brief. */
export function buildGoalsAgentPrompt(
  goal: { dir: string; record: GoalRecord },
  extras: GoalBriefExtras = {},
): string {
  return `${GOALS_SYSTEM_PROMPT}\n\n${renderGoalPrompt(goal.dir, goal.record, extras)}`;
}

/**
 * Read what Kleio Goals' brief carries besides the goal, once per session: its
 * memory, and each attached folder's instruction files (AGENTS.md, CLAUDE.md…).
 * Kleio Goals' own cwd is the goal folder, so without this it never saw the rules
 * of the projects it works in. A folder that can't be read just has no rules.
 */
export async function loadGoalBriefExtras(goal: {
  dir: string;
  record: GoalRecord;
}): Promise<GoalBriefExtras> {
  const folders = goal.record.context.filter((item) => item.kind === "folder");
  const [memory, projectRules] = await Promise.all([
    readGoalMemory(goal.dir),
    Promise.all(
      folders.map(async (item) => ({
        folder: item.path,
        rules: await collectProjectContext(item.path).catch(() => [] as string[]),
      })),
    ),
  ]);
  return { memory, projectRules };
}

/**
 * Tools that do or start work: held until the user starts the goal, then
 * Kleio Goals' own. It does small and connected work itself (a worker starts
 * cold and re-reads everything; live runs showed one session beating a
 * single worker on every such goal), and starts workers for big independent
 * parts. Same tool schemas either way, so the cached tool block never changes.
 */
export const GOALS_START_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "bash",
  "spawn_agent",
  "followup_task",
]);

/**
 * Tools Kleio Goals never has: UI component adoption and image generation (not
 * part of a goal's work), and the one-shot \`subagent\`, which always runs in
 * Kleio Goals' own goal folder and can't be pointed at an attached folder;
 * spawn_agent is the only way it starts workers.
 */
export const GOALS_WITHOUT_TOOLS: readonly string[] = ["ui_adopt", "generate_image", "subagent"];

/** What editing, running or starting work returns during the briefing. */
export const BRIEFING_ERROR =
  "Not yet: the goal hasn't started. During the briefing you only read (read, ls, find, web search) and ask. Editing, running commands and starting workers open once the user starts the goal. If the user has told you to go ahead, ask the start question now with ask_user (the goal starts when they pick it): " +
  `kind "choice", with exactly the option labels "${GOAL_START_OPTION}" and "${GOAL_HOLD_OPTION}". Never begin the work before that.`;

/** Error text ask_user returns while Kleio Goals has not spoken yet. */
export const GREET_FIRST_ERROR =
  "Not yet: write to the user first. Greet them and say the goal back in your own words as a normal message, then ask.";

function hasAssistantText(messages: readonly { role: string; content: unknown }[]): boolean {
  return messages.some(
    (m) =>
      m.role === "assistant" &&
      (typeof m.content === "string"
        ? m.content.trim().length > 0
        : Array.isArray(m.content) &&
          m.content.some(
            (part: unknown) =>
              typeof part === "object" &&
              part !== null &&
              (part as { type?: unknown }).type === "text" &&
              typeof (part as { text?: unknown }).text === "string" &&
              (part as { text: string }).text.trim().length > 0,
          )),
  );
}

/**
 * Hold ask_user until Kleio Goals has written something to the user. A question
 * card as the very first thing in a new goal reads as an interrogation, and a
 * card shown before the turn's text would sit above the greeting. Once there
 * is any assistant text (this run or an earlier one), the tool is untouched.
 */
/**
 * Added to the answer that starts the goal. The kickoff told Kleio Goals not to
 * start work in its first reply, and the start question usually rides on that
 * same reply's card: without this it stopped right after the user started the
 * goal (live run, "Add a blog"), and the goal sat idle.
 */
export const GOAL_STARTED_NOTE =
  "\n\nThe goal has started. Start the work now, in this reply: do it yourself, or start workers for its big independent parts.";

/**
 * Kleio Goals' ask_user: never before it has greeted the user, and the answer
 * that starts the goal comes back with GOAL_STARTED_NOTE.
 */
function goalAskUser(
  tools: readonly AgentTool[],
  hasSpoken: () => boolean,
  isActive: () => boolean,
): AgentTool[] {
  return tools.map((tool) =>
    tool.name !== "ask_user"
      ? tool
      : {
          ...tool,
          execute: async (args, context) => {
            if (!hasSpoken()) throw new Error(GREET_FIRST_ERROR);
            const wasActive = isActive();
            const result = await tool.execute(args, context);
            if (wasActive || !isActive()) return result;
            if (typeof result === "string") return result + GOAL_STARTED_NOTE;
            const { content } = result;
            return {
              ...result,
              content:
                typeof content === "string"
                  ? content + GOAL_STARTED_NOTE
                  : [...content, { type: "text", text: GOAL_STARTED_NOTE.trim() }],
            };
          },
        },
  );
}

/**
 * Create a Kleio Goals session. Sessions are stored like coding sessions, keyed by
 * the goal folder, so the goal list and goal deletion find them there.
 */
export function createGoalsAgentSession(options: GoalsAgentOptions): AgentSession {
  const {
    goal,
    extras,
    additionalTools = [],
    isActive = () => false,
    onRunActive,
    ...sessionOptions
  } = options;
  let spokeThisSession = false;
  // The goal is being worked on while Kleio Goals' own loop runs or any worker
  // is still live (a turn can end waiting on its team). Other processes read
  // that from the marker, so a goal this one is running never shows there as
  // interrupted, and is never resumed twice.
  let looping = false;
  const liveWorkers = new Set<string>();
  let release: (() => void) | null = null;
  const syncRunMarker = (): void => {
    const working = looping || liveWorkers.size > 0;
    if (working && !release) release = holdGoalRun(goal.dir);
    else if (!working && release) {
      release();
      release = null;
    }
  };
  // `getMessages()` is the conversation as of the last finished run, so text
  // streamed in the current run is tracked live alongside it.
  const hasSpoken = (): boolean => spokeThisSession || hasAssistantText(session.getMessages());
  const session: AgentSession = new AgentSession({
    ...sessionOptions,
    additionalTools: goalAskUser(additionalTools, hasSpoken, isActive),
    // The goal is static for a session, so its brief belongs in the cached
    // prefix rather than a per-run tail.
    agentPrompt: buildGoalsAgentPrompt(goal, extras),
    // Talks to the user directly, so no sub-agent return contract.
    agentRole: "primary",
    // The goal folder holds notes, not a codebase; attached folders are added
    // as workspace roots and read on demand.
    agentContext: "none",
    promptCacheKeyPrefix: "gggoals",
    onRunActive: (active) => {
      looping = active;
      syncRunMarker();
      onRunActive?.(active);
    },
    // Orchestrating is the job: bringing in workers, steering them and
    // waiting on them must not need a tool_search first.
    coreTools: GOALS_CORE_TOOLS,
    withoutTools: GOALS_WITHOUT_TOOLS,
    // Its own team (goal-team.ts), never Kleio Coder's or the user's agents,
    // and each worker can reach every attached folder, not only its own.
    subAgents: GOAL_TEAM,
    shareRootsWithSubAgents: true,
    // A worker started without naming an agent is still a team member.
    defaultSubAgent: "builder",
    // The team only starts once the user starts the goal. Same tool schemas
    // either way, so the cached tool block never changes.
    wrapTool: (tool) => {
      if (!GOALS_START_TOOLS.has(tool.name)) return tool;
      return {
        ...tool,
        execute: async (args, context) => {
          if (!isActive()) throw new Error(BRIEFING_ERROR);
          return tool.execute(args, context);
        },
      };
    },
  });
  session.eventBus.on("text_delta", ({ text }) => {
    if (text.trim()) spokeThisSession = true;
  });
  session.eventBus.on("subagent_state", (worker) => {
    if (worker.state === "starting" || worker.state === "running") liveWorkers.add(worker.agent_id);
    else liveWorkers.delete(worker.agent_id);
    syncRunMarker();
  });
  // Teardown drops every bus listener, so a worker's last "closed" may never
  // arrive: a disposed session lets go of the goal however it ended.
  const dispose = session.dispose.bind(session);
  session.dispose = async () => {
    try {
      await dispose();
    } finally {
      looping = false;
      liveWorkers.clear();
      syncRunMarker();
    }
  };
  return session;
}
