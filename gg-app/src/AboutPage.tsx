import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  ClockCounterClockwiseIcon,
  GraduationCapIcon,
  YoutubeLogoIcon,
} from "@phosphor-icons/react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl, openWhatsNewWindow } from "./agent";
import { Badge } from "./Badge";
import { CHANGELOG } from "./changelog";
import { drawKenPortrait } from "./goal-ken-portrait";
import { useSettingsPageReady } from "./settings-ready";
import { releaseText } from "./WhatsNewParts";
import {
  buildShipLog,
  dayHeadline,
  dayOfVersion,
  formatLongDate,
  formatShipDate,
  localIsoDate,
  versionsLabel,
  type ShipDay,
  type ShipLevel,
  type ShipLog,
} from "./about-ship-log";
import { aboutLines, GG_CODER_STARTED, SKOOL_URL, YOUTUBE_URL, type KenSay } from "./about-content";
import "./AboutPage.css";

/**
 * About: who makes GG Coder and where to find him. Ken rises behind his
 * storybook box (the Workers view's dialogue art) and says hello; beside him,
 * where GG Coder came from and the ways to learn with him. Under that, the
 * desktop app's releases by day, read from the changelog.
 */
export function AboutPage(): React.ReactElement {
  const [version, setVersion] = useState<string | null>(null);
  const [versionRead, setVersionRead] = useState(false);
  // The installed version marks its day on the log; wait for it so the mark
  // doesn't pop in after the page shows.
  useSettingsPageReady(versionRead);

  useEffect(() => {
    let live = true;
    void getVersion()
      .then((v) => {
        if (live) setVersion(v);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setVersionRead(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const log = useMemo(() => buildShipLog(CHANGELOG, localIsoDate(new Date())), []);
  const lines = useMemo(() => aboutLines(log), [log]);
  const nameId = useId();

  return (
    <div className="about">
      <section className="settings-card about-maker" aria-labelledby={nameId}>
        <AboutKen lines={lines} start={versionRead} />
        <div className="about-maker-copy">
          <h2 id={nameId} className="about-name">
            Ken Kai
          </h2>
          <p className="about-bio">
            Ken builds GG Coder, a coding agent for your desktop. On Skool, he helps people learn to
            build with AI.
          </p>
          <p className="about-origin">
            {`CLI since ${formatLongDate(GG_CODER_STARTED)}. App since ${formatLongDate(log.firstDate)}.`}
          </p>
          <div className="about-actions">
            <a
              className="btn btn-primary btn-lg about-cta"
              href={SKOOL_URL}
              onClick={(e) => {
                e.preventDefault();
                void openUrl(SKOOL_URL);
              }}
            >
              <GraduationCapIcon size={18} weight="bold" aria-hidden="true" />
              Learn with Ken on Skool
            </a>
            <a
              className="btn btn-ghost btn-lg about-cta"
              href={YOUTUBE_URL}
              onClick={(e) => {
                e.preventDefault();
                void openUrl(YOUTUBE_URL);
              }}
            >
              <YoutubeLogoIcon size={18} weight="bold" aria-hidden="true" />
              Watch on YouTube
            </a>
          </div>
        </div>
      </section>
      <ShipLogCard log={log} version={version} />
      {/* Credit the pixel fonts (Alagard asks for it; m5x7 is CC0, credited anyway). */}
      <p className="about-credits">Pixel fonts: m5x7 by Daniel Linssen, Alagard by Hewett Tsoi.</p>
    </div>
  );
}

// Typing and entrance timings, as in KenDialogue: Ken's rise starts at 130ms
// and springs for --duration-spring (0.5s).
const ENTER_MS = 600;
const REDUCED_ENTER_MS = 120;
const CHAR_MS = 30;
const MOUTH_MS = 110;
const BLINK_EVERY_MS = 3100;
const BLINK_MS = 130;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

type KenPhase = "hidden" | "entering" | "talking";

/**
 * Ken in his storybook box, saying his lines one at a time like a game: each
 * types out while his mouth moves, a bobbing ▼ waits once it's out, and a
 * click (or Enter) finishes the line or moves to the next. The dots under the
 * box say which line he's on; after the last he starts over.
 */
export function AboutKen({
  lines,
  start,
}: {
  lines: readonly KenSay[];
  /** Come up now (the page has shown). */
  start: boolean;
}): React.ReactElement {
  const [reduced] = useState(prefersReducedMotion);
  const [phase, setPhase] = useState<KenPhase>("hidden");
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(0);
  const [mouthOpen, setMouthOpen] = useState(false);
  const [blink, setBlink] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const line = lines[index] ?? lines[0];
  const length = line?.text.length ?? 0;
  const typing = phase === "talking" && shown < length;
  const lineOut = phase === "talking" && !typing;
  const last = index === lines.length - 1;

  // Up on the next frame, so the hidden pose paints first and the entrance
  // transitions have somewhere to start from.
  useEffect(() => {
    if (!start || phase !== "hidden") return;
    const id = requestAnimationFrame(() => setPhase("entering"));
    return () => cancelAnimationFrame(id);
  }, [start, phase]);

  useEffect(() => {
    if (phase !== "entering") return;
    const id = window.setTimeout(() => setPhase("talking"), reduced ? REDUCED_ENTER_MS : ENTER_MS);
    return () => window.clearTimeout(id);
  }, [phase, reduced]);

  // Typing, with his mouth moving (shut on spaces and stops). Less motion:
  // the whole line at once.
  useEffect(() => {
    if (!typing || !line) {
      setMouthOpen(false);
      return;
    }
    if (reduced) {
      setShown(length);
      return;
    }
    const id = window.setTimeout(() => {
      const next = shown + 1;
      setShown(next);
      const ch = line.text[next - 1] ?? " ";
      setMouthOpen(!/[\s.,!?:;]/.test(ch) && Math.floor(performance.now() / MOUTH_MS) % 2 === 0);
    }, CHAR_MS);
    return () => window.clearTimeout(id);
  }, [typing, line, shown, length, reduced]);

  // He blinks now and then while he's up.
  useEffect(() => {
    if (phase === "hidden" || reduced) return;
    let shut: number | undefined;
    const id = window.setInterval(() => {
      setBlink(true);
      shut = window.setTimeout(() => setBlink(false), BLINK_MS);
    }, BLINK_EVERY_MS);
    return () => {
      window.clearInterval(id);
      if (shut !== undefined) window.clearTimeout(shut);
    };
  }, [phase, reduced]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas && line) drawKenPortrait(canvas, line.face, { talk: mouthOpen, blink });
  }, [line, mouthOpen, blink]);

  const onClick = useCallback(() => {
    if (phase !== "talking") return;
    if (typing) {
      setShown(length);
      return;
    }
    setIndex((i) => (i + 1) % lines.length);
    setShown(0);
  }, [phase, typing, length, lines.length]);

  const action = typing ? "Show all" : last ? "Start over" : "Next";
  return (
    <div className="ken-dialogue about-ken" data-phase={phase}>
      <div className="ken-dialogue-portrait" aria-hidden="true">
        <canvas ref={canvasRef} />
      </div>
      <button
        type="button"
        className="ken-dialogue-box"
        aria-label={
          line
            ? `Ken, ${index + 1} of ${lines.length}: ${line.text} ${phase === "talking" ? action : ""}`
            : undefined
        }
        onClick={onClick}
      >
        <span className="ken-dialogue-name">Ken</span>
        <span className="ken-dialogue-text" aria-hidden="true">
          {line?.text.slice(0, shown)}
        </span>
        <span className="ken-dialogue-more" data-on={lineOut ? "" : undefined} />
      </button>
      <div className="about-ken-dots" aria-hidden="true">
        {lines.map((said, i) => (
          <span key={said.text} className="about-ken-dot" data-on={i === index ? "" : undefined} />
        ))}
      </div>
      {/* Read out once, whole, when he starts a line (not letter by letter). */}
      <p className="sr-only" aria-live="polite">
        {line && phase === "talking" ? `Ken: ${line.text}` : ""}
      </p>
    </div>
  );
}

function releasesLabel(count: number): string {
  return count === 1 ? "1 release" : `${count} releases`;
}

const LEVELS: readonly ShipLevel[] = [0, 1, 2, 3, 4];

/**
 * The ship log: a calendar of every day since the first release, a column per
 * week, brighter for more releases. Pointing at a day (or arrowing to it)
 * shows what shipped beside it; it opens on the day your version shipped.
 * One Tab stop: the arrow keys move a day (up, down) or a week (left, right).
 */
export function ShipLogCard({
  log,
  version,
}: {
  log: ShipLog;
  version: string | null;
}): React.ReactElement {
  const titleId = useId();
  const gridRef = useRef<HTMLDivElement>(null);
  const yours = useMemo(() => dayOfVersion(log, version), [log, version]);
  const [picked, setPicked] = useState<string | null>(null);
  const selected =
    log.days.find((day) => day.date === picked) ??
    yours ??
    log.lastShipped ??
    log.days[log.days.length - 1] ??
    null;

  function moveTo(day: ShipDay | undefined): void {
    if (!day) return;
    setPicked(day.date);
    gridRef.current?.querySelector<HTMLElement>(`[data-date="${day.date}"]`)?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, day: ShipDay): void {
    const at = log.days.indexOf(day);
    const step: Record<string, number> = {
      ArrowUp: -1,
      ArrowDown: 1,
      ArrowLeft: -7,
      ArrowRight: 7,
    };
    let next: ShipDay | undefined;
    const delta = step[event.key];
    if (delta !== undefined) next = log.days[at + delta];
    else if (event.key === "Home") next = log.days[0];
    else if (event.key === "End") next = log.days[log.days.length - 1];
    else return;
    event.preventDefault();
    moveTo(next);
  }

  const calStyle: CSSProperties & Record<"--weeks", number> = { "--weeks": log.weeks };
  return (
    <section className="settings-card about-log" aria-labelledby={titleId}>
      <div className="settings-section-head">
        <h2 id={titleId} className="settings-section-title about-log-title">
          Desktop app releases
        </h2>
        <p className="settings-desc">
          Each square is a day since the app's first release. Brighter means more releases. Point at
          a day to see what changed.
        </p>
      </div>
      <div className="about-log-body">
        <div className="about-log-map">
          <div
            ref={gridRef}
            className="about-cal"
            role="group"
            aria-label="Releases by day"
            style={calStyle}
          >
            {log.months.map((month) => (
              <span
                key={`${month.label}-${month.week}`}
                className="about-cal-month"
                style={{ gridColumn: month.week + 2 }}
                aria-hidden="true"
              >
                {month.label}
              </span>
            ))}
            {["Mon", "Wed", "Fri"].map((name, i) => (
              <span
                key={name}
                className="about-cal-weekday"
                style={{ gridRow: i * 2 + 2 }}
                aria-hidden="true"
              >
                {name}
              </span>
            ))}
            {log.days.map((day) => {
              const isSelected = day === selected;
              const isYours = day === yours;
              const dayStyle: CSSProperties & Record<"--col", number> = {
                gridColumn: day.week + 2,
                gridRow: day.weekday + 2,
                "--col": day.week,
              };
              return (
                <button
                  key={day.date}
                  type="button"
                  className="about-day"
                  data-date={day.date}
                  data-level={day.level}
                  data-yours={isYours ? "" : undefined}
                  aria-current={isSelected ? "true" : undefined}
                  aria-label={`${formatShipDate(day.date)}: ${
                    day.releases.length === 0 ? "no releases" : releasesLabel(day.releases.length)
                  }${isYours ? ", your version" : ""}`}
                  tabIndex={isSelected ? 0 : -1}
                  style={dayStyle}
                  onMouseEnter={() => setPicked(day.date)}
                  onFocus={() => setPicked(day.date)}
                  onClick={() => setPicked(day.date)}
                  onKeyDown={(event) => onKeyDown(event, day)}
                />
              );
            })}
          </div>
          <div className="about-cal-key" aria-hidden="true">
            <span>Less</span>
            {LEVELS.map((level) => (
              <span key={level} className="about-day about-day-swatch" data-level={level} />
            ))}
            <span>More</span>
            {yours && (
              <>
                <span
                  className="about-day about-day-swatch about-cal-key-gap"
                  data-level={yours.level}
                  data-yours=""
                />
                <span>Your version</span>
              </>
            )}
          </div>
        </div>
        {selected && <ShipReadout day={selected} isYours={selected === yours} />}
      </div>
      <div className="about-log-foot">
        <p className="about-log-facts">
          {`${releasesLabel(log.releases)}.`}
          {version && ` You're on v${version}.`}
        </p>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void openWhatsNewWindow("calm").catch(() => {})}
        >
          <ClockCounterClockwiseIcon size={14} weight="bold" aria-hidden="true" />
          Read every release
        </button>
      </div>
    </section>
  );
}

/** What shipped on the day in focus: the date, the versions, the lead feature. */
function ShipReadout({ day, isYours }: { day: ShipDay; isYours: boolean }): React.ReactElement {
  const lead = dayHeadline(day);
  return (
    // Re-keyed per day, so each one fades in where the last one was.
    <div className="about-readout fade-swap" key={day.date}>
      <p className="about-readout-meta">
        <span className="about-readout-date">{formatShipDate(day.date)}</span>
        <span>
          {day.releases.length === 0 ? "No releases" : releasesLabel(day.releases.length)}
        </span>
        {day.releases.length > 0 && (
          <span className="about-readout-versions">{versionsLabel(day)}</span>
        )}
        {isYours && <Badge>Your version</Badge>}
      </p>
      <p className="about-readout-line">{lead ? releaseText(lead.headline) : "No release."}</p>
      <p className="about-readout-more">
        {lead && lead.more > 0 ? `+${lead.more} more that day` : "\u00a0"}
      </p>
    </div>
  );
}
