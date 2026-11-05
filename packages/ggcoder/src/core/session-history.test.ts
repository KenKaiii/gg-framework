import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type {
  AutopilotMarkerPayload,
  AppMarkerPayload,
  KenTurnPayload,
} from "./session-manager.js";
import { STEERING_PREFIX, buildNotificationSteeringText } from "./steering.js";
import { frameAutopilotInjection } from "./autopilot-cycle.js";
import {
  normalizeAutopilotMarkersForHistory,
  normalizeAppMarkersForHistory,
  normalizeKenTurnsForHistory,
  reconstructCheckpointHistory,
  replayMessagesInOrder,
  restoreUserRow,
  restoreAssistantTexts,
  detectPromptCommand,
  resolveRestoredCommand,
  extractToolImagePaths,
} from "./session-history.js";

describe("reconstructCheckpointHistory", () => {
  const summary = (text: string): Message => ({
    role: "user",
    content: `[Previous conversation summary]\n\n${text}`,
    provenance: { source: "runtime", kind: "compaction_summary", visibility: "summary" },
  });
  const acknowledgement: Message = {
    role: "assistant",
    content:
      "I have the full context from the summary above, including where work left off and the next step.",
    provenance: { source: "runtime", kind: "compaction_ack", visibility: "hidden" },
  };
  const original: Message[] = [
    { role: "user", content: "original question" },
    { role: "assistant", content: "original answer" },
    { role: "user", content: "retained question" },
    { role: "assistant", content: "retained answer" },
  ];
  const afterFirst: Message[] = [
    { role: "user", content: "after first compaction" },
    { role: "assistant", content: "first follow-up answer" },
  ];
  const afterSecond: Message[] = [
    { role: "user", content: "after second compaction" },
    { role: "assistant", content: "second follow-up answer" },
  ];

  it("replays three generations chronologically without retained tails or summaries duplicated", () => {
    const restored = reconstructCheckpointHistory([
      { header: { id: "original" }, messages: original },
      {
        header: { id: "first", parentSessionId: "original" },
        messages: [summary("first summary"), acknowledgement, ...original.slice(2), ...afterFirst],
      },
      {
        header: { id: "second", parentSessionId: "first" },
        messages: [summary("second summary"), acknowledgement, ...afterFirst, ...afterSecond],
      },
    ]);

    expect(restored).toEqual([...original, ...afterFirst, ...afterSecond]);
    for (const message of [...original.slice(2), ...afterFirst, ...afterSecond]) {
      expect(restored.filter((candidate) => candidate.content === message.content)).toHaveLength(1);
    }
    expect(restored.some((message) => String(message.content).includes("summary"))).toBe(false);
  });

  it("keeps the oldest readable checkpoint summary when its parent is unavailable", () => {
    const fallback = summary("recoverable context");
    const restored = reconstructCheckpointHistory([
      {
        header: { id: "first", parentSessionId: "missing" },
        messages: [fallback, acknowledgement, ...afterFirst],
      },
      {
        header: { id: "second", parentSessionId: "first" },
        messages: [summary("replacement"), acknowledgement, ...afterFirst, ...afterSecond],
      },
    ]);

    expect(restored).toEqual([fallback, ...afterFirst, ...afterSecond]);
  });

  it("never consumes repeated messages appended after the retained-tail boundary", () => {
    const repeated: Message[] = [
      { role: "user", content: "repeat me" },
      { role: "assistant", content: "same answer" },
    ];
    const restored = reconstructCheckpointHistory([
      { header: { id: "original" }, messages: [...repeated, ...repeated] },
      {
        header: { id: "child", parentSessionId: "original", retainedMessageCount: 2 },
        messages: [summary("replacement"), acknowledgement, ...repeated, ...repeated],
      },
    ]);

    expect(restored).toEqual([...repeated, ...repeated, ...repeated]);
  });
});

describe("normalizeAutopilotMarkersForHistory", () => {
  it("drops out-of-range compacted-session markers and dedupes exact all-clear rows", () => {
    const markers: AutopilotMarkerPayload[] = [
      { version: 1, phase: "done", afterMessageCount: 2 },
      { version: 1, phase: "done", afterMessageCount: 2 },
      { version: 1, phase: "done", afterMessageCount: 9 },
      { version: 1, phase: "human", afterMessageCount: 3, reason: "Needs user approval." },
      { version: 1, phase: "done", afterMessageCount: 12 },
    ];

    const restored = normalizeAutopilotMarkersForHistory(markers, 4);

    expect(restored).toEqual([
      { version: 1, phase: "done", afterMessageCount: 2, copySeed: "done\u00002\u0000\u0000" },
      {
        version: 1,
        phase: "human",
        afterMessageCount: 3,
        reason: "Needs user approval.",
        copySeed: "human\u00003\u0000Needs user approval.\u0000",
      },
    ]);
    expect(restored.filter((m) => m.phase === "done")).toHaveLength(1);
  });
});

describe("normalizeAppMarkersForHistory", () => {
  it("drops out-of-range markers and dedupes exact payloads", () => {
    const markers: AppMarkerPayload[] = [
      { version: 1, kind: "plan", afterMessageCount: 1, data: { reason: "complex change" } },
      { version: 1, kind: "plan", afterMessageCount: 1, data: { reason: "complex change" } },
      { version: 1, kind: "task", afterMessageCount: 9, data: { title: "stale task" } },
    ];
    expect(normalizeAppMarkersForHistory(markers, 4)).toEqual([
      { version: 1, kind: "plan", afterMessageCount: 1, data: { reason: "complex change" } },
    ]);
  });
});

describe("normalizeKenTurnsForHistory", () => {
  it("clamps stale anchors to the last message instead of dropping, and dedupes", () => {
    const turns: KenTurnPayload[] = [
      { version: 1, question: "why?", reply: "because", afterMessageCount: 2 },
      { version: 1, question: "why?", reply: "because", afterMessageCount: 2 },
      { version: 1, question: "later q", reply: "later a", afterMessageCount: 50 },
    ];
    expect(normalizeKenTurnsForHistory(turns, 4)).toEqual([
      { version: 1, question: "why?", reply: "because", afterMessageCount: 2 },
      { version: 1, question: "later q", reply: "later a", afterMessageCount: 4 },
    ]);
  });
});

describe("restoreUserRow", () => {
  it("strips the mid-run steering wrapper so queued prompts resume clean", () => {
    const row = restoreUserRow(`${STEERING_PREFIX}also add dark mode`);
    expect(row.text).toBe("also add dark mode");
  });

  it("strips the autopilot preamble so injected prompts resume as the clean body", () => {
    const row = restoreUserRow(frameAutopilotInjection("Add a test for the login flow."));
    expect(row.text).toBe("Add a test for the login flow.");
    expect(row.text).not.toContain("[Autopilot]");
  });

  it("flags autopilot-injected turns so resume can skip the bubble live never showed", () => {
    const injected = restoreUserRow(frameAutopilotInjection("Fix the failing test."));
    expect(injected.autopilotInjected).toBe(true);

    // The same body typed by a human keeps its user bubble.
    expect(restoreUserRow("Fix the failing test.").autopilotInjected).toBe(false);
  });

  it("flags pushed background-status updates so resume skips them", () => {
    // The live run renders no bubble for these (the loop yields
    // `steering_message`, which no host forwards). They are persisted only
    // because the model genuinely saw them — so a reopened session must not
    // suddenly show build logs as if the user had typed them.
    const row = restoreUserRow(
      buildNotificationSteeringText([
        'Background process c1c45a8d (pnpm dev) exited with code 0 after 40s. Read it with task_output id="c1c45a8d".',
      ]),
    );
    expect(row.notification).toBe(true);

    // A human writing about a background process still gets their bubble.
    expect(restoreUserRow("why did pnpm dev exit?").notification).toBe(false);
  });

  it("flags a status update delivered as block content", () => {
    const row = restoreUserRow([
      { type: "text", text: buildNotificationSteeringText(["Background process p1 exited 1."]) },
    ]);
    expect(row.notification).toBe(true);
  });

  it("keeps steering and notification framing distinct", () => {
    // Both are machine framing, but only steering wraps something a human
    // actually typed — that one keeps its bubble, stripped.
    const steered = restoreUserRow(`${STEERING_PREFIX}also add dark mode`);
    expect(steered.notification).toBe(false);
    expect(steered.text).toBe("also add dark mode");
  });

  it("detects the autopilot preamble under a steering wrapper and in block content", () => {
    const steered = restoreUserRow(
      `${STEERING_PREFIX}${frameAutopilotInjection("Retry the deploy.")}`,
    );
    expect(steered.autopilotInjected).toBe(true);
    expect(steered.text).toBe("Retry the deploy.");

    const blocks = restoreUserRow([
      { type: "text", text: frameAutopilotInjection("Retry the deploy.") },
    ]);
    expect(blocks.autopilotInjected).toBe(true);
    expect(blocks.text).toBe("Retry the deploy.");
  });

  it("drops attachment notes and the attached-files block, keeps typed text + images", () => {
    const row = restoreUserRow([
      {
        type: "text",
        text: "what's in this screenshot?\n\nAttached files (inspect with your tools):\n- notes.txt (saved at /p/notes.txt)",
      },
      { type: "image", mediaType: "image/png", data: "aGk=" },
      { type: "text", text: "[Image saved at /p/.gg/uploads/x.png]" },
    ]);
    expect(row.text).toBe("what's in this screenshot?");
    expect(row.images).toEqual(["data:image/png;base64,aGk="]);
    expect(row.videoWarning).toBe(false);
  });

  it("flags the non-native-video note so resume re-shows the live info row", () => {
    const row = restoreUserRow([
      { type: "text", text: "summarize this clip" },
      {
        type: "text",
        text: "[User attached a video file at /p/clip.mp4. You cannot watch video directly; if needed, use ffmpeg to extract frames or audio.]",
      },
    ]);
    expect(row.text).toBe("summarize this clip");
    expect(row.videoWarning).toBe(true);
    expect(row.attachments).toEqual([{ kind: "video", name: "clip.mp4" }]);
  });

  it("recovers attached file and video chips, including a file-only message", () => {
    const row = restoreUserRow([
      {
        type: "text",
        text: "Attached files (inspect with your tools):\n- My Book (2nd ed).epub (saved at /p/.gg/uploads/lx1-My_Book_2nd_ed_.epub)\n- spec.pdf (saved at /p/.gg/uploads/lx2-spec.pdf)\nThe read tool opens PDF and EPUB files as text.",
      },
      {
        type: "text",
        text: "The user attached a video at /p/.gg/uploads/lx3-demo.mov. You CAN watch it: call the read tool on this exact path now.",
      },
      {
        type: "text",
        text: `[User attached a file "notes.txt" but it could not be saved, so it can't be opened.]`,
      },
    ]);
    expect(row.text).toBe("");
    expect(row.attachments).toEqual([
      { kind: "file", name: "My Book (2nd ed).epub" },
      { kind: "file", name: "spec.pdf" },
      { kind: "video", name: "demo.mov" },
      { kind: "file", name: "notes.txt" },
    ]);
  });
});

describe("resolveRestoredCommand", () => {
  const candidates = [
    { name: "release", prompt: "# Release\n\nShip the thing." },
    { name: "commit", prompt: "# Commit\n\nWrite a commit." },
  ];

  it("reverses an expanded template body back to its /name chip", () => {
    expect(detectPromptCommand("# Release\n\nShip the thing.", candidates)).toBe("/release");
    expect(resolveRestoredCommand(null, "# Release\n\nShip the thing.", candidates)).toBe(
      "/release",
    );
  });

  it("keeps the user's trailing args", () => {
    const body = "# Release\n\nShip the thing.\n\n## User Instructions\n\npatch only";
    expect(resolveRestoredCommand(null, body, candidates)).toBe("/release patch only");
  });

  it("leaves an ordinary message alone", () => {
    expect(resolveRestoredCommand(null, "just a normal question", candidates)).toBeNull();
  });

  // The reported bug: editing a command template (or the app-vs-CLI wording of a
  // built-in) made the body match fail, so reopening the session rendered the
  // whole raw template instead of the `/name` chip.
  it("uses the persisted invocation when the template has drifted since", () => {
    const bodyFromOldTemplate = "# Release\n\nShip the thing the OLD way.";
    // Body matching alone can no longer recognise it.
    expect(detectPromptCommand(bodyFromOldTemplate, candidates)).toBeNull();
    // The invocation recorded at send time still restores the chip.
    expect(resolveRestoredCommand("/release", bodyFromOldTemplate, candidates)).toBe("/release");
  });

  it("prefers the persisted invocation over a body match, args included", () => {
    expect(
      resolveRestoredCommand("/release patch only", "# Release\n\nShip the thing.", candidates),
    ).toBe("/release patch only");
  });

  it("ignores a blank persisted invocation and falls back to the body", () => {
    expect(resolveRestoredCommand("   ", "# Commit\n\nWrite a commit.", candidates)).toBe(
      "/commit",
    );
  });
});

describe("restoreAssistantTexts", () => {
  it("keeps server-tool text splits as separate bubbles", () => {
    expect(
      restoreAssistantTexts([
        { type: "text", text: "Let me search for that." },
        { type: "server_tool_call", id: "st1", name: "web_search", args: {} },
        { type: "text", text: "Found it — here's the answer." },
      ] as never),
    ).toEqual(["Let me search for that.", "Found it — here's the answer."]);
  });

  it("passes plain string content through as one bubble", () => {
    expect(restoreAssistantTexts("hello")).toEqual(["hello"]);
    expect(restoreAssistantTexts("  ")).toEqual([]);
  });
});

describe("replayMessagesInOrder", () => {
  it("flushes an anchored marker immediately after a tool result", async () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "t1", name: "read", args: {} }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "t1", content: "result" }],
      },
      { role: "assistant", content: "after tool" },
    ];
    const replayed: string[] = [];

    await replayMessagesInOrder(
      messages,
      (message) => {
        replayed.push(message.role === "assistant" ? "assistant" : "tool");
        if (message.role === "tool") return;
      },
      (count) => {
        if (count === 2) replayed.push("error-marker");
      },
    );

    expect(replayed).toEqual(["assistant", "tool", "error-marker", "assistant"]);
  });
});

describe("extractToolImagePaths", () => {
  it.each([
    ["read tool", "Read image file /Users/me/shot.png [image/png]", ["/Users/me/shot.png"]],
    [
      "read tool with resize note and spaces",
      "Read image file /Users/me/My Shots/a b.png [image/jpeg] (resized from 10 to 5 bytes)",
      ["/Users/me/My Shots/a b.png"],
    ],
    [
      "screenshot tool",
      "Captured http://localhost:3000 → /tmp/My Dir/shot.png [image/png] (1280×800)",
      ["/tmp/My Dir/shot.png"],
    ],
    [
      "generate_image single keeps a comma in the path",
      "Generated image → /proj/out, final.png",
      ["/proj/out, final.png"],
    ],
    [
      "generate_image multiple, primary first",
      "Generated 2 images → /proj/a-1.png, /proj/a-2.png",
      ["/proj/a-1.png", "/proj/a-2.png"],
    ],
    ["unknown text", "something else entirely", []],
  ])("%s", (_label, text, expected) => {
    expect(extractToolImagePaths(text)).toEqual(expected);
  });
});
