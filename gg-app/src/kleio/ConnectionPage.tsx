// Settings → Connection: how this device, the host and the other Kleio app
// reach each other. Everything runs on the host; the Mac and the iPhone are
// windows onto it, joined over Kleio's link, or by the host's address over
// Tailscale or your own network.
//
// - The verdict: in plain words, does it work, what was checked, and numbered
//   steps to fix it when it doesn't (connectionDiagnosis.ts). Over the link
//   it's diagnoseLink's, in the same words as the gate and the home screen.
// - Kleio's link (Rust: kleio/link.rs, macOS and iOS): that it's end-to-end
//   encrypted and what isn't, which way it goes and through which relay, its
//   numbers and path events under Details, and pairing by the host's address
//   under "Advanced: connect over your own network". Windows and Linux
//   builds don't show it.
// - Host: its name (or address), how quickly it replies, how this device is
//   paired.
// - Notifications: they come through Apple, so they aren't end-to-end
//   encrypted, and whether they quote what was said (the host's setting; an
//   admin device changes it).
// - Tailscale (a Mac paired by address): the private network's details.
// - Pair a device: a one-time pairing QR code an iPhone scans, with its
//   pairing text for a Mac, and Allow or Deny for the device that uses it
//   over the link (admin; PairingOffer.tsx). Leaving the page takes the code
//   away, as Done does.
// - Devices: every paired device, with the ones paired this week marked New,
//   and Revoke this device (admin).
//
// Replaces upstream's Telegram "Remote" page: the iPhone app is Kleio's remote.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ArrowClockwiseIcon,
  ArrowUpIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  DesktopIcon,
  DeviceMobileIcon,
  HardDrivesIcon,
  LockSimpleIcon,
  QuestionIcon,
  ShieldCheckIcon,
  TrashIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { openUrl } from "../agent";
import { Badge } from "../Badge";
import { isPhone } from "../platform";
import { SettingsCard } from "../settings-section";
import { SettingsHeaderAction, SettingsHeaderStatus } from "../settings-header";
import { theme } from "../theme";
import { toast, type ToastTone } from "../toast";
import {
  diagnose,
  isKleioDown,
  relayHost,
  unreachableReason,
  type Checked,
  type Diagnosis,
  type FixStep,
  type HealthCheck,
  type LinkHealth,
  type Tone,
} from "./connectionDiagnosis";
import { linkVerdict, REACH_TIMEOUT_MS } from "./hostReach";
import {
  hostHealth,
  KleioApiError,
  notificationSettings,
  type NotificationSettings,
  setQuoteText,
} from "./kleioApi";
import {
  adoptRelayList,
  refusedPings,
  type RelayList,
  relayList,
  type RelayPing,
  type RelayRow,
  type RelayState,
  setRelayList,
} from "./kleioRelays";
import {
  kleioLink,
  useKleioLink,
  type LinkStatus,
  type SwitchStatus,
  type TicketCheck,
} from "./kleioLink";
import { LinkConfirm, takesPairingText, TicketPaste, TicketScan } from "./LinkPairing";
import { noTicketWords, type OfferEnd, PairingOffer, useWithdrawOnClose } from "./PairingOffer";
import { readTicket } from "./pairTicket";
import { relTime } from "./relTime";
import { ForgetHost } from "./ForgetHost";
import { RestartNotice, UrlPairFields } from "./UrlPairing";
import { useFollowLatest } from "./useFollowLatest";
import {
  explainError,
  isNewDevice,
  kleio,
  useKleioRemote,
  type Device as PairedDevice,
  type Forgot,
  type PairOffer,
  type TailscaleStatus,
} from "./useKleioRemote";

const REFRESH_MS = 15_000;
/** The link card reads the link this often. Reading never dials. */
const LINK_REFRESH_MS = 3_000;
/** Path events the link card shows: the latest, as many as the link keeps
 *  (`KEPT_EVENTS` in `link.rs`). */
const LINK_EVENTS_SHOWN = 20;
/** What n0's relay is, and how it did in the connection prototype's field tests. */
export const N0_RELAY_LINE =
  "The default relay is n0's: free, shared with other apps, and rate-limited. We measured about 1 MB/s. 73% of our test phone's connection time went through it, and on EE 4G no connection went direct.";

type Device = "Mac" | "iPhone";

/** One round of checks, with whether this device had a network at the time. */
interface Checks {
  health: HealthCheck;
  /** The check failed with the host's link answering for a stopped Kleio (its 502). */
  kleioDown: boolean;
  /** `null` on the iPhone, which can't read its own Tailscale, and over the link. */
  net: Checked<TailscaleStatus> | null;
  online: boolean;
}

const TONE_COLOR: Record<Tone, string> = {
  good: theme.success,
  warn: theme.warning,
  bad: theme.error,
};

export function shortName(host: string): string {
  return host.split(".")[0] ?? host;
}

/** "12 ms" / "1.2 s": how quick the Mac mini answered. */
export function formatLatency(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The HTTP status a failed call carries; 0 when nothing replied. */
function statusOf(e: unknown): number {
  if (typeof e !== "object" || e === null || !("status" in e)) return 0;
  return typeof e.status === "number" ? e.status : 0;
}

/** A round of checks as diagnoseLink reads it. */
function linkHealthOf(checks: Checks): LinkHealth {
  return checks.health.state === "ok"
    ? { state: "ok", value: checks.health.value }
    : { state: "error", kleioDown: checks.kleioDown };
}

export function ConnectionPage(): React.ReactElement {
  const { status, refresh: refreshRemote } = useKleioRemote();
  // Read here for the verdict and the map as well as the link card.
  const { link, setLink } = useKleioLink(LINK_REFRESH_MS);
  const active = status?.active ?? null;
  const paired = status?.paired ?? null;
  const phone = isPhone();
  const device: Device = phone ? "iPhone" : "Mac";
  // Whether this launch reaches the host over the link: unknown until the
  // link answers, or turns out not to be in this build, so the first check
  // already knows which way it goes.
  const overLink = link === undefined ? undefined : link?.active === true;
  const [checks, setChecks] = useState<Checks | null>(null);
  const [checking, setChecking] = useState(false);
  // The devices Pair a device has paired here: each joins the Devices list.
  const [pairings, setPairings] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const check = useCallback(async () => {
    if (overLink === undefined) return;
    setChecking(true);
    const [h, t] = await Promise.allSettled([
      hostHealth(REACH_TIMEOUT_MS),
      // Tailscale says nothing about the link, and the iPhone can't read it.
      phone || overLink ? Promise.resolve(null) : kleio.tailscale(),
    ]);
    if (!alive.current) return;
    setChecks({
      health:
        h.status === "fulfilled"
          ? { state: "ok", value: h.value }
          : {
              state: "error",
              reason: unreachableReason(statusOf(h.reason), explainError(h.reason)),
            },
      kleioDown:
        h.status === "rejected" &&
        h.reason instanceof KleioApiError &&
        isKleioDown(h.reason.status, h.reason.message),
      net:
        t.status === "rejected"
          ? { state: "error" }
          : t.value === null
            ? null
            : { state: "ok", value: t.value },
      online: navigator.onLine,
    });
    setChecking(false);
  }, [phone, overLink]);

  useEffect(() => {
    if (overLink === undefined) return;
    void check();
    const id = window.setInterval(() => void check(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [check, overLink]);

  const hostLabel = shortName(active?.host ?? paired?.host ?? "Host");
  const linkInUse = overLink === true && link ? link : null;

  // Whether the host's notifications quote what was said: its Notifications
  // card, and the link card's words about what isn't end-to-end encrypted.
  const [notices, setNotices] = useState<Notices>({ state: "loading" });
  const pairedId = active?.deviceId ?? null;
  useEffect(() => {
    if (pairedId === null) return;
    let live = true;
    notificationSettings().then(
      (s) => {
        if (live) setNotices({ state: "ok", quoteText: s.quoteText });
      },
      (e: unknown) => {
        if (!live) return;
        // A host from before the setting turns the route away.
        const old = e instanceof KleioApiError && (e.status === 404 || e.status === 403);
        setNotices({ state: "error", old, message: explainError(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [pairedId]);
  const verdict = !checks
    ? null
    : linkInUse
      ? linkVerdict(linkInUse, linkHealthOf(checks))
      : diagnose({
          health: checks.health,
          net: checks.net,
          online: checks.online,
          hostLabel,
          device,
        });
  const health = checks?.health ?? null;

  return (
    <>
      <SettingsHeaderStatus>
        <Badge color={verdict ? TONE_COLOR[verdict.tone] : undefined}>
          {verdict?.badge ?? "Checking…"}
        </Badge>
      </SettingsHeaderStatus>
      <SettingsHeaderAction>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={checking}
          onClick={() => void check()}
        >
          <ArrowClockwiseIcon size={14} weight="bold" aria-hidden="true" />
          {checking ? "Checking…" : "Check again"}
        </button>
      </SettingsHeaderAction>

      <ConnectionMap
        device={device}
        hostLabel={hostLabel}
        health={health}
        via={linkInUse ? "Kleio's link" : "Tailscale"}
        {...firstLeg(checks, linkInUse, phone)}
      />

      <Verdict verdict={verdict} hostLabel={hostLabel} />

      <div className="settings-cols">
        <div className="settings-col">
          <LinkCard
            link={link}
            setLink={setLink}
            device={device}
            hostLabel={hostLabel}
            quoteText={notices.state === "ok" ? notices.quoteText : null}
            onPaired={() => void refreshRemote()}
            byAddress={active !== null && link?.active !== true}
            admin={active?.admin ?? false}
          />

          <SettingsCard
            title="Host"
            description="Kleio's brain lives here. Chats, specialists and code all run on it, so they keep going when this device sleeps."
          >
            <dl className="conn-facts">
              {linkInUse ? (
                <Fact label="Name">
                  <code className="conn-code">{active?.host ?? linkInUse.host ?? "—"}</code>
                </Fact>
              ) : (
                <Fact label="Address">
                  <code className="conn-code">
                    {active?.base ?? paired?.baseUrl ?? "Not paired"}
                  </code>
                </Fact>
              )}
              {health?.state === "ok" && (
                <Fact label="Reply time">{formatLatency(health.value.latencyMs)}</Fact>
              )}
              <Fact label={`This ${device}`}>
                {active ? (
                  <>
                    “{active.label}”
                    {active.admin && (
                      <Badge color={theme.warning} className="conn-inline-badge">
                        Admin
                      </Badge>
                    )}
                  </>
                ) : (
                  "Not paired"
                )}
              </Fact>
              {paired && <Fact label="Paired">{relTime(paired.pairedAt)}</Fact>}
            </dl>
            {/* Forgotten in this launch: it applies on the next. */}
            {paired ? (
              <ForgetHost compact onForgot={refreshRemote} />
            ) : (
              active && <RestartNotice what="You just forgot the host." />
            )}
          </SettingsCard>

          {active && (
            <NotificationsCard
              notices={notices}
              admin={active.admin}
              device={device}
              hostLabel={hostLabel}
              onSaved={(s) => setNotices({ state: "ok", quoteText: s.quoteText })}
            />
          )}

          {active && <RelaysCard admin={active.admin} hostLabel={hostLabel} />}

          {!phone && overLink === false && (
            <TailscaleCard net={checks === null ? undefined : checks.net} hostLabel={hostLabel} />
          )}
        </div>

        <div className="settings-col">
          <PairDeviceCard
            baseUrl={active?.base ?? null}
            admin={active?.admin ?? false}
            onDone={(how) => {
              void check();
              if (how === "paired") setPairings((n) => n + 1);
            }}
          />
          <DevicesCard
            admin={active?.admin ?? false}
            selfId={active?.deviceId ?? null}
            pairings={pairings}
            onChanged={() => {
              void refreshRemote();
              void check();
            }}
          />
        </div>
      </div>
    </>
  );
}

// ─── the verdict: does it work, what was checked, how to fix it ─────────────

function ToneIcon({ tone, size }: { tone: Tone | "unknown"; size: number }): React.ReactElement {
  if (tone === "good") return <CheckCircleIcon size={size} weight="fill" aria-hidden="true" />;
  if (tone === "warn") return <WarningCircleIcon size={size} weight="fill" aria-hidden="true" />;
  if (tone === "bad") return <XCircleIcon size={size} weight="fill" aria-hidden="true" />;
  return <QuestionIcon size={size} weight="bold" aria-hidden="true" />;
}

function Verdict({
  verdict,
  hostLabel,
}: {
  /** `null` until the first check finishes. */
  verdict: Diagnosis | null;
  hostLabel: string;
}): React.ReactElement {
  if (!verdict) {
    return (
      <section className="conn-verdict" aria-label="Connection check">
        <p className="conn-verdict-detail" role="status">
          Checking the connection to {hostLabel}…
        </p>
      </section>
    );
  }
  return (
    <section className={`conn-verdict is-${verdict.tone}`} aria-label="Connection check">
      <span className="conn-verdict-icon">
        <ToneIcon tone={verdict.tone} size={22} />
      </span>
      <div className="conn-verdict-body">
        <div role="status">
          <h3 className="conn-verdict-title">{verdict.headline}</h3>
          <p className="conn-verdict-detail">{verdict.detail}</p>
        </div>
        <ul className="conn-checks" aria-label="What was checked">
          {verdict.checks.map((c) => (
            <li key={c.label} className={`conn-check is-${c.tone}`}>
              <ToneIcon tone={c.tone} size={15} />
              <span className="conn-check-label">{c.label}</span>
              <span className="conn-check-text">{c.text}</span>
            </li>
          ))}
        </ul>
        {verdict.fix.length > 0 && (
          <div className="conn-fix">
            <h4 className="conn-fix-title">How to fix it</h4>
            <ol className="conn-steps">
              {verdict.fix.map((step) => (
                <li key={step.text}>
                  <FixStepText step={step} />
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </section>
  );
}

function FixStepText({ step }: { step: FixStep }): React.ReactElement {
  const { link, command } = step;
  return (
    <>
      {step.text}
      {link && (
        <button
          type="button"
          className="btn btn-ghost btn-sm conn-fix-link"
          onClick={() => void openUrl(link.url)}
        >
          {link.label}
        </button>
      )}
      {command && <CommandLine command={command} />}
    </>
  );
}

/** A command to run on the Mac mini, with a button that copies it. */
function CommandLine({ command }: { command: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);
  return (
    <span className="conn-command">
      {/* Wraps only between words: a break inside `-k` or a name would misread. */}
      <code>
        {command.split(" ").map((word, i) => (
          <span key={`${i}:${word}`}>
            {i > 0 && " "}
            <span className="conn-command-word">{word}</span>
          </span>
        ))}
      </code>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => {
          navigator.clipboard.writeText(command).then(
            () => setCopied(true),
            () => toast("Couldn't copy. Select the command and copy it instead.", "error"),
          );
        }}
      >
        {copied ? (
          <CheckIcon size={13} weight="bold" aria-hidden="true" />
        ) : (
          <CopyIcon size={13} weight="bold" aria-hidden="true" />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="conn-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// ─── the map: this device ── the way in ── host ── the way in ── the other ──

type NodeState = "is-up" | "is-down" | "is-unknown" | "is-idle";

/**
 * The map's first leg, this device to the host, and this device's end of it.
 * Over the link, from what the link says; otherwise from Tailscale here.
 */
function firstLeg(
  checks: Checks | null,
  link: LinkStatus | null,
  phone: boolean,
): { linkUp: boolean; selfState: NodeState; selfDetail: string } {
  const reached = checks?.health.state === "ok";
  const app = phone ? "Kleio app" : "Kleio Desktop";
  if (link) {
    // This device's side is down when its link can't work from here.
    const down =
      !link.running ||
      link.refusal !== null ||
      link.unreached?.kind === "no-relay" ||
      checks?.online === false;
    return {
      linkUp: reached || link.connected,
      selfState: !checks ? "is-unknown" : down ? "is-down" : "is-up",
      selfDetail: app,
    };
  }
  const net = checks?.net?.state === "ok" ? checks.net.value : null;
  return {
    linkUp: reached || (net?.running === true && net.host?.online === true),
    // A reply from the host proves this device's Tailscale works, even on
    // the iPhone, where the app can't read Tailscale itself.
    selfState: net ? (net.running ? "is-up" : "is-down") : reached ? "is-up" : "is-unknown",
    selfDetail: net?.self?.name ?? app,
  };
}

function ConnectionMap({
  device,
  hostLabel,
  health,
  via,
  linkUp,
  selfState,
  selfDetail,
}: {
  device: Device;
  hostLabel: string;
  /** `null` until the first check finishes. */
  health: HealthCheck | null;
  /** How the devices reach the host: Kleio's link, or Tailscale. */
  via: string;
  linkUp: boolean;
  selfState: NodeState;
  selfDetail: string;
}): React.ReactElement {
  const hostKnown = health !== null;
  const hostUp = health?.state === "ok" && health.value.sidecar === "up";
  const phone = device === "iPhone";
  const desktop = <DesktopIcon size={26} weight="duotone" aria-hidden="true" />;
  const mobile = <DeviceMobileIcon size={26} weight="duotone" aria-hidden="true" />;
  return (
    <section className="conn-map" aria-label="How your devices connect">
      <MapNode
        icon={phone ? mobile : desktop}
        name={`This ${device}`}
        detail={selfDetail}
        state={selfState}
      />
      <MapLink up={linkUp} known={hostKnown} label={via} />
      <MapNode
        icon={<HardDrivesIcon size={30} weight="duotone" aria-hidden="true" />}
        name={hostLabel}
        detail="Kleio host"
        state={!hostKnown ? "is-unknown" : hostUp ? "is-up" : "is-down"}
        hub
      />
      <MapLink up={hostUp} known={hostKnown} label={via} />
      <MapNode
        icon={phone ? desktop : mobile}
        name={phone ? "Mac" : "iPhone"}
        detail={phone ? "Kleio Desktop" : "Kleio app"}
        state="is-idle"
      />
    </section>
  );
}

function MapNode({
  icon,
  name,
  detail,
  state,
  hub = false,
}: {
  icon: React.ReactNode;
  name: string;
  detail: string;
  state: NodeState;
  hub?: boolean;
}): React.ReactElement {
  return (
    <div className={`conn-node ${state}${hub ? " is-hub" : ""}`}>
      <span className="conn-node-icon">
        {icon}
        <span className="conn-node-dot" aria-hidden="true" />
      </span>
      <span className="conn-node-name">{name}</span>
      <span className="conn-node-detail">{detail}</span>
    </div>
  );
}

function MapLink({
  up,
  known,
  label,
}: {
  up: boolean;
  known: boolean;
  label: string;
}): React.ReactElement {
  return (
    <div
      className={`conn-link ${!known ? "is-unknown" : up ? "is-up" : "is-down"}`}
      aria-hidden="true"
    >
      <span className="conn-link-line" />
      <span className="conn-link-label">
        <LockSimpleIcon size={11} weight="bold" />
        {label}
      </span>
    </div>
  );
}

// ─── Tailscale (Mac only: the iPhone app can't read the phone's Tailscale) ──

function TailscaleCard({
  net,
  hostLabel,
}: {
  /** `undefined` until the first check finishes. */
  net: Checked<TailscaleStatus> | null | undefined;
  hostLabel: string;
}): React.ReactElement {
  const ts = net?.state === "ok" ? net.value : null;
  return (
    <SettingsCard
      title="Tailscale"
      description="The private network between your devices. Nothing is open to the internet."
    >
      {net === undefined ? (
        <p className="settings-desc">Checking Tailscale on this Mac…</p>
      ) : !ts ? (
        <p className="settings-desc">Couldn't read Tailscale's settings on this Mac.</p>
      ) : !ts.installed ? (
        <p className="settings-desc">Not installed on this Mac yet.</p>
      ) : !ts.running ? (
        <p className="settings-desc">
          Tailscale isn't connected on this Mac, so there's nothing to show yet.
        </p>
      ) : (
        <dl className="conn-facts">
          {ts.tailnet && <Fact label="Account">{ts.tailnet}</Fact>}
          {ts.self && <Fact label="This Mac">{ts.self.name}</Fact>}
          {ts.host?.ip && (
            <Fact label={hostLabel}>
              <code className="conn-code">{ts.host.ip}</code>
            </Fact>
          )}
          {ts.version && <Fact label="Version">{ts.version.split("-")[0]}</Fact>}
        </dl>
      )}
      {ts && ts.health.length > 0 && (
        <div className="conn-health-box">
          <p className="conn-fix-title">Tailscale says</p>
          <ul className="conn-health">
            {ts.health.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
      )}
    </SettingsCard>
  );
}

// ─── Kleio's link ───────────────────────────────────────────────────────────

/** `14:06:21`, this device's time. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

function LinkBadge({ link }: { link: LinkStatus }): React.ReactElement {
  if (!link.active) {
    return link.paired ? (
      <Badge color={theme.warning}>Not in use</Badge>
    ) : (
      <Badge>Not paired</Badge>
    );
  }
  if (link.error !== null || !link.running) return <Badge color={theme.error}>Not running</Badge>;
  if (link.refusal !== null) return <Badge color={theme.error}>Turned away</Badge>;
  if (!link.connected) {
    return <Badge color={theme.warning}>{link.dialling ? "Reconnecting" : "Not connected"}</Badge>;
  }
  if (link.rateLimited) return <Badge color={theme.warning}>Slowed</Badge>;
  return link.path === "direct" ? (
    <Badge color={theme.success}>Direct</Badge>
  ) : (
    <Badge>Relay</Badge>
  );
}

/** Which way the open connection goes. */
function linkPath(link: LinkStatus): React.ReactNode {
  if (!link.connected) {
    return link.dialling ? "Reconnecting…" : "No connection open. The next request dials.";
  }
  if (link.path === "direct") {
    return (
      <>
        Direct <code className="conn-code">{link.pathAddr}</code>
      </>
    );
  }
  if (link.path !== "relay") return "Connected";
  const own = relayHost(link.pathAddr);
  const through = link.pathN0
    ? "Through n0's public relay"
    : `Through your relay${own ? ` (${own})` : ""}`;
  return link.rateLimited ? `${through}, slowed by the relay` : through;
}

/** The host's relay, by name: one of n0's, or the host's own. */
function linkRelay(link: LinkStatus): React.ReactNode {
  const host = relayHost(link.relay);
  if (!host) return "—";
  const name = <code className="conn-code">{host}</code>;
  return link.relayN0 ? <>n0&apos;s public relay {name}</> : name;
}

/** What the host's notifications are, for `device`'s own words. */
function notificationsName(device: Device): string {
  return device === "iPhone"
    ? "Notifications and Live Activities"
    : "iPhone notifications and Live Activities";
}

/**
 * What isn't end-to-end encrypted: the host's notifications and Live
 * Activities go through Apple, with the start of a reply, question or error
 * unless the host quotes nothing (`quoteText` false). Unknown is taken as
 * quoting, as hosts did before the setting.
 */
function notificationsLine(device: Device, quoteText: boolean | null): string {
  const what = notificationsName(device);
  return quoteText === false
    ? `${what} aren't end-to-end encrypted: Apple delivers them, but they quote nothing that was said.`
    : `${what} aren't end-to-end encrypted: Apple delivers them, with the start of a reply, question or error.`;
}

/** The host's notifications setting, as the page holds it. */
type Notices =
  | { state: "loading" }
  | { state: "ok"; quoteText: boolean }
  /** `old`: a host from before the setting. */
  | { state: "error"; old: boolean; message: string };

const QUOTE_ON =
  "They quote the start of a reply, question or error, and some questions can be answered from the lock screen.";
const QUOTE_OFF =
  "They say what happened, such as Finished or Needs your answer, but quote nothing. Questions are answered in Kleio.";

/**
 * Notifications: they come through Apple, so they aren't end-to-end
 * encrypted. An admin device chooses whether they quote what was said; any
 * other device sees the choice.
 */
function NotificationsCard({
  notices,
  admin,
  device,
  hostLabel,
  onSaved,
}: {
  notices: Notices;
  admin: boolean;
  device: Device;
  hostLabel: string;
  onSaved: (settings: NotificationSettings) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descId = useId();

  async function choose(quoteText: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onSaved(await setQuoteText(quoteText));
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      title="Notifications"
      description={`${notificationsName(device)} come through Apple, so they aren't end-to-end encrypted like your chats.`}
    >
      {notices.state === "error" ? (
        <p className="settings-desc">
          {notices.old
            ? `Kleio on ${hostLabel} can't leave text out of notifications yet. Update it to choose.`
            : notices.message}
        </p>
      ) : (
        <div className="kleio-setting">
          <span className="kleio-setting-text">
            <span className="kleio-setting-name">Quote what was said</span>
            <span className="kleio-setting-desc" id={descId}>
              {notices.state === "loading" ? "Checking…" : notices.quoteText ? QUOTE_ON : QUOTE_OFF}
            </span>
          </span>
          <label className="cl-switch kleio-switch">
            <input
              type="checkbox"
              aria-label="Quote what was said"
              aria-describedby={descId}
              checked={notices.state === "ok" && notices.quoteText}
              disabled={!admin || busy || notices.state !== "ok"}
              onChange={(e) => void choose(e.target.checked)}
            />
            <span />
          </label>
        </div>
      )}
      {!admin && notices.state === "ok" && (
        <p className="settings-desc">Only an admin device can change this.</p>
      )}
      {error && (
        <p className="conn-bad" role="alert">
          {error}
        </p>
      )}
    </SettingsCard>
  );
}

/** A part of a card that opens on request. */
function Disclosure({
  summary,
  onOpen,
  children,
}: {
  summary: string;
  onOpen?: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <details
      className="conn-disclosure"
      onToggle={(e) => {
        if (e.currentTarget.open) onOpen?.();
      }}
    >
      <summary className="conn-disclosure-summary">
        <CaretRightIcon
          size={13}
          weight="bold"
          aria-hidden="true"
          className="conn-disclosure-caret"
        />
        {summary}
      </summary>
      <div className="conn-disclosure-body">{children}</div>
    </details>
  );
}

/**
 * The link card, the page's main one: that the link is end-to-end encrypted
 * and what isn't, which way it goes and through which relay, its numbers and
 * path events under Details, and pairing by the host's address under
 * Advanced. A device not paired over the link pairs here too. Nothing in a
 * build without the link.
 */
function LinkCard({
  link,
  setLink,
  device,
  hostLabel,
  quoteText,
  onPaired,
  byAddress,
  admin,
}: {
  /** `undefined` until the link answers; `null` in a build without it. */
  link: LinkStatus | null | undefined;
  setLink: (status: LinkStatus) => void;
  device: Device;
  hostLabel: string;
  /** Whether the host's notifications quote what was said; null while unknown. */
  quoteText: boolean | null;
  onPaired: () => void;
  /** This launch reaches the host by its address (Tailscale), not the link. */
  byAddress: boolean;
  /** This device is an admin on the host. */
  admin: boolean;
}): React.ReactElement | null {
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [ticket, setTicket] = useState<{ ticket: string; check: TicketCheck } | null>(null);
  const [label, setLabel] = useState("");
  const [switchStatus, setSwitchStatus] = useState<SwitchStatus | null>(null);
  const [removing, setRemoving] = useState(false);

  // A switch's cleanup, while there's an old pairing to put away (switch.rs).
  useEffect(() => {
    if (!link?.paired) return;
    let live = true;
    kleioLink.switchStatus().then(
      (s) => live && setSwitchStatus(s),
      () => live && setSwitchStatus(null),
    );
    return () => {
      live = false;
    };
  }, [link?.paired, link?.connected]);
  if (!link) return null;

  /** An admin device switches with an admin code of its own: one Touch ID, nothing to paste. */
  async function switchHere(): Promise<void> {
    setError(null);
    setChecking(true);
    try {
      const offer = await kleio.offer(true);
      if (!offer.ticket) {
        setError(noTicketWords(offer.ticketError));
        return;
      }
      setTicket({ ticket: offer.ticket, check: await kleioLink.checkTicket(offer.ticket) });
    } catch (e) {
      setError(explainError(e));
    } finally {
      setChecking(false);
    }
  }

  async function removeOld(): Promise<void> {
    setError(null);
    setRemoving(true);
    try {
      await kleioLink.removeOld();
      setSwitchStatus(await kleioLink.switchStatus().catch(() => null));
      onPaired();
    } catch (e) {
      setError(explainError(e));
    } finally {
      setRemoving(false);
    }
  }

  async function openTicket(text: string): Promise<void> {
    setError(null);
    const route = readTicket(text);
    if (route.kind !== "link") {
      setError(
        route.kind === "v2"
          ? "That's a Tailscale pairing ticket. This card pairs over the Kleio link."
          : route.error,
      );
      return;
    }
    setChecking(true);
    try {
      setTicket({ ticket: route.ticket, check: await kleioLink.checkTicket(route.ticket) });
    } catch (e) {
      setError(explainError(e));
    } finally {
      setChecking(false);
    }
  }

  // This launch goes over the link, even after its pairing is set aside.
  const inUse = link.active && link.error === null;
  const phone = device === "iPhone";
  return (
    <SettingsCard
      title="Kleio's link"
      badge={<LinkBadge link={link} />}
      description={
        link.active
          ? `Your chats travel end-to-end encrypted between this ${device} and ${hostLabel}. Relays pass them on but can't read them.`
          : "Reaches your host from anywhere, end-to-end encrypted, with no Tailscale needed."
      }
    >
      {link.active && <p className="settings-desc">{notificationsLine(device, quoteText)}</p>}
      {!link.paired && !link.active ? (
        ticket ? (
          <LinkConfirm
            ticket={ticket.ticket}
            check={ticket.check}
            label={label}
            onLabel={setLabel}
            onBack={() => setTicket(null)}
            onPaired={(now) => {
              if (now) setLink(now);
              setTicket(null);
              onPaired();
            }}
          />
        ) : (
          <>
            {byAddress ? (
              <p className="settings-desc">{switchWords(device, hostLabel, admin)}</p>
            ) : (
              <p className="settings-desc">Not paired over the link.</p>
            )}
            {byAddress && admin && (
              <div className="conn-row">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={checking}
                  onClick={() => void switchHere()}
                >
                  {checking ? "Making a pair code…" : "Switch to Kleio's link"}
                </button>
              </div>
            )}
            {phone && <TicketScan busy={checking} onTicket={(text) => void openTicket(text)} />}
            {takesPairingText(link) && (
              <TicketPaste busy={checking} onTicket={(text) => void openTicket(text)} />
            )}
          </>
        )
      ) : !link.active ? (
        <p className="settings-desc">
          Paired over the link with {link.host ? shortName(link.host) : "the host"}.{" "}
          {phone ? "Close Kleio and open it again to use it." : "Restart Kleio to use it."}
          {byAddress &&
            ` Your pairing over Tailscale stays until the link has reached ${hostLabel}, as the way back.`}
        </p>
      ) : !link.paired ? (
        <p className="settings-desc">
          This {device}&apos;s link pairing was removed. Kleio keeps using the link until{" "}
          {phone ? "you close it and open it again." : "it restarts."}
        </p>
      ) : null}
      {/* Over the link, the verdict above says why it isn't running. */}
      {!link.active && link.error !== null && (
        <p className="conn-bad" role="alert">
          {link.error}
        </p>
      )}
      {(link.paired || link.active) && (
        <dl className="conn-facts">
          {inUse && (
            <>
              <Fact label="Path">{linkPath(link)}</Fact>
              <Fact label="Round trip">
                {link.connected && link.rttMs !== null ? formatLatency(link.rttMs) : "—"}
              </Fact>
            </>
          )}
          <Fact label="Relay">{linkRelay(link)}</Fact>
        </dl>
      )}
      {inUse && link.relayN0 && <p className="settings-desc">{N0_RELAY_LINE}</p>}
      {switchStatus && switchStatus.state !== "none" && (
        <SwitchCleanup
          status={switchStatus}
          device={device}
          hostLabel={hostLabel}
          removing={removing}
          onRemove={() => void removeOld()}
        />
      )}
      {error && (
        <p className="conn-bad" role="alert">
          {error}
        </p>
      )}
      {inUse && <LinkDetails link={link} />}
      <Disclosure summary="Advanced: connect over your own network">
        <OwnNetworkForm
          device={device}
          hostLabel={hostLabel}
          linkPaired={link.paired}
          onPaired={onPaired}
        />
      </Disclosure>
    </SettingsCard>
  );
}

/** What a device paired by address is offered, to switch to the link. */
export function switchWords(device: Device, hostLabel: string, admin: boolean): string {
  const how = admin
    ? `It pairs again with a code of its own, so this ${device} stays an admin.`
    : device === "iPhone"
      ? "Scan a pairing QR code from an admin device's Settings → Connection."
      : "Paste pairing text from an admin device's Settings → Connection.";
  return `This ${device} reaches ${hostLabel} over Tailscale. Switch to Kleio's link: no Tailscale needed. ${how} Your pairing over Tailscale stays until the link has reached ${hostLabel}.`;
}

/** What the switch's cleanup is waiting for, and the way out when the host refused. */
function SwitchCleanup({
  status,
  device,
  hostLabel,
  removing,
  onRemove,
}: {
  status: SwitchStatus;
  device: Device;
  hostLabel: string;
  removing: boolean;
  onRemove: () => void;
}): React.ReactElement | null {
  const old = `This ${device}'s old pairing over Tailscale`;
  switch (status.state) {
    case "none":
      return null;
    case "waiting-for-link":
      return (
        <p className="settings-desc">
          {old} stays until the link has reached {hostLabel}: it's the way back.
        </p>
      );
    case "pending":
      return <p className="settings-desc">{old} is removed the next time the link connects.</p>;
    case "waiting-for-host":
      return (
        <p className="settings-desc" role="status">
          {old} is removed once {hostLabel} answers over Tailscale. Kleio tries again each time the
          link connects.{status.reason ? ` Last try: ${status.reason}` : ""}
        </p>
      );
    case "unfinished":
      return (
        <p className="settings-desc" role="status">
          {hostLabel} dropped {old.replace("This", "this")}, but a part of it is still on this{" "}
          {device}. Kleio removes it the next time the link connects.
          {status.reason ? ` (${status.reason})` : ""}
        </p>
      );
    case "refused":
      return (
        <>
          <p className="conn-bad" role="alert">
            {status.reason ?? `${hostLabel} won't remove ${old.replace("This", "this")}.`} The link
            works, so it can be removed from this {device}. {hostLabel} lists it until an admin
            revokes it.
          </p>
          <div className="conn-row">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={removing}
              onClick={onRemove}
            >
              {removing ? "Removing…" : `Remove it from this ${device}`}
            </button>
          </div>
        </>
      );
  }
}

/** The link's numbers and recent path events, for a closer look. */
function LinkDetails({ link }: { link: LinkStatus }): React.ReactElement {
  const eventsRef = useRef<HTMLDivElement>(null);
  const { catchUp, handlers: followHandlers } = useFollowLatest(eventsRef);
  // Each refresh replaces the events: a reader at the newest is carried
  // along, one scrolled up to read isn't.
  useEffect(() => {
    catchUp();
  }, [link.events, catchUp]);
  const events = link.events.slice(-LINK_EVENTS_SHOWN);
  return (
    // Closed, the box has no height to scroll; opened, it starts at the newest.
    <Disclosure summary="Details" onOpen={catchUp}>
      <dl className="conn-facts">
        <Fact label="Connected">
          {link.connected && link.connectedSinceMs !== null
            ? `Since ${clock(link.connectedSinceMs)}, ${relTime(new Date(link.connectedSinceMs).toISOString())}`
            : "—"}
        </Fact>
        <Fact label="Redials">{String(link.redials)}</Fact>
        <Fact label="Last resume">
          {link.lastResumeMs !== null ? formatLatency(link.lastResumeMs) : "None yet"}
        </Fact>
        {link.hostKey && (
          <Fact label="Host key">
            <code className="conn-code">{link.hostKey.slice(0, 10)}…</code>
          </Fact>
        )}
      </dl>
      <div>
        <p className="conn-fix-title" id="conn-link-events">
          Path events
        </p>
        <div
          ref={eventsRef}
          className="conn-link-events-box"
          role="region"
          aria-labelledby="conn-link-events"
          tabIndex={0}
          {...followHandlers}
        >
          {events.length === 0 ? (
            <p className="settings-desc">None yet.</p>
          ) : (
            <ol className="conn-link-events" aria-labelledby="conn-link-events">
              {events.map((event, i) => (
                <li key={`${event.atMs}:${i}`}>
                  <time dateTime={new Date(event.atMs).toISOString()}>{clock(event.atMs)}</time>
                  <span>{event.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </Disclosure>
  );
}

/**
 * What a pairing by address says about the link pairing it set aside, from
 * what that pairing's host said when asked to remove it. `sticky`: it stays
 * until dismissed, as the host still lists it.
 */
function setAsideWords(
  setAside: Forgot | null,
  device: Device,
): { message: string; tone: ToastTone; sticky: boolean } | null {
  switch (setAside?.onHost) {
    case "removed":
      return {
        message: `The host removed this ${device}'s link pairing.`,
        tone: "success",
        sticky: false,
      };
    case "refused":
      return {
        message: `This ${device}'s link pairing was set aside here. The host turned its token away (HTTP 401), so it may have been revoked already. If the host still lists it, an admin can revoke it.`,
        tone: "warning",
        sticky: true,
      };
    case "notRemoved":
      return {
        message: `This ${device}'s link pairing was set aside here only: ${setAside.reason}. The host lists it until an admin revokes it.`,
        tone: "warning",
        sticky: true,
      };
    default:
      return null;
  }
}

/**
 * Today's pairing form, for a host this device reaches over Tailscale,
 * another VPN or its own network: its https address and a pair code. The
 * pairing replaces this device's from the next launch (`kleio_pair`). A
 * link pairing it replaces is set aside, and its host asked to remove it.
 */
function OwnNetworkForm({
  device,
  hostLabel,
  linkPaired,
  onPaired,
}: {
  device: Device;
  hostLabel: string;
  linkPaired: boolean;
  onPaired: () => void;
}): React.ReactElement {
  const [baseUrl, setBaseUrl] = useState("");
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const paired = await kleio.pair(baseUrl, code, label);
      const words = setAsideWords(paired.setAside, device);
      if (words?.sticky) toast(words.message, words.tone, 0);
      else if (words) toast(words.message, words.tone);
      await kleio.activatePairing();
      setDone(true);
      onPaired();
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) return <RestartNotice what="Paired over your own network." />;
  return (
    <form
      className="conn-own-network"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="settings-desc">
        For a host this {device} reaches over Tailscale, another VPN or your own network, at an
        https address. Run <code className="conn-code">kleio-host pair</code> on {hostLabel} for a
        code.
      </p>
      <UrlPairFields
        baseUrl={baseUrl}
        code={code}
        label={label}
        onBaseUrl={setBaseUrl}
        onCode={setCode}
        onLabel={setLabel}
        busy={busy}
      />
      <p className="settings-desc">
        {linkPaired
          ? `Pairing here replaces this ${device}'s link pairing from the next launch, and asks ${hostLabel} to remove it. If it can't be reached, ${hostLabel} lists the link pairing until an admin revokes it.`
          : `Pairing here replaces this ${device}'s pairing from the next launch. ${hostLabel} still lists the old one until an admin revokes it.`}
      </p>
      {error && (
        <p className="conn-bad" role="alert">
          {error}
        </p>
      )}
      <div className="conn-row">
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={busy || !baseUrl || !code}
        >
          {busy ? "Pairing…" : "Pair"}
        </button>
      </div>
    </form>
  );
}

// ─── relays: the link's relay list, as an admin changes it ──────────────────

/** "Run your own relay" in kleio-link's README. */
const OWN_RELAY_DOCS =
  "https://github.com/fmckie/gg-framework/blob/main/packages/kleio-link/README.md#run-your-own-relay";

/** A relay in the list, in words: n0's, or its host name. */
export function relayName(entry: string): string {
  if (entry === "n0") return "n0's public relays";
  try {
    return new URL(entry).host;
  } catch {
    return entry;
  }
}

/** A relay's state, in words. */
const RELAY_STATE_WORDS: Record<RelayState, string> = {
  home: "In use",
  connecting: "Connecting",
  standby: "Ready",
  unreachable: "Can't be reached",
  untested: "Not tried yet",
  unknown: "Not known",
};

/** What a relay said to GET /ping, in words, when it didn't answer as a relay. */
export function pingWords(ping: RelayPing): string {
  if (ping.kind === "relay") return `${relayName(ping.relay)} answered in ${ping.ms} ms.`;
  return `${relayName(ping.relay)}: ${ping.detail}.`;
}

/** An address as typed, made a relay entry: https://<host>[:<port>]/. Null when it isn't one. */
export function relayEntryOf(typed: string): string | null {
  const t = typed.trim();
  if (t.toLowerCase() === "n0") return "n0";
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  return url.href;
}

type RelaysState =
  | { state: "loading" }
  | { state: "ok"; list: RelayList }
  | { state: "error"; old: boolean; message: string };

function RelaysCard({
  admin,
  hostLabel,
}: {
  admin: boolean;
  hostLabel: string;
}): React.ReactElement {
  const [relays, setRelays] = useState<RelaysState>({ state: "loading" });
  const [draft, setDraft] = useState<string[] | null>(null);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unanswered, setUnanswered] = useState<RelayPing[]>([]);
  const [confirmUse, setConfirmUse] = useState(false);
  const addId = useId();

  const load = useCallback(async () => {
    try {
      setRelays({ state: "ok", list: await relayList() });
    } catch (e) {
      const old = e instanceof KleioApiError && (e.status === 404 || e.status === 403);
      setRelays({ state: "error", old, message: explainError(e) });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (relays.state !== "ok") {
    return (
      <SettingsCard title="Relays" description="Relays help your devices find this host.">
        <p className="settings-desc">
          {relays.state === "loading"
            ? "Checking…"
            : relays.old
              ? `Kleio on ${hostLabel} can't change its relays yet. Update it to choose.`
              : relays.message}
        </p>
      </SettingsCard>
    );
  }
  const list = relays.list;
  const entries = draft ?? list.relays.map((r) => r.entry);
  const changed = draft !== null && draft.join("\n") !== list.relays.map((r) => r.entry).join("\n");
  const rowOf = (entry: string): RelayRow | undefined => list.relays.find((r) => r.entry === entry);

  function edit(next: string[]): void {
    setDraft(next);
    setError(null);
    setUnanswered([]);
  }

  function add(): void {
    const entry = relayEntryOf(adding);
    if (entry === null) {
      setError("Type a relay's https address, such as https://relay.example.com/.");
      return;
    }
    if (entries.includes(entry)) {
      setError(`${relayName(entry)} is in the list already.`);
      return;
    }
    edit([entry, ...entries]);
    setAdding("");
  }

  async function save(force: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { list: saved } = await setRelayList(list.listVersion, entries, force);
      setRelays({ state: "ok", list: saved });
      setDraft(null);
      setUnanswered([]);
      toast(
        saved.inUse
          ? "Relays saved. The host uses them now."
          : `Relays saved. The host moves once ${waitingWords(saved.waiting)} have the new list.`,
        "success",
      );
    } catch (e) {
      const pings = refusedPings(e);
      if (pings.length > 0) {
        setUnanswered(pings.filter((p) => p.kind !== "relay"));
      } else if (e instanceof KleioApiError && e.status === 409) {
        setError(
          "The relays changed on another device. Here they are now; make your change again.",
        );
        setDraft(null);
        await load();
      } else {
        setError(explainError(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function adoptNow(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setRelays({ state: "ok", list: await adoptRelayList(list.listVersion) });
      setConfirmUse(false);
      toast("The host uses the new relays now.", "success");
    } catch (e) {
      if (e instanceof KleioApiError && e.status === 409) await load();
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      title="Relays"
      description="Your devices find this host through these, in order. n0's are free and shared, and slow big downloads to about 1 MB/s. A relay of your own is faster."
    >
      <ol className="conn-devices" aria-label="Relays, in order">
        {entries.map((entry, i) => {
          const row = rowOf(entry);
          return (
            <li key={entry} className="conn-device">
              <span className="conn-device-main">
                <span className="conn-device-name">
                  {relayName(entry)}
                  {list.hostRelay !== null && row?.state === "home" && (
                    <Badge color={theme.success} className="conn-inline-badge">
                      In use
                    </Badge>
                  )}
                  {(row === undefined || row.new) && (
                    <Badge color={theme.info} className="conn-inline-badge">
                      New
                    </Badge>
                  )}
                </span>
                <span className="conn-device-sub">
                  {row === undefined
                    ? "Not saved yet"
                    : row.state === "home"
                      ? entry === "n0"
                        ? "The host is on one of them"
                        : "The host is on it"
                      : RELAY_STATE_WORDS[row.state]}
                </span>
              </span>
              {admin && (
                <span className="conn-inline-confirm conn-relay-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={`Move up: ${relayName(entry)}`}
                    disabled={busy || i === 0}
                    onClick={() => {
                      const next = [...entries];
                      [next[i - 1], next[i]] = [entry, next[i - 1] ?? entry];
                      edit(next);
                    }}
                  >
                    <ArrowUpIcon size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={`Remove: ${relayName(entry)}`}
                    disabled={busy || entries.length === 1}
                    onClick={() => edit(entries.filter((e) => e !== entry))}
                  >
                    <TrashIcon size={14} aria-hidden="true" />
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {!list.inUse && (
        <p className="settings-desc" role="status">
          The host stays on relays every device knows until {waitingWords(list.waiting)}{" "}
          {list.waiting === 1 ? "has" : "have"} the new list
          {list.waitingFor && list.waitingFor.length > 0
            ? `: ${list.waitingFor.map((d) => d.label).join(", ")}`
            : ""}
          . A device opens Kleio to get it.
        </p>
      )}

      {admin ? (
        <>
          {entries.length < 4 && (
            <form
              className="conn-row conn-relay-add"
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <label className="sr-only" htmlFor={addId}>
                A relay's address
              </label>
              <input
                id={addId}
                className="modal-input"
                type="text"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="https://relay.example.com/"
                value={adding}
                disabled={busy}
                onChange={(e) => setAdding(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn-ghost btn-sm"
                disabled={busy || adding.trim() === ""}
              >
                Add
              </button>
            </form>
          )}
          {unanswered.length > 0 && (
            <div className="conn-bad conn-relay-unanswered" role="alert">
              <p>
                {unanswered.length === 1 ? "This relay doesn't" : "These relays don't"} answer as a
                relay does:
              </p>
              <ul>
                {unanswered.map((p) => (
                  <li key={p.relay}>{pingWords(p)}</li>
                ))}
              </ul>
            </div>
          )}
          {error && (
            <p className="conn-bad" role="alert">
              {error}
            </p>
          )}
          {confirmUse && !changed && !list.inUse && (
            <p className="settings-desc">
              The host moves at once. A device without the new list then pairs again.
            </p>
          )}
          <div className="conn-row">
            {changed && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => edit(list.relays.map((r) => r.entry))}
                >
                  Undo
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy}
                  onClick={() => void save(unanswered.length > 0)}
                >
                  {busy ? "Saving…" : unanswered.length > 0 ? "Save anyway" : "Save"}
                </button>
              </>
            )}
            {!changed &&
              !list.inUse &&
              (confirmUse ? (
                <span className="conn-inline-confirm">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => setConfirmUse(false)}
                  >
                    Keep waiting
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => void adoptNow()}
                  >
                    Use it now
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => setConfirmUse(true)}
                >
                  Use it now…
                </button>
              ))}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void openUrl(OWN_RELAY_DOCS)}
            >
              Run your own relay
            </button>
          </div>
        </>
      ) : (
        <p className="settings-desc">Only an admin device can change the relays.</p>
      )}
    </SettingsCard>
  );
}

/** "1 device" or "3 devices". */
function waitingWords(n: number): string {
  return n === 1 ? "1 device" : `${n} devices`;
}

// ─── pair a device: a one-time pairing QR code ──────────────────────────────

function PairDeviceCard({
  baseUrl,
  admin,
  onDone,
}: {
  /** The address this device reaches the host at, for a Tailscale QR code
   *  when the host gives no link ticket. */
  baseUrl: string | null;
  admin: boolean;
  /** Once the code on show closes, with why (PairingOffer's `onDone`). */
  onDone: (how: OfferEnd) => void;
}): React.ReactElement {
  const [offer, setOffer] = useState<PairOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Leaving the page with a code on show takes it away, as Done does.
  useWithdrawOnClose(offer);

  const done = useCallback(
    (how: OfferEnd) => {
      setOffer(null);
      onDone(how);
    },
    [onDone],
  );

  async function mint(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setOffer(await kleio.offer(false));
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      title="Pair a device"
      description="Pair another iPhone or Mac with your host. An iPhone scans the QR code, and a Mac pastes its pairing text."
    >
      {!admin ? (
        <p className="settings-desc">
          Only an admin device can pair another device. On your host, run{" "}
          <code className="conn-code">kleio-host pair</code>: an iPhone scans its QR code, and a Mac
          pastes its pairing text.
        </p>
      ) : offer ? (
        <PairingOffer offer={offer} baseUrl={baseUrl} onDone={done} />
      ) : (
        <div className="conn-pair-start">
          <ShieldCheckIcon size={20} weight="duotone" aria-hidden="true" />
          <p className="settings-desc">
            You'll get a one-time code that works for a few minutes. It pairs the device; it never
            shares a password.
          </p>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => void mint()}
          >
            {busy ? "Confirm with Touch ID…" : "Show pairing QR"}
          </button>
        </div>
      )}
      {error && (
        <p className="conn-bad" role="alert">
          {error}
        </p>
      )}
    </SettingsCard>
  );
}

// ─── devices ────────────────────────────────────────────────────────────────

function DevicesCard({
  admin,
  selfId,
  pairings,
  onChanged,
}: {
  admin: boolean;
  selfId: string | null;
  /** How many devices Pair a device has paired on this page. */
  pairings: number;
  onChanged: () => void;
}): React.ReactElement {
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  /** When the list was loaded: what New is measured from. */
  const [readAt, setReadAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setDevices(await kleio.devices());
      setReadAt(Date.now());
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // A device Pair a device pairs joins the list, if the list is on show.
  // One not on show stays so: Show devices is what asks for Touch ID.
  const shown = devices !== null;
  const listedPairings = useRef(pairings);
  useEffect(() => {
    if (pairings === listedPairings.current) return;
    listedPairings.current = pairings;
    if (shown) void load();
  }, [pairings, shown, load]);

  async function revoke(device: PairedDevice): Promise<void> {
    setBusy(true);
    try {
      setDevices(await kleio.revoke(device.deviceId));
      setConfirm(null);
      toast(`${device.label} revoked.`, "success");
      onChanged();
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }

  const live = (devices ?? []).filter((d) => !d.revoked);
  return (
    <SettingsCard
      title="Devices"
      description="Everything paired with your host. New marks a device paired this week. Revoke one and it's cut off straight away."
    >
      {!admin ? (
        <p className="settings-desc">Only an admin device can see and revoke devices.</p>
      ) : devices === null ? (
        <div className="conn-row">
          <p className="settings-desc">Showing devices needs Touch ID.</p>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => void load()}
          >
            {busy ? "Confirm with Touch ID…" : "Show devices"}
          </button>
        </div>
      ) : live.length === 0 ? (
        <p className="settings-desc">No devices paired.</p>
      ) : (
        <ul className="conn-devices">
          {live.map((d) => (
            <li key={d.deviceId} className="conn-device">
              <span className="conn-device-icon" aria-hidden="true">
                {/iphone|ipad|phone/i.test(d.label) ? (
                  <DeviceMobileIcon size={18} weight="duotone" />
                ) : (
                  <DesktopIcon size={18} weight="duotone" />
                )}
              </span>
              <span className="conn-device-main">
                <span className="conn-device-name">
                  {d.label}
                  {d.deviceId === selfId && <Badge className="conn-inline-badge">This Mac</Badge>}
                  {isNewDevice(d, selfId, readAt) && (
                    <Badge color={theme.info} className="conn-inline-badge">
                      New
                    </Badge>
                  )}
                  {d.admin && (
                    <Badge color={theme.warning} className="conn-inline-badge">
                      Admin
                    </Badge>
                  )}
                </span>
                <span className="conn-device-sub">
                  {d.lastSeen ? `Active ${relTime(d.lastSeen)}` : `Paired ${relTime(d.created)}`}
                </span>
              </span>
              {d.deviceId !== selfId &&
                (confirm === d.deviceId ? (
                  <span className="conn-inline-confirm">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setConfirm(null)}
                    >
                      Keep
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busy}
                      onClick={() => void revoke(d)}
                    >
                      Revoke
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={`Revoke this device: ${d.label}`}
                    onClick={() => setConfirm(d.deviceId)}
                  >
                    Revoke this device
                  </button>
                ))}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="conn-bad" role="alert">
          {error}
        </p>
      )}
    </SettingsCard>
  );
}
