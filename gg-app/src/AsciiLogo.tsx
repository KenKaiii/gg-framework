import { PRODUCT_DISPLAY_NAME } from "./brand";

// Centered "SUPAH CODER" ASCII banner with a horizontal gradient + animated
// shimmer sweep. Mirrors the brand gradient used across the CLI logos.
const LOGO_LINES = [
  "███████╗██╗   ██╗██████╗  █████╗ ██╗  ██╗     ██████╗ ██████╗ ██████╗ ███████╗██████╗ ",
  "██╔════╝██║   ██║██╔══██╗██╔══██╗██║  ██║    ██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗",
  "███████╗██║   ██║██████╔╝███████║███████║    ██║     ██║   ██║██║  ██║█████╗  ██████╔╝",
  "╚════██║██║   ██║██╔═══╝ ██╔══██║██╔══██║    ██║     ██║   ██║██║  ██║██╔══╝  ██╔══██╗",
  "███████║╚██████╔╝██║     ██║  ██║██║  ██║    ╚██████╗╚██████╔╝██████╔╝███████╗██║  ██║",
  "╚══════╝ ╚═════╝ ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝",
];

export function AsciiLogo(): React.ReactElement {
  return (
    <div className="ascii-logo" aria-label={PRODUCT_DISPLAY_NAME}>
      {LOGO_LINES.map((line, i) => (
        <div className="ascii-logo-line" key={i}>
          {line}
        </div>
      ))}
    </div>
  );
}
