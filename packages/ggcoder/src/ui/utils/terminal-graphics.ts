// Inline terminal image rendering via the iTerm2 and kitty graphics protocols.
//
// Two protocols cover the common graphics-capable terminals:
//   - "iterm"  → iTerm2 / WezTerm (OSC 1337 File=inline=1)
//   - "kitty"  → kitty / Ghostty   (APC _G chunked transmission)
//
// Detection defaults to "none" on any uncertainty (non-TTY, unknown TERM,
// tmux without passthrough) so we never emit raw escape sequences into a
// terminal that would print them as garbage.

export type GraphicsProtocol = "iterm" | "kitty" | "none";

/** kitty transmits image data in <= 4096-byte base64 chunks. */
const KITTY_CHUNK_SIZE = 4096;

/**
 * Detect which inline-image graphics protocol the current terminal supports.
 *
 * @param env   Environment to inspect (defaults to `process.env`).
 * @param isTTY Whether stdout is a TTY (defaults to `process.stdout.isTTY`).
 *              Graphics are only emitted to a real interactive terminal.
 */
export function detectGraphicsProtocol(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): GraphicsProtocol {
  if (!isTTY) return "none";

  // tmux rewrites/strips graphics sequences unless passthrough is configured.
  // We don't enable passthrough by default, so treat tmux as unsupported.
  if (env["TMUX"] || env["TERM"]?.includes("tmux") || env["TERM"]?.includes("screen")) {
    return "none";
  }

  const termProgram = env["TERM_PROGRAM"];

  // iTerm2 and WezTerm both implement the iTerm2 inline-image OSC.
  if (termProgram === "iTerm.app" || termProgram === "WezTerm" || env["WEZTERM_PANE"]) {
    return "iterm";
  }

  // kitty and Ghostty implement the kitty graphics protocol.
  if (env["KITTY_WINDOW_ID"] || env["TERM"]?.includes("kitty")) {
    return "kitty";
  }
  if (termProgram === "ghostty" || env["GHOSTTY_RESOURCES_DIR"] || env["GHOSTTY_BIN_DIR"]) {
    return "kitty";
  }

  return "none";
}

/**
 * Encode a base64 image payload into an inline-image escape sequence for the
 * given protocol. Returns an empty string for the "none" protocol so callers
 * can append unconditionally.
 */
export function encodeInlineImage(base64: string, protocol: GraphicsProtocol): string {
  if (protocol === "none" || base64.length === 0) return "";

  if (protocol === "iterm") {
    // OSC 1337 ; File = inline=1 ; preserveAspectRatio=1 : <base64> BEL
    return `\u001b]1337;File=inline=1;preserveAspectRatio=1:${base64}\u0007`;
  }

  // kitty graphics protocol: chunked APC transmission.
  //   first chunk:  _G f=100,a=T,m=<1|0> ; <chunk> ST
  //   later chunks: _G m=<1|0> ; <chunk> ST
  // m=1 marks "more chunks follow", m=0 marks the final chunk.
  const chunks: string[] = [];
  for (let offset = 0; offset < base64.length; offset += KITTY_CHUNK_SIZE) {
    const chunk = base64.slice(offset, offset + KITTY_CHUNK_SIZE);
    const isFirst = offset === 0;
    const isLast = offset + KITTY_CHUNK_SIZE >= base64.length;
    const more = isLast ? 0 : 1;
    const control = isFirst ? `f=100,a=T,m=${more}` : `m=${more}`;
    chunks.push(`\u001b_G${control};${chunk}\u001b\\`);
  }
  return chunks.join("");
}
