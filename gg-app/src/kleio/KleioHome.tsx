// Kleio's home screen: Ken's layout, entry animation and dithered waves (his
// HomeScreen stays in the tree, unused, so upstream syncs stay easy), dressed
// in Kleio's crimson and white, with Kleio's own ways in.

import { useEffect, useState } from "react";
import {
  CirclesThreeIcon,
  CodeIcon,
  GearSixIcon,
  SparkleIcon,
  WaveformIcon,
} from "@phosphor-icons/react";
import { getVersion } from "@tauri-apps/api/app";
import { HomeDither } from "../HomeDither";
import { useHomeBackgroundEnabled } from "../home-background";
import { KLEIO_BACKGROUND, KLEIO_WAVES } from "./kleioWaves";
import type { SettingsTabId } from "../SettingsScreen";
import { authStatusWithError, getLocalModels, getSettings, waitForReady } from "../agent";
import { toast } from "../toast";
import { refreshVoiceReady, talkToKleio, useVoiceReady } from "./VoiceMode";
import { useCallOpen } from "./voiceCall";
import { KleioMark } from "./KleioMark";
import { hasUsableLocalModel } from "./privateModels";
import { useKleioRemote } from "./useKleioRemote";
import { diagnosisText } from "./connectionDiagnosis";
import { useHostReach, useHostReachWords } from "./hostReach";
import { shortHost } from "./host-name";

interface Props {
  /** Chat with Kleio: upstream's Chat screen (the general agent), on the Mac mini. */
  onChat: () => void;
  /** Coding projects on the Mac mini. */
  onCode: () => void;
  /** Goals: long-running objectives the coordinator splits among workers. */
  onGoals: () => void;
  /** Kleio's specialists ("Blobs" in the code and on the host). Apps live in Settings. */
  onBlobs: () => void;
  onSettings: (tab?: SettingsTabId) => void;
  refreshSignal?: number;
}

export function KleioHome({
  onChat,
  onCode,
  onGoals,
  onBlobs,
  onSettings,
  refreshSignal = 0,
}: Props): React.ReactElement {
  const { status } = useKleioRemote();
  const [ready, setReady] = useState<{ folder: boolean; model: boolean } | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const backgroundOn = useHomeBackgroundEnabled();
  // The voice screen covers this one and moves its own waves: these hold still.
  const covered = useCallOpen();
  // Her natural voice is set up on the Mac mini: "Talk to Kleio", else "Brief me".
  const voiceReady = useVoiceReady();
  // Paired is not enough: the Mac mini has to be answering right now.
  const reach = useHostReach();
  // Over Kleio's link, why it isn't (diagnoseLink's words).
  const words = useHostReachWords();
  const connected = Boolean(status?.active) && reach === "connected";

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (connected) void refreshVoiceReady();
  }, [connected, refreshSignal]);

  // Chat and Code need a model on the Mac mini: a signed-in provider, or a
  // private one (Tinfoil, Ollama) that is running. Code also needs a projects
  // folder. Unknown (the host didn't answer yet) never blocks: the next screen
  // explains.
  async function refresh(): Promise<void> {
    await waitForReady().catch(() => {});
    const [settings, auth, local] = await Promise.all([
      getSettings().catch(() => null),
      authStatusWithError().catch(() => null),
      getLocalModels().catch(() => null),
    ]);
    // A list that couldn't be read (e.g. the Mac mini restarted and is still
    // replacing this phone's session) is unknown, not "nobody signed in".
    const signedIn = auth && !auth.error ? auth.providers.some((p) => p.connected) : null;
    const localReady = local ? hasUsableLocalModel(local) : null;
    setReady({
      folder: settings ? (settings.configured ?? Boolean(settings.projectsRoot)) : true,
      model: signedIn !== false || localReady === true,
    });
  }

  useEffect(() => {
    void refresh();
    const onFocus = (): void => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (refreshSignal > 0) void refresh();
  }, [refreshSignal]);

  const modelReady = ready === null || ready.model;
  const codeReady = ready === null || (ready.folder && ready.model);

  function needModel(): void {
    toast("Connect an AI model first.", "warning");
    onSettings("providers");
  }

  function openChat(): void {
    if (modelReady) return onChat();
    needModel();
  }

  function openCode(): void {
    if (codeReady) return onCode();
    if (!ready?.model) return needModel();
    toast("Set a projects folder on your host first.", "warning");
    onSettings("general");
  }

  const host = status?.active?.host;
  const mini = host ? shortHost(host) : "your host";
  const pill = !status?.active
    ? { state: "is-down", text: `Disconnected from ${mini}` }
    : reach === "checking"
      ? { state: "is-checking", text: words?.headline ?? `Connecting to ${mini}…` }
      : reach === "connected"
        ? { state: "is-up", text: `Connected to ${mini}` }
        : { state: "is-down", text: words?.headline ?? `Disconnected from ${mini}` };

  return (
    <div className="home kleio-home" data-tauri-drag-region>
      {backgroundOn && (
        <HomeDither waveColor={KLEIO_WAVES} backgroundColor={KLEIO_BACKGROUND} paused={covered} />
      )}
      <div className="home-version-row">
        <button
          type="button"
          className={`kleio-status ${pill.state}`}
          title={
            words && pill.state !== "is-up"
              ? diagnosisText(words)
              : pill.state === "is-down"
                ? "Can't reach your host. Open Connection to see why."
                : "Connection to your host"
          }
          onClick={() => onSettings("connection")}
        >
          <span className="kleio-status-dot" aria-hidden="true" />
          <span className="kleio-status-text">{pill.text}</span>
        </button>
      </div>
      <KleioMark />
      <div className="home-tagline">Talk to your work: chat, code and specialists in one app.</div>
      <div className="home-actions">
        <button
          type="button"
          className={`btn btn-primary home-action${modelReady ? "" : " is-dimmed"}`}
          aria-disabled={modelReady ? undefined : true}
          onClick={openChat}
        >
          <SparkleIcon size={18} weight="bold" aria-hidden="true" />
          Kleio
        </button>
        <button
          type="button"
          className={`btn btn-ghost home-action${codeReady ? "" : " is-dimmed"}`}
          aria-disabled={codeReady ? undefined : true}
          onClick={openCode}
        >
          <CodeIcon size={18} weight="bold" aria-hidden="true" />
          Code
        </button>
        <button type="button" className="btn btn-ghost home-action" onClick={onGoals}>
          Goals
        </button>
        <button type="button" className="btn btn-ghost home-action" onClick={onBlobs}>
          <CirclesThreeIcon size={18} weight="bold" aria-hidden="true" />
          Specialists
        </button>
      </div>
      <button
        type="button"
        className="home-brief"
        title={
          voiceReady
            ? "Talk to Kleio: ask what's happening, or plan something out (⌘⇧B)"
            : "Hear what needs you, what finished and what's still working (⌘⇧B)"
        }
        onClick={() => void talkToKleio()}
      >
        <WaveformIcon size={16} weight="bold" aria-hidden="true" />
        {voiceReady ? "Talk to Kleio" : "Brief me"}
      </button>
      <button
        type="button"
        className="icon-circle home-settings"
        aria-label="Settings"
        title="Settings"
        onClick={() => onSettings()}
      >
        <GearSixIcon size={20} weight="bold" aria-hidden="true" />
      </button>
      {/* An update shows as the banner along the bottom (App.tsx). */}
      <div className="home-version-corner">
        {version && <span className="home-version">{`v${version}`}</span>}
      </div>
    </div>
  );
}
