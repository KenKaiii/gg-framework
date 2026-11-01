/**
 * Pushed background-status updates ride the steering path into the model's
 * context, so they are persisted as `user` messages. But the LIVE transcript
 * never shows a bubble for them — the loop yields `steering_message`, which no
 * host forwards to the UI.
 *
 * That asymmetry was the bug: a session looked clean while you worked in it and
 * came back full of "Background process … exited with code 0" lines the moment
 * you reopened it. Every surface that reconstructs a transcript from the
 * session file must therefore skip them, exactly as it already skips autopilot
 * injections.
 */
import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import { restoreUserRow } from "./session-history.js";
import { findUserSessionPrompt, getUserSessionPrompt } from "./session-preview.js";
import { sessionToMarkdown } from "./session-export.js";
import { buildNotificationSteeringText, STEERING_PREFIX } from "./steering.js";

const DEV_SERVER_NOTIFICATION = buildNotificationSteeringText([
  'Background process c1c45a8d (pnpm dev) exited with code 0 after 40s. Last output: …ELIFECYCLE Command failed. Read it with task_output id="c1c45a8d".',
]);

const PROGRESS_NOTIFICATION = buildNotificationSteeringText([
  "Background process c1c45a8d (pnpm dev) is still running after 3.2m, 48210 bytes logged. Latest: [electron] compiled ok",
]);

/** A realistic resumed transcript: real work, with status updates interleaved. */
function transcript(): Message[] {
  return [
    { role: "user", content: "start the dev server and fix the login bug" },
    { role: "assistant", content: "Starting it now." },
    { role: "user", content: PROGRESS_NOTIFICATION },
    { role: "assistant", content: "Still building. Meanwhile, here's the fix." },
    { role: "user", content: DEV_SERVER_NOTIFICATION },
    { role: "assistant", content: "The server exited; I'll restart it." },
    { role: "user", content: `${STEERING_PREFIX}also add dark mode` },
    { role: "assistant", content: "Done." },
  ];
}

describe("resumed transcript", () => {
  it("hides pushed status updates but keeps everything the user sent", () => {
    const visible = transcript()
      .filter((m) => m.role === "user")
      .map((m) => restoreUserRow(m.content))
      .filter((row) => !row.notification)
      .map((row) => row.text);

    expect(visible).toEqual(["start the dev server and fix the login bug", "also add dark mode"]);
  });

  it("hides them whether the process is still running or has exited", () => {
    expect(restoreUserRow(PROGRESS_NOTIFICATION).notification).toBe(true);
    expect(restoreUserRow(DEV_SERVER_NOTIFICATION).notification).toBe(true);
  });
});

describe("session title", () => {
  it("never uses a status update as the title", () => {
    // Otherwise a session is listed as "Background process c1c45a8d (pnpm dev)
    // exited with code 0" — unrecognisable and unsearchable.
    expect(getUserSessionPrompt(DEV_SERVER_NOTIFICATION)).toBeNull();
    expect(getUserSessionPrompt(PROGRESS_NOTIFICATION)).toBeNull();
  });

  it("falls through a leading status update to the real prompt", () => {
    const title = findUserSessionPrompt([
      { role: "user", content: DEV_SERVER_NOTIFICATION },
      { role: "user", content: "fix the login bug" },
    ]);
    expect(title).toBe("fix the login bug");
  });
});

describe("session export", () => {
  it("omits status updates from exported markdown", () => {
    const markdown = sessionToMarkdown(
      { mode: "code", cwd: "/tmp/project", provider: "anthropic", model: "claude-test" },
      transcript(),
    );

    // The user's own words survive.
    expect(markdown).toContain("start the dev server and fix the login bug");
    expect(markdown).toContain("also add dark mode");
    // The machine framing and its payload do not — an export must match the
    // conversation the user actually had.
    expect(markdown).not.toContain("Status update on");
    expect(markdown).not.toContain("c1c45a8d");
    expect(markdown).not.toContain("still running after");
  });
});

describe("provenance-first visibility", () => {
  const human = { source: "human", kind: "prompt", visibility: "transcript" } as const;
  const hiddenRuntime = {
    source: "runtime",
    kind: "notification",
    visibility: "hidden",
  } as const;

  it("trusts metadata over misleading message text for titles and exports", () => {
    const messages: Message[] = [
      { role: "user", content: "ordinary-looking generated context", provenance: hiddenRuntime },
      { role: "user", content: DEV_SERVER_NOTIFICATION, provenance: human },
    ];

    expect(findUserSessionPrompt(messages)).toBe(DEV_SERVER_NOTIFICATION);
    const markdown = sessionToMarkdown(
      { mode: "code", cwd: "/tmp/project", provider: "anthropic", model: "claude-test" },
      messages,
    );
    expect(markdown).not.toContain("ordinary-looking generated context");
    expect(markdown).toContain(DEV_SERVER_NOTIFICATION);
  });

  it("renders tagged summaries as compaction markers without exporting their payload", () => {
    const markdown = sessionToMarkdown(
      { mode: "code", cwd: "/tmp/project", provider: "anthropic", model: "claude-test" },
      [
        {
          role: "user",
          content: "summary payload without a legacy prefix",
          provenance: {
            source: "runtime",
            kind: "compaction_summary",
            visibility: "summary",
          },
        },
      ],
    );

    expect(markdown).toContain("conversation compacted here");
    expect(markdown).not.toContain("summary payload without a legacy prefix");
    expect(markdown).not.toContain("no messages yet");
  });
});
