import { useEffect, useRef } from "react";

/**
 * An icon button drawn as a GG Royale sprite: the game's 1px ink outline, a
 * light edge where the light falls (top left) and a shade on the far side,
 * like its lock, shield and heart icons. Pointing at it lifts it a pixel and
 * rings it in the game's hover colour; pressing sinks it.
 *
 * Sprites are rows of palette keys ("." is clear), shown at --icon-px screen
 * pixels per art pixel with nearest-neighbour sampling.
 */

/** GG Royale colours: ink, then steel (its lock shackle and calendar rings). */
const PALETTE = {
  "#": "#1e0c1f",
  h: "#c8bed2",
  b: "#8a9ab0",
  s: "#5a6880",
} as const;
type PaletteKey = keyof typeof PALETTE;

export const PIXEL_ICONS = {
  gear: [
    "........##........",
    ".......#hs#.......",
    "...##..#hs#..##...",
    "..#hs###hs###hs#..",
    "..#sbhhhbbhhhbs#..",
    "...#hbbbbbbbbs#...",
    "...#hbbbssbbbs#...",
    ".###hbbs##sbbs###.",
    "#hhhbbs#..#hbbhhs#",
    "#sssbbs#..#hbbsss#",
    ".###hbbs##hbbs###.",
    "...#hbbbhhbbbs#...",
    "...#hbbbbbbbbs#...",
    "..#hbsssbbsssbs#..",
    "..#ss###hs###ss#..",
    "...##..#hs#..##...",
    ".......#ss#.......",
    "........##........",
  ],
} as const;
export type PixelIcon = keyof typeof PIXEL_ICONS;

function isPaletteKey(ch: string): ch is PaletteKey {
  return ch in PALETTE;
}

function paint(canvas: HTMLCanvasElement, rows: readonly string[]): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] ?? ".";
      if (!isPaletteKey(ch)) continue;
      ctx.fillStyle = PALETTE[ch];
      ctx.fillRect(x, y, 1, 1);
    }
  });
}

interface Props extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly icon: PixelIcon;
  /** The button's accessible name (it has no visible text). */
  readonly label: string;
}

export function PixelIconButton({ icon, label, className, ...rest }: Props): React.ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  const rows = PIXEL_ICONS[icon];
  const w = rows[0]?.length ?? 0;
  const h = rows.length;
  useEffect(() => {
    if (ref.current) paint(ref.current, PIXEL_ICONS[icon]);
  }, [icon]);
  return (
    <button
      type="button"
      className={`pixel-icon-button${className ? ` ${className}` : ""}`}
      aria-label={label}
      style={{ "--icon-w": w, "--icon-h": h } as React.CSSProperties}
      {...rest}
    >
      <canvas ref={ref} width={w} height={h} aria-hidden="true" />
    </button>
  );
}
