/**
 * The autopilot reviewer for `kleio-coder acp`: the session the autopilot cycle
 * prompts. Built like the desktop's `ensureKenAutoSession` (app-sidecar.ts):
 * Ken's autopilot system prompt, Ken's read-only tool set, a transient
 * session, long cache retention, and the project's Ken model pin when one is
 * valid (otherwise Ken follows Kleio Coder's model, as on the desktop).
 */
import type { Provider } from "@kleio/ai";
import { getModel } from "@kleio/core";
import { AgentSession } from "../core/agent-session.js";
import { buildKenAutopilotSystemPrompt } from "../core/ken-prompt.js";
import { validateKenModelPref } from "../core/ken-model.js";
import { KEN_ALLOWED_TOOLS, lastAssistantText } from "../app-sidecar/ken-context.js";
import { loadKenModelPref } from "../app-sidecar/app-settings.js";

/** The reviewer the ACP autopilot cycle talks to. A seam so tests can script Ken. */
export interface AcpKenReviewer {
  /** Wipe review history (start of each cycle). */
  reset(): Promise<void>;
  /** Prompt Ken with a digest; resolves to his final reply text. */
  review(digest: string): Promise<string>;
  /** Stop an in-flight review (session/cancel, queued message). */
  abort(): void;
  dispose(): Promise<void>;
}

export interface AcpKenReviewerOptions {
  cwd: string;
  /** Kleio Coder's current model; Ken follows it unless the project pins his own. */
  buildModel: () => { provider: Provider; model: string };
}

export function createAcpKenReviewer(options: AcpKenReviewerOptions): AcpKenReviewer {
  let abort = new AbortController();
  let ken: AgentSession | null = null;

  async function ensure(): Promise<AgentSession> {
    if (ken) return ken;
    const pinned = validateKenModelPref(await loadKenModelPref(options.cwd), {
      modelExists: (id) => getModel(id) !== undefined,
      providerConnected: () => true,
    });
    const target = pinned ?? options.buildModel();
    const created = new AgentSession({
      provider: target.provider,
      model: target.model,
      cwd: options.cwd,
      systemPrompt: await buildKenAutopilotSystemPrompt(options.cwd),
      allowedTools: KEN_ALLOWED_TOOLS,
      transient: true,
      signal: abort.signal,
      forceLongCacheRetention: true,
    });
    await created.initialize();
    ken = created;
    return created;
  }

  return {
    async reset() {
      await ken?.newSession().catch(() => undefined);
    },
    async review(digest) {
      const session = await ensure();
      await session.prompt(digest);
      return lastAssistantText(session.getMessages());
    },
    abort() {
      abort.abort();
      abort = new AbortController();
      ken?.setSignal(abort.signal);
    },
    async dispose() {
      abort.abort();
      const current = ken;
      ken = null;
      await current?.dispose();
    },
  };
}
