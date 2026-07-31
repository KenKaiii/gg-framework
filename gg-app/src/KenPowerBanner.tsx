// "SUPAH ON" / "SUPAH OFF" ASCII banner shown over the chat BODY (inside
// `.transcript-frame`, a non-scrolling sibling of `.transcript` sized to the
// same viewport — NOT inside `.transcript` itself, which scrolls, so an
// absolutely positioned overlay there would pin to the scrolled content
// instead of what's on screen) when Autopilot (Ken's auto-review loop) is
// toggled — the chat head/nav and footer stay visible around it. Same
// ANSI-Shadow block font as the home-screen SUPAH CODER logo (see AsciiLogo.tsx),
// tinted in Ken's teal. Pops in with the same scale+fade "flash" the app uses
// for its zoom-level HUD, holds briefly, then dissolves back out — quick,
// decorative, non-interactive, no lateral motion. Self-removes via `onDone`
// once the animation finishes so the caller can just stop rendering it.
const KEN_IS_ON = [
  "███████╗██╗   ██╗██████╗  █████╗ ██╗  ██╗     ██████╗ ███╗   ██╗",
  "██╔════╝██║   ██║██╔══██╗██╔══██╗██║  ██║    ██╔═══██╗████╗  ██║",
  "███████╗██║   ██║██████╔╝███████║███████║    ██║   ██║██╔██╗ ██║",
  "╚════██║██║   ██║██╔═══╝ ██╔══██║██╔══██║    ██║   ██║██║╚██╗██║",
  "███████║╚██████╔╝██║     ██║  ██║██║  ██║    ╚██████╔╝██║ ╚████║",
  "╚══════╝ ╚═════╝ ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝     ╚═════╝ ╚═╝  ╚═══╝",
];

const KEN_IS_OFF = [
  "███████╗██╗   ██╗██████╗  █████╗ ██╗  ██╗     ██████╗ ███████╗███████╗",
  "██╔════╝██║   ██║██╔══██╗██╔══██╗██║  ██║    ██╔═══██╗██╔════╝██╔════╝",
  "███████╗██║   ██║██████╔╝███████║███████║    ██║   ██║█████╗  █████╗  ",
  "╚════██║██║   ██║██╔═══╝ ██╔══██║██╔══██║    ██║   ██║██╔══╝  ██╔══╝  ",
  "███████║╚██████╔╝██║     ██║  ██║██║  ██║    ╚██████╔╝██║     ██║     ",
  "╚══════╝ ╚═════╝ ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝     ╚═════╝ ╚═╝     ╚═╝     ",
];

interface Props {
  mode: "on" | "off";
  /** Fired once the slide-out animation finishes — unmount it here. */
  onDone: () => void;
}

export function KenPowerBanner({ mode, onDone }: Props): React.ReactElement {
  const lines = mode === "on" ? KEN_IS_ON : KEN_IS_OFF;
  return (
    <div className="ken-power-overlay" aria-hidden="true">
      {/* Keyed on `mode` so flipping the toggle again mid-animation remounts
          this node instead of restyling it in place — the slide-in/out
          animation always plays from a clean start, even on a rapid
          on/off/on flip. */}
      <div
        key={mode}
        className={`ken-power-banner ken-power-banner-${mode}`}
        onAnimationEnd={onDone}
      >
        {lines.map((line, i) => (
          <div className="ken-power-banner-line" key={i}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
