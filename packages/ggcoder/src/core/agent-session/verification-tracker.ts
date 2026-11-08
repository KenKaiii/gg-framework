import type { AgentToolCallEndEvent, AgentToolCallStartEvent } from "@kleio/agent";
import type { BackgroundProcess } from "../process-manager.js";
import {
  isCheckOwnFile,
  isCodeFilePath,
  isVerificationCommand,
  type VerificationGate,
} from "../verification-gate.js";
import { classifyVerificationCommand, extractStandaloneCheck } from "../verification-evidence.js";
import { captureVerificationSnapshot } from "../verification-snapshot.js";
import { resolveShell } from "../shell.js";
import { autoBackgroundedId, REVIEW_REJECTED_BEFORE_START } from "../../tools/bash.js";
import { editTargetPaths } from "../../tools/edit-targets.js";

/** A tool call observed between its start and end events. */
export interface TrackedToolCall {
  name: string;
  args: Record<string, unknown>;
  revision: number;
  sourceSnapshot?: string | null;
}

interface SnapshotCheck {
  command: string;
  revision: number;
  sourceSnapshot?: string | null;
}

interface BackgroundCheck {
  revision: number;
  command: string;
  sourceSnapshot?: string | null;
}

/** A check the model ran inside a command whose exit status could not count. */
export interface RefusedCheck {
  /** The check alone, in a form that counts on its own (`cd app && npm test`). */
  command: string;
  /** Source revision when the model's command finished. */
  revision: number;
}

/**
 * Host-observed verification evidence: which files this run mutated, which
 * tool calls are in flight (with their pre-run workspace snapshot), and which
 * background checks still owe an exit code. Feeds the session's
 * {@link VerificationGate}; persistence stays with the session.
 */
export class VerificationTracker {
  private readonly fileEditCounts = new Map<string, number>();
  private readonly toolCalls = new Map<string, TrackedToolCall>();
  private readonly backgroundVerification = new Map<string, BackgroundCheck>();
  private refusedCheck: RefusedCheck | null = null;

  /** The bash tool runs under bash with pipefail (not the Windows cmd.exe
   *  fallback), so checks with read-only commands around them may count. */
  private readonly posixShell: boolean;

  constructor(
    private readonly gate: VerificationGate,
    private readonly cwd: string,
    private readonly listProcesses: () => BackgroundProcess[],
    private readonly isPlanMode: () => boolean = () => false,
    posixShell = !resolveShell("").isCmdFallback,
  ) {
    this.posixShell = posixShell;
  }

  private classify(command: string) {
    return classifyVerificationCommand(command, { posixShell: this.posixShell });
  }

  recordFileMutated(relative: string): void {
    this.fileEditCounts.set(relative, (this.fileEditCounts.get(relative) ?? 0) + 1);
  }

  /** Per-run reset of mutated files and in-flight calls. */
  resetRun(): void {
    this.fileEditCounts.clear();
    this.toolCalls.clear();
    this.refusedCheck = null;
  }

  /**
   * The check to re-run when a turn would end unverified: the last one the
   * model ran this run inside a command that could not count (`npm test 2>&1 |
   * tail; node -e '…'`), provided nothing was edited since and no other
   * evidence is still in flight. It recovers a check the model already ran;
   * it never adds one the model skipped. Returned once.
   */
  takeRefusedCheck(): RefusedCheck | null {
    const pending = this.refusedCheck;
    this.refusedCheck = null;
    if (!pending || pending.revision !== this.gate.revision) return null;
    const inFlight =
      this.backgroundVerification.size > 0 ||
      [...this.toolCalls.values()].some((call) => call.sourceSnapshot !== undefined);
    return !inFlight && this.gate.verificationProblem() !== null ? pending : null;
  }

  /** Fold in the host's re-run of a {@link takeRefusedCheck} result. A pass
   *  counts like any standalone check at that revision. A failure only stays
   *  unverified: the re-run lacks the original command's context (variables,
   *  files it wrote first), so it is no proof the model's run failed. */
  recordRefusedCheckRerun(check: RefusedCheck, passed: boolean): void {
    if (passed) {
      this.gate.recordVerification(check.revision, check.command);
    } else {
      this.gate.recordRejectedCheck(
        check.command,
        "Kleio re-ran this check on its own and it did not pass",
      );
    }
  }

  /** Drop background checks whose process no longer exists. */
  pruneBackground(liveProcessIds: ReadonlySet<string>): void {
    for (const id of this.backgroundVerification.keys()) {
      if (!liveProcessIds.has(id)) this.backgroundVerification.delete(id);
    }
  }

  clearBackground(): void {
    this.backgroundVerification.clear();
  }

  getToolCall(toolCallId: string): TrackedToolCall | undefined {
    return this.toolCalls.get(toolCallId);
  }

  /** Track a starting call. Resolves true when verification state must be persisted. */
  async recordToolCallStart(event: AgentToolCallStartEvent): Promise<boolean> {
    const tracked: TrackedToolCall = {
      name: event.name,
      args: event.args ?? {},
      revision: this.gate.revision,
    };
    this.toolCalls.set(event.toolCallId, tracked);
    const startClassification =
      event.name === "bash" && typeof event.args?.command === "string"
        ? this.classify(event.args.command)
        : null;
    if (
      startClassification &&
      typeof event.args?.command === "string" &&
      (isVerificationCommand(event.args.command) ||
        startClassification.accepted ||
        // Must match the tool_call_end predicate: a snapshot-eligible
        // command that never captured a "before" snapshot is misread at
        // the end as an uncomparable workspace and re-arms the gate.
        startClassification.snapshotEligible === true)
    ) {
      // A check that can rewrite files (--fix, build scripts, emitters)
      // invalidates earlier in-flight evidence AND marks the run as
      // touched. A check that is merely UNRECOGNIZED (`make test`, `deno
      // test`) rewrites nothing we can point to: bumping the revision for
      // it poisoned the gate on green output and re-armed the hook into
      // every later question turn.
      this.gate.recordVerificationAttempt();
      const classification = startClassification;
      if (classification.snapshotEligible && event.args.persist !== true) {
        const call = tracked;
        call.sourceSnapshot = await captureVerificationSnapshot(this.cwd, [
          ...this.fileEditCounts.keys(),
        ]);
        if (call.sourceSnapshot === null) this.gate.requireFreshVerification(true);
      } else if (
        (classification.accepted && event.args.persist !== true) ||
        (!classification.accepted && classification.mayMutate)
      ) {
        // Flag the workspace unknown only when tool_call_end can resolve
        // it: a bounded check records pass/fail, a file-rewriting command
        // bumps the revision. An unrecognized read-only check (`biome ci`)
        // or a persistent-shell run records nothing at the end, so
        // flagging it left verified work Unverified forever — and
        // autopilot silently refused every later turn.
        this.gate.requireFreshVerification(!classification.accepted && classification.mayMutate);
      }
      return true;
    }
    return false;
  }

  /**
   * Fold a finished call into the gate. Only host-observed successful
   * mutations and trustworthy check results affect approval. The model's text
   * is never evidence. Resolves true when verification state changed.
   */
  async recordToolCallEnd(
    event: AgentToolCallEndEvent,
    call: TrackedToolCall | undefined,
  ): Promise<boolean> {
    const name = call?.name ?? "";
    const args = call?.args;
    let verificationChanged = false;
    // In plan mode write/edit can only touch `.gg/plans/*.md`; a code-file
    // write there was refused (refusals return text, not isError). Counting
    // it as a change left "unverified" work that blocked plan approval.
    if (!event.isError && args && !this.isPlanMode()) {
      if (name === "edit" || name === "write") {
        // Check-owning files (tsconfig.json, pytest.ini, vitest.config.ts …)
        // are tracked even when they are not source code: editing one
        // invalidates earlier check results. A multi-file edit records every file.
        for (const filePath of editTargetPaths(args as Record<string, unknown>)) {
          if (isCodeFilePath(filePath) || isCheckOwnFile(filePath)) {
            this.gate.recordMutation(filePath);
            verificationChanged = true;
          }
        }
      }
    }
    if (args && call && name === "bash") {
      const command = typeof args.command === "string" ? args.command : "";
      const classification = this.classify(command);
      if (args.review === true && event.result === REVIEW_REJECTED_BEFORE_START) {
        // The core tool rejected its arguments BEFORE spawning. Never mint
        // a pass, or poison the failed-check ledger with an unexecuted check.
        // A child's output cannot match: bash always prefixes it with Exit code.
        this.gate.recordRejectedCheck(command, REVIEW_REJECTED_BEFORE_START);
        delete call.sourceSnapshot;
        verificationChanged = true;
      } else if (classification.accepted || classification.snapshotEligible) {
        // A foreground check that outlived the default budget was moved to
        // the background, not failed: track it to its real exit the same way.
        const autoBackgroundId = event.isError ? undefined : autoBackgroundedId(event.result);
        if (
          (autoBackgroundId !== undefined || args.run_in_background === true) &&
          !event.isError &&
          args.persist !== true
        ) {
          const id = autoBackgroundId ?? /^ID:\s*(\S+)/m.exec(event.result)?.[1];
          // No parseable ID means the check cannot be tracked to a real exit
          // code — no evidence either way. Recording a FAILURE here made
          // every later green run of a different spelling look owed.
          if (id)
            this.backgroundVerification.set(id, {
              revision: call.revision,
              command,
              ...(classification.snapshotEligible
                ? { sourceSnapshot: call.sourceSnapshot ?? null }
                : {}),
            });
          else if (classification.snapshotEligible) this.gate.requireFreshVerification(true);
        } else if (args.persist === true) {
          // Persistent-shell checks are not bounded evidence (steering can
          // interleave): neither a pass nor a failure. A recorded failure
          // here blocked approval for sessions that prefer the shell.
        } else if (classification.snapshotEligible) {
          await this.finishSnapshotVerification(
            { command, revision: call.revision, sourceSnapshot: call.sourceSnapshot ?? null },
            !event.isError && /^Exit code:\s*0(?:\s|$)/i.test(event.result.trim()),
          );
          verificationChanged = true;
        } else {
          if (!event.isError && /^Exit code:\s*0(?:\s|$)/i.test(event.result.trim())) {
            this.gate.recordVerification(call.revision, command);
          } else {
            this.gate.recordFailedVerification(command, call.revision);
          }
          verificationChanged = true;
        }
        delete call.sourceSnapshot;
      } else if (classification.candidate) {
        // Green but untrusted: remember WHY so the demand can tell the
        // agent which command shape actually clears the gate.
        this.gate.recordRejectedCheck(command, classification.reason);
      }
      if (classification.accepted) {
        this.refusedCheck = null;
      } else if (!event.isError && args.persist !== true && args.run_in_background !== true) {
        const check = extractStandaloneCheck(command);
        if (check) this.refusedCheck = { command: check, revision: this.gate.revision };
      }
    }
    if (!event.isError && args && name === "task_output" && typeof args.id === "string") {
      verificationChanged =
        (await this.recordFinishedBackgroundVerification(args.id)) || verificationChanged;
    }
    return verificationChanged;
  }

  /** Settle every background check whose process has exited. Resolves true if any changed. */
  async settleFinishedBackground(): Promise<boolean> {
    let backgroundChanged = false;
    for (const id of this.backgroundVerification.keys()) {
      backgroundChanged =
        (await this.recordFinishedBackgroundVerification(id)) || backgroundChanged;
    }
    return backgroundChanged;
  }

  /** In-flight or unconfirmed evidence, else the gate's own problem. */
  verificationProblem(): string | null {
    if ([...this.toolCalls.values()].some((call) => call.sourceSnapshot !== undefined)) {
      return "Unverified: a build is still running or its workspace comparison is pending.";
    }
    return (
      this.gate.verificationProblem() ??
      (this.backgroundVerification.size > 0
        ? "Unverified: a background check is still running or its result has not been confirmed."
        : null)
    );
  }

  private async recordFinishedBackgroundVerification(id: string): Promise<boolean> {
    const started = this.backgroundVerification.get(id);
    const proc = this.listProcesses().find((entry) => entry.id === id);
    if (!started || !proc || proc.exitCode === null) return false;
    if (started.sourceSnapshot !== undefined) {
      await this.finishSnapshotVerification(started, proc.exitCode === 0);
    } else if (proc.exitCode === 0) {
      this.gate.recordVerification(started.revision, started.command);
    } else {
      this.gate.recordFailedVerification(started.command, started.revision);
    }
    this.backgroundVerification.delete(id);
    return true;
  }

  private async finishSnapshotVerification(check: SnapshotCheck, passed: boolean): Promise<void> {
    const after = check.sourceSnapshot
      ? await captureVerificationSnapshot(this.cwd, [...this.fileEditCounts.keys()])
      : null;
    const classification = this.classify(check.command);
    const recordFailure = (revision?: number): void => {
      if (classification.ambiguousFailure) {
        this.gate.recordRejectedCheck(
          check.command,
          "exit status cannot tell a failed check from a failed read-only command",
        );
      } else if (revision === undefined) {
        this.gate.recordFailedVerification(check.command);
      } else {
        this.gate.recordFailedVerification(check.command, revision);
      }
    };
    if (after === null || after !== check.sourceSnapshot) {
      this.gate.requireFreshVerification(true);
      this.gate.recordRejectedCheck(
        check.command,
        after === null
          ? "Workspace inputs could not be compared; run a read-only check after the command"
          : "Command changed workspace inputs; run checks against the changed source",
      );
      if (!passed) recordFailure();
    } else if (passed) {
      if (classification.snapshotPreserveOnly) {
        this.gate.recordRejectedCheck(check.command, classification.reason);
      } else {
        this.gate.recordVerification(check.revision, check.command);
      }
    } else {
      recordFailure(check.revision);
    }
  }
}
