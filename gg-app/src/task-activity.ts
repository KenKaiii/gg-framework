import type { SidecarEvent } from "./agent";

export type TaskPhase =
  "idle" | "working" | "reviewing" | "attention" | "done" | "unverified" | "failed" | "stopped";
export interface TaskActivity {
  phase: TaskPhase;
  label: string;
  detail: string;
  startedAt: number | null;
  endedAt: number | null;
  tokens: number;
  runTokens: number;
  changed: boolean;
  reviewed: boolean;
  reviewPending: boolean;
  verification: "passed" | "failed" | "incomplete" | "not_recorded";
  verifiedChecks: number;
  project: string | null;
  pendingPlan: boolean;
  decisionToolId: string | null;
  mutationTools: string[];
  reviewNote: string;
  waitingForAnswer: boolean;
  phraseCounts: Record<string, number>;
  cancelling: boolean;
  connectionLost: boolean;
  interrupted: boolean;
  planRemaining: number;
  pendingAgents: string[];
  codeChanged: boolean;
  scopedVerification: boolean;
  workspaceWarning: string;
  workKind: "answer" | "research" | "tools" | "background";
  activeTools: Record<string, { name: string; background: boolean }>;
}
export const INITIAL_ACTIVITY: TaskActivity = {
  phase: "idle",
  label: "Ready for work",
  detail: "",
  startedAt: null,
  endedAt: null,
  tokens: 0,
  runTokens: 0,
  changed: false,
  reviewed: false,
  reviewPending: false,
  verification: "not_recorded",
  verifiedChecks: 0,
  project: null,
  pendingPlan: false,
  decisionToolId: null,
  mutationTools: [],
  reviewNote: "",
  waitingForAnswer: false,
  phraseCounts: {},
  cancelling: false,
  connectionLost: false,
  interrupted: false,
  planRemaining: 0,
  pendingAgents: [],
  codeChanged: false,
  scopedVerification: false,
  workspaceWarning: "",
  workKind: "answer",
  activeTools: {},
};

// Rotate on a new activity span, never on each streamed token. Each pool
// describes the same observed activity; outcomes deliberately keep fixed wording.
const PROGRESS_PHRASES: Record<string, readonly string[]> = {
  "Thinking…": ["Thinking…", "Thinking it through…", "Reasoning through the next step…"],
  "Working on your request…": [
    "Working on your request…",
    "Working through your request…",
    "Continuing with your request…",
  ],
  "Writing a response…": [
    "Writing a response…",
    "Putting the response into words…",
    "Composing the response…",
  ],
  "Reading the relevant code…": [
    "Reading the relevant code…",
    "Looking through the code…",
    "Examining the code…",
  ],
  "Making the changes…": ["Making the changes…", "Editing the code…", "Applying the changes…"],
  "Checking references…": [
    "Checking references…",
    "Looking up references…",
    "Consulting reference material…",
  ],
  "Running checks…": ["Running checks…", "Checking the changes…", "Running verification…"],
  "Running a command…": [
    "Running a command…",
    "Executing a command…",
    "Working through a command…",
  ],
};

function progressLabel(s: TaskActivity, base: string): TaskActivity {
  const phrases = PROGRESS_PHRASES[base];
  if (!phrases) return { ...s, label: base };
  if (phrases.includes(s.label)) return s;
  const count = s.phraseCounts[base] ?? 0;
  return {
    ...s,
    label: phrases[count % phrases.length]!,
    phraseCounts: { ...s.phraseCounts, [base]: count + 1 },
  };
}

const finiteCount = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
const reason = (d: Record<string, unknown>, fallback: string): string =>
  typeof d.reason === "string" && d.reason.trim() ? d.reason.slice(0, 2000) : fallback;

function finish(s: TaskActivity, now: number): TaskActivity {
  if (["failed", "stopped", "attention"].includes(s.phase)) return { ...s, reviewPending: false };
  const reviewed = s.reviewed ? "Ken reviewed this task." : "Ken did not review this task.";
  if (s.verification === "failed")
    return {
      ...s,
      phase: "failed",
      label: "Checks failed",
      detail: `${s.detail || "A recorded check failed."} Review the failed checks in chat before continuing.`,
      endedAt: now,
      reviewPending: false,
    };
  if (s.interrupted || s.planRemaining > 0 || (s.pendingAgents?.length ?? 0) > 0) {
    return {
      ...s,
      phase: "unverified",
      endedAt: now,
      reviewPending: false,
      label: s.interrupted
        ? "Response incomplete"
        : s.planRemaining > 0
          ? "Plan incomplete"
          : "Agents still running",
    };
  }
  // Only the host's "incomplete" (an Autopilot cycle's check) is unverified.
  // A plain reply leaves checks to the commit, so unchecked edits are saved
  // work, not a warning; a check that ran and failed was handled above.
  if (s.verification === "incomplete")
    return {
      ...s,
      phase: "unverified",
      label: s.changed ? "Changed · verification incomplete" : "Verification incomplete",
      endedAt: now,
      reviewPending: false,
      detail: `${s.detail || "No passing automated check was recorded for the current changes."} ${reviewed} Review what remains unchecked in chat.`,
    };
  return {
    ...s,
    phase: "done",
    label:
      s.verification === "passed"
        ? "Done · checks passed"
        : s.changed
          ? "Changes saved"
          : s.workKind === "background"
            ? "Background work started"
            : s.workKind === "research"
              ? "Findings ready"
              : s.workKind === "tools"
                ? "Tool work finished"
                : "Response ready",
    endedAt: now,
    reviewPending: false,
    detail: `${s.verification === "passed" ? `${s.verifiedChecks} passing check${s.verifiedChecks === 1 ? "" : "s"} recorded for the current code.` : "No automated checks were recorded."} ${reviewed} ${s.reviewNote ? `${s.reviewNote} ` : ""}Review the result in chat. This status does not confirm a release.`,
  };
}

function toolPhase(name: string, args: Record<string, unknown>): string {
  if (["read", "grep", "find", "ls", "code_search", "code_nav", "source_path"].includes(name))
    return "Reading the relevant code…";
  if (["edit", "write"].includes(name)) return "Making the changes…";
  if (["web_search", "web_fetch", "steroids"].includes(name)) return "Checking references…";
  if (["subagent", "spawn_agent", "wait_agent"].includes(name)) return "Coordinating agent work…";
  if (name === "screenshot") return "Inspecting the app…";
  if (name === "debug") return "Stepping through the code…";
  if (name === "bash")
    return typeof args.command === "string" &&
      /^(?:(?:pnpm|npm|yarn|bun)\s+(?:exec\s+|run\s+)?(?:test|check|lint|build|vitest)|(?:pytest|tsc|vitest)\b)/.test(
        args.command.trim(),
      )
      ? "Running checks…"
      : "Running a command…";
  if (name === "task_output") return "Checking background work…";
  return "Working on your request…";
}

const PROGRESS_EVENTS = new Set([
  "thinking_delta",
  "text_delta",
  "tool_call_start",
  "server_tool_call",
  "retry",
  "hook",
  "compaction_start",
  "compaction_end",
  "ask_user",
  "plan_exit",
  "autopilot_review_start",
  "autopilot_prompted",
  "autopilot_plan_accepted",
  "autopilot_done",
  "autopilot_ignored",
  "autopilot_human",
  "autopilot_capped",
  "autopilot_error",
]);

/** Only event/evidence fields set outcomes. Assistant prose never determines success. */
export function reduceTaskActivity(s: TaskActivity, e: SidecarEvent, now: number): TaskActivity {
  const d = e.data as Record<string, unknown>;
  const settled = s.endedAt !== null && !s.reviewPending;
  if (PROGRESS_EVENTS.has(e.type) && (settled || s.cancelling || s.connectionLost)) return s;
  if (
    settled &&
    (e.type === "run_end" ||
      e.type === "run_cancelling" ||
      e.type === "cancel_failed" ||
      (e.type === "run_start" && d.continued === true))
  )
    return s;
  switch (e.type) {
    case "connection_lost":
      return s.phase === "working" || s.phase === "reviewing"
        ? { ...s, connectionLost: true, label: "Reconnecting…" }
        : s;
    case "retry":
      return s.phase === "working" && !s.waitingForAnswer && d.silent !== true
        ? { ...s, label: "Retrying…" }
        : s;
    case "server_tool_call":
      return s.phase === "working" && !s.waitingForAnswer
        ? progressLabel(s, toolPhase(String(d.name ?? ""), {}))
        : s;
    case "truncated":
    case "max_turns":
      return !settled && s.startedAt !== null
        ? {
            ...s,
            interrupted: d.continued !== true,
            label: d.continued === true ? "Continuing…" : "Response incomplete",
          }
        : s;
    case "plan_progress": {
      const total = finiteCount(d.total);
      const completed = new Set(
        Array.isArray(d.completed)
          ? d.completed.filter(
              (step): step is number =>
                typeof step === "number" && Number.isInteger(step) && step >= 1 && step <= total,
            )
          : [],
      );
      return { ...s, planRemaining: total - completed.size };
    }
    case "subagent_state": {
      if (s.startedAt === null || typeof d.agent_id !== "string") return s;
      const pending = (s.pendingAgents ?? []).filter((id) => id !== d.agent_id);
      if (d.state === "starting" || d.state === "running") pending.push(d.agent_id);
      return {
        ...s,
        pendingAgents: pending,
        label:
          s.phase === "working" && !s.cancelling && !s.connectionLost && !s.waitingForAnswer
            ? pending.length > 0
              ? "Agents working…"
              : "Reviewing agent results…"
            : s.label === "Agents still running" && pending.length === 0
              ? "Review agent results"
              : s.label,
      };
    }
    case "ready": {
      const project = typeof d.cwd === "string" ? d.cwd : s.project;
      if (project !== s.project) {
        s = { ...INITIAL_ACTIVITY, project };
        if (d.running === true)
          return {
            ...s,
            phase: "working",
            label: "Working on your request…",
            startedAt: now,
          };
      }
      if (d.reviewPending === true && d.running !== true) {
        return {
          ...s,
          project,
          phase: "reviewing",
          label: "Ken reviewing…",
          reviewPending: true,
          connectionLost: false,
          endedAt: null,
          startedAt: s.startedAt ?? now,
        };
      }
      if (d.running === true && (settled || s.phase === "idle")) {
        return {
          ...INITIAL_ACTIVITY,
          project,
          phase: "working",
          label: "Working on your request…",
          startedAt: now,
        };
      }
      if (s.connectionLost && d.running === true) {
        return {
          ...s,
          connectionLost: false,
          label: s.cancelling ? "Stopping the task…" : "Working on your request…",
        };
      }
      if (d.running === false && ["working", "reviewing"].includes(s.phase))
        return {
          ...s,
          phase: "stopped",
          label: "Reconnected · review latest result",
          connectionLost: false,
          detail: "The run ended while disconnected. Check the latest result in chat.",
          endedAt: now,
          reviewPending: false,
        };
      return s;
    }
    case "session_reset":
      return s.reviewPending && typeof d.planTotal === "number"
        ? s
        : { ...INITIAL_ACTIVITY, project: s.project };
    case "run_start": {
      const continuation = d.continued === true && s.startedAt !== null;
      const wording = continuation
        ? s
        : progressLabel({ ...s, label: "" }, "Working on your request…");
      return {
        ...(continuation ? s : { ...INITIAL_ACTIVITY, project: s.project }),
        phase: "working",
        label: continuation ? "Applying Ken’s corrections…" : wording.label,
        phraseCounts: wording.phraseCounts,
        detail: "",
        startedAt: continuation ? s.startedAt : now,
        endedAt: null,
        runTokens: 0,
        reviewPending: false,
        decisionToolId: null,
        mutationTools: [],
        activeTools: {},
        pendingPlan: false,
        waitingForAnswer: false,
        cancelling: false,
        connectionLost: false,
        interrupted: false,
      };
    }
    case "run_cancelling":
      return { ...s, phase: "working", label: "Stopping the task…", cancelling: true };
    case "cancel_failed":
      return {
        ...s,
        phase: "working",
        label: "Cancellation failed · task still running",
        cancelling: false,
        detail: "Try cancelling again or review the error in chat.",
      };
    case "tool_call_start": {
      if (s.startedAt === null || s.phase === "reviewing") return s;
      const name = String(d.name ?? "");
      if (name === "ask_user")
        return {
          ...s,
          phase: "attention",
          label: "Your decision needed",
          detail: "Answer the question in chat to continue.",
          decisionToolId: typeof d.toolCallId === "string" ? d.toolCallId : null,
          waitingForAnswer: true,
        };
      if (s.waitingForAnswer) return s;
      return {
        ...progressLabel(s, toolPhase(name, (d.args as Record<string, unknown>) ?? {})),
        phase: "working",
        activeTools:
          typeof d.toolCallId === "string"
            ? {
                ...s.activeTools,
                [d.toolCallId]: {
                  name,
                  background:
                    name === "bash" &&
                    (d.args as Record<string, unknown> | undefined)?.run_in_background === true,
                },
              }
            : s.activeTools,
        mutationTools:
          (name === "edit" || name === "write") && typeof d.toolCallId === "string"
            ? [...s.mutationTools, d.toolCallId].slice(-64)
            : s.mutationTools,
      };
    }
    case "ask_user":
      return {
        ...s,
        phase: "attention",
        label: "Your decision needed",
        detail: "Answer the question in chat to continue.",
        waitingForAnswer: true,
      };
    case "tool_call_end": {
      const id = typeof d.toolCallId === "string" ? d.toolCallId : "";
      const tool = s.activeTools[id];
      if (tool) {
        const activeTools = { ...s.activeTools };
        delete activeTools[id];
        const research = [
          "read",
          "grep",
          "find",
          "ls",
          "web_search",
          "web_fetch",
          "code_search",
          "code_nav",
        ].includes(tool.name);
        s = {
          ...s,
          activeTools,
          workKind:
            d.isError === true
              ? s.workKind
              : tool.background
                ? "background"
                : s.workKind === "background"
                  ? s.workKind
                  : research
                    ? "research"
                    : s.workKind === "research"
                      ? s.workKind
                      : "tools",
        };
      }
      if (typeof d.toolCallId === "string" && s.mutationTools.includes(d.toolCallId))
        return {
          ...s,
          changed: s.changed || d.isError !== true,
          mutationTools: s.mutationTools.filter((id) => id !== d.toolCallId),
        };
      return s.decisionToolId !== null && d.toolCallId === s.decisionToolId
        ? {
            ...s,
            phase: "working",
            label:
              d.isError === true
                ? "Question closed · checking next step…"
                : "Continuing with your decision…",
            detail: "",
            decisionToolId: null,
            waitingForAnswer: false,
          }
        : s;
    }
    // A new main-agent response starts only after its blocking tools settle.
    // This also resumes MCP questions, which do not expose an ask_user tool id.
    case "thinking_delta":
    case "text_delta": {
      if (s.phase !== "working" && !s.waitingForAnswer) return s;
      const next = progressLabel(
        s,
        e.type === "thinking_delta" ? "Thinking…" : "Writing a response…",
      );
      return next === s
        ? s
        : { ...next, phase: "working", waitingForAnswer: false, decisionToolId: null };
    }
    case "hook":
      return s.phase === "working"
        ? {
            ...s,
            label: d.kind === "verification" ? "Checking the changes…" : "Reviewing the work…",
          }
        : s;
    case "compaction_start":
      return { ...s, phase: "working", label: "Keeping the task context…" };
    case "compaction_end":
      return s.phase === "working" ? { ...s, label: "Continuing the task…" } : s;
    case "turn_end": {
      const usage = d.usage as { outputTokens?: number } | undefined;
      const n = finiteCount(usage?.outputTokens);
      return n ? { ...s, tokens: s.tokens + n, runTokens: s.runTokens + n } : s;
    }
    case "agent_done": {
      const usage = d.totalUsage as { outputTokens?: number } | undefined;
      const n = Math.max(0, finiteCount(usage?.outputTokens) - s.runTokens);
      return n ? { ...s, tokens: s.tokens + n, runTokens: s.runTokens + n } : s;
    }
    case "autopilot_usage":
      return { ...s, tokens: s.tokens + finiteCount(d.outputTokens) };
    case "run_end": {
      if (d.cancelled === true)
        return {
          ...s,
          phase: "stopped",
          label: "Stopped · unfinished",
          detail: "Some changes may already exist. Review them in chat before continuing.",
          endedAt: now,
          reviewPending: false,
        };
      if (d.failed === true || s.phase === "failed")
        return {
          ...s,
          phase: "failed",
          label: "Task failed",
          detail: s.detail || "Review the error in chat before retrying.",
          endedAt: now,
          reviewPending: false,
        };
      const candidate = d.turnVerification as Record<string, unknown> | undefined;
      const turn =
        candidate &&
        typeof candidate === "object" &&
        typeof candidate.changed === "boolean" &&
        ["passed", "failed", "incomplete", "not_recorded"].includes(String(candidate.verification))
          ? candidate
          : undefined;
      const codeChanged = s.codeChanged || turn?.changed === true;
      // Continue to judge all edits in a Ken correction cycle, but never borrow
      // earlier turns' checks to describe a fresh read-only request.
      const statusData = turn && !codeChanged ? turn : d;
      const verification = ["passed", "failed", "incomplete", "not_recorded"].includes(
        String(statusData.verification),
      )
        ? (statusData.verification as TaskActivity["verification"])
        : d.unverified
          ? "incomplete"
          : "not_recorded";
      const next = {
        ...s,
        codeChanged,
        scopedVerification: !!turn,
        workspaceWarning:
          turn && !codeChanged && verification !== d.verification
            ? d.verification === "failed"
              ? "Earlier checks failed"
              : d.verification === "incomplete" || d.unverified === true
                ? "Earlier work unchecked"
                : ""
            : "",
        verification:
          verification === "passed" && finiteCount(statusData.verifiedChecks) === 0
            ? ("not_recorded" as const)
            : verification,
        verifiedChecks: finiteCount(statusData.verifiedChecks),
        detail:
          turn && !codeChanged && typeof turn.reason === "string"
            ? turn.reason.slice(0, 2000)
            : typeof d.verificationReason === "string"
              ? d.verificationReason.slice(0, 2000)
              : s.phase === "attention"
                ? s.detail
                : "",
      };
      if (s.phase === "attention") return next;
      // A blocked verification gate cannot hand off to Ken, even if an older
      // sidecar optimistically announced a pending review on run_end.
      if (next.verification === "failed" || next.verification === "incomplete")
        return finish(next, now);
      if (s.pendingPlan && d.reviewPending !== true)
        return {
          ...next,
          phase: "attention",
          label: "Plan needs your decision",
          detail: "Review the proposed plan before implementation.",
          endedAt: now,
        };
      return d.reviewPending === true
        ? { ...next, phase: "reviewing", label: "Preparing Ken’s review…", reviewPending: true }
        : finish(next, now);
    }
    case "autopilot_review_start":
      return {
        ...s,
        phase: "reviewing",
        label: "Ken reviewing…",
        reviewPending: true,
        endedAt: null,
        startedAt: s.startedAt ?? now,
      };
    case "autopilot_prompted":
      return {
        ...s,
        phase: "working",
        label: "Applying Ken’s corrections…",
        reviewPending: true,
        endedAt: null,
      };
    case "autopilot_plan_accepted":
      return {
        ...s,
        phase: "working",
        label: "Plan approved · preparing implementation…",
        reviewPending: true,
        endedAt: null,
        pendingPlan: false,
      };
    case "autopilot_done":
      return finish({ ...s, phase: "working", reviewed: true, reviewNote: reason(d, "") }, now);
    case "autopilot_ignored":
      return s.reviewPending
        ? finish(
            { ...s, phase: s.phase === "reviewing" ? "working" : s.phase, reviewed: false },
            now,
          )
        : s;
    case "autopilot_human":
      if (s.verification === "failed" || s.verification === "incomplete") {
        return finish({ ...s, phase: "working", detail: reason(d, s.detail) }, now);
      }
      return {
        ...s,
        phase: "attention",
        label: "Your decision needed",
        detail: reason(d, "Review Ken’s message in chat before continuing."),
        endedAt: now,
        reviewPending: false,
      };
    case "autopilot_capped":
      return {
        ...s,
        phase: "stopped",
        label: "Paused · review limit reached",
        detail:
          "Ken reached the correction limit. Review the remaining work in chat before continuing.",
        endedAt: now,
        reviewPending: false,
      };
    case "autopilot_error":
      return {
        ...s,
        phase: "failed",
        label: "Ken’s review failed",
        detail: "The work was not approved. Review the error in chat before retrying.",
        endedAt: now,
        reviewPending: false,
      };
    case "error":
      return ["working", "reviewing"].includes(s.phase)
        ? {
            ...s,
            phase: "failed",
            label: "Task failed",
            detail:
              typeof d.headline === "string"
                ? d.headline.slice(0, 1000)
                : "Review the error in chat.",
            endedAt: now,
          }
        : s;
    case "plan_exit":
      return { ...s, pendingPlan: true, label: "Plan ready for review…" };
    default:
      return s;
  }
}
