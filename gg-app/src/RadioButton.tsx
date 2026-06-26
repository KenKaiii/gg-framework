import { useEffect, useRef, useState } from "react";
import { Radio } from "lucide-react";
import { theme } from "./theme";
import { getRadioState, setRadio, type RadioStation } from "./agent";

/**
 * Titlebar control that streams a free internet radio station while you work.
 * Mirrors WindowLayoutButton's popover pattern (icon button + dropdown of
 * choices). Playback runs inside THIS window's agent sidecar, so opening more
 * windows never duplicates audio — each window's radio is independent.
 *
 * The button turns accent-colored while a station is playing; the dropdown
 * shows every station plus an "Off" entry to stop it.
 */
export function RadioButton(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Load this window's radio state once (and whenever the menu opens, so a
  // station started elsewhere in this window stays in sync).
  useEffect(() => {
    if (!open) return;
    void getRadioState().then((s) => {
      setStations(s.stations);
      setCurrent(s.current);
    });
  }, [open]);

  useEffect(() => {
    void getRadioState().then((s) => {
      setStations(s.stations);
      setCurrent(s.current);
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const id = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open]);

  async function choose(station: string): Promise<void> {
    setOpen(false);
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const playing = await setRadio(station);
      setCurrent(playing);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const playing = current !== null;

  return (
    <div className="winlayout" ref={ref}>
      <button
        className="btn btn-ghost btn-sm btn-nav-icon"
        disabled={busy}
        title={playing ? "Radio playing — click to change or stop" : "Play internet radio"}
        style={playing ? { color: theme.accent } : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Radio size={16} />
      </button>
      {open && (
        <>
          {/* Full-screen catcher: closes the menu on any outside click,
              including clicks on Tauri drag regions the document listener
              can't see. */}
          <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />
          <div
            className="winlayout-menu"
            style={{ background: theme.surface2, borderColor: theme.border }}
          >
            {stations.map((s) => (
              <button
                key={s.id}
                className="winlayout-item"
                style={{ color: current === s.id ? theme.accent : theme.text }}
                title={s.description}
                onClick={() => void choose(s.id)}
              >
                {current === s.id ? "● " : ""}
                {s.name}
              </button>
            ))}
            <button
              className="winlayout-item"
              style={{ color: theme.textMuted }}
              disabled={!playing}
              onClick={() => void choose("off")}
            >
              Stop radio
            </button>
            {error && (
              <div style={{ color: theme.error, fontSize: 11, padding: "4px 9px", maxWidth: 220 }}>
                {error}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
