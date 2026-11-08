// Replace CLI-specific guidance (slash commands, CLI tool names) with
// desktop-app equivalents so the webview never shows "run ggcoder login".
// Applied to BOTH the message and guidance fields — the auth "Not logged in…
// Run "ggcoder login"" string lives in `message`, not `guidance`.
export function desktopGuidance(guidance: string): string {
  return (
    guidance
      // Auth: `Run "ggcoder login"` / `Run 'ggcoder login'` / `Run `ggcoder login``
      // (any quote style, or none) → button. Do this first so the whole phrase
      // is rewritten cleanly instead of leaving a dangling `Run "…"`.
      .replaceAll(/Run ["'`]?ggcoder login["'`]?/gi, "Use the Login to AI Providers button")
      // Any remaining bare mention.
      .replaceAll(/ggcoder login/gi, "the Login to AI Providers button")
      // /compact: the app has NO manual compact command or button — it only
      // auto-compacts (and now auto-recovers on overflow). If this guidance is
      // reached, auto-compaction already couldn't reduce enough, so the only
      // real affordance is a fresh session. Don't tell the user to run a
      // command that doesn't exist in the app.
      .replaceAll(
        /Run \/compact to shrink history, or start a new session\./gi,
        "Start a new session to reset the context.",
      )
      // /model: handle each phrasing pattern
      .replaceAll(/switch to (\S+) with \/model/gi, "switch to $1 using the model selector")
      .replaceAll(/Switch with \/model\./gi, "Switch using the model selector.")
      .replaceAll(
        /try a different model with \/model\./gi,
        "try a different model using the model selector.",
      )
      .replaceAll(/Use \/model to switch/gi, "Use the model selector to switch")
      // /help
      .replaceAll(/see \/help/gi, "check the help menu")
  );
}
