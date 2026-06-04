// The update engine now lives in @kenkaiiii/gg-core. This module pins it to
// gg-boss's npm package + its own state file under ~/.gg/boss/ so it can't
// fight with ggcoder's checker, and supplies the ggboss restart wording.
import path from "node:path";
import os from "node:os";
import { createAutoUpdater } from "@kenkaiiii/gg-core";

const updater = createAutoUpdater({
  packageName: "@kenkaiiii/gg-boss",
  stateFilePath: () => path.join(os.homedir(), ".gg", "boss", "update-state.json"),
  periodicMessage: ({ currentVersion, latestVersion, updateCommand }) =>
    `Ken just pushed a fresh update — ${currentVersion} → ${latestVersion}! Restart ggboss to grab it (or run ${updateCommand} if you can't wait).`,
});

export const checkAndAutoUpdate = updater.checkAndAutoUpdate;
export const getPendingUpdate = updater.getPendingUpdate;
export const startPeriodicUpdateCheck = updater.startPeriodicUpdateCheck;
export const stopPeriodicUpdateCheck = updater.stopPeriodicUpdateCheck;
