/**
 * World's loading screen (owner: "it has to load with some sort of animation, not just Loading, so it doesn't look
 * frozen"). Shown the moment World is opened, until the game has drawn its first frame.
 *
 * World builds its rooms on the app's own main thread (a sealed iframe shares the app's process in WebKit), so a
 * JavaScript-driven animation would stutter while it works. Everything that moves here animates only transform and
 * opacity, which WebKit hands to the compositor: the house keeps floating, the lit windows keep glowing and the bar's
 * sheen keeps sweeping even while World is busy. The fill and the line of text follow World's real progress
 * ({ t: 'progress', p, label } messages: "Building the Den", "Planting the street"...).
 */
export type WorldBoot = { p: number; label: string };

/** Window panes on the house, lit one by one as loading goes on (x, y in the SVG's units). */
const PANES: Array<[number, number]> = [
  [-38, 2],
  [-22, 10],
  [-38, 24],
  [-22, 32],
  [22, 10],
  [38, 2],
  [22, 32],
  [38, 24],
];

export function WorldLoading({
  boot,
  gone,
}: {
  boot: WorldBoot | null;
  gone: boolean;
}): React.ReactElement {
  const p = Math.max(0, Math.min(1, boot?.p ?? 0));
  const lit = Math.round(p * PANES.length);
  return (
    <div className={`world-loading${gone ? " is-gone" : ""}`} aria-hidden={gone}>
      <div className="world-loading-scene" aria-hidden="true">
        <span className="world-loading-star s1" />
        <span className="world-loading-star s2" />
        <span className="world-loading-star s3" />
        <span className="world-loading-star s4" />
        <div className="world-loading-float">
          <svg className="world-loading-house" viewBox="-70 -78 140 150" width="140" height="150">
            <defs>
              <linearGradient id="wl-left" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#3a2f55" />
                <stop offset="1" stopColor="#261f3b" />
              </linearGradient>
              <linearGradient id="wl-right" x1="1" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#4a3c6c" />
                <stop offset="1" stopColor="#30274a" />
              </linearGradient>
              <linearGradient id="wl-roofL" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#8a4c63" />
                <stop offset="1" stopColor="#5e3346" />
              </linearGradient>
              <linearGradient id="wl-roofR" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#a65d77" />
                <stop offset="1" stopColor="#7a4157" />
              </linearGradient>
              <radialGradient id="wl-glow">
                <stop offset="0" stopColor="#ffd29a" stopOpacity="0.85" />
                <stop offset="1" stopColor="#ffd29a" stopOpacity="0" />
              </radialGradient>
            </defs>
            {/* isometric walls */}
            <path d="M0 48 L-52 22 L-52 -14 L0 12 Z" fill="url(#wl-left)" />
            <path d="M0 48 L52 22 L52 -14 L0 12 Z" fill="url(#wl-right)" />
            {/* roof */}
            {/* a hip roof over the walls' top diamond (with a little overhang): its two front faces */}
            <path d="M-57 -15 L0 14 L0 -58 Z" fill="url(#wl-roofL)" />
            <path d="M57 -15 L0 14 L0 -58 Z" fill="url(#wl-roofR)" />
            <path d="M0 -58 L0 14" stroke="#c77a95" strokeWidth="1.5" opacity="0.6" />
            {/* chimney */}
            <path d="M24 -44 L32 -40 L32 -26 L24 -30 Z" fill="#5e3346" />
            <path d="M24 -44 L32 -40 L38 -43 L30 -47 Z" fill="#a65d77" />
            {/* door */}
            <path d="M6 42 L14 38 L14 24 L6 28 Z" fill="#1a1428" />
            {PANES.map(([x, y], i) => {
              const on = i < lit;
              const right = x > 0;
              const d = right
                ? `M${x - 5} ${y + 2.5} L${x + 5} ${y - 2.5} L${x + 5} ${y - 12.5} L${x - 5} ${y - 7.5} Z`
                : `M${x - 5} ${y - 2.5} L${x + 5} ${y + 2.5} L${x + 5} ${y - 7.5} L${x - 5} ${y - 12.5} Z`;
              return (
                <g key={i} className={`world-loading-pane${on ? " is-lit" : ""}`}>
                  <circle
                    cx={x}
                    cy={y - 5}
                    r="13"
                    fill="url(#wl-glow)"
                    className="world-loading-halo"
                  />
                  <path d={d} className="world-loading-glass" />
                </g>
              );
            })}
          </svg>
        </div>
        <span className="world-loading-shadow" />
      </div>
      <div className="world-loading-text">{boot?.label ? `${boot.label}…` : "Opening World…"}</div>
      <div
        className="world-loading-bar"
        role="progressbar"
        aria-label="Loading World"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(p * 100)}
      >
        <span
          className="world-loading-fill"
          style={{ transform: `scaleX(${Math.max(0.04, p)})` }}
        />
        <span className="world-loading-sheen" />
      </div>
    </div>
  );
}
