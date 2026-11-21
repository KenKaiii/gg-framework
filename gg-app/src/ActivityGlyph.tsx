import { ACTIVITY_GLYPHS, glyphPath, type ActivityGlyphName } from "./pixel-glyphs";

/**
 * The activity bar's lead: the current step's pixel glyph in a sunk well, in
 * the status colour. While work runs (`live`), one pixel marches along the
 * well's floor.
 */
export function ActivityGlyph({
  glyph,
  color,
  live,
}: {
  glyph: ActivityGlyphName;
  color: string;
  live: boolean;
}): React.ReactElement {
  const rows = ACTIVITY_GLYPHS[glyph];
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  return (
    <span
      className="well activity-glyph"
      data-glyph={glyph}
      data-live={live ? "" : undefined}
      aria-hidden="true"
      style={{ color }}
    >
      {/* Keyed so only a changed step fades its glyph in. */}
      <svg
        key={glyph}
        className="activity-glyph-art"
        width={w * 2}
        height={h * 2}
        viewBox={`0 0 ${w} ${h}`}
        shapeRendering="crispEdges"
      >
        <path d={glyphPath(rows)} fill="currentColor" />
      </svg>
    </span>
  );
}
