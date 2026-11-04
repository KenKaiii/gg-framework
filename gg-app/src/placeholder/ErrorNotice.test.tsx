// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorNotice } from "./ErrorNotice";
import {
  activeChatErrorId,
  chatErrorCopy,
  chatErrorTone,
  readChatError,
  type ChatErrorData,
} from "../chat-error";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const limit: ChatErrorData = {
  reason: "usage_limit",
  headline: "ChatGPT usage limit reached",
  guidance: "Wait for the reset, or use another provider.",
  message: "Provider diagnostic",
  scope: "error",
};
function details(container: HTMLElement): HTMLElement | null {
  const toggle = container.querySelector<HTMLElement>("[aria-controls]");
  const id = toggle?.getAttribute("aria-controls");
  return id ? document.getElementById(id) : null;
}

describe("chat error notice (placeholder)", () => {
  it("shows the headline and next step as a warning, with details hidden and one model action", () => {
    const { container } = render(
      <ErrorNotice error={limit} active modelPicker={<button>Switch provider</button>} />,
    );
    expect(screen.getByText(limit.headline ?? "")).toBeTruthy();
    expect(container.querySelector('[data-tone="warning"]')).not.toBeNull();
    expect(screen.getByRole("img", { name: "Warning" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch provider" })).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Show error details" });
    expect(toggle.textContent).toBe("Details");
    expect(details(container)?.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(details(container)?.hidden).toBe(false);
    expect(screen.getByRole("button", { name: "Hide error details" })).toBeTruthy();
    expect(screen.getByText("Provider diagnostic")).toBeTruthy();
    // No exit animation here: closing hides the details at once.
    fireEvent.click(toggle);
    expect(details(container)?.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("marks failures as errors and never executes diagnostic markup", () => {
    const { container } = render(
      <ErrorNotice
        error={{
          reason: "provider",
          headline: "Request failed",
          guidance: "Check details",
          message: '<script>throw new Error("not code")</script>',
        }}
        active
      />,
    );
    expect(container.querySelector('[data-tone="error"]')).not.toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(/<script>/)).toBeTruthy();
  });

  it("keeps restored errors muted, without active actions or stale reset advice", () => {
    const { container } = render(
      <ErrorNotice
        error={{ ...limit, historical: true }}
        active={false}
        modelPicker={<button>Switch provider</button>}
      />,
    );
    expect(container.querySelector('[data-tone="history"]')).not.toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch provider" })).toBeNull();
    expect(screen.getByText("Earlier: ChatGPT usage limit reached")).toBeTruthy();
    expect(
      screen.queryByText("Wait for the reset, or use another provider.")?.closest("[hidden]"),
    ).toBeTruthy();
  });

  it("changes guidance at reset time without promising recovery, then cleans up the timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const { unmount } = render(
      <ErrorNotice error={{ ...limit, resetsAt: 1_800_000_001 }} active />,
    );
    act(() => {
      vi.advanceTimersByTime(1_002);
    });
    expect(
      screen.getByText("The reset time has passed. Check usage before trying again."),
    ).toBeTruthy();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("asks the transcript to keep the opened details in view", () => {
    const grow = vi.fn();
    render(<ErrorNotice error={limit} active onContentGrow={grow} />);
    expect(grow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show error details" }));
    expect(grow).toHaveBeenCalledOnce();
  });

  it("retains metadata across each scope and rejects malformed values", () => {
    for (const scope of ["error", "ken_error", "autopilot_error"]) {
      const parsed = readChatError(
        { ...limit, resetsAt: 1_800_000_000, occurredAt: 1_799_000_000_000, statusCode: 429 },
        scope,
      );
      expect(parsed.scope).toBe(scope);
      expect(parsed.resetsAt).toBe(1_800_000_000);
      expect(chatErrorCopy(parsed, true, 1_800_000_000_001).guidance).toContain(
        "reset time has passed",
      );
    }
    expect(readChatError({ ...limit }, "ken_error").headline).toBe(
      "Helper: ChatGPT usage limit reached",
    );
    const invalid = readChatError({
      reason: "run_command",
      resetsAt: Infinity,
      statusCode: "429",
      headline: [],
    });
    expect(invalid.reason).toBeUndefined();
    expect(invalid.resetsAt).toBeUndefined();
    expect(invalid.headline).toBeUndefined();
  });

  it("distinguishes warnings, failures and history independently of provider text", () => {
    expect(chatErrorTone({ reason: "billing" }, true)).toBe("error");
    expect(chatErrorTone({ reason: "rate_limit" }, true)).toBe("warning");
    expect(chatErrorTone({ reason: "provider" }, false)).toBe("history");
    expect(
      chatErrorCopy({ headline: "Unsupported model", guidance: "Wait for usage" }, true, 0)
        .headline,
    ).toBe("Something went wrong");
  });

  it("retires errors after a new message, without treating them as resolved", () => {
    expect(
      activeChatErrorId([
        { id: 1, kind: "error" },
        { id: 2, kind: "info" },
      ]),
    ).toBe(1);
    expect(
      activeChatErrorId([
        { id: 1, kind: "error" },
        { id: 2, kind: "user" },
      ]),
    ).toBeNull();
    expect(activeChatErrorId([{ id: 1, kind: "error", historical: true }])).toBeNull();
    expect(
      activeChatErrorId([
        { id: 1, kind: "error" },
        { id: 2, kind: "ken" },
      ]),
    ).toBe(1);
    expect(
      activeChatErrorId([
        { id: 1, kind: "error" },
        { id: 2, kind: "assistant" },
      ]),
    ).toBe(1);
  });
});
