import { error as logError } from "@tauri-apps/plugin-log";

export const TAURI_MISSING_LISTENER_ENTRY_ERROR =
  "undefined is not an object (evaluating 'listeners[eventId].handlerId')";

export type TauriUnlisten = () => unknown;
export type SafeTauriUnlisten = () => Promise<void>;

interface SafeTauriUnlistenDependencies {
  yieldTask?: () => Promise<void>;
  reportError?: (context: string, error: unknown) => void | Promise<void>;
}

function isMissingListenerEntryError(error: unknown): boolean {
  return error instanceof TypeError && error.message === TAURI_MISSING_LISTENER_ENTRY_ERROR;
}

function yieldTask(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function reportCleanupError(context: string, error: unknown): Promise<void> {
  await logError(`Tauri listener cleanup failed (${context}): ${String(error)}`);
}

/**
 * Wrap Tauri's event unlisten function with the narrow workaround for
 * tauri-apps/tauri#15799. The first missing-entry failure can occur before
 * Tauri's registration eval reaches the webview, so one task yield and one
 * retry lets the same unlisten function reach its backend cleanup call.
 */
export function createSafeTauriUnlisten(
  unlisten: TauriUnlisten,
  context: string,
  dependencies: SafeTauriUnlistenDependencies = {},
): SafeTauriUnlisten {
  const yieldOnce = dependencies.yieldTask ?? yieldTask;
  const reportError = dependencies.reportError ?? reportCleanupError;
  let cleanupPromise: Promise<void> | null = null;

  const cleanup = async (): Promise<void> => {
    try {
      await unlisten();
      return;
    } catch (error) {
      if (!isMissingListenerEntryError(error)) {
        await reportError(context, error);
        return;
      }
    }

    await yieldOnce();
    try {
      await unlisten();
    } catch (error) {
      await reportError(context, error);
    }
  };

  return () => {
    cleanupPromise ??= cleanup();
    return cleanupPromise;
  };
}
