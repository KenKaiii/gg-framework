import { useEffect, useMemo, useState } from "react";

// Home-screen meme cards. Each has a real GIF `src` plus an emoji/caption that
// double as the offline fallback if the GIF fails to load (onError swap), so a
// dead URL never leaves a blank card. Swap `src` for your own hosted GIFs any
// time — the layout/rotation is URL-agnostic.
interface Meme {
  id: number;
  src: string;
  emoji: string;
  caption: string;
}

// Giphy public CDN (i.giphy.com) — designed for hotlink/embedding. Classic
// programmer-humor GIFs.
const MEMES: Meme[] = [
  {
    id: 1,
    src: "https://i.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif",
    emoji: "🔥🐶☕",
    caption: "This is fine.",
  },
  {
    id: 2,
    src: "https://i.giphy.com/media/13HgwGsXF0aiGY/giphy.gif",
    emoji: "🤖",
    caption: "It works on my machine",
  },
  {
    id: 3,
    src: "https://i.giphy.com/media/ZVik7pBtu9dNS/giphy.gif",
    emoji: "🧠💥",
    caption: "git push --force",
  },
  {
    id: 4,
    src: "https://i.giphy.com/media/LmNwrBhejkK9EFP504/giphy.gif",
    emoji: "👀",
    caption: "// TODO: fix later",
  },
  {
    id: 5,
    src: "https://i.giphy.com/media/l3q2K5jinAlChoCLS/giphy.gif",
    emoji: "🚢🐛",
    caption: "Ship it.",
  },
  {
    id: 6,
    src: "https://i.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif",
    emoji: "♻️",
    caption: "Ctrl+C → Ctrl+V",
  },
  {
    id: 7,
    src: "https://i.giphy.com/media/xT9IgG50Fb7Mi0prBC/giphy.gif",
    emoji: "😴",
    caption: "99 little bugs…",
  },
  {
    id: 8,
    src: "https://i.giphy.com/media/mlvseq9yvZhba/giphy.gif",
    emoji: "🦆",
    caption: "Rubber duck debugging",
  },
  {
    id: 9,
    src: "https://i.giphy.com/media/QMHoU66sBXqqLqYvGO/giphy.gif",
    emoji: "💀",
    caption: "Compiles. Don't touch.",
  },
  {
    id: 10,
    src: "https://i.giphy.com/media/NTur7XlVDUdqM/giphy.gif",
    emoji: "🎉",
    caption: "Fixed one bug, made three",
  },
  {
    id: 11,
    src: "https://i.giphy.com/media/nYI8SmmChYXK0/giphy.gif",
    emoji: "🤷🤖",
    caption: "The AI wrote it, not me",
  },
  {
    id: 12,
    src: "https://i.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif",
    emoji: "🫡",
    caption: "Accept all. Read nothing.",
  },
  {
    id: 13,
    src: "https://i.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif",
    emoji: "✅🚀",
    caption: "Vibe check passed. Ship it.",
  },
  {
    id: 14,
    src: "https://i.giphy.com/media/3oKIPnAiaMCws8nOsE/giphy.gif",
    emoji: "🙏📦",
    caption: "npm install && pray",
  },
  {
    id: 15,
    src: "https://i.giphy.com/media/l46Cy1rHbQ92uuLXa/giphy.gif",
    emoji: "🧠📜",
    caption: "Context window full again",
  },
  {
    id: 16,
    src: "https://i.giphy.com/media/l3q2XhfQ8oCkm1Ts4/giphy.gif",
    emoji: "👨‍🍳🔥",
    caption: "My agent is cooking",
  },
  {
    id: 17,
    src: "https://i.giphy.com/media/xT0xezQGU5xCDJuCPe/giphy.gif",
    emoji: "⏳💀",
    caption: "Rate limited mid-vibe",
  },
  {
    id: 18,
    src: "https://i.giphy.com/media/l1J9u3TZfpmeDLkD6/giphy.gif",
    emoji: "🤫",
    caption: "It compiled. Don't ask how.",
  },
  {
    id: 19,
    src: "https://i.giphy.com/media/3oEduSbSGpGaRX2Vri/giphy.gif",
    emoji: "👍👀",
    caption: "LGTM (did not read)",
  },
  {
    id: 20,
    src: "https://i.giphy.com/media/26tn33aiTi1jkl6H6/giphy.gif",
    emoji: "🤝🤖",
    caption: "Merge conflict? Ask the AI.",
  },
  {
    id: 21,
    src: "https://i.giphy.com/media/3o7btPCcdNniyf0ArS/giphy.gif",
    emoji: "💪⌨️",
    caption: "Prompt harder.",
  },
  {
    id: 22,
    src: "https://i.giphy.com/media/xUPGcguWZHRC2HyBRS/giphy.gif",
    emoji: "💸🪙",
    caption: "Tokens are my whole budget",
  },
];

// Four CORNER zones, pinned to the window edges in PIXELS so cards never
// overflow regardless of window size. We always pick 3 DISTINCT corners, so any
// two cards sharing a side are always top+bottom (never stacked) and can't
// overlap. The centered logo/buttons stay clear because every zone hugs a
// corner. Jitter is small and stays within the corner's quadrant.
type VEdge = "top" | "bottom";
type HEdge = "left" | "right";
interface Zone {
  v: VEdge;
  h: HEdge;
  vInset: number;
  hInset: number;
}

const ZONES: Zone[] = [
  { v: "top", h: "left", vInset: 28, hInset: 18 },
  { v: "top", h: "right", vInset: 28, hInset: 18 },
  { v: "bottom", h: "left", vInset: 22, hInset: 18 },
  { v: "bottom", h: "right", vInset: 22, hInset: 18 },
];

interface Placed extends Meme {
  v: VEdge;
  h: HEdge;
  vInset: number;
  hInset: number;
  rotate: number;
}

function pickFour(): Placed[] {
  // 4 distinct memes, one per corner — every corner is filled and no two cards
  // share a corner, so they can't overlap.
  const memes = [...MEMES].sort(() => Math.random() - 0.5).slice(0, ZONES.length);
  const zones = [...ZONES].sort(() => Math.random() - 0.5);
  return memes.map((m, i) => {
    const zone = zones[i]!;
    // Small jitter that keeps the card inside its corner (positive from each
    // anchored edge so it drifts inward, never toward the opposite card).
    return {
      ...m,
      ...zone,
      vInset: zone.vInset + Math.random() * 8,
      hInset: zone.hInset + Math.random() * 12,
      rotate: Math.random() * 8 - 4,
    };
  });
}

/**
 * Decorative floating meme cards on the home screen — 4 of many shown at once (one
 * per corner), rotating every few seconds with a fade. Purely for flair;
 * pointer-events disabled so it never blocks the buttons.
 */
export function MemeLayer(): React.ReactElement {
  const [picks, setPicks] = useState<Placed[]>(() => pickFour());
  // Re-roll the set on an interval; keyed remount drives the fade-in.
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setPicks(pickFour());
      setCycle((c) => c + 1);
    }, 6000);
    return () => clearInterval(id);
  }, []);

  const cards = useMemo(
    () =>
      picks.map((m) => (
        <div
          key={`${cycle}-${m.id}`}
          className="meme-card"
          style={
            {
              [m.v]: `${m.vInset}px`,
              [m.h]: `${m.hInset}px`,
              // Rotation is exposed as a custom property so the entrance keyframe
              // can combine it with a scale/rise without clobbering the angle.
              "--rot": `${m.rotate}deg`,
            } as React.CSSProperties
          }
        >
          <MemeCardBody meme={m} />
        </div>
      )),
    [picks, cycle],
  );

  return (
    <div className="meme-layer" aria-hidden="true">
      {cards}
    </div>
  );
}

/**
 * One card: the GIF, or — if it fails to load — a graceful emoji/caption
 * fallback so a dead URL never leaves an empty card.
 */
function MemeCardBody({ meme }: { meme: Placed }): React.ReactElement {
  const [failed, setFailed] = useState(false);
  return (
    <>
      {failed ? (
        <span className="meme-emoji">{meme.emoji}</span>
      ) : (
        <img
          className="meme-gif"
          src={meme.src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
      {/* Caption overlays the GIF at the bottom with a gradient scrim. */}
      <span className="meme-caption">{meme.caption}</span>
    </>
  );
}
