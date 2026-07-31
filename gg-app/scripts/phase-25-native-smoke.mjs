import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PHASE25_PACKAGED_SMOKE_DISABLED_MESSAGE =
  "Phase 25 packaged smoke automation is retired: it must not inspect or mutate installed apps, processes, shortcuts, registry state, notifications, installers, or user data. Use the isolated dev fixture for automated verification and complete the visible Windows toast check manually at release time.";

export async function runPhase25PackagedSmoke() {
  throw new Error(PHASE25_PACKAGED_SMOKE_DISABLED_MESSAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPhase25PackagedSmoke().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
