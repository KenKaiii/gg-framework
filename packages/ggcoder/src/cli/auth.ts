import readline from "node:readline/promises";
import path from "node:path";
import chalk from "chalk";
import { renderLoginSelector } from "../ui/login.js";
import { ensureAppDirs } from "../config.js";
import { initLogger, log, closeLogger } from "../core/logger.js";
import { AuthStorage } from "../core/auth-storage.js";
import { loginAnthropic } from "../core/oauth/anthropic.js";
import { loginOpenAI } from "../core/oauth/openai.js";
import { loginGemini } from "../core/oauth/gemini.js";
import { loginKimi } from "../core/oauth/kimi.js";
import { MOONSHOT_OAUTH_KEY } from "@kenkaiiii/gg-core";
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

  try {
    const callbacks: OAuthLoginCallbacks = {
      onOpenUrl: (url) => {
        console.log(chalk.hex("#60a5fa").bold("Opening browser..."));
        openBrowser(url);
        console.log(
          chalk.hex("#6b7280")("\nIf the browser didn't open, visit:\n") +
            chalk.hex("#6b7280")(url) +
            "\n",
        );
      },
      onPromptCode: async (message) => {
        return rl.question(message + " ");
      },
      onStatus: (message) => {
        console.log(chalk.hex("#6b7280")(message));
      },
    };

    // Moonshot supports two auth methods: Kimi Code OAuth (preferred) and a
    // Moonshot Open Platform API key. Let the user pick; OAuth credentials are
    // stored under a distinct key so both can coexist (OAuth wins at runtime).
    let kimiViaOAuth = false;
    if (provider === "moonshot") {
      const choice = (
        await rl.question(
          chalk.hex("#60a5fa")("Sign in with (1) Kimi OAuth [default] or (2) API key? "),
        )
      ).trim();
      kimiViaOAuth = choice === "" || choice === "1";
    }

    let creds;
    let storageKey: string = provider;
    if (provider === "moonshot" && kimiViaOAuth) {
      creds = await loginKimi(callbacks);
      storageKey = MOONSHOT_OAUTH_KEY;
    } else if (
      provider === "glm" ||
      provider === "moonshot" ||
      provider === "xiaomi" ||
      provider === "minimax" ||
      provider === "deepseek" ||
      provider === "openrouter"
    ) {
      const keyLabel =
        provider === "glm"
          ? "Z.AI"
          : provider === "xiaomi"
            ? "Xiaomi MiMo"
            : provider === "minimax"
              ? "MiniMax"
              : provider === "deepseek"
                ? "DeepSeek"
                : provider === "openrouter"
                  ? "OpenRouter"
                  : "Moonshot";
      const apiKey = await rl.question(chalk.hex("#60a5fa")(`Paste your ${keyLabel} API key: `));
      if (!apiKey.trim()) {
        console.log(chalk.hex("#ef4444")("No API key provided. Login cancelled."));
        return;
      }
      creds = {
        accessToken: apiKey.trim(),
        refreshToken: "",
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 * 100, // ~100 years
        ...(provider === "xiaomi" ? { baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" } : {}),
      } satisfies OAuthCredentials;
    } else {
      creds =
        provider === "anthropic"
          ? await loginAnthropic(callbacks)
          : provider === "gemini"
            ? await loginGemini(callbacks)
            : await loginOpenAI(callbacks);
    }

    await authStorage.setCredentials(storageKey, creds);
    log("INFO", "auth", `Login succeeded for ${displayName(provider)}`);
    console.log(chalk.hex("#4ade80")(`\n✓ Logged in to ${displayName(provider)} successfully!`));
  } finally {
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
  const myUid = process.getuid!();
  let fixed = 0;

  // ── Environment ─────────────────────────────────────────────
  console.log(accent("  Environment\n"));
  console.log(dim(`    Home:      ${home}`));
  console.log(dim(`    $HOME:     ${process.env.HOME ?? "(not set)"}`));
  console.log(dim(`    Node.js:   ${process.version}`));
  console.log(dim(`    Platform:  ${process.platform} ${process.arch}`));
  console.log(dim(`    UID:       ${myUid}  EUID: ${process.geteuid!()}`));

  if (process.env.HOME && process.env.HOME !== home) {
    console.log(warn("\n    ⚠ $HOME differs from os.homedir() — this can cause auth mismatches"));
  }
  if (myUid !== process.geteuid!()) {
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
    if (stat.uid !== myUid) {
      console.log(warn(`    ⚠ Owned by uid ${stat.uid}, expected ${myUid}`));
      try {
        await fsP.chown(ggDir, myUid, process.getgid!());
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
    if (stat.uid !== myUid) {
      console.log(warn(`    ⚠ Owned by uid ${stat.uid}, expected ${myUid}`));
      try {
        await fsP.chown(authFile, myUid, process.getgid!());
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
  await authStorage.clearAll();
  log("INFO", "auth", "Logout succeeded");
  closeLogger();
  console.log(chalk.green("Logged out successfully."));
}
