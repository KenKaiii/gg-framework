// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: vi.fn(() => ({ cancel: vi.fn() })),
  });
});
const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./agent", () => ({ openUrl }));
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatErrorNotice } from "./ChatErrorNotice";
import {
  activeChatErrorId,
  chatErrorCopy,
  chatErrorTone,
  readChatError,
  type ChatErrorData,
} from "./chat-error";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, "animate");
  vi.useRealTimers();
});
const limit: ChatErrorData = {
  reason: "usage_limit",
  headline: "ChatGPT usage limit reached",
  guidance: "Wait for the reset, or use another provider.",
  message: "Provider diagnostic",
  scope: "error",
};

describe("compact chat errors", () => {
  it("shows two concise lines in amber, with details hidden and one model action", () => {
    const { container } = render(
      <ChatErrorNotice error={limit} active modelPicker={<button>Switch provider</button>} />,
    );
    expect(screen.getByText(limit.headline ?? "")).toBeTruthy();
    expect(container.querySelector(".chat-error-warning")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Switch provider" })).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Show error details" });
    expect(toggle.textContent).toBe("Details");
    expect(
      toggle.closest(".chat-error-heading")?.querySelector(".chat-error-headline")?.textContent,
    ).toBe(limit.headline);
    expect(container.querySelector<HTMLElement>(".chat-error-details")?.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(container.querySelector<HTMLElement>(".chat-error-details")?.hidden).toBe(false);
    expect(screen.getByText("Provider diagnostic")).toBeTruthy();
  });

  it("dissolves details out before hiding them and keeps closing content inert", () => {
    vi.useFakeTimers();
    const onContentGrow = vi.fn();
    const { container, unmount } = render(
      <ChatErrorNotice error={limit} active onContentGrow={onContentGrow} />,
    );
    const toggle = screen.getByRole("button", { name: "Show error details" });
    const details = container.querySelector<HTMLElement>(".chat-error-details");
    fireEvent.click(toggle);
    expect(details?.classList.contains("dissolve-in")).toBe(false);
    expect(details?.getAttribute("aria-hidden")).toBe("false");
    expect(onContentGrow).toHaveBeenCalledOnce();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(details?.hidden).toBe(false);
    expect(details?.classList.contains("leaving")).toBe(true);
    expect(details?.hasAttribute("inert")).toBe(true);
    expect(details?.getAttribute("aria-hidden")).toBe("true");
    act(() => vi.advanceTimersByTime(219));
    expect(details?.hidden).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(details?.hidden).toBe(true);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes immediately without WAAPI", () => {
    Reflect.deleteProperty(Element.prototype, "animate");
    const { container } = render(<ChatErrorNotice error={limit} active />);
    fireEvent.click(screen.getByRole("button", { name: "Show error details" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide error details" }));
    expect(container.querySelector<HTMLElement>(".chat-error-details")?.hidden).toBe(true);
  });

  it("can reopen details during their exit without a stale timer hiding them", () => {
    vi.useFakeTimers();
    const { container } = render(<ChatErrorNotice error={limit} active />);
    const toggle = screen.getByRole("button", { name: "Show error details" });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    act(() => vi.advanceTimersByTime(100));
    fireEvent.click(toggle);
    act(() => vi.advanceTimersByTime(340));
    const details = container.querySelector<HTMLElement>(".chat-error-details");
    expect(details?.hidden).toBe(false);
    expect(details?.hasAttribute("inert")).toBe(false);
    expect(details?.classList.contains("leaving")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders failures red and never executes diagnostic markup", () => {
    const { container } = render(
      <ChatErrorNotice
        error={{
          reason: "provider",
          headline: "Request failed",
          guidance: "Check details",
          message: '<script>throw new Error("not code")</script>',
        }}
        active
      />,
    );
    expect(container.querySelector(".chat-error-error")).not.toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(/<script>/)).toBeTruthy();
  });

  it("keeps restored errors muted and still, without active actions or stale reset advice", () => {
    const { container } = render(
      <ChatErrorNotice
        error={{ ...limit, historical: true }}
        active={false}
        modelPicker={<button>Switch provider</button>}
      />,
    );
    expect(container.querySelector(".chat-error-history")).not.toBeNull();
    expect(container.querySelector(".is-animated")).toBeNull();
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
      <ChatErrorNotice error={{ ...limit, resetsAt: 1_800_000_001 }} active />,
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

describe("ChatGPT plan usage limit", () => {
  const planLimit: ChatErrorData = { ...limit, manageUsage: "chatgpt" };

  it("opens ChatGPT usage settings from the live notice", () => {
    render(<ChatErrorNotice error={planLimit} active />);
    fireEvent.click(screen.getByRole("button", { name: "Manage usage" }));
    expect(openUrl).toHaveBeenCalledWith("https://chatgpt.com/settings/usage");
  });

  it("drops the action on earlier errors and on unknown values", () => {
    render(<ChatErrorNotice error={planLimit} active={false} />);
    expect(screen.queryByRole("button", { name: "Manage usage" })).toBeNull();
    expect(readChatError({ headline: "x", manageUsage: "https://evil.example" }).manageUsage).toBe(
      undefined,
    );
    expect(readChatError({ headline: "x", manageUsage: "chatgpt" }).manageUsage).toBe("chatgpt");
  });
});
