// The update engine now lives in @kenkaiiii/gg-core. This module pins it to
// ggcoder's npm package + state file, keeping the "ggcoder"-branded surface and
// the same exported function names so consumers/tests are unchanged.
import path from "node:path";
import os from "node:os";
import { createAutoUpdater } from "@kenkaiiii/gg-core";

const updater = createAutoUpdater({
  packageName: "@kenkaiiii/ggcoder",
  stateFilePath: () => path.join(os.homedir(), ".gg", "update-state.json"),
});

export const checkAndAutoUpdate = updater.checkAndAutoUpdate;
export const getPendingUpdate = updater.getPendingUpdate;
export const startPeriodicUpdateCheck = updater.startPeriodicUpdateCheck;
export const stopPeriodicUpdateCheck = updater.stopPeriodicUpdateCheck;
