import type { ActivityGlyphName } from "./pixel-glyphs";
import { PROGRESS_PHRASES, type TaskPhase } from "./task-activity";

// Every progress pool, by its base phrase (each rotation shares the glyph).
const BY_POOL: Readonly<Record<string, ActivityGlyphName>> = {
  "Thinking…": "think",
  "Working on your request…": "work",
  "Writing a response…": "write",
  "Reading the relevant code…": "read",
  "Making the changes…": "edit",
  "Checking references…": "web",
  "Running checks…": "check",
  "Running a command…": "run",
};

// Labels task-activity.ts sets directly. Outcomes show what they're about; the
// tick is kept for passing checks alone, so it never vouches for unchecked work.
const BY_LABEL: Readonly<Record<string, ActivityGlyphName>> = {
  "Done · checks passed": "done",
  "Response ready": "write",
  "Findings ready": "read",
  "Changes saved": "edit",
  "Tool work finished": "run",
  "Background work started": "background",
  "Checks failed": "check",
  "Verification incomplete": "check",
  "Changed · verification incomplete": "check",
  "Response incomplete": "write",
  "Task failed": "fail",
  "Ken’s review failed": "fail",
  "Stopped · unfinished": "stop",
  "Starting…": "start",
  "Inspecting the app…": "inspect",
  "Stepping through the code…": "debug",
  "Coordinating agent work…": "agents",
  "Agents working…": "agents",
  "Reviewing agent results…": "agents",
  "Agents still running": "agents",
  "Review agent results": "agents",
  "Checking background work…": "background",
  "Checking the changes…": "check",
  "Reviewing the work…": "review",
  "Preparing Ken’s review…": "review",
  "Ken reviewing…": "review",
  "Applying Ken’s corrections…": "edit",
  "Keeping the task context…": "context",
  "Continuing…": "work",
  "Continuing the task…": "work",
  "Continuing with your decision…": "work",
  "Question closed · checking next step…": "work",
  "Retrying…": "retry",
  "Reconnecting…": "reconnect",
  "Reconnected · review latest result": "reconnect",
  "Stopping the task…": "stop",
  "Plan ready for review…": "plan",
  "Plan needs your decision": "plan",
  "Plan approved · preparing implementation…": "plan",
  "Plan incomplete": "plan",
  "Your decision needed": "ask",
  "Cancellation failed · task still running": "warn",
  "Paused · review limit reached": "review",
};

const BY_PHASE: Readonly<Record<TaskPhase, ActivityGlyphName>> = {
  idle: "idle",
  working: "work",
  reviewing: "review",
  attention: "ask",
  done: "write",
  unverified: "warn",
  failed: "fail",
  stopped: "stop",
};

/** The glyph for an activity's full (un-shortened) label, falling back to its phase. */
export function activityGlyph(label: string, phase: TaskPhase): ActivityGlyphName {
  const direct = BY_LABEL[label];
  if (direct) return direct;
  for (const [base, phrases] of Object.entries(PROGRESS_PHRASES)) {
    if (phrases.includes(label)) return BY_POOL[base] ?? BY_PHASE[phase];
  }
  return BY_PHASE[phase];
}
