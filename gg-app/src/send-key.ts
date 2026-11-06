/** What the composer's round send key does right now. */
export type SendKeyAction = "send" | "stop-run" | "stop-ken";

// The send key is the only Stop control: it stops GG's run, Ken's autopilot
// review (both through the run's cancel) or a manual @Ken reply.
export function sendKeyAction(state: {
  shellMode: boolean;
  running: boolean;
  kenRunning: boolean;
  autopilotReviewing: boolean;
}): SendKeyAction {
  if (state.shellMode) return "send";
  if (state.running || state.autopilotReviewing) return "stop-run";
  if (state.kenRunning) return "stop-ken";
  return "send";
}
