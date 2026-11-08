import {
  evaluateLoopBreak,
  CycleDetector,
  ToolCallProgressTracker,
  detectTextRepetition,
  type CycleDetection,
  type LoopBreakDecision,
} from "../loop-breaker.js";
import {
  MAX_SEMANTIC_LOOP_CALLS,
  shouldRunSemanticLoopCheck,
  type SemanticCallDigest,
  type SemanticLoopVerdict,
} from "../semantic-loop-check.js";
import { TURN_EXTENSION_MAX_FAILURE_RATIO } from "./helpers.js";

/** LLM-judged loop detection state for one run. */
export interface SemanticLoopRunState {
  checksUsed: number;
  lastCheckTurn: number;
  pending: boolean;
  verdict: SemanticLoopVerdict | null;
  injected: boolean;
}

function freshSemanticLoopState(): SemanticLoopRunState {
  return { checksUsed: 0, lastCheckTurn: 0, pending: false, verdict: null, injected: false };
}

/**
 * Per-run stuck-detection state (mirrors the TUI's useAgentLoop refs): tool
 * stats, streamed text, progress/cycle trackers, the two-stage loop-breaker and
 * the semantic loop judge's budget. Reset at the start of every run; observed
 * from the event stream. Owns state and decisions only — logging, events and
 * the judge call stay with the session.
 */
export class RunLoopMonitor {
  stats = { toolCalls: 0, toolFailures: 0, turns: 0 };
  text = "";
  consecutiveFailures = 0;
  repeatedNoProgressCalls = 0;
  readonly progressTracker = new ToolCallProgressTracker();
  readonly cycleDetector = new CycleDetector();
  cyclicPattern: CycleDetection | null = null;
  /** 0 = none; 1 = first nudge sent; 2 = final stop-and-report injected. */
  loopBreakInjected: 0 | 1 | 2 = 0;
  /** Recent tool-call digests for the semantic loop judge — bounded ring. */
  recentCalls: SemanticCallDigest[] = [];
  /** LLM-judged loop detection state. `verdict` holds a LOOP verdict awaiting
   *  injection at the next steering poll; judge failures fail open (no
   *  injection) and still consume budget + cooldown. Replaced (never mutated)
   *  on reset so a late judge from an earlier run cannot write into it. */
  semanticLoop: SemanticLoopRunState = freshSemanticLoopState();

  /** Clean slate for a new run. */
  reset(): void {
    this.stats = { toolCalls: 0, toolFailures: 0, turns: 0 };
    this.text = "";
    this.consecutiveFailures = 0;
    this.repeatedNoProgressCalls = 0;
    this.progressTracker.reset();
    this.cycleDetector.reset();
    this.cyclicPattern = null;
    this.loopBreakInjected = 0;
    this.recentCalls = [];
    this.semanticLoop = freshSemanticLoopState();
  }

  recordText(text: string): void {
    this.text += text;
  }

  recordToolEnd(
    name: string,
    args: Record<string, unknown> | undefined,
    result: string,
    isError: boolean,
  ): void {
    this.stats.toolCalls += 1;
    if (isError) this.stats.toolFailures += 1;
    this.consecutiveFailures = isError ? this.consecutiveFailures + 1 : 0;
    this.repeatedNoProgressCalls = this.progressTracker.record(name, args, result, isError);
    this.cyclicPattern = this.cycleDetector.record(name, args, result, isError);
    // Semantic-loop judge input: a bounded digest of WHAT was attempted and
    // HOW it came out. Args/results are sliced AT RECORD TIME — a write with
    // a 50 KiB payload or a bash dump must never inflate the ring, and the
    // judge needs shapes, not payloads.
    this.recentCalls.push({
      tool: name,
      args: args === undefined ? "" : JSON.stringify(args).slice(0, 300),
      ok: !isError,
      result: result.slice(0, 400),
    });
    if (this.recentCalls.length > MAX_SEMANTIC_LOOP_CALLS) {
      this.recentCalls.splice(0, this.recentCalls.length - MAX_SEMANTIC_LOOP_CALLS);
    }
  }

  recordTurn(turn: number): void {
    this.stats.turns = turn;
  }

  /** Deterministic stuck verdict from the current signals. */
  evaluateLoopBreak(): LoopBreakDecision {
    return evaluateLoopBreak({
      consecutiveFailures: this.consecutiveFailures,
      repeatedNoProgressCalls: this.repeatedNoProgressCalls,
      textRepetitionDetected: detectTextRepetition(this.text),
      ...(this.cyclicPattern ? { cyclicPattern: this.cyclicPattern } : {}),
    });
  }

  /**
   * Two-stage loop-breaker: stage 1 nudges; a FRESH detection after that
   * escalates to stage 2. Returns the stage to inject (signals reset so stage 2
   * only fires on new evidence), or null when nothing should be injected.
   */
  takeLoopBreakStage(decision: LoopBreakDecision): 1 | 2 | null {
    if (this.loopBreakInjected >= 2) return null;
    if (!decision.shouldBreak) return null;
    const stage = this.loopBreakInjected === 0 ? (1 as const) : (2 as const);
    this.loopBreakInjected = stage;
    this.progressTracker.reset();
    this.cycleDetector.reset();
    this.cyclicPattern = null;
    this.consecutiveFailures = 0;
    this.repeatedNoProgressCalls = 0;
    // The deterministic breaker owns this burst — a semantic verdict from
    // the same burst must not double-correct on the next poll.
    this.semanticLoop.verdict = null;
    // Clear the text buffer too — otherwise a stage-1 text-repetition
    // trigger still sees the same repeated tail on the next check and
    // escalates to stage 2 on stale evidence.
    this.text = "";
    return stage;
  }

  /** Consume a pending semantic LOOP verdict, exactly once per run. */
  takeSemanticVerdict(): SemanticLoopVerdict | null {
    if (!this.semanticLoop.verdict || this.semanticLoop.injected) return null;
    const verdict = this.semanticLoop.verdict;
    this.semanticLoop.injected = true;
    this.semanticLoop.verdict = null;
    // The judged burst has been addressed; a fresh burst must re-accumulate.
    this.consecutiveFailures = 0;
    return verdict;
  }

  shouldRunSemanticCheck(deterministicBreak: boolean): boolean {
    return shouldRunSemanticLoopCheck({
      consecutiveFailures: this.consecutiveFailures,
      totalFailures: this.stats.toolFailures,
      turns: this.stats.turns,
      lastCheckTurn: this.semanticLoop.lastCheckTurn,
      checksUsed: this.semanticLoop.checksUsed,
      checkPending: this.semanticLoop.pending,
      deterministicBreak,
    });
  }

  /** Mark a judge call in flight; the returned run state is its stale-guard token. */
  beginSemanticCheck(): SemanticLoopRunState {
    const runState = this.semanticLoop;
    runState.pending = true;
    return runState;
  }

  /** Publish a judge verdict only if its run is still the current one. */
  publishSemanticVerdict(runState: SemanticLoopRunState, verdict: SemanticLoopVerdict): void {
    if (this.semanticLoop === runState) runState.verdict = verdict;
  }

  /** Settle a judge call: consume budget + cooldown, unless its run is stale. */
  settleSemanticCheck(runState: SemanticLoopRunState): void {
    if (this.semanticLoop === runState) {
      runState.pending = false;
      runState.checksUsed += 1;
      runState.lastCheckTurn = this.stats.turns;
    }
  }

  /** Reasons to refuse a turn-budget extension; empty means grant. */
  turnExtensionRefusals(): string[] {
    const refusals: string[] = [];

    const stuck = this.evaluateLoopBreak();
    if (stuck.shouldBreak) refusals.push(...stuck.reasons);

    // Stage 2 means the loop-breaker already detected spinning twice and told
    // the agent to stop and report. Do not overrule that with more turns.
    if (this.loopBreakInjected >= 2) refusals.push("loop-breaker already escalated");

    const { toolCalls, toolFailures } = this.stats;
    if (toolCalls > 0 && toolFailures / toolCalls > TURN_EXTENSION_MAX_FAILURE_RATIO) {
      refusals.push(`${toolFailures}/${toolCalls} tool calls failed`);
    }
    return refusals;
  }
}
