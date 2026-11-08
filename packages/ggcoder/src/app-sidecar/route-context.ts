import type { AgentSession } from "../core/agent-session.js";
import type { WorkspaceMode, SseClient, HfPullState, SessionContext } from "./session-types.js";
import type { GoalRecord } from "../core/goals-store.js";
import type { RunLifecycle } from "../core/run-lifecycle.js";
import type { AskUserBridge } from "../core/ask-user.js";
import type { effectiveKenModel, KenModelPref } from "../core/ken-model.js";
import type { BackgroundProcess } from "../core/process-manager.js";
import type { GitHubCI } from "../utils/github-ci.js";
import type { ProgressManager } from "./progress-manager.js";
import type { MemoryStore } from "../chat-agents/memory.js";
import type { JiwaStore } from "../chat-agents/jiwa.js";
import type { AppPaths, Dictation, LocalEndpointProbe, LocalEndpoint } from "@kleio/core";
import type { RunClaim } from "../core/run-claim.js";
import type { WorkflowCommandSpec } from "../core/autopilot-gate.js";
import type { Provider } from "@kleio/ai";
import type { AuthStorage } from "../core/auth-storage.js";
import type { AuthProviderMeta, AuthMethod, AuthMethodMeta } from "../core/auth-providers.js";
import type { OAuthLoginCallbacks } from "../core/oauth/types.js";
import type { ElicitationBridge } from "../core/mcp/elicitation-bridge.js";
import type { HfSearchRow } from "../hf-pull.js";
import type { ServeController } from "../modes/serve-mode.js";
import type { AgentTool } from "@kleio/agent";
import type { Routine, RoutineRunner, RoutineStore } from "../routines.js";
import type { KeepAwake } from "../core/keep-awake.js";

/** Closure state of one `createSession` context that the per-session route
 *  handlers read and write. Built in `createSession`; `let` bindings are
 *  exposed as getter/setter pairs so writes land on the closure variable. */
export interface SessionRouteContext {
  session: AgentSession;
  readonly mode: WorkspaceMode;
  chatAgent: "general" | "therapist" | "research";
  running: boolean;
  readonly runLifecycle: RunLifecycle;
  autopilot: boolean;
  readonly asks: AskUserBridge;
  readonly kenStatePayload: () => ReturnType<typeof effectiveKenModel>;
  readonly footerExtras: () => {
    contextWindow: number;
    gitBranch: string | null;
    isGitRepo: boolean;
    gitDirtyFileCount: number;
    gitHubIssues: number | null;
    gitHubPRs: number | null;
    gitHubRepoUrl: string | null;
    gitHubCI: GitHubCI | null;
    tasks: ReturnType<() => BackgroundProcess[]>;
    additionalRoots: string[];
  };
  readonly progress: ProgressManager;
  readonly memoryStore: MemoryStore;
  readonly jiwaStore: JiwaStore;
  clientSeq: number;
  readonly clients: Set<SseClient>;
  autopilotActive: boolean;
  readonly paths: AppPaths;
  readonly host: "127.0.0.1";
  readonly cwd: string;
  historyImages: Map<string, { data: string; mediaType: string }>;
  readonly runClaim: RunClaim;
  /** This window session's daemon id. */
  readonly sessionId: string;
  /** Ids of every live window session whose cwd is `cwd`, this one included. */
  readonly sessionIdsAt: (cwd: string) => string[];
  /** Whether any live window session in `cwd` is working right now (see goal list status). */
  readonly busyAt: (cwd: string) => boolean;
  /** Set when this session's cwd is a Goal folder; null for every other session. */
  goal: { dir: string; record: GoalRecord } | null;
  readonly broadcast: (type: string, data: unknown) => void;
  readonly loadWorkflowCommandSpecs: () => Promise<WorkflowCommandSpec[]>;
  autopilotCancelled: boolean;
  readonly clearPendingPlan: () => void;
  readonly runAgent: (
    label: string,
    run: () => Promise<void>,
    reviewPending?: () => boolean,
  ) => Promise<void>;
  pendingPlanPath: string | null;
  readonly runAutopilotCycle: (originalRequest: string) => Promise<void>;
  readonly runStrandedQueue: () => Promise<void>;
  kenRunning: boolean;
  readonly ensureKenSession: () => Promise<AgentSession>;
  gitBranch: string | null;
  injectedAutopilotPrompts: string[];
  readonly broadcastError: (
    type: "error" | "ken_error" | "autopilot_error",
    logLabel: string,
    err: unknown,
  ) => void;
  pendingKenModel: { provider: Provider; model: string } | null;
  readonly syncKenModel: (provider: Provider, model: string) => Promise<void>;
  kenAbort: AbortController;
  kenSession: AgentSession | null;
  readonly dictation: Dictation;
  readonly runTasks: (startId: string | null, all: boolean) => Promise<void>;
  readonly auth: AuthStorage;
  localProbes: LocalEndpointProbe[];
  readonly localModelBlocker: (modelId: string) => Promise<string | undefined>;
  readonly learnServedContext: (modelId: string, load: boolean) => Promise<void>;
  /** Starts a goal in its briefing when the user's message says to. */
  readonly startGoalFromMessage: (text: string) => Promise<void>;
  kenModelOverride: KenModelPref | null;
  readonly syncKenAutoModel: (provider: Provider, model: string) => Promise<void>;
  autopilotReviewing: boolean;
  taskRunAll: boolean;
  /** The current run was fired by a routine: nobody is watching, short ask deadline. */
  scheduledRunActive: boolean;
  readonly keepAwake: KeepAwake;
  kenAutoAbort: AbortController;
  kenAutoSession: AgentSession | null;
  pendingCancelDrain: { generation: number; text: string } | null;
  readonly CANCEL_TIMEOUT_MS: 5000;
  readonly deactivateApprovedPlan: () => void;
  /** Open the human plan review box once everything has settled. */
  readonly offerPendingPlan: () => void;
  /** Put the session back in read-only plan mode before a plan revision. */
  readonly reenterPlanModeForRevision: () => Promise<void>;
  /** The plan the review box should show now (`-1`: ignore earlier offers). */
  readonly pendingPlanForHuman: (
    offeredGeneration: number,
  ) => { planPath: string; content: string } | null;
  readonly activateApprovedPlan: (planPath: string | undefined) => Promise<number>;
  readonly planProgressPayload: () => { total: number; completed: number[] };
  readonly authStatusPayload: () => Promise<{
    providers: (AuthProviderMeta & {
      connected: boolean;
      connectedMethods: AuthMethod[];
      activeMethod?: AuthMethod;
      oauthExhaustedUntil?: number;
      priorityNote?: string;
      methodGuidance: AuthMethodMeta[];
    })[];
    localConnected: boolean;
  }>;
  readonly broadcastAll: (type: string, data: unknown) => void;
  oauthInFlight: boolean;
  readonly oauthInFlightProviders: Set<string>;
  readonly authCallbacks: () => OAuthLoginCallbacks;
  pendingCode: ((code: string) => void) | null;
  readonly elicitations: ElicitationBridge;
  readonly localStatePayload: () => {
    endpoints: {
      id: string;
      label: string;
      baseUrl: string;
      kind: LocalEndpoint["kind"];
      custom: boolean;
      reachable: boolean;
      reason?: string;
      models: {
        id: string;
        rawId: string;
        contextWindow: number;
        contextWindowKnown: boolean;
        supportsTools: boolean;
        supportsImages: boolean;
        supportsThinking: boolean;
        loaded?: boolean;
      }[];
    }[];
  };
  readonly scanLocalModels: (force: boolean) => Promise<LocalEndpointProbe[]>;
  hfPull: HfPullState | null;
  readonly hfPullPayload: (s: HfPullState) => Record<string, unknown>;
  readonly hfSearch: (query: string) => Promise<HfSearchRow[]>;
  readonly startHfPull: (repo: string) => Promise<Record<string, unknown>>;
  readonly cancelHfPull: () => boolean;
  serveController: ServeController | null;
}

/** Daemon-wide state the fork's daemon-level route handlers read. Built in
 *  `main`; every field is a `const` there. */
export interface DaemonRouteContext {
  readonly auth: AuthStorage;
  readonly sessions: Map<string, SessionContext>;
  readonly paths: AppPaths;
  readonly host: "127.0.0.1";
  readonly memoryStore: MemoryStore;
  readonly jiwaStore: JiwaStore;
  readonly brainTools: AgentTool[];
  readonly dictation: Dictation;
  readonly routinesPayload: () => { routines: Routine[] };
  readonly routineRunner: RoutineRunner;
  readonly routineStore: RoutineStore;
  readonly broadcastAll: (type: string, data: unknown) => void;
  readonly keepAwake: KeepAwake;
}
