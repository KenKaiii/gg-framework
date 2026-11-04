import React, { useRef } from "react";
import { render } from "ink";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentTool } from "@kleio/agent";
import type { Message, Provider, ThinkingLevel } from "@kleio/ai";
import type { LanguageId } from "../../core/language-detector.js";
import { useModeState } from "./useModeState.js";

const spawnTool: AgentTool = {
  name: "spawn_agent",
  description: "Spawn a child",
  parameters: z.object({}),
  async execute() {
    return { content: "unused" };
  },
};

function Harness({
  messages,
  provider,
  model,
  thinking,
}: {
  messages: { current: Message[] };
  provider: Provider;
  model: string;
  thinking: ThinkingLevel | undefined;
}): null {
  const providerRef = useRef(provider);
  const modelRef = useRef(model);
  const thinkingLevelRef = useRef(thinking);
  providerRef.current = provider;
  modelRef.current = model;
  thinkingLevelRef.current = thinking;
  useModeState({
    initialPlanMode: false,
    skills: undefined,
    cwdRef: useRef(process.cwd()),
    currentToolsRef: useRef([spawnTool]),
    providerRef,
    modelRef,
    thinkingLevelRef,
    approvedPlanPathRef: useRef(undefined),
    injectedLanguagesRef: useRef(new Set<LanguageId>()),
    messagesRef: messages,
  });
  return null;
}

function prompt(messages: { current: Message[] }): string {
  return String(messages.current[0]?.content ?? "");
}

// Exercise the real hook across renders without mocking prompt policy or
// rebuilding the prompt: this is the terminal thinking-toggle path.
describe("useModeState Ultra policy", () => {
  it.each(["gpt-6-astra", "gpt-6.1-sol"])(
    "updates %s when Ultra is toggled both ways",
    async (model) => {
      const messages: { current: Message[] } = {
        current: [{ role: "system", content: "custom instructions" }],
      };
      const mounted = render(
        <Harness messages={messages} provider="openai" model={model} thinking="high" />,
        { patchConsole: false },
      );
      try {
        await vi.waitFor(() => expect(prompt(messages)).toContain("only when the user"));
        mounted.rerender(
          <Harness messages={messages} provider="openai" model={model} thinking="ultra" />,
        );
        await vi.waitFor(() => expect(prompt(messages)).toContain("Proactively use spawn_agent"));
        expect(prompt(messages)).not.toContain("only when the user");
        expect(prompt(messages)).toContain("custom instructions");
        mounted.rerender(
          <Harness messages={messages} provider="openai" model={model} thinking={undefined} />,
        );
        await vi.waitFor(() => expect(prompt(messages)).toContain("only when the user"));
        expect(prompt(messages)).not.toContain("Proactively use spawn_agent");
        expect(prompt(messages).match(/## Async subagent orchestration/g)).toHaveLength(1);
      } finally {
        mounted.unmount();
      }
    },
  );

  it("removes stale Ultra guidance after a model or provider switch", async () => {
    const messages: { current: Message[] } = { current: [{ role: "system", content: "base" }] };
    const mounted = render(
      <Harness messages={messages} provider="openai" model="gpt-6.1-sol" thinking="ultra" />,
      { patchConsole: false },
    );
    try {
      await vi.waitFor(() => expect(prompt(messages)).toContain("Proactively use spawn_agent"));
      mounted.rerender(
        <Harness messages={messages} provider="openai" model="gpt-6-luna" thinking="max" />,
      );
      await vi.waitFor(() => expect(prompt(messages)).toBe("base"));
      mounted.rerender(
        <Harness messages={messages} provider="openai" model="gpt-6-astra" thinking="ultra" />,
      );
      await vi.waitFor(() => expect(prompt(messages)).toContain("Proactively use spawn_agent"));
      mounted.rerender(
        <Harness messages={messages} provider="anthropic" model="claude-opus-5-5" thinking="max" />,
      );
      await vi.waitFor(() => expect(prompt(messages)).toBe("base"));
    } finally {
      mounted.unmount();
    }
  });
});
