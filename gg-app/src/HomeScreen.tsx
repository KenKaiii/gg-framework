import { useEffect, useState } from "react";
import { Settings, Download } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AsciiLogo } from "./AsciiLogo";
import { HomeBackdrop } from "./HomeBackdrop";
import { MemeLayer } from "./MemeLayer";
import { SettingsModal } from "./SettingsModal";
import { TelegramSettingsModal } from "./TelegramSettingsModal";
import { McpModal } from "./McpModal";
import {
  waitForReady,
  getSettings,
  authStatus,
  getServeStatus,
  startServe,
  stopServe,
  openWhatsNewWindow,
  getProgress,
  type ProgressSnapshot,
} from "./agent";
import { RankBadge } from "./RankBadge";
import { ScorecardModal } from "./ScorecardModal";
import { useAppUpdate } from "./update";
import { toast } from "./toast";

interface Props {
  onProjects: () => void;
  onChat: () => void;
  onLogin: () => void;
}

/**
 * App entry screen: the shimmering GG Coder banner over the primary actions.
 * Code and Chat require a configured workspace folder and connected AI provider.
 */
export function HomeScreen({ onProjects, onChat, onLogin }: Props): React.ReactElement {
  const [folderSet, setFolderSet] = useState(false);
  const [providerCount, setProviderCount] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showTelegram, setShowTelegram] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [serving, setServing] = useState(false);
  const [telegramConfigured, setTelegramConfigured] = useState(false);
  const [serveBusy, setServeBusy] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressSnapshot | null>(null);
  const [showScorecard, setShowScorecard] = useState(false);
  const appUpdate = useAppUpdate();

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
    // Serve status lives in the sidecar (the Telegram bot runs there). Best-effort
    // — gate it on readiness but never let it block the native reads above.
    void waitForReady()
      .then(() => getServeStatus())
      .then((serve) => {
        setServing(serve.running);
        setTelegramConfigured(serve.configured);
      })
      .catch(() => {});
  }

  useEffect(() => {
    void refresh().catch(() => {});
    // Re-check when the window regains focus so a folder/provider set elsewhere
    // (or after a sidecar respawn) reflects without an app restart.
    const onFocus = (): void => void refresh().catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const ready = folderSet && providerCount > 0;

  async function handleServe(): Promise<void> {
    if (serveBusy) return;
    if (providerCount === 0) {
      toast("Connect an AI provider first.", "warning");
      return;
    }
    if (!telegramConfigured) {
      toast("Set up Telegram first.", "warning");
      setShowTelegram(true);
      return;
    }
    setServeBusy(true);
    try {
      if (serving) {
        await stopServe();
        setServing(false);
        toast("Stopped serving.", "success");
      } else {
        await startServe();
        setServing(true);
        toast("Serving on Telegram — message your bot.", "success");
      }
    } catch (e) {
      toast(`Serve failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setServeBusy(false);
    }
  }

  function handleWorkspace(open: () => void): void {
    if (ready) {
      open();
      return;
    }
    // Guide the user to the missing prerequisite(s).
    if (!folderSet) {
      toast("Set a workspace folder first. Open Settings.", "warning");
    }
    if (providerCount === 0) {
      toast("Connect an AI provider first.", "warning");
    }
  }

  return (
    <div className="home" data-tauri-drag-region>
      <HomeBackdrop />
      <MemeLayer />
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
          <Download size={14} strokeWidth={2.25} aria-hidden="true" />
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
        version && (
          <div className="home-version-row">
            <span className="home-version">{`v${version}`}</span>
            <RankBadge
              snapshot={progress}
              onClick={() => setShowScorecard(true)}
              className="home-rank-badge"
            />
            <button
              className="home-whatsnew"
              type="button"
              title="See the latest updates"
              onClick={() => void openWhatsNewWindow().catch(() => {})}
            >
              What&apos;s new
            </button>
          </div>
        )
      )}
      <AsciiLogo />
      <div className="home-tagline">Cause the other coding agents piss me off</div>
      <div className="home-byline">
        By Ken Kai
        <span className="home-byline-sep">{"\u00b7"}</span>
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
        <span className="home-byline-sep">{"\u00b7"}</span>
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
      <div className="home-actions">
        <div className="home-projects-row home-primary-row">
          <button
            className={`btn btn-primary btn-lg home-btn${ready ? "" : " is-dimmed"}`}
            aria-disabled={!ready}
            onClick={() => handleWorkspace(onProjects)}
          >
            Code
          </button>
          <button
            className={`btn btn-primary btn-lg home-btn${ready ? "" : " is-dimmed"}`}
            aria-disabled={!ready}
            onClick={() => handleWorkspace(onChat)}
          >
            Chat
          </button>
          <button
            className="btn btn-ghost btn-icon btn-nav-icon home-settings"
            title="Settings"
            onClick={() => setShowSettings(true)}
          >
            <Settings size={20} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div className="home-projects-row">
          <button className="btn btn-ghost btn-lg home-btn" onClick={onLogin}>
            Login to AI Providers
          </button>
          <button
            className="btn btn-ghost btn-lg home-btn"
            title="Manage MCP servers"
            onClick={() => setShowMcp(true)}
          >
            MCP
          </button>
        </div>
        <div className="home-projects-row">
          <button
            className={`btn btn-ghost btn-lg home-btn${serving ? " home-serve-active" : ""}`}
            disabled={serveBusy}
            onClick={() => void handleServe()}
          >
            {serveBusy ? "Working\u2026" : serving ? "\u25CF Remote · Stop" : "Remote"}
          </button>
          <button
            className="btn btn-ghost btn-icon btn-nav-icon home-settings"
            title="Telegram setup"
            onClick={() => setShowTelegram(true)}
          >
            <Settings size={20} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onSaved={() => {
            setFolderSet(true);
            toast("Project folder saved.", "success");
          }}
        />
      )}
      {showTelegram && (
        <TelegramSettingsModal
          onClose={() => setShowTelegram(false)}
          onSaved={() => setTelegramConfigured(true)}
        />
      )}
      {showMcp && <McpModal onClose={() => setShowMcp(false)} />}
      {showScorecard && progress && (
        <ScorecardModal snapshot={progress} onClose={() => setShowScorecard(false)} />
      )}
    </div>
  );
}
