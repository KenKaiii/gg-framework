import readline from "node:readline/promises";
import path from "node:path";
import chalk from "chalk";
import { renderLoginSelector } from "../ui/login.js";
import { ensureAppDirs } from "../config.js";
import { initLogger, log, closeLogger } from "../core/logger.js";
import { AuthStorage } from "../core/auth-storage.js";
import {
  CHATGPT_USAGE_URL,
  ChatGPTPlanNotEnabledError,
  loginChatGPT,
  revokeChatGPTSignIn,
} from "../core/oauth/openai.js";
import {
  OPENAI_CHATGPT_KEY,
  dualAuthProvider,
  signInWithClaudeCode,
  signInWithHermes,
  signOutOfClaudeCode,
} from "@kenkaiiii/gg-core";
import { getAuthProvider, describeAuthMethods } from "../core/auth-providers.js";
import type { OAuthCredentials, OAuthLoginCallbacks } from "../core/oauth/types.js";
import {
  CLI_VERSION,
  clearVisibleScreen,
  displayName,
  renderLogoBlock,
  openBrowser,
  requireInteractiveTTY,
} from "./shared.js";

export async function runLogin(): Promise<void> {
  requireInteractiveTTY();
  clearVisibleScreen();
  const paths = await ensureAppDirs();
  initLogger(paths.logFile, { version: CLI_VERSION });
  log("INFO", "auth", "Login flow started");

  const authStorage = new AuthStorage();
  await authStorage.load();

  // Phase 1: Ink-based provider selector
  const provider = await renderLoginSelector(CLI_VERSION);
  if (!provider) {
    console.log(chalk.hex("#6b7280")("Login cancelled."));
    return;
  }

  console.log(
    chalk.hex("#60a5fa").bold("\nLogging in to ") +
      chalk.hex("#a78bfa")(displayName(provider)) +
      chalk.hex("#60a5fa").bold("...\n"),
  );

  // Phase 2: OAuth flow (readline needed for Anthropic code paste)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Download progress repaints one terminal line instead of printing ~100.
  let progressLine = false;
  const endProgressLine = () => {
    if (progressLine) process.stdout.write("\n");
    progressLine = false;
  };

  try {
    const callbacks: OAuthLoginCallbacks = {
      onOpenUrl: (url) => {
        endProgressLine();
        console.log(chalk.hex("#60a5fa").bold("Opening browser..."));
        openBrowser(url);
        console.log(
          chalk.hex("#6b7280")("\nIf the browser didn't open, visit:\n") +
            chalk.hex("#6b7280")(url) +
            "\n",
        );
      },
      onPromptCode: async (message, signal) => {
        // `signal` fires when the code already arrived over the loopback
        // callback, so the competing paste prompt is torn down rather than
        // holding the terminal open after login has already succeeded.
        return signal ? rl.question(message + " ", { signal }) : rl.question(message + " ");
      },
      onStatus: (message) => {
        if (process.stdout.isTTY && message.startsWith("Downloading Claude Code…")) {
          process.stdout.write(`\r\x1b[2K${chalk.hex("#6b7280")(message)}`);
          progressLine = true;
          return;
        }
        endProgressLine();
        console.log(chalk.hex("#6b7280")(message));
      },
    };

    // Dual-auth providers (OpenAI) take a plan sign-in *and* a pay-per-token
    // API key. Let the user pick; the sign-in is stored under a distinct key so
    // both can coexist (the plan wins at runtime, the key covers it while its
    // usage is out — see gg-core's DUAL_AUTH_PROVIDERS).
    const dual = dualAuthProvider(provider);
    let useOAuth = false;
    if (dual) {
      for (const detail of describeAuthMethods(provider)) {
        const n = detail.method === "oauth" ? "1" : "2";
        console.log(chalk.hex("#a78bfa")(`  (${n}) ${detail.label}`));
        console.log(chalk.hex("#6b7280")(`      ${detail.billing}`));
        if (detail.requires) console.log(chalk.hex("#6b7280")(`      Needs: ${detail.requires}`));
      }
      console.log(
        chalk.hex("#6b7280")(
          `\n  Connecting both is fine — your ${dual.oauthLabel} is used first and the ` +
            `${dual.apiKeyLabel} covers it while its usage is out.\n`,
        ),
      );
      const [signIn, apiKey] = describeAuthMethods(provider);
      const choice = (
        await rl.question(
          chalk.hex("#60a5fa")(`Use (1) ${signIn?.label} [default] or (2) ${apiKey?.label}? `),
        )
      ).trim();
      useOAuth = choice === "" || choice === "1";
    }

    // Anthropic: Sign in with Claude (runs through Claude Code, downloaded on
    // first use) or an Anthropic API key on the normal request path.
    let claudeSignIn = false;
    if (provider === "anthropic") {
      const details = describeAuthMethods(provider);
      for (const detail of details) {
        const n = detail.method === "oauth" ? "1" : "2";
        console.log(chalk.hex("#a78bfa")(`  (${n}) ${detail.label}`));
        console.log(chalk.hex("#6b7280")(`      ${detail.billing}`));
        if (detail.when) console.log(chalk.hex("#6b7280")(`      ${detail.when}`));
      }
      if (details.some((d) => d.method === "apikey")) {
        const choice = (
          await rl.question(
            chalk.hex("#60a5fa")(
              "Use (1) Sign in with Claude [default] or (2) an Anthropic API key? ",
            ),
          )
        ).trim();
        claudeSignIn = choice === "" || choice === "1";
      } else {
        claudeSignIn = true;
      }
    }

    if (claudeSignIn) {
      const status = await signInWithClaudeCode(authStorage, callbacks);
      endProgressLine();
      log("INFO", "auth", "Signed in with Claude through Claude Code");
      console.log(
        chalk.hex("#4ade80")(
          `\n✓ Signed in with Claude${status.email ? ` as ${status.email}` : ""}!`,
        ),
      );
      return;
    }

    if (dual && useOAuth) {
      try {
        const previous = await authStorage.getCredentials(OPENAI_CHATGPT_KEY);
        const creds = await loginChatGPT(callbacks, previous ? { previous } : {});
        await authStorage.setCredentials(OPENAI_CHATGPT_KEY, creds);
      } catch (err) {
        if (!(err instanceof ChatGPTPlanNotEnabledError)) throw err;
        console.log(chalk.hex("#fbbf24")(`\n${err.message}`));
        return;
      }
      log("INFO", "auth", "Signed in with ChatGPT");
      console.log(chalk.hex("#4ade80")("\n✓ Signed in with ChatGPT!"));
      console.log(chalk.hex("#6b7280")(`  Manage what GG Coder may use at ${CHATGPT_USAGE_URL}`));
      return;
    }

    // Nous Portal: the sign-in lives in Hermes Agent, which also owns the
    // subscription proxy GG Coder routes through.
    if (provider === "nous") {
      await signInWithHermes(authStorage, callbacks);
      endProgressLine();
      log("INFO", "auth", "Signed in to Nous Portal through Hermes");
      console.log(chalk.hex("#4ade80")("\n✓ Signed in to Nous Portal through Hermes!"));
      return;
    }

    const meta = getAuthProvider(provider);
    if (!meta?.methods.includes("apikey")) {
      console.log(chalk.hex("#ef4444")(`${displayName(provider)} has no API key option.`));
      return;
    }
    // A provider taking both a plan key and a pay-per-token key (Kimi, Xiaomi)
    // stores each under its own key; ask which one this is.
    const variants = meta.apiKeyVariants ?? [];
    let variant = variants[0];
    if (variants.length > 1) {
      variants.forEach((v, i) => {
        console.log(chalk.hex("#a78bfa")(`  (${i + 1}) ${v.label}`));
        console.log(chalk.hex("#6b7280")(`      ${v.billing}`));
      });
      const choice = (
        await rl.question(
          chalk.hex("#60a5fa")(
            `Which key is this? ${variants.map((v, i) => `(${i + 1}) ${v.label}`).join(" or ")} [1] `,
          ),
        )
      ).trim();
      variant = variants[Number(choice) - 1] ?? variants[0];
    } else {
      const detail = describeAuthMethods(provider).find((d) => d.method === "apikey");
      if (detail?.billing) console.log(chalk.hex("#6b7280")(`  ${detail.billing}`));
      if (detail?.when) console.log(chalk.hex("#6b7280")(`  ${detail.when}`));
    }
    // Key label comes from AUTH_PROVIDERS so the CLI and the desktop app can
    // never drift on what a provider's key is called.
    const keyLabel = variant?.label ?? meta.apiKeyLabel ?? displayName(provider);
    const apiKey = await rl.question(chalk.hex("#60a5fa")(`Paste your ${keyLabel} API key: `));
    if (!apiKey.trim()) {
      console.log(chalk.hex("#ef4444")("No API key provided. Login cancelled."));
      return;
    }
    const baseUrl = variant?.baseUrl ?? meta.apiKeyBaseUrl;
    const creds = {
      accessToken: apiKey.trim(),
      refreshToken: "",
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 * 100, // ~100 years
      ...(baseUrl ? { baseUrl } : {}),
    } satisfies OAuthCredentials;
    const storageKey = variant?.key ?? provider;

    await authStorage.setCredentials(storageKey, creds);
    log("INFO", "auth", `Login succeeded for ${displayName(provider)}`);
    console.log(chalk.hex("#4ade80")(`\n✓ Logged in to ${displayName(provider)} successfully!`));
  } finally {
    endProgressLine();
    rl.close();
    closeLogger();
  }
}

export async function runDoctor(): Promise<void> {
  clearVisibleScreen();

  const os = await import("node:os");
  const fsP = await import("node:fs/promises");

  const dim = chalk.hex("#6b7280");
  const primary = chalk.hex("#60a5fa");
  const accent = chalk.hex("#a78bfa");
  const good = chalk.hex("#4ade80");
  const warn = chalk.hex("#fbbf24");
  const bad = chalk.hex("#ef4444");

  // ── Banner ──────────────────────────────────────────────────
  console.log();
  for (const row of renderLogoBlock([
    primary.bold("GG Coder") +
      dim(` v${CLI_VERSION}`) +
      dim(" · By ") +
      chalk.white.bold("Ken Kai"),
    accent("Doctor"),
    dim("Diagnose & Fix"),
  ])) {
    console.log(row);
  }
  console.log();

  const home = os.homedir();
  const ggDir = path.join(home, ".gg");
  const authFile = path.join(ggDir, "auth.json");
  const lockFile = authFile + ".lock";
  // uid/gid exist only on POSIX; Windows has no file ownership to check or fix.
  const ids =
    process.getuid && process.geteuid && process.getgid
      ? { uid: process.getuid(), euid: process.geteuid(), gid: process.getgid() }
      : null;
  let fixed = 0;

  // ── Environment ─────────────────────────────────────────────
  console.log(accent("  Environment\n"));
  console.log(dim(`    Home:      ${home}`));
  console.log(dim(`    $HOME:     ${process.env.HOME ?? "(not set)"}`));
  console.log(dim(`    Node.js:   ${process.version}`));
  console.log(dim(`    Platform:  ${process.platform} ${process.arch}`));
  if (ids) console.log(dim(`    UID:       ${ids.uid}  EUID: ${ids.euid}`));

  if (process.env.HOME && process.env.HOME !== home) {
    console.log(warn("\n    ⚠ $HOME differs from os.homedir() — this can cause auth mismatches"));
  }
  if (ids && ids.uid !== ids.euid) {
    console.log(warn("    ⚠ uid ≠ euid — running with elevated privileges (sudo?)"));
    console.log(dim("      Running ggcoder with sudo can cause ownership issues."));
    console.log(dim("      Use without sudo, or fix after: sudo chown -R $(whoami) ~/.gg"));
  }
  console.log();

  // ── Config Directory ────────────────────────────────────────
  console.log(accent("  Config Directory\n"));

  try {
    const stat = await fsP.stat(ggDir);
    const mode = stat.mode & 0o777;
    console.log(dim(`    Path:  ${ggDir}`));
    console.log(dim(`    Mode:  0o${mode.toString(8)}  UID: ${stat.uid}`));

    // Fix ownership
    if (ids && stat.uid !== ids.uid) {
      console.log(warn(`    ⚠ Owned by uid ${stat.uid}, expected ${ids.uid}`));
      try {
        await fsP.chown(ggDir, ids.uid, ids.gid);
        console.log(good("    ✓ Fixed directory ownership"));
        fixed++;
      } catch {
        console.log(bad(`    ✗ Cannot fix — try: sudo chown -R $(whoami) ${ggDir}`));
      }
    }

    // Fix permissions (should be 0o700)
    if (mode !== 0o700) {
      try {
        await fsP.chmod(ggDir, 0o700);
        console.log(good("    ✓ Fixed directory permissions → 0o700"));
        fixed++;
      } catch {
        console.log(bad(`    ✗ Cannot fix — try: chmod 700 ${ggDir}`));
      }
    }
  } catch {
    console.log(warn(`    ${ggDir} missing — creating...`));
    try {
      await fsP.mkdir(ggDir, { recursive: true, mode: 0o700 });
      console.log(good(`    ✓ Created ${ggDir}`));
      fixed++;
    } catch (mkErr) {
      console.log(
        bad(`    ✗ Cannot create: ${mkErr instanceof Error ? mkErr.message : String(mkErr)}`),
      );
      console.log();
      return;
    }
  }
  console.log();

  // ── Lock File ───────────────────────────────────────────────
  try {
    const lockStat = await fsP.stat(lockFile);
    const ageMs = Date.now() - lockStat.mtimeMs;
    console.log(accent("  Lock File\n"));
    console.log(warn(`    ⚠ Stale lock found (age: ${Math.round(ageMs / 1000)}s)`));
    await fsP.unlink(lockFile);
    console.log(good("    ✓ Removed"));
    fixed++;
    console.log();
  } catch {
    // No lock file — good, skip section entirely
  }

  // ── Auth File ───────────────────────────────────────────────
  console.log(accent("  Auth File\n"));

  let authData: Record<string, unknown> | null = null;
  let authNeedsRewrite = false;

  try {
    const stat = await fsP.stat(authFile);
    const mode = stat.mode & 0o777;
    console.log(dim(`    Path:  ${authFile}`));
    console.log(
      dim(`    Size:  ${stat.size} bytes  Mode: 0o${mode.toString(8)}  UID: ${stat.uid}`),
    );

    // Fix ownership
    if (ids && stat.uid !== ids.uid) {
      console.log(warn(`    ⚠ Owned by uid ${stat.uid}, expected ${ids.uid}`));
      try {
        await fsP.chown(authFile, ids.uid, ids.gid);
        console.log(good("    ✓ Fixed file ownership"));
        fixed++;
      } catch {
        console.log(bad(`    ✗ Cannot fix — try: sudo chown $(whoami) ${authFile}`));
      }
    }

    // Fix permissions (should be 0o600)
    if (mode !== 0o600) {
      try {
        await fsP.chmod(authFile, 0o600);
        console.log(good("    ✓ Fixed file permissions → 0o600"));
        fixed++;
      } catch {
        console.log(bad(`    ✗ Cannot fix — try: chmod 600 ${authFile}`));
      }
    }

    // Try to read and parse
    try {
      const content = await fsP.readFile(authFile, "utf-8");
      try {
        authData = JSON.parse(content) as Record<string, unknown>;
      } catch {
        console.log(bad("    ✗ Invalid JSON — backing up and resetting"));
        const backupName = `auth.json.corrupt.${Date.now()}`;
        await fsP.copyFile(authFile, path.join(ggDir, backupName));
        await fsP.writeFile(authFile, "{}", { encoding: "utf-8", mode: 0o600 });
        console.log(good(`    ✓ Corrupt file backed up as ${backupName}`));
        console.log(dim('      Run "ggcoder login" to re-authenticate'));
        authData = {};
        fixed++;
      }
    } catch (readErr) {
      const code = (readErr as NodeJS.ErrnoException).code;
      if (code === "EACCES") {
        console.log(bad("    ✗ Permission denied reading auth.json"));
        console.log(dim(`      Try: sudo chown $(whoami) ${authFile} && chmod 600 ${authFile}`));
      } else {
        console.log(
          bad(`    ✗ Read error: ${readErr instanceof Error ? readErr.message : String(readErr)}`),
        );
      }
    }
  } catch {
    console.log(dim(`    Path:  ${authFile}`));
    console.log(warn('    Not found — run "ggcoder login" to authenticate'));
  }
  console.log();

  // ── Credentials ─────────────────────────────────────────────
  if (authData && Object.keys(authData).length > 0) {
    console.log(accent("  Credentials\n"));

    for (const p of Object.keys(authData)) {
      const cred = authData[p] as Record<string, unknown> | undefined;
      if (!cred || typeof cred !== "object") {
        console.log(bad(`    ✗ ${p}: invalid entry — removing`));
        delete authData[p];
        authNeedsRewrite = true;
        fixed++;
        continue;
      }
      if (!cred.accessToken || typeof cred.accessToken !== "string") {
        console.log(bad(`    ✗ ${p}: missing accessToken — removing`));
        delete authData[p];
        authNeedsRewrite = true;
        fixed++;
        continue;
      }
      const token = String(cred.accessToken);
      const masked = token.slice(0, 8) + "..." + token.slice(-4);
      const expires =
        typeof cred.expiresAt === "number" ? new Date(cred.expiresAt).toISOString() : "unknown";
      const expired = typeof cred.expiresAt === "number" && Date.now() > cred.expiresAt;
      if (expired) {
        console.log(warn(`    ⚠ ${p}: ${masked}  expired ${expires}`));
      } else {
        console.log(good(`    ✓ ${p}: ${masked}  expires ${expires}`));
      }
    }

    if (authNeedsRewrite) {
      try {
        await fsP.writeFile(authFile, JSON.stringify(authData, null, 2), {
          encoding: "utf-8",
          mode: 0o600,
        });
        console.log(good("    ✓ Cleaned up auth.json"));
      } catch {
        console.log(bad("    ✗ Failed to write cleaned auth.json"));
      }
    }
    console.log();
  }

  // ── Temp Files ──────────────────────────────────────────────
  try {
    const entries = await fsP.readdir(ggDir);
    const tmpFiles = entries.filter((e) => e.startsWith("auth.json.") && e.endsWith(".tmp"));
    if (tmpFiles.length > 0) {
      console.log(accent("  Temp Files\n"));
      console.log(warn(`    ⚠ ${tmpFiles.length} orphaned temp file(s) from interrupted writes`));
      for (const tmp of tmpFiles) {
        await fsP.unlink(path.join(ggDir, tmp)).catch(() => {});
      }
      console.log(good(`    ✓ Removed ${tmpFiles.length} file(s)`));
      fixed++;
      console.log();
    }
  } catch {
    // Can't read directory — already flagged above
  }

  // ── Summary ─────────────────────────────────────────────────
  if (fixed > 0) {
    console.log(good(`  ✓ Fixed ${fixed} issue${fixed > 1 ? "s" : ""}.`));
  } else {
    console.log(good("  ✓ Everything looks good."));
  }
  console.log();
}

export async function runLogout(): Promise<void> {
  const paths = await ensureAppDirs();
  initLogger(paths.logFile, { version: CLI_VERSION });
  log("INFO", "auth", "Logout requested");

  const authStorage = new AuthStorage();
  await authStorage.load();
  // Claude Code holds the Claude login itself; the marker goes with clearAll.
  await signOutOfClaudeCode(authStorage);
  // End the ChatGPT plan's renewable session at OpenAI before dropping it.
  const chatgpt = await authStorage.getCredentials(OPENAI_CHATGPT_KEY);
  const revoked = chatgpt ? await revokeChatGPTSignIn(chatgpt) : true;
  await authStorage.clearAll();
  log("INFO", "auth", "Logout succeeded");
  closeLogger();
  console.log(chalk.green("Logged out successfully."));
  if (!revoked) {
    console.log(
      chalk.hex("#fbbf24")(
        "OpenAI didn't confirm the ChatGPT sign-out. Disconnect GG Coder in ChatGPT settings to be sure.",
      ),
    );
  }
}
