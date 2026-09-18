// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type AppComponent from "./App";
import type { WorkspaceHeader as WorkspaceHeaderComponent } from "./WorkspaceHeader";

let App: typeof AppComponent;
let WorkspaceHeader: typeof WorkspaceHeaderComponent;
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");

function nativeIPC(command: string): unknown {
  if (command === "window_restore_target") {
    return { mode: "code", cwd: "/work/focus-project", sessionPath: null };
  }
  // Mount the real workspace and composer, without starting a daemon or model.
  return new Promise(() => {});
}

beforeAll(async () => {
  mockWindows("main");
  mockIPC(nativeIPC);
  App = (await import("./App")).default;
  WorkspaceHeader = (await import("./WorkspaceHeader")).WorkspaceHeader;
});

beforeEach(() => {
  // jsdom lacks element scrolling; preserve the scroll position the app requests.
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions): void {
      this.scrollTop = options.top ?? 0;
    },
  });
  localStorage.clear();
  mockWindows("main");
  mockIPC(nativeIPC);
});

afterEach(() => {
  cleanup();
  clearMocks();
  vi.restoreAllMocks();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

async function workspace(withPicker = false): Promise<HTMLTextAreaElement> {
  render(
    <>
      <App />
      {withPicker && (
        <WorkspaceHeader
          workspaceMode="code"
          cwd="/work/focus-project"
          navHidden
          onToggleNav={vi.fn()}
        >
          <button>Fixture navigation</button>
        </WorkspaceHeader>
      )}
      <button data-testid="other-action">
        <span>Other action</span>
      </button>
      <div data-testid="background">Background</div>
    </>,
  );
  return await waitFor(() => {
    const input = document.querySelector<HTMLTextAreaElement>("textarea");
    expect(input).not.toBeNull();
    return input!;
  });
}

async function openPicker(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Project colour: Automatic" }));
  const picker = screen.getByRole("dialog", { name: "Project colour" });
  await waitFor(() =>
    expect(within(picker).getByRole("button", { name: "Blue" }).getAttribute("aria-disabled")).toBe(
      "false",
    ),
  );
  return picker;
}

function webkitMouseDown(button: HTMLElement): void {
  fireEvent.pointerDown(button);
  fireEvent.mouseDown(button);
  // Mac WebKit blurs the focused choice but does not focus the clicked button.
  act(() => (document.activeElement as HTMLElement).blur());
  expect(document.activeElement).toBe(document.body);
}

describe("composer focus with Mac WebKit mouse behaviour", () => {
  it("allows a colour click to finish without the composer closing the picker", async () => {
    const input = await workspace(true);
    const picker = await openPicker();
    const blue = within(picker).getByRole("button", { name: "Blue" });
    webkitMouseDown(blue);
    fireEvent.mouseUp(blue);
    expect(document.activeElement).not.toBe(input);
    expect(screen.getByRole("dialog", { name: "Project colour" })).toBe(picker);
    fireEvent.click(blue);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Project colour: Blue" })).toBeDefined(),
    );
    expect(localStorage.getItem("gg-project-colour:/work/focus-project")).toBe("Blue");
  });

  it("does not steal focus when the window gains focus with the picker open", async () => {
    const input = await workspace(true);
    const picker = await openPicker();
    act(() => (document.activeElement as HTMLElement).blur());
    fireEvent.focus(window);
    expect(document.activeElement).not.toBe(input);
    expect(screen.getByRole("dialog", { name: "Project colour" })).toBe(picker);
  });

  it("leaves other clicked buttons alone even when only their child is targeted", async () => {
    const input = await workspace();
    act(() => input.blur());
    fireEvent.mouseUp(screen.getByText("Other action"));
    expect(document.activeElement).not.toBe(input);
  });

  it("still focuses the composer after clicking ordinary background", async () => {
    const input = await workspace();
    act(() => input.blur());
    fireEvent.mouseUp(screen.getByTestId("background"));
    expect(document.activeElement).toBe(input);
  });
});
