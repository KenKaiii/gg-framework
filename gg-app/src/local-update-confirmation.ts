import type { UpdatePhase } from "./update";

export const LOCAL_UPDATE_CONFIRMATION_TITLE = "Rebase and build patched update?";

export const LOCAL_UPDATE_CONFIRMATION_MESSAGE =
  "This will create a backup of commits and dirty work, rebase custom/local-customizations on upstream/main, verify the local fork, run checks, and build a patched installer. It will not install the official binary or push.";

export const LOCAL_UPDATE_CONFIRMATION_CONFIRM_LABEL = "Rebase and build installer";

export function shouldConfirmLocalUpdate(localPatched: boolean, phase: UpdatePhase): boolean {
  return localPatched && (phase === "available" || phase === "error");
}
