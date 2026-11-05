import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthProvider } from "./agent";
import type { BrainBay } from "./brain/brain-bay";
import { providerLogo, providerLogoIsMono } from "./provider-logos";
import { PROVIDER_GROUPS, groupProviders } from "./provider-groups";
import { useMotionLevel } from "./window-motion";
import "./ProvidersBay.css";

interface Props {
  providers: AuthProvider[];
  onOpen: (provider: AuthProvider) => void;
  onOpenLocal: () => void;
  onOpenHfPull: () => void;
}

const methodLabel = (m: string): string => (m === "oauth" ? "OAuth" : "API key");

/**
 * The AI Providers page as a brain bay: a three.js brain in the middle and the
 * providers around it, grouped by country. Each connected provider is a living
 * nerve from its card into its own region of the brain, which charges as the
 * nerve lands and upgrades as more providers connect. The brain loads on
 * demand; without WebGL the cards stand on their own.
 */
export function ProvidersBay({
  providers,
  onOpen,
  onOpenLocal,
  onOpenHfPull,
}: Props): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const bayRef = useRef<BrainBay | null>(null);
  const [brain, setBrain] = useState<"loading" | "ready" | "unavailable">("loading");
  const [hot, setHot] = useState<string | null>(null);
  const motion = useMotionLevel();

  const values = useMemo(() => providers.map((p) => p.value), [providers]);
  const valuesKey = values.join(",");
  const connected = useMemo(
    () => providers.filter((p) => p.connected).map((p) => p.value),
    [providers],
  );
  const connectedKey = connected.join(",");
  const groups = useMemo(() => groupProviders(providers), [providers]);

  // Latest values for the async mount, without re-mounting the brain on every change.
  const latest = useRef({ connected, motion, providers, onOpen });
  useEffect(() => {
    latest.current = { connected, motion, providers, onOpen };
  });

  useEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    const overlay = overlayRef.current;
    if (!root || !stage || !overlay) return;
    let cancelled = false;
    let bay: BrainBay | null = null;
    void import("./brain/brain-bay")
      .then(({ mountBrainBay }) => {
        if (cancelled) return;
        bay = mountBrainBay({
          root,
          stage,
          overlay,
          providers: valuesKey.split(","),
          onHover: setHot,
          onPick: (value) => {
            const p = latest.current.providers.find((x) => x.value === value);
            if (p) latest.current.onOpen(p);
          },
        });
        bayRef.current = bay;
        bay.setMotion(latest.current.motion);
        bay.setConnected(latest.current.connected);
        setBrain("ready");
      })
      .catch(() => {
        // No WebGL (or the chunk failed to load): the cards still do everything.
        if (!cancelled) setBrain("unavailable");
      });
    return () => {
      cancelled = true;
      bay?.dispose();
      bayRef.current = null;
    };
  }, [valuesKey]);

  useEffect(() => {
    bayRef.current?.setConnected(connectedKey ? connectedKey.split(",") : []);
  }, [connectedKey]);

  useEffect(() => {
    bayRef.current?.setMotion(motion);
  }, [motion]);

  const point = (value: string | null): void => {
    setHot(value);
    bayRef.current?.setHot(value);
  };

  const card = (p: AuthProvider): React.ReactElement => {
    const logo = providerLogo(p.value);
    const method = p.connected ? (p.activeMethod ?? p.connectedMethods?.[0]) : undefined;
    return (
      <button
        key={p.value}
        type="button"
        className={`bay-card${p.connected ? " is-on" : ""}${hot === p.value ? " is-hot" : ""}`}
        data-bay-card
        aria-label={`${p.label}: ${method ? `connected with ${methodLabel(method)}` : "not connected"}`}
        onClick={() => onOpen(p)}
        onPointerEnter={() => point(p.value)}
        onPointerLeave={() => point(null)}
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && point(p.value)}
        onBlur={() => point(null)}
      >
        <span className="bay-logo">
          {logo ? (
            <img
              className="login-logo"
              src={logo}
              alt=""
              data-mono={providerLogoIsMono(p.value) || undefined}
            />
          ) : (
            <span className="bay-logo-letter">{p.label.charAt(0)}</span>
          )}
        </span>
        <span className="bay-name">
          <b>{p.label}</b>
          {method && <small>{methodLabel(method)}</small>}
        </span>
        {/* Where the nerve joins the card: the midpoint of the edge facing the brain. */}
        <span className="bay-port" data-bay-port={p.value} aria-hidden="true" />
      </button>
    );
  };

  const groupSection = (
    id: string,
    name: string,
    order: number,
    children: React.ReactNode,
    count?: string,
  ): React.ReactElement => (
    <section key={id} className="bay-group" style={{ order }} aria-label={name}>
      <h3>
        {name}
        {count && <small>{count}</small>}
      </h3>
      {children}
    </section>
  );

  const banks = { left: [] as React.ReactElement[], right: [] as React.ReactElement[] };
  groups.forEach(({ group, providers: list }) => {
    const on = list.filter((p) => p.connected).length;
    const order = PROVIDER_GROUPS.indexOf(group);
    banks[group.bank].push(
      groupSection(group.id, group.name, order, list.map(card), `${on} of ${list.length}`),
    );
  });
  banks.right.push(
    groupSection(
      "local",
      "On your machine",
      PROVIDER_GROUPS.length,
      <>
        {/* No key and no account: these open their own setup instead of a login. */}
        <button
          type="button"
          className="bay-card is-local"
          onClick={onOpenLocal}
          title="Local models: Ollama, LM Studio, llama.cpp, vLLM or any OpenAI-compatible endpoint"
        >
          <span className="bay-logo">
            <img className="login-logo" src={providerLogo("ollama")} alt="" />
          </span>
          <span className="bay-name">
            <b>Local models</b>
          </span>
        </button>
        <button
          type="button"
          className="bay-card is-local"
          onClick={onOpenHfPull}
          title="Hugging Face: download models to Ollama"
        >
          <span className="bay-logo">
            <img className="login-logo" src={providerLogo("huggingface")} alt="" />
          </span>
          <span className="bay-name">
            <b>Hugging Face</b>
          </span>
        </button>
      </>,
    ),
  );

  return (
    <div className={`providers-bay${brain === "unavailable" ? " is-flat" : ""}`} ref={rootRef}>
      <div className="bay-stage" ref={stageRef} />
      <div className="bay-banks" data-bay-scroll>
        <div className="bay-bank is-left" data-bay-scroll>
          {banks.left}
        </div>
        <div className="bay-bank is-right" data-bay-scroll>
          {banks.right}
        </div>
      </div>
      <canvas className="bay-nerves" ref={overlayRef} aria-hidden="true" />
    </div>
  );
}
