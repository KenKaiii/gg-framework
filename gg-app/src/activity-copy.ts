// Presentation only: these phrases never decide the outcome or its colour.
// Keep each pool semantically equivalent, short, and stable for one request.
export const OUTCOME_PHRASES: Record<string, readonly string[]> = {
  "Response ready": [
    "Answer ready. GG.",
    "Your answer is ready",
    "Answer’s all yours",
    "Fresh answer, ready",
    "Answer ready to read",
    "Response served up",
  ],
  "Findings ready": [
    "Findings, fresh in",
    "Findings ready. GG.",
    "Notes ready to read",
    "Here’s the rundown",
    "Findings on the table",
    "Your findings are in",
  ],
  "Changes saved": [
    "Edits in. Have a look",
    "Changes saved. GG.",
    "Edits ready to review",
    "Changes on the page",
    "Edits are on the board",
    "Changes ready to read",
  ],
  "Tool work finished": [
    "Tool results are in",
    "Tools wrapped up",
    "Tool output, ready",
    "Results ready to read",
    "Tool run wrapped up",
    "Tool results. Your move",
  ],
  "Background work started": [
    "Background job started",
    "Job sent backstage",
    "Background job launched",
    "Job started offstage",
    "Background launch made",
    "Job launched backstage",
  ],
  // "{checks}" becomes the recorded count ("1 check", "3 checks"): one passing
  // lint must not read as a full suite.
  "Done · checks passed": [
    "{checks} passed. Nice.",
    "{checks} came back green",
    "{checks} passed. GG.",
    "{checks} passed. Lovely.",
    "{checks} passed cleanly",
    "Green: {checks} passed",
  ],
  // A failed check may be the environment, not the code: say what happened,
  // not what to fix.
  "Checks failed": [
    "A check failed",
    "Checks came back red",
    "Checks didn’t pass",
    "Red checks. Take a look",
    "Checks failed. See chat",
    "A check came back red",
  ],
  "Verification incomplete": [
    "Checks still needed",
    "Not verified just yet",
    "Checks not confirmed",
    "Verification still owed",
    "No passing check yet",
    "Still needs a check",
  ],
  "Task failed": [
    "Run hit a snag",
    "Run failed. Regroup",
    "This run hit trouble",
    "Run error. Take a look",
    "Run failed. Retry next",
    "Run couldn’t finish",
  ],
  "Stopped · unfinished": [
    "Stopped. Not finished",
    "Run stopped short",
    "Stopped mid-run",
    "Stopped before the end",
    "Run halted. Not done",
    "Stopped. Pick up later",
  ],
  "Response incomplete": [
    "Answer cut short",
    "Response needs more",
    "Answer still unfinished",
    "Response ended early",
    "Answer needs another go",
    "Response not finished",
  ],
  "Plan incomplete": [
    "Plan still has steps",
    "Plan needs another pass",
    "Plan not finished yet",
    "Plan steps still open",
    "More plan steps to go",
    "Plan has work left",
  ],
  "Agents still running": [
    "Agents still at work",
    "Agents haven’t wrapped",
    "Agents still working",
    "Agents need more time",
    "Agent work still open",
    "Waiting on the agents",
  ],
  "Your decision needed": [
    "Your call from here",
    "Your move. We’ll wait",
    "Need your call next",
    "A decision for you",
    "Waiting on your call",
    "Your choice comes next",
  ],
  "Plan needs your decision": [
    "Plan ready. Your call",
    "Plan needs your nod",
    "Your move on the plan",
    "Plan awaits your call",
    "Plan ready for a nod",
    "Plan choice is yours",
  ],
  "Paused · review limit reached": [
    "Review limit reached",
    "Review cap. Take a look",
    "Review rounds maxed out",
    "Review hit its limit",
    "Review capped. Your move",
    "Review limit. Paused",
  ],
  // The review errored; it never judged the work, so nothing here may sound
  // like a rejection.
  "Ken’s review failed": [
    "Ken’s review hit an error",
    "Ken couldn’t review",
    "Review error. Try again",
    "Ken’s review errored",
    "Review errored. Retry",
    "Ken’s review broke off",
  ],
};
OUTCOME_PHRASES["Changed · verification incomplete"] = OUTCOME_PHRASES["Verification incomplete"]!;

export function outcomePhrase(label: string, seed: number, checks = 0): string | undefined {
  const choices = OUTCOME_PHRASES[label];
  if (!choices) return undefined;
  const index = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) % choices.length : 0;
  const phrase = choices[index];
  if (!phrase?.includes("{checks}")) return phrase;
  const count = checks > 0 ? `${checks} check${checks === 1 ? "" : "s"}` : "checks";
  const text = phrase.replace("{checks}", count);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
