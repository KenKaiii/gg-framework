// Apps: the services Kleio and every Blob can use for you (Gmail, Calendar,
// Notion…), through Composio on the Mac mini. Connected apps sit on top; the
// catalogue below is a searchable grid. Sign-in happens in the browser, and the
// page notices when it's done.
//
// Logos come from Composio's logo CDN, addressed by the app's slug — never
// from the catalogue's free-form logo links, which can point anywhere. The
// app's content security policy allows images from that one origin only.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  MagnifyingGlassIcon,
  PlugsIcon,
  XIcon,
} from "@phosphor-icons/react";
import { openUrl } from "../agent";
import { Badge } from "../Badge";
import { SettingsCard } from "../settings-section";
import { SettingsHeaderStatus } from "../settings-header";
import { theme } from "../theme";
import {
  connectToolkit,
  disconnect,
  listConnections,
  listToolkits,
  errorText,
  KleioApiError,
  type Connection,
  type Toolkit,
} from "./kleioApi";
import { KeyForm } from "./KeyForm";

/** The one image origin the CSP allows (src-tauri/tauri.conf.json). */
export const LOGO_ORIGIN = "https://logos.composio.dev";
/** Where an app's own developer keys are added (Composio's auth configs). */
export const COMPOSIO_AUTH_CONFIGS_URL = "https://dashboard.composio.dev/~/project/auth-configs";

/** What went wrong with an app, in words. Older hosts pass Composio's raw
 *  JSON as the detail; its own message is the readable part. */
export function appErrorText(e: unknown): string {
  if (!(e instanceof KleioApiError) || e.message !== "composio") return errorText(e);
  let detail = e.detail?.trim() ?? "";
  if (detail.startsWith("{")) {
    try {
      const err = (JSON.parse(detail) as { error?: { message?: unknown } }).error;
      if (typeof err?.message === "string") detail = err.message;
    } catch {
      // Not JSON after all: show it as it came.
    }
  }
  if (/does not require authentication/i.test(detail))
    return "This app doesn't need a sign-in. Kleio and your specialists can already use it.";
  if (/does not manage auth/i.test(detail))
    return "Composio has no ready-made sign-in for this app. Add your own developer keys for it in Composio, then connect again.";
  return detail ? `Composio couldn't do that: ${detail}` : "Composio couldn't do that.";
}

/** A failed connect that only your own keys in Composio can fix. */
function needsSetup(e: unknown): boolean {
  if (!(e instanceof KleioApiError)) return false;
  return e.code === "needs_setup" || /does not manage auth/i.test(e.detail ?? "");
}

/** A connect refused because the app needs no sign-in at all. */
function needsNoSignIn(e: unknown): boolean {
  if (!(e instanceof KleioApiError)) return false;
  return e.code === "no_auth" || /does not require authentication/i.test(e.detail ?? "");
}
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const SEARCH_DEBOUNCE_MS = 300;
/** While a sign-in is open in the browser, check back this often. */
const PENDING_POLL_MS = 4_000;

/** Composio's logo for an app, or null for a slug that isn't one. */
export function logoUrl(slug: string): string | null {
  return SLUG.test(slug) ? `${LOGO_ORIGIN}/api/${slug.toLowerCase()}` : null;
}

export type ConnectionState = "connected" | "pending" | "expired" | "failed" | "other";

export function connectionState(status: string): ConnectionState {
  switch (status.toUpperCase()) {
    case "ACTIVE":
      return "connected";
    case "INITIATED":
    case "INITIALIZING":
      return "pending";
    case "EXPIRED":
      return "expired";
    case "FAILED":
      return "failed";
    default:
      return "other";
  }
}

function stateText(status: string): string {
  switch (connectionState(status)) {
    case "connected":
      return "Connected";
    case "pending":
      return "Finish signing in, in your browser";
    case "expired":
      return "Expired — reconnect it";
    case "failed":
      return "Didn't connect — try again";
    case "other":
      return status.toLowerCase();
  }
}

const ACRONYMS = new Set(["ai", "api", "ats", "cms", "crm", "erp", "hr", "it", "seo", "sms"]);

/**
 * An app's first category in sentence case, acronyms kept whole:
 * "developer tools" → "Developer tools", "ai" → "AI".
 */
export function categoryLabel(categories: readonly string[]): string | null {
  const words = (categories[0] ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return words
    .map((w, i) =>
      ACRONYMS.has(w) ? w.toUpperCase() : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w,
    )
    .join(" ");
}

export function AppLogo({
  slug,
  name,
  size = 40,
}: {
  slug: string;
  name: string;
  size?: number;
}): React.ReactElement {
  const src = logoUrl(slug);
  const [failed, setFailed] = useState(false);
  return (
    <span className="app-logo" style={{ width: size, height: size }} aria-hidden="true">
      {src && !failed ? (
        <img
          src={src}
          alt=""
          width={size - 12}
          height={size - 12}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="app-logo-letter">{name.trim().charAt(0).toUpperCase() || "?"}</span>
      )}
    </span>
  );
}

export function AppsPage(): React.ReactElement {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [search, setSearch] = useState("");
  const [toolkits, setToolkits] = useState<Toolkit[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The last connect needs the user's own keys in Composio: offer the way there. */
  const [setupFor, setSetupFor] = useState<string | null>(null);
  /** Apps found to need no sign-in after a connect was refused (older hosts). */
  const [noSignIn, setNoSignIn] = useState<ReadonlySet<string>>(new Set());
  const query = useRef("");

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await listConnections();
      setConfigured(r.configured);
      setConnections(r.connections);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    // Back from the browser's sign-in: refresh when the window regains focus,
    // or is on screen again (the iPhone, coming back from Safari).
    const again = (): void => {
      if (document.visibilityState !== "hidden") void load();
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [load]);

  const waiting = connections.some((c) => connectionState(c.status) === "pending");
  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(() => void load(), PENDING_POLL_MS);
    return () => window.clearInterval(id);
  }, [waiting, load]);

  useEffect(() => {
    if (!configured) return;
    let live = true;
    const text = search.trim();
    const t = window.setTimeout(() => {
      query.current = text;
      setToolkits(null);
      listToolkits(text ? { search: text } : {})
        .then((p) => {
          if (!live) return;
          setToolkits(p.toolkits);
          setCursor(p.nextCursor);
        })
        .catch((e: unknown) => live && setError(errorText(e)));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [configured, search]);

  async function more(): Promise<void> {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const asked = query.current;
    try {
      const p = await listToolkits({ ...(asked ? { search: asked } : {}), cursor });
      // A new search started meanwhile: its results win.
      if (asked !== query.current) return;
      setToolkits((cur) => {
        const seen = new Set((cur ?? []).map((t) => t.slug));
        return [...(cur ?? []), ...p.toolkits.filter((t) => !seen.has(t.slug))];
      });
      setCursor(p.nextCursor);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoadingMore(false);
    }
  }

  async function connect(slug: string): Promise<void> {
    setPending(slug);
    setError(null);
    setSetupFor(null);
    try {
      const r = await connectToolkit(slug);
      await openUrl(r.redirectUrl);
      await load();
    } catch (e) {
      if (needsNoSignIn(e)) {
        // Nothing to connect: show the app as ready instead of an error.
        setNoSignIn((s) => new Set(s).add(slug));
      } else {
        setError(appErrorText(e));
        if (needsSetup(e)) setSetupFor(slug);
      }
    } finally {
      setPending(null);
    }
  }

  async function remove(c: Connection): Promise<void> {
    setPending(c.id);
    setError(null);
    try {
      await disconnect(c.id);
      setConfirmRemove(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(null);
    }
  }

  if (configured === false) {
    return (
      <SettingsCard
        title="Apps aren't set up yet"
        description="Apps connect through Composio on your host."
      >
        <p className="kleio-page-intro">
          Add a Composio API key and Gmail, Calendar, Notion and hundreds more can work for Kleio
          and every specialist.
        </p>
        <KeyForm name="composio" onSaved={() => void load()} />
      </SettingsCard>
    );
  }

  const active = connections.filter((c) => connectionState(c.status) === "connected");
  const bySlug = new Map(connections.map((c) => [c.toolkit, c]));

  return (
    <>
      <SettingsHeaderStatus>
        {configured !== null && (
          <Badge color={active.length > 0 ? theme.success : undefined}>
            {`${active.length} connected`}
          </Badge>
        )}
      </SettingsHeaderStatus>

      <p className="kleio-page-intro">
        Connected apps work for Kleio and every specialist — read your mail, check your calendar,
        update Notion. You sign in once, in your browser.
      </p>

      {error && (
        <div className="kleio-error app-error" role="alert">
          <span>{error}</span>
          {setupFor && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void openUrl(COMPOSIO_AUTH_CONFIGS_URL)}
            >
              <ArrowSquareOutIcon size={14} weight="bold" aria-hidden="true" />
              Open Composio
            </button>
          )}
        </div>
      )}

      {connections.length > 0 && (
        <SettingsCard title="Your apps" description="Kleio and your specialists can use these now.">
          <ul className="app-mine">
            {connections.map((c) => {
              const state = connectionState(c.status);
              return (
                <li key={c.id} className="app-mine-row">
                  <AppLogo slug={c.toolkit} name={c.name} size={36} />
                  <span className="app-mine-text">
                    <span className="app-mine-name">{c.name}</span>
                    <span className={`app-mine-state is-${state}`}>
                      {state === "connected" && (
                        <CheckCircleIcon size={13} weight="fill" aria-hidden="true" />
                      )}
                      {stateText(c.status)}
                    </span>
                  </span>
                  {confirmRemove === c.id ? (
                    <span className="app-confirm" role="group" aria-label={`Disconnect ${c.name}?`}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setConfirmRemove(null)}
                        disabled={pending === c.id}
                      >
                        Keep
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void remove(c)}
                        disabled={pending === c.id}
                      >
                        {pending === c.id ? "Disconnecting…" : "Disconnect"}
                      </button>
                    </span>
                  ) : (
                    <span className="app-confirm">
                      {(state === "expired" || state === "failed") && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => void connect(c.toolkit)}
                          disabled={pending !== null}
                        >
                          Reconnect
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm app-remove"
                        onClick={() => setConfirmRemove(c.id)}
                        aria-label={`Disconnect ${c.name}`}
                        title={`Disconnect ${c.name}`}
                      >
                        <XIcon size={14} weight="bold" aria-hidden="true" />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </SettingsCard>
      )}

      <SettingsCard
        title="Add an app"
        description="Search hundreds of apps. Connecting opens your browser."
      >
        <label className="app-search">
          <MagnifyingGlassIcon size={16} weight="bold" aria-hidden="true" />
          <input
            className="modal-input"
            type="search"
            placeholder="Search Gmail, Notion, Calendar…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search apps"
            spellCheck={false}
          />
        </label>

        {toolkits === null ? (
          <div className="app-grid app-grid-skeleton" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="app-tile" />
            ))}
          </div>
        ) : toolkits.length === 0 ? (
          <p className="kleio-empty">No apps match “{search.trim()}”.</p>
        ) : (
          <>
            <ul className="app-grid">
              {toolkits.map((t) => {
                const existing = bySlug.get(t.slug);
                const state = existing ? connectionState(existing.status) : null;
                const cat = categoryLabel(t.categories);
                const ready = t.auth === "none" || noSignIn.has(t.slug);
                return (
                  <li key={t.slug} className="app-tile">
                    <span className="app-tile-top">
                      <AppLogo slug={t.slug} name={t.name} />
                      <span className="app-tile-name">
                        <span className="app-tile-title">{t.name}</span>
                        {cat && <span className="app-tile-category">{cat}</span>}
                      </span>
                    </span>
                    <span className="app-tile-desc">{t.description || "\u00a0"}</span>
                    {state === "connected" ? (
                      <span className="app-tile-foot">
                        <span className="app-tile-connected">
                          <CheckCircleIcon size={14} weight="fill" aria-hidden="true" />
                          Connected
                        </span>
                      </span>
                    ) : ready ? (
                      <span className="app-tile-foot">
                        <span
                          className="app-tile-connected"
                          title="Kleio and your specialists can use it without signing in."
                        >
                          <CheckCircleIcon size={14} weight="fill" aria-hidden="true" />
                          Ready · no sign-in
                        </span>
                      </span>
                    ) : (
                      <span className="app-tile-foot">
                        {t.auth === "setup" && (
                          <span className="app-tile-note">Needs your own keys</span>
                        )}
                        <button
                          type="button"
                          className="btn btn-sm app-connect"
                          disabled={pending !== null}
                          onClick={() => void connect(t.slug)}
                          aria-label={`Connect ${t.name}`}
                        >
                          <PlugsIcon size={14} weight="bold" aria-hidden="true" />
                          {pending === t.slug
                            ? "Opening…"
                            : state === "pending"
                              ? "Waiting…"
                              : "Connect"}
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {cursor && (
              <div className="app-more">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void more()}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : "Show more apps"}
                </button>
              </div>
            )}
          </>
        )}
      </SettingsCard>
    </>
  );
}
