import { Channel, invoke } from "@tauri-apps/api/core";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Download and install a pending update. Builds installed from the .rpm go
 * through the app's own installer (`install_rpm_update`): the plugin's bare
 * `rpm -U` is refused by RPM 6 for packages without a trusted GPG signature.
 * Every other build uses the plugin as before.
 */
export async function installUpdate(
  update: Pick<Update, "downloadAndInstall">,
  onEvent: (event: DownloadEvent) => void,
  call: Invoke = invoke,
): Promise<void> {
  const rpm = await call<boolean>("update_installs_rpm").catch(() => false);
  if (!rpm) {
    await update.downloadAndInstall(onEvent);
    return;
  }
  const channel = new Channel<DownloadEvent>();
  channel.onmessage = onEvent;
  await call("install_rpm_update", { onEvent: channel });
}
