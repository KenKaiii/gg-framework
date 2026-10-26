import { useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { error as logError } from "@tauri-apps/plugin-log";
import { HomeTitle } from "./HomeTitle";
import { PixelIconButton } from "./PixelIconButton";
import { PixelTip } from "./PixelTip";
import { PlateButton } from "./PlateButton";
import { HomeScenery, withScenery } from "./HomeScenery";
import { HomeCritters } from "./HomeCritters";
import { HomeUpdateButton } from "./HomeUpdateButton";
import { useHomeBackgroundEnabled } from "./home-background";
import { groundFilter, lightAt } from "./scene-light";
import { useLocalHour } from "./use-local-hour";
import { useRandomBiome } from "./use-random-biome";
import type { SettingsTabId } from "./SettingsScreen";
import {
  waitForReady,
  getSettings,
  authStatus,
  openWhatsNewWindow,
  setRemoteActive,
  getServeStatus,
} from "./agent";
import { useAppUpdate } from "./update";
import { toast } from "./toast";

// A failed setup check leaves the workspace buttons dimmed, so leave a trace in
// the app log instead of failing silently. The next focus retries.
function logSetupCheckFailure(e: unknown): Promise<void> {
  return logError(`Home setup check failed: ${String(e)}`);
}

interface Props {
  onProjects: () => void;
  onGoals: () => void;
  onChat: () => void;
  onMotion: () => void;
  /** Shows World full-window. */
  onWorld: () => void;
  /**
   * World is on screen (it fades in over Home once the game is ready).
   * Until then the World plate stays pressed, so the click visibly took.
   */
  worldShown?: boolean;
  /** Opens full-screen Settings, optionally on a given tab. */
  onSettings: (tab?: SettingsTabId) => void;
  /**
   * Bumped when something OUTSIDE this screen changed serve/auth state (the
   * macOS tray toggling Remote, or its Settings modal saving a projects
   * folder). A counter, not a boolean, so repeats always re-fire.
   */
  refreshSignal?: number;
}

/**
 * App entry screen: the shimmering GG Coder banner over the primary actions.
 * Code, Chat and Motion require a configured workspace folder and connected AI provider;
 * World (the local game) needs neither, so it is never dimmed;
 * everything else lives in full-screen Settings (the bottom-right gear).
 */
export function HomeScreen({
  onProjects,
  onGoals,
  onChat,
  onMotion,
  onWorld,
  worldShown = false,
  onSettings,
  refreshSignal = 0,
}: Props): React.ReactElement {
  const [folderSet, setFolderSet] = useState(false);
  const [providerCount, setProviderCount] = useState(0);
  const [version, setVersion] = useState<string | null>(null);
  // The version row stays hidden until the version is read, so What's new
  // never shifts sideways when the number arrives.
  const [versionRead, setVersionRead] = useState(false);
  const appUpdate = useAppUpdate();
  const worldNoteId = useId();
  // Held down from the moment World starts opening until it's on screen.
  const [worldOpening, setWorldOpening] = useState(false);
  useEffect(() => {
    if (worldShown) setWorldOpening(false);
  }, [worldShown]);

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {})
      .finally(() => setVersionRead(true));
  }, []);

  async function refresh(): Promise<void> {
    // Settings + auth are read NATIVELY (Rust) — do them first, WITHOUT waiting on
    // the sidecar, so the workspace gate never stays dimmed just because the
    // agent is slow/crashed.
    const [settings, providers] = await Promise.all([getSettings(), authStatus()]);
    // Prefer the explicit `configured` flag; fall back to a non-empty root so an
    // older sidecar (one that predates the flag) degrades to "set" instead of
    // dimming forever.
    setFolderSet(settings?.configured ?? Boolean(settings?.projectsRoot));
    setProviderCount(providers.filter((p) => p.connected).length);
    // Keep the macOS tray's Remote label in step with the sidecar (it may have
    // respawned). Best-effort, and never blocks the native reads above.
    void waitForReady()
      .then(() => getServeStatus())
      .then((serve) => void setRemoteActive(serve.running))
      .catch(() => {});
  }

  useEffect(() => {
    void refresh().catch(logSetupCheckFailure);
    // Re-check when the window regains focus so a folder/provider set elsewhere
    // (or after a sidecar respawn) reflects without an app restart.
    const onFocus = (): void => void refresh().catch(logSetupCheckFailure);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Skips the initial 0 so mounting doesn't double-refresh.
  useEffect(() => {
    if (refreshSignal > 0) void refresh().catch(logSetupCheckFailure);
  }, [refreshSignal]);

  const ready = folderSet && providerCount > 0;

  function handleWorkspace(open: () => void): void {
    if (ready) {
      open();
      return;
    }
    // Take the user to the missing prerequisite: the folder first (General),
    // then a provider.
    if (!folderSet) {
      toast("Set a workspace folder first.", "warning");
      onSettings("general");
    } else if (providerCount === 0) {
      toast("Connect an AI provider first.", "warning");
      onSettings("providers");
    }
  }

  const backgroundOn = useHomeBackgroundEnabled();
  // The critters' terrain for this visit. With the scenery on it has to be one
  // with a horizon painted behind it, and its ground takes the sky's light.
  const [visitBiome] = useRandomBiome();
  const biome = backgroundOn ? withScenery(visitBiome) : visitBiome;
  const hour = useLocalHour();
  const sceneStyle = useMemo(
    (): (CSSProperties & Record<"--scene-ground", string>) | undefined =>
      backgroundOn ? { "--scene-ground": groundFilter(lightAt(hour)) } : undefined,
    [backgroundOn, hour],
  );

  return (
    <div className="home" data-tauri-drag-region style={sceneStyle}>
      {backgroundOn && <HomeScenery hour={hour} />}
      {/* Above the banner: the running version, and what's new in it. */}
      <div className={`home-version-row${versionRead ? "" : " is-pending"}`}>
        {version && (
          <>
            <span className="home-version">{`v${version}`}</span>
            <span className="home-version-sep" aria-hidden="true">
              {"\u00b7"}
            </span>
          </>
        )}
        <PixelTip text="What's new: the latest updates, and everything since.">
          <button
            className="home-whatsnew"
            type="button"
            onClick={() => void openWhatsNewWindow("calm").catch(() => {})}
          >
            What&apos;s new
          </button>
        </PixelTip>
      </div>
      <HomeTitle />
      <div className="home-tagline">Cause the other coding agents piss me off</div>
      <div className="home-actions">
        {/* GG Royale's plate buttons, its word in Alagard, each with a pixel tip. */}
        <PixelTip text="Code: open a project and build it with the agent.">
          <PlateButton
            className="home-action"
            label="Code"
            dimmed={!ready}
            onClick={() => handleWorkspace(onProjects)}
          />
        </PixelTip>
        <PixelTip text="Goals: hand over a bigger goal and let a team of agents work on it.">
          <PlateButton
            className="home-action"
            label="Goals"
            dimmed={!ready}
            onClick={() => handleWorkspace(onGoals)}
          />
        </PixelTip>
        <PixelTip text="Chat: talk things through, no project needed.">
          <PlateButton
            className="home-action"
            label="Chat"
            dimmed={!ready}
            onClick={() => handleWorkspace(onChat)}
          />
        </PixelTip>
        <PixelTip text="Motion: make videos and animations.">
          <PlateButton
            className="home-action"
            label="Motion"
            dimmed={!ready}
            onClick={() => handleWorkspace(onMotion)}
          />
        </PixelTip>
        {/* World: the local 3D game, full-window in this window; new, so it
            carries a New tag. */}
        <div className="home-action-slot">
          <PixelTip text="World: a cozy 3D hangout for coders, with your coding level and an optional online save.">
            <PlateButton
              className={`home-action${worldOpening ? " is-loading" : ""}`}
              label={worldOpening ? "Loading" : "World"}
              held={worldOpening}
              aria-describedby={worldNoteId}
              onClick={() => {
                setWorldOpening(true);
                onWorld();
              }}
            />
          </PixelTip>
          {/* While World loads (it takes a moment to build the scene), the tag shows three pulsing pixel dots, so
              Home never looks frozen. */}
          <span id={worldNoteId} className={`home-action-beta${worldOpening ? " is-loading" : ""}`}>
            {worldOpening ? (
              <span className="home-loading-dots" aria-label="Loading World">
                <i />
                <i />
                <i />
              </span>
            ) : (
              "New"
            )}
          </span>
        </div>
      </div>
      {/* Settings: a GG Royale pixel gear. */}
      <PixelTip text="Settings: AI providers, your projects folder, and more.">
        <PixelIconButton
          className="home-settings"
          icon="gear"
          label="Settings"
          onClick={() => onSettings()}
        />
      </PixelTip>
      {/* Along the bottom edge: every critter, out playing. */}
      <HomeCritters biome={biome} />
      {/* Top centre: the update button, only while an update is out. */}
      <div className="home-version-corner">
        <HomeUpdateButton appUpdate={appUpdate} current={version} />
      </div>
    </div>
  );
}
