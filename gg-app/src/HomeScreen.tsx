import { useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import {
  CodeIcon,
  ChatCircleTextIcon,
  DownloadSimpleIcon,
  FilmSlateIcon,
  GearSixIcon,
} from "@phosphor-icons/react";
import { getVersion } from "@tauri-apps/api/app";
import { error as logError } from "@tauri-apps/plugin-log";
import { AsciiLogo } from "./AsciiLogo";
import { HomeScenery, withScenery } from "./HomeScenery";
import { HomeCritters } from "./HomeCritters";
import { useHomeBackgroundEnabled } from "./home-background";
import { groundFilter, lightAt } from "./scene-light";
import { useLocalHour } from "./use-local-hour";
import { useRandomBiome } from "./use-random-biome";
import type { SettingsTabId } from "./SettingsScreen";
import {
  openUrl,
  waitForReady,
  getSettings,
  authStatus,
  openWhatsNewWindow,
  getProgress,
  setRemoteActive,
  getServeStatus,
  type ProgressSnapshot,
} from "./agent";
import { RankBadge } from "./RankBadge";
import { ScorecardModal } from "./ScorecardModal";
import { useAppUpdate } from "./update";
import { toast } from "./toast";

// A failed setup check leaves the workspace buttons dimmed, so leave a trace in
// the app log instead of failing silently. The next focus retries.
function logSetupCheckFailure(e: unknown): Promise<void> {
  return logError(`Home setup check failed: ${String(e)}`);
}

interface Props {
  onProjects: () => void;
  onChat: () => void;
  onMotion: () => void;
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
 * everything else lives in full-screen Settings (the bottom-right gear).
 */
export function HomeScreen({
  onProjects,
  onChat,
  onMotion,
  onSettings,
  refreshSignal = 0,
}: Props): React.ReactElement {
  const [folderSet, setFolderSet] = useState(false);
  const [providerCount, setProviderCount] = useState(0);
  const [version, setVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressSnapshot | null>(null);
  const [showScorecard, setShowScorecard] = useState(false);
  const appUpdate = useAppUpdate();
  const motionNoteId = useId();

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {});
    void waitForReady()
      .then(() => getProgress())
      .then(setProgress)
      .catch(() => {});
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
      {/* Above the banner: your rank and What's new. */}
      <div className="home-version-row">
        <RankBadge
          snapshot={progress}
          onClick={() => setShowScorecard(true)}
          className="home-rank-badge"
        />
        <button
          className="home-whatsnew"
          type="button"
          title="See the latest updates"
          onClick={() => void openWhatsNewWindow("calm").catch(() => {})}
        >
          What&apos;s new
        </button>
      </div>
      <AsciiLogo />
      <div className="home-tagline">Cause the other coding agents piss me off</div>
      <div className="home-actions">
        <button
          type="button"
          className={`btn btn-primary home-action${ready ? "" : " is-dimmed"}`}
          aria-disabled={ready ? undefined : true}
          onClick={() => handleWorkspace(onProjects)}
        >
          <CodeIcon size={18} weight="bold" aria-hidden="true" />
          Code
        </button>
        <button
          type="button"
          className={`btn btn-primary home-action${ready ? "" : " is-dimmed"}`}
          aria-disabled={ready ? undefined : true}
          onClick={() => handleWorkspace(onChat)}
        >
          <ChatCircleTextIcon size={18} weight="bold" aria-hidden="true" />
          Chat
        </button>
        {/* Motion is still being built, so its button says so underneath. */}
        <div className="home-action-slot">
          <button
            type="button"
            className={`btn btn-primary home-action${ready ? "" : " is-dimmed"}`}
            aria-disabled={ready ? undefined : true}
            aria-describedby={motionNoteId}
            onClick={() => handleWorkspace(onMotion)}
          >
            <FilmSlateIcon size={18} weight="bold" aria-hidden="true" />
            Motion
          </button>
          <span id={motionNoteId} className="home-action-note">
            Still in process
          </span>
        </div>
      </div>
      <button
        type="button"
        className="icon-circle home-settings"
        aria-label="Settings"
        title="Settings"
        onClick={() => onSettings()}
      >
        <GearSixIcon size={20} weight="bold" aria-hidden="true" />
      </button>
      {/* Along the bottom edge: every critter, out playing. The links sit just
        above their lane. */}
      <HomeCritters biome={biome} />
      {/* Bottom centre: your links. */}
      <div className="home-byline home-links">
        By Ken Kai
        <span className="home-byline-sep" aria-hidden="true">
          {"\u00b7"}
        </span>
        <a
          className="home-link"
          href="https://skool.com/kenkai"
          onClick={(e) => {
            e.preventDefault();
            void openUrl("https://skool.com/kenkai");
          }}
        >
          Skool
        </a>
        <span className="home-byline-sep" aria-hidden="true">
          {"\u00b7"}
        </span>
        <a
          className="home-link"
          href="https://youtube.com/@kenkaidoesai"
          onClick={(e) => {
            e.preventDefault();
            void openUrl("https://youtube.com/@kenkaidoesai");
          }}
        >
          YouTube
        </a>
      </div>
      {/* Top centre: the version, or the update button when one is ready. */}
      <div className="home-version-corner">
        {appUpdate.phase === "available" || appUpdate.phase === "installing" ? (
          <button
            className={`home-update${appUpdate.phase === "installing" ? " home-update-progress" : ""}`}
            disabled={appUpdate.phase === "installing"}
            title={`Update to ${appUpdate.version} — installs and restarts the app`}
            onClick={() => void appUpdate.install()}
          >
            {appUpdate.phase === "installing" && (
              <span className="home-update-fill" style={{ width: `${appUpdate.progress ?? 0}%` }} />
            )}
            <DownloadSimpleIcon size={14} weight="bold" aria-hidden="true" />
            {/* Both labels occupy the same grid cell; the inactive one is
              visibility:hidden, so the pill is ALWAYS sized to the wider of
              the two and never resizes when the install starts or the
              percentage climbs. */}
            <span className="home-update-swap">
              <span className={appUpdate.phase === "installing" ? "home-update-hidden" : undefined}>
                {`Update to ${appUpdate.version}`}
              </span>
              <span className={appUpdate.phase === "installing" ? undefined : "home-update-hidden"}>
                {"Installing\u2026"}
                <span className="home-update-pct">{`${appUpdate.progress ?? 0}%`}</span>
              </span>
            </span>
          </button>
        ) : (
          version && <span className="home-version">{`v${version}`}</span>
        )}
      </div>

      {showScorecard && progress && (
        <ScorecardModal snapshot={progress} onClose={() => setShowScorecard(false)} />
      )}
    </div>
  );
}
