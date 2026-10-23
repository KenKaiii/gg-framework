import { useEffect, useId, useState } from "react";
import { openUrl, type RoyaleSummary, royaleStatus, royaleSummary } from "./agent";
import { Icon } from "./icons";
import { Modal } from "./Modal";
import { PlateButton } from "./PlateButton";
import { toast } from "./toast";

/** GG Royale's privacy notice, in the public GG Coder repo. */
export const ROYALE_PRIVACY_URL =
  "https://github.com/KenKaiii/gg-framework/blob/main/GG-ROYALE-PRIVACY.md";
export const ROYALE_CONTACT = "ken@kenkais.com";

/**
 * What the link box says. Bump ROYALE_CONSENT_VERSION whenever any of it
 * changes, so everyone is asked again (once) with the new wording.
 */
export const ROYALE_CONSENT_VERSION = 3;
export const ROYALE_CONSENT_LINES = [
  "Royale is an online blackjack game inside GG Coder. You play with chips you earn by coding and playing. There is no real money: nothing can be bought, sold or cashed out.",
  'Linking shares only that a run finished, how many commits it made, the kind of bug it fixed (like "test" or "type"), that a goal made progress, and that a deploy happened. Never your code, files, commands or prompts.',
  "Other players see your player name and what you say at a table. Be kind, and don't share personal info.",
  "You can delete all your Royale data any time, in the game under Privacy & credits.",
] as const;
const CONSENT_KEY = "gg-royale-consent";

/** The link-box version this computer last agreed to (0 = never). */
export function royaleConsentAccepted(): number {
  try {
    const n = Number(localStorage.getItem(CONSENT_KEY));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
function acceptRoyaleConsent(): void {
  try {
    localStorage.setItem(CONSENT_KEY, String(ROYALE_CONSENT_VERSION));
  } catch {
    // Private storage off: they'll simply be asked again next time.
  }
}
/** Forget the agreement, so the link box shows again (after deleting the data). */
export function forgetRoyaleConsent(): void {
  try {
    localStorage.removeItem(CONSENT_KEY);
  } catch {
    // Nothing stored.
  }
}

/**
 * The link box, in GG Royale's look: what the game is, what linking shares,
 * what others see, and an 18+ confirmation (casino-style games are adults-only
 * in Australia, even with play chips). "Let's play" works only once the
 * box is ticked.
 */
function RoyaleConsent({
  onAccept,
  onClose,
}: {
  onAccept: () => void;
  onClose: () => void;
}): React.ReactElement {
  const [adult, setAdult] = useState(false);
  const [nudge, setNudge] = useState(false);
  const tickId = useId();
  return (
    <Modal title="Royale" onClose={onClose} className="royale-consent">
      <div className="royale-consent-body">
        {ROYALE_CONSENT_LINES.map((line) => (
          <p key={line}>{line}</p>
        ))}
        <p className="royale-consent-links">
          <a
            href={ROYALE_PRIVACY_URL}
            onClick={(e) => {
              e.preventDefault();
              void openUrl(ROYALE_PRIVACY_URL);
            }}
          >
            Privacy notice
          </a>
          <span aria-hidden="true">·</span>
          <span>{ROYALE_CONTACT}</span>
        </p>
        <label
          className={`royale-consent-tick${nudge && !adult ? " is-nudged" : ""}`}
          htmlFor={tickId}
        >
          <input
            id={tickId}
            type="checkbox"
            checked={adult}
            onChange={(e) => {
              setAdult(e.target.checked);
              setNudge(false);
            }}
          />
          <span>I'm 18 or older</span>
        </label>
      </div>
      <div className="royale-consent-actions">
        <PlateButton label="Cancel" kind="wine" onClick={onClose} />
        <PlateButton
          label="Let's play"
          dimmed={!adult}
          onClick={() => {
            if (!adult) {
              setNudge(true);
              return;
            }
            acceptRoyaleConsent();
            onAccept();
          }}
        />
      </div>
    </Modal>
  );
}

/**
 * Enters GG Royale. It asks first (the link box) until this computer has
 * agreed to the current wording; after that it goes straight in. `onOpen`
 * shows the GG Royale screen in this window. Shared by the home screen's
 * Royale button and the Deck's Royale key.
 */
export function useRoyaleLauncher(onOpen: () => void): {
  launch: () => void;
  consent: React.ReactElement | null;
} {
  const [confirming, setConfirming] = useState(false);

  async function launch(): Promise<void> {
    try {
      const status = await royaleStatus();
      if (status.linked && royaleConsentAccepted() >= ROYALE_CONSENT_VERSION) onOpen();
      else setConfirming(true);
    } catch (e) {
      toast(`GG Royale: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  const consent = confirming ? (
    <RoyaleConsent
      onAccept={() => {
        setConfirming(false);
        onOpen();
      }}
      onClose={() => setConfirming(false)}
    />
  ) : null;

  return { launch: () => void launch(), consent };
}

/** How often a visible GG Royale button refreshes its badge. */
export const ROYALE_SUMMARY_INTERVAL_MS = 60_000;

/**
 * GG Royale badge counts: fetched on mount and every minute while the page is
 * visible, and only once linked, so unlinked users make no network calls.
 */
export function useRoyaleSummary(): RoyaleSummary | null {
  const [summary, setSummary] = useState<RoyaleSummary | null>(null);
  useEffect(() => {
    let alive = true;
    async function refresh(): Promise<void> {
      if (document.visibilityState === "hidden") return;
      try {
        if (!(await royaleStatus()).linked) {
          if (alive) setSummary(null);
          return;
        }
        const next = await royaleSummary();
        if (alive) setSummary(next);
      } catch {
        // A badge is decoration: keep the last value on a failed refresh.
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), ROYALE_SUMMARY_INTERVAL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  return summary;
}

/** Rewards waiting (red) beat people playing (subtle); nothing when zero. */
export function RoyaleBadge({
  summary,
}: {
  summary: RoyaleSummary | null;
}): React.ReactElement | null {
  if (!summary) return null;
  if (summary.claimable > 0) {
    const label = `${summary.claimable} ${summary.claimable === 1 ? "reward" : "rewards"} waiting`;
    return (
      <span className="royale-badge is-claim" role="status" aria-label={label} title={label}>
        {summary.claimable}
      </span>
    );
  }
  if (summary.playing > 0) {
    return (
      <span className="royale-badge" role="status">
        {summary.playing} playing
      </span>
    );
  }
  return null;
}

/** Deck key for GG Royale, next to Trophies in a workspace window. */
export function RoyaleKey({ onOpen }: { onOpen: () => void }): React.ReactElement {
  const { launch, consent } = useRoyaleLauncher(onOpen);
  const summary = useRoyaleSummary();
  return (
    <>
      <span className="royale-key-slot">
        <button
          type="button"
          className="key key-sm trophy-key"
          aria-label="GG Royale"
          title="GG Royale: online game mode"
          onClick={launch}
        >
          <Icon name="play" size={13} />
          <span className="well">Royale</span>
        </button>
        <RoyaleBadge summary={summary} />
      </span>
      {consent}
    </>
  );
}
