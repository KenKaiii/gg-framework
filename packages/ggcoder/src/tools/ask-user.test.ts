import { describe, expect, it, vi } from "vitest";
import { createAskUserBridge, type AskUserPrompt } from "../core/ask-user.js";
import { createAskUserTool } from "./ask-user.js";
import os from "node:os";
import { buildSystemPrompt } from "../system-prompt.js";

/** The tool + bridge wired the way the sidecar wires them, minus the HTTP hop. */
function harness() {
  const broadcast = vi.fn<(prompt: AskUserPrompt) => void>();
  const bridge = createAskUserBridge({ broadcast, timeoutMs: 60_000 });
  const tool = createAskUserTool(bridge.park);
  const call = (args: unknown): Promise<string> =>
    Promise.resolve(
      tool.execute(tool.parameters.parse(args), {
        signal: new AbortController().signal,
        toolCallId: "t1",
        onUpdate: () => {},
      } as never),
    ) as Promise<string>;
  /** The prompt the UI would have rendered, once it has been broadcast. */
  const prompt = async (): Promise<AskUserPrompt> => {
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalled());
    return broadcast.mock.calls[0]![0];
  };
  return { bridge, call, prompt, broadcast };
}

describe("ask_user", () => {
  // The routing rule is about WHETHER a question exists, not how weighty it is.
  // Scoping the tool to "blocking decisions" left soft closers ("want me to
  // also…?") with nowhere legal to go: the system prompt bans a written asking
  // line whenever this tool is registered, so a narrow description pushed the
  // model back into prose and the user lost the clickable card. The opposite
  // failure matters just as much: the description must not read as an
  // obligation to ask something every turn.
  it("routes soft follow-up offers through the card, not just blocking decisions", async () => {
    const { description } = createAskUserTool(vi.fn());
    expect(description).toContain("instead of a prose question");
    // The routing rule now lives in the system prompt (rendered whenever this
    // tool is registered) rather than repeated in the schema.
    const prompt = await buildSystemPrompt(os.tmpdir(), undefined, false, undefined, ["ask_user"]);
    expect(prompt).toContain('Every question — a blocker or an optional "want me to also…?"');
    expect(prompt).toContain("is an `ask_user` call");
    // …and never manufactures a question when none exists.
    expect(prompt).toContain("No question? Just end.");
    // The old blocked-only scoping must be gone, not merely softened.
    expect(description).not.toContain("ask once, at the point you are blocked");
  });

  it("blocks until the user answers, then returns the answer to the model", async () => {
    const { bridge, call, prompt } = harness();
    const result = call({
      questions: [{ id: "flag", question: "Flip the flag for everyone now?", kind: "confirm" }],
    });
    const asked = await prompt();

    // Yes/No is implied by `confirm` — the model never spells it out.
    expect(asked.questions[0]!.options?.map((o) => o.value)).toEqual(["yes", "no"]);
    expect(bridge.pendingCount).toBe(1);

    bridge.settle(asked.id, { action: "answer", answers: { flag: "yes" } });
    await expect(result).resolves.toContain("Flip the flag for everyone now?\n→ yes");
    expect(bridge.pendingCount).toBe(0);
  });

  it("returns the picked value of a single choice", async () => {
    const { bridge, call, prompt } = harness();
    const result = call({
      questions: [
        {
          id: "store",
          question: "Which store for sessions?",
          kind: "choice",
          detail: "I migrate the fixtures either way.",
          options: [
            { label: "SQLite", recommended: true },
            { label: "Postgres" },
            { label: "Redis" },
          ],
        },
      ],
    });
    const asked = await prompt();
    expect(asked.questions[0]!.detail).toBe("I migrate the fixtures either way.");
    // The recommendation is carried to the UI as a mark, not as a default.
    expect(asked.questions[0]!.options?.[0]?.recommended).toBe(true);

    bridge.settle(asked.id, { action: "answer", answers: { store: "SQLite" } });
    await expect(result).resolves.toContain("Which store for sessions?\n→ SQLite");
  });

  it("joins every pick of a multi-select", async () => {
    const { bridge, call, prompt } = harness();
    const result = call({
      questions: [
        {
          id: "steps",
          question: "Which steps should I run?",
          kind: "multi",
          options: [{ label: "Typecheck" }, { label: "Test suite" }, { label: "Windows smoke" }],
        },
      ],
    });
    const asked = await prompt();
    bridge.settle(asked.id, {
      action: "answer",
      answers: { steps: ["Typecheck", "Windows smoke"] },
    });
    await expect(result).resolves.toContain("→ Typecheck, Windows smoke");
  });

  it("passes free text straight through", async () => {
    const { bridge, call, prompt } = harness();
    const result = call({
      questions: [{ id: "name", question: "What should I call the flag?", kind: "text" }],
    });
    const asked = await prompt();
    bridge.settle(asked.id, { action: "answer", answers: { name: "retry_uploads" } });
    await expect(result).resolves.toContain("→ retry_uploads");
  });

  it("answers several questions in one call", async () => {
    const { bridge, call, prompt } = harness();
    const result = call({
      questions: [
        {
          id: "trial",
          question: "Trial length before the first charge?",
          kind: "choice",
          options: [{ label: "14 days", recommended: true }, { label: "No trial" }],
        },
        {
          id: "proration",
          question: "Proration on mid-cycle upgrade?",
          kind: "choice",
          options: [{ label: "Prorate", recommended: true }, { label: "Charge full" }],
        },
      ],
    });
    const asked = await prompt();
    expect(asked.questions).toHaveLength(2);
    bridge.settle(asked.id, {
      action: "answer",
      answers: { trial: "14 days", proration: "Prorate" },
    });
    const text = await result;
    expect(text).toContain("Trial length before the first charge?\n→ 14 days");
    expect(text).toContain("Proration on mid-cycle upgrade?\n→ Prorate");
  });

  it("tells the model to stop asking when the user never answers", async () => {
    const { bridge, call, prompt } = harness();
    const result = call({
      questions: [{ id: "go", question: "Run the migration against prod?", kind: "confirm" }],
    });
    await prompt();
    // What an aborted run / closed window does to a parked question.
    bridge.cancelAll();
    await expect(result).resolves.toContain("did not answer");
  });

  // Typing a prompt instead of clicking an option is itself an answer: the
  // sidecar releases the parked call on POST /prompt, so the turn resumes and
  // reads the typed message rather than sitting out the ten-minute timeout.
  it("releases the turn when the user replies with their own message", async () => {
    const { bridge, call, prompt } = harness();
    const result = call({
      questions: [{ id: "go", question: "Run the migration against prod?", kind: "confirm" }],
    });
    await prompt();
    bridge.cancelAll({ action: "cancel", superseded: true });
    const text = await result;
    expect(text).toContain("sent their own message instead");
    // Not the dead-end wording: another message is on its way, so "stop and
    // wait for them" would strand the user's actual instruction.
    expect(text).not.toContain("stop and wait");
    expect(bridge.pendingCount).toBe(0);
  });

  it("puts the user's own message in the result, so the model needn't wait for it", async () => {
    // Regression: on Claude Code the typed message queued behind the turn, so
    // the model read "it arrives next" alone and replied "I'll wait for your message".
    const { bridge, call, prompt } = harness();
    const result = call({
      questions: [{ id: "name", question: "Use a descriptive name?", kind: "confirm" }],
    });
    await prompt();
    bridge.cancelAll({ action: "cancel", superseded: true, message: "I like proper names." });
    const text = await result;
    expect(text).toContain("<user_message>\nI like proper names.\n</user_message>");
    expect(text).toContain("Treat it as their answer");
    expect(text).not.toContain("arrives next");
  });

  it("puts a reply's attachments in the result too, so nothing is left to arrive later", async () => {
    // Regression: a reply with a screenshot kept the "arrives next" wording, and on
    // Claude Code the model filled the gap with "[Awaiting the user's next message.]".
    const { bridge, call, prompt } = harness();
    const result = call({
      questions: [{ id: "layout", question: "Header layout?", kind: "confirm" }],
    });
    await prompt();
    const image = { type: "image" as const, mediaType: "image/png", data: "AAAA" };
    bridge.cancelAll({
      action: "cancel",
      superseded: true,
      message: "Course title + step title",
      attachments: [image, { type: "text", text: "[Image saved at /tmp/a.png]" }],
    });
    const { content } = (await result) as unknown as { content: unknown[] };
    expect(content[0]).toMatchObject({ type: "text" });
    const text = (content[0] as { text: string }).text;
    expect(text).toContain("<user_message>\nCourse title + step title\n</user_message>");
    expect(text).toContain("Their attachments follow.");
    expect(text).not.toContain("arrives next");
    expect(content.slice(1)).toEqual([
      image,
      { type: "text", text: "[Image saved at /tmp/a.png]" },
    ]);
  });

  it("reports a question that cannot be rendered instead of parking the turn", async () => {
    const { call, broadcast } = harness();
    await expect(
      call({
        questions: [{ id: "store", question: "Which store?", kind: "choice", options: [] }],
      }),
    ).resolves.toContain("needs at least 2 options");
    await expect(
      call({
        questions: [
          { id: "dupe", question: "First?", kind: "confirm" },
          { id: "dupe", question: "Second?", kind: "confirm" },
        ],
      }),
    ).resolves.toContain("unique `id`");
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("stops blocking at the soft deadline rather than holding the turn forever", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const bridge = createAskUserBridge({ broadcast: () => {}, onTimeout, timeoutMs: 1000 });
      const tool = createAskUserTool(bridge.park);
      const result = tool.execute(
        { questions: [{ id: "q", question: "Ship it?", kind: "confirm" }] },
        { signal: new AbortController().signal, toolCallId: "t1", onUpdate: () => {} } as never,
      ) as Promise<string>;
      await vi.advanceTimersByTimeAsync(1001);
      await expect(result).resolves.toContain("No answer yet");
      expect(onTimeout).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // A click sends only the option itself, so an option that asks the user to
  // narrow things down arrives as an instruction the agent cannot act on.
  it("rejects options that hand the decision back to the user", async () => {
    const { call, broadcast } = harness();
    for (const label of [
      "Fix something specific",
      "Something else",
      "Other",
      "Tell me more",
      "Choose a file for me to look at",
    ]) {
      await expect(
        call({
          questions: [
            {
              id: "what",
              question: "What should I work on?",
              kind: "choice",
              options: [{ label }, { label: "Fix the failing upload test" }],
            },
          ],
        }),
      ).resolves.toContain("click sends only that option");
    }
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("still accepts concrete, actionable options", async () => {
    const { bridge, call, prompt } = harness();
    const result = call({
      questions: [
        {
          id: "what",
          question: "What should I fix first?",
          kind: "choice",
          options: [
            { label: "The failing upload test", recommended: true },
            // "Select" appears here but the option names its own target, so it
            // is actionable and must not trip the guard.
            { label: "Select mode on the picker screen" },
          ],
        },
      ],
    });
    const asked = await prompt();
    bridge.settle(asked.id, { action: "answer", answers: { what: "The failing upload test" } });
    await expect(result).resolves.toContain("The failing upload test");
  });
});
