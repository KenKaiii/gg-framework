import { renderGgFace, type GgFaceFrame, type GgFaceMood } from "./gg-face";

// The faces never change, so build each SVG once rather than on every render.
const FRAMES: Readonly<Record<GgFaceFrame, string>> = {
  ready: renderGgFace("ready"),
  blink: renderGgFace("blink"),
  happy: renderGgFace("happy"),
  curious: renderGgFace("curious"),
  worried: renderGgFace("worried"),
  sad: renderGgFace("sad"),
  shocked: renderGgFace("shocked"),
};

/**
 * GG Coder's little robot (see gg-face.ts) showing a mood. Ready blinks now
 * and then; the other moods hold still. `size` is the edge in CSS px.
 * Decorative: the text beside it carries the meaning.
 */
export function GgFace({
  mood,
  size = 18,
}: {
  mood: GgFaceMood;
  size?: number;
}): React.ReactElement {
  return (
    <span
      className={`gg-face gg-face-${mood}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <img className="gg-face-layer" src={FRAMES[mood]} alt="" draggable={false} />
      {mood === "ready" && (
        <img className="gg-face-layer gg-face-blink" src={FRAMES.blink} alt="" draggable={false} />
      )}
    </span>
  );
}
