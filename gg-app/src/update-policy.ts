export type UpdateInstallPath = "local-patched" | "official" | "none";

export interface InstallableUpdate {
  downloadAndInstall: () => Promise<void>;
}

export interface InstallUpdateForBuildOptions {
  localPatched: boolean;
  sourceRoot: string;
  update: InstallableUpdate | null;
  startLocalPatchedUpdate: (sourceRoot: string) => Promise<void>;
  relaunch: () => Promise<void>;
}

export async function installUpdateForBuild({
  localPatched,
  sourceRoot,
  update,
  startLocalPatchedUpdate,
  relaunch,
}: InstallUpdateForBuildOptions): Promise<UpdateInstallPath> {
  if (localPatched) {
    await startLocalPatchedUpdate(sourceRoot);
    return "local-patched";
  }
  if (!update) return "none";
  await update.downloadAndInstall();
  await relaunch();
  return "official";
}
