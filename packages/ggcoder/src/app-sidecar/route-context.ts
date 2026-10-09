import type { JiwaStore } from "../chat-agents/jiwa.js";
import type { MemoryStore } from "../chat-agents/memory.js";
import type { AgentSession } from "../core/agent-session.js";
import type { AskUserBridge } from "../core/ask-user.js";
import type { AuthMethod, AuthMethodMeta, AuthProviderMeta } from "../core/auth-providers.js";
import type { WorkflowCommandSpec } from "../core/autopilot-gate.js";
import type { EffectiveKenModel, KenModelPref } from "../core/ken-model.js";
import type { ElicitationBridge } from "../core/mcp/elicitation-bridge.js";
import type { BackgroundProcess } from "../core/process-manager.js";
import type { RunClaim } from "../core/run-claim.js";
import type { RunLifecycle } from "../core/run-lifecycle.js";
import type { HfSearchRow } from "../hf-pull.js";
import type { ServeController } from "../modes/serve-mode.js";
import type { GitHubCI } from "../utils/github-ci.js";
import type { ProjectHealth } from "../core/project-health-score.js";
import type { ProgressManager } from "./progress-manager.js";
import type { HfPullState, SseClient, WorkspaceMode } from "./session-types.js";
import type { Provider } from "@kenkaiiii/gg-ai";
import type {
  AppPaths,
  AuthStorage,
  LocalEndpointKind,
  LocalEndpointProbe,
  OAuthLoginCallbacks,
} from "@kenkaiiii/gg-core";

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
  readonly kenStatePayload: () => EffectiveKenModel;
  readonly footerExtras: () => {
    contextWindow: number;
    gitBranch: string | null;
    isGitRepo: boolean;
    gitDirtyFileCount: number;
    gitHubIssues: number | null;
    gitHubPRs: number | null;
    gitHubRepoUrl: string | null;
    gitHubCI: GitHubCI | null;
    projectHealth: ProjectHealth | null;
    tasks: BackgroundProcess[];
    additionalRoots: string[];
  };
  readonly progress: ProgressManager;
  readonly memoryStore: MemoryStore;
  readonly jiwaStore: JiwaStore;
  clientSeq: number;
  readonly clients: Set<SseClient>;
  autopilotActive: boolean;
  readonly pendingPlanForHuman: (
    offeredGeneration: number,
  ) => { planPath: string; content: string } | null;
  readonly paths: AppPaths;
  readonly host: string;
  readonly cwd: string;
  readonly asks: AskUserBridge;
  readonly runClaim: RunClaim;
  readonly broadcast: (type: string, data: unknown) => void;
  scheduledRunActive: boolean;
  readonly loadWorkflowCommandSpecs: () => Promise<WorkflowCommandSpec[]>;
  autopilotCancelled: boolean;
  readonly clearPendingPlan: () => void;
  readonly runAgent: (
    label: string,
    run: () => Promise<void>,
    reviewPending?: () => boolean,
  ) => Promise<void>;
  readonly reenterPlanModeForRevision: () => Promise<void>;
  pendingPlanPath: string | null;
  readonly runAutopilotCycle: (originalRequest: string) => Promise<void>;
  readonly runStrandedQueue: () => Promise<void>;
  readonly offerPendingPlan: () => void;
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
  readonly runTasks: (startId: string | null, all: boolean) => Promise<void>;
  readonly auth: AuthStorage;
  localProbes: LocalEndpointProbe[];
  readonly localModelBlocker: (modelId: string) => Promise<string | undefined>;
  kenModelOverride: KenModelPref | null;
  readonly syncKenAutoModel: (provider: Provider, model: string) => Promise<void>;
  autopilotReviewing: boolean;
  taskRunAll: boolean;
  kenAutoAbort: AbortController;
  kenAutoSession: AgentSession | null;
  pendingCancelDrain: { generation: number; text: string } | null;
  readonly CANCEL_TIMEOUT_MS: number;
  readonly deactivateApprovedPlan: () => void;
  readonly activateApprovedPlan: (planPath: string | undefined) => Promise<number>;
  readonly planProgressPayload: () => { total: number; completed: number[] };
  readonly authStatusPayload: () => Promise<{
    providers: (AuthProviderMeta & {
      connected: boolean;
      connectedMethods: AuthMethod[];
      activeMethod?: AuthMethod | undefined;
      oauthExhaustedUntil?: number | undefined;
      priorityNote?: string | undefined;
      methodGuidance: AuthMethodMeta[];
    })[];
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
      kind: LocalEndpointKind;
      custom: boolean;
      reachable: boolean;
      reason?: string | undefined;
      models: {
        id: string;
        rawId: string;
        contextWindow: number;
        contextWindowKnown: boolean;
        supportsTools: boolean;
        supportsImages: boolean;
        supportsThinking: boolean;
        loaded?: boolean | undefined;
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
