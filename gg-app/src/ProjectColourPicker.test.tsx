// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { openFolder } = vi.hoisted(() => ({ openFolder: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./agent", () => ({ openProjectPath: openFolder, openUrl: vi.fn() }));
import { WorkspaceHeader } from "./WorkspaceHeader";
import { PROJECT_ACCENTS, PROJECT_COLOUR_NAMES, projectAccent } from "./projectAccent";
import { projectColourStore } from "./project-colours";

beforeEach(() => {
  localStorage.clear();
  openFolder.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty("zoom");
});

function header(cwd: string | undefined = "/work/project", mode: "code" | "chat" = "code") {
  return (
    <WorkspaceHeader
      workspaceMode={mode}
      cwd={cwd}
      gitBranch="main"
      navHidden
      onToggleNav={vi.fn()}
    >
      <button>New session</button>
    </WorkspaceHeader>
  );
}

async function openPicker(): Promise<HTMLElement> {
  const trigger = screen.getByRole("button", { name: "Project colour: Automatic" });
  fireEvent.click(trigger);
  const picker = screen.getByRole("dialog", { name: "Project colour" });
  await waitFor(() =>
    expect(within(picker).getByRole("button", { name: "Blue" }).getAttribute("aria-disabled")).toBe(
      "false",
    ),
  );
  return picker;
}

async function choose(picker: HTMLElement, name: string): Promise<void> {
  fireEvent.click(within(picker).getByRole("button", { name }));
  await waitFor(() =>
    expect(within(picker).getByRole("button", { name }).getAttribute("aria-pressed")).toBe("true"),
  );
}

describe("project colour picker in the shared header", () => {
  it("defaults to the original automatic dot with no stripe and preserves folder opening", async () => {
    const { container } = render(header());
    expect(
      container
        .querySelector<HTMLElement>(".chat-head")
        ?.style.getPropertyValue("--project-accent"),
    ).toBe(projectAccent("/work/project"));
    expect(container.querySelector(".chat-head-project-stripe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "project" }));
    expect(openFolder).toHaveBeenCalledWith("/work/project");
    expect(screen.queryByRole("dialog")).toBeNull();
    const picker = await openPicker();
    expect(within(picker).getByRole("button", { name: "Automatic" })).toBe(document.activeElement);
    expect(picker.closest(".chat-head-title")).toBeNull();
    for (const button of [
      screen.getByRole("button", { name: "project" }),
      screen.getByRole("button", { name: "Project colour: Automatic" }),
      ...within(picker).getAllByRole("button"),
    ]) {
      expect(button.hasAttribute("data-tauri-drag-region")).toBe(false);
    }
    expect(
      container.querySelector(".chat-head-strip")?.hasAttribute("data-tauri-drag-region"),
    ).toBe(true);
  });

  it("applies every palette choice, optional stripe, None, and Automatic reset", async () => {
    const { container } = render(header());
    const picker = await openPicker();
    for (const [index, colour] of PROJECT_COLOUR_NAMES.entries()) {
      await choose(picker, colour);
      expect(
        container
          .querySelector<HTMLElement>(".chat-head")
          ?.style.getPropertyValue("--project-accent"),
      ).toBe(PROJECT_ACCENTS[index]);
      expect(
        within(picker).getByRole("button", { name: colour }).querySelector("svg"),
      ).not.toBeNull();
    }
    const stripe = within(picker).getByRole("checkbox", { name: /Show header stripe/ });
    fireEvent.click(stripe);
    await waitFor(() =>
      expect(container.querySelector(".chat-head-project-stripe")).not.toBeNull(),
    );
    await choose(picker, "None");
    expect(container.querySelector(".chat-head-project-stripe")).toBeNull();
    expect(
      container
        .querySelector<HTMLElement>(".chat-head")
        ?.style.getPropertyValue("--project-accent"),
    ).toBe("");
    fireEvent.keyDown(picker, { key: "Escape" });
    const neutral = screen.getByRole("button", { name: "Project colour: None" });
    expect(neutral.classList.contains("project-colour-trigger-none")).toBe(true);
    expect(document.activeElement).toBe(neutral);
    fireEvent.keyDown(neutral, { key: "ArrowDown" });
    const reopened = screen.getByRole("dialog", { name: "Project colour" });
    await choose(reopened, "Automatic");
    expect(
      container
        .querySelector<HTMLElement>(".chat-head")
        ?.style.getPropertyValue("--project-accent"),
    ).toBe(projectAccent("/work/project"));
    expect(localStorage.getItem("gg-project-colour:/work/project")).toBeNull();
    fireEvent.click(within(reopened).getByRole("checkbox", { name: /Show header stripe/ }));
    await waitFor(() => expect(container.querySelector(".chat-head-project-stripe")).toBeNull());
  });

  it("supports keyboard opening/navigation, Escape, outside press, and focus leaving", async () => {
    render(header());
    const trigger = screen.getByRole("button", { name: "Project colour: Automatic" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const picker = screen.getByRole("dialog", { name: "Project colour" });
    const automatic = within(picker).getByRole("button", { name: "Automatic" });
    expect(document.activeElement).toBe(automatic);
    fireEvent.keyDown(automatic, { key: "ArrowRight" });
    expect(document.activeElement).toBe(within(picker).getByRole("button", { name: "None" }));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(within(picker).getByRole("button", { name: "Orchid" }));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(automatic);
    fireEvent.keyDown(automatic, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await openPicker();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await openPicker();
    act(() => screen.getByRole("button", { name: "project" }).focus());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "project" }));
  });

  it.each(
    [0.5, 1, 1.25, 2].flatMap((zoom) => [
      { zoom, rectZoom: zoom },
      { zoom, rectZoom: 1 },
    ]),
  )(
    "keeps the picker within a minimum-size window at $zoom zoom with $rectZoom rect scaling",
    async ({ zoom, rectZoom }) => {
      document.documentElement.style.setProperty("zoom", String(zoom));
      vi.stubGlobal("innerWidth", 480);
      vi.stubGlobal("innerHeight", 360);
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.classList.contains("project-colour-trigger") ? 24 : 264;
      });
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(333);
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
        new DOMRect(82 * rectZoom, 7 * rectZoom, 24 * rectZoom, 24 * rectZoom),
      );
      render(header());
      const picker = await openPicker();
      const left = Number.parseFloat(picker.style.left);
      const top = Number.parseFloat(picker.style.top);
      const width = Math.min(264, Number.parseFloat(picker.style.maxWidth));
      const height = Math.min(333, Number.parseFloat(picker.style.maxHeight));
      expect(Number.parseFloat(picker.style.maxWidth)).toBe(480 / zoom - 16);
      expect(Number.parseFloat(picker.style.maxHeight)).toBe(360 / zoom - 16);
      expect(left * zoom).toBeGreaterThanOrEqual(0);
      expect(top * zoom).toBeGreaterThanOrEqual(0);
      expect((left + width) * zoom).toBeLessThanOrEqual(480);
      expect((top + height) * zoom).toBeLessThanOrEqual(360);
    },
  );

  it("cancels delayed focus restoration when the header unmounts", async () => {
    const { unmount } = render(header());
    await openPicker();
    const schedule = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(123);
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    fireEvent.pointerDown(document.body);
    expect(schedule).toHaveBeenCalledOnce();
    unmount();
    expect(cancel).toHaveBeenCalledWith(123);
  });

  it("updates all headers for one project but not a same-named project elsewhere", async () => {
    const { container } = render(
      <>
        {header()}
        {header("/other/project", "chat")}
        {header()}
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Project colour: Automatic" })).toHaveLength(3),
    );
    await act(async () => {
      await projectColourStore.setChoice("/work/project", "Blue");
    });
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Project colour: Blue" })).toHaveLength(2),
    );
    expect(screen.getAllByRole("button", { name: "Project colour: Automatic" })).toHaveLength(1);
    await act(async () => {
      await projectColourStore.setStripe(true);
    });
    expect(container.querySelectorAll(".chat-head-project-stripe")).toHaveLength(3);
  });

  it.each([undefined, ""])(
    "does not create a picker or preferences in folderless Code/Chat contexts (%s)",
    (cwd) => {
      render(
        <>
          <WorkspaceHeader workspaceMode="code" cwd={cwd} navHidden onToggleNav={vi.fn()}>
            <button>New session</button>
          </WorkspaceHeader>
          <WorkspaceHeader workspaceMode="chat" cwd={cwd} navHidden onToggleNav={vi.fn()}>
            <button>New chat</button>
          </WorkspaceHeader>
        </>,
      );
      expect(screen.getByText("GG Coder")).toBeDefined();
      expect(screen.getByText("GG Chat")).toBeDefined();
      expect(screen.queryByRole("button", { name: /Project colour/ })).toBeNull();
      expect(localStorage.length).toBe(0);
    },
  );

  it("saves the latest colour clicked while an earlier choice is still saving", async () => {
    const { container } = render(header());
    const picker = await openPicker();
    const actualSave = projectColourStore.setChoice;
    let finishFirstSave!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      finishFirstSave = resolve;
    });
    const save = vi
      .spyOn(projectColourStore, "setChoice")
      .mockImplementationOnce(async (cwd, choice) => {
        await firstSave;
        await actualSave(cwd, choice);
      });
    fireEvent.click(within(picker).getByRole("button", { name: "Blue" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Green" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Orchid" }));
    await act(async () => {
      finishFirstSave();
      await firstSave;
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Project colour: Orchid" })).toBeDefined(),
    );
    expect(localStorage.getItem("gg-project-colour:/work/project")).toBe("Orchid");
    expect(
      container
        .querySelector<HTMLElement>(".chat-head")
        ?.style.getPropertyValue("--project-accent"),
    ).toBe(PROJECT_ACCENTS[9]);
    expect(save.mock.calls.map(([, choice]) => choice)).toEqual(["Blue", "Orchid"]);
  });

  it("still saves the latest queued choice when the earlier save fails", async () => {
    render(header());
    const picker = await openPicker();
    let failFirstSave!: () => void;
    const firstSave = new Promise<void>((_, reject) => {
      failFirstSave = () => reject(new Error("temporary write failure"));
    });
    vi.spyOn(projectColourStore, "setChoice").mockImplementationOnce(() => firstSave);
    fireEvent.click(within(picker).getByRole("button", { name: "Blue" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Green" }));
    await act(async () => {
      failFirstSave();
      await firstSave.catch(() => undefined);
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Project colour: Green" })).toBeDefined(),
    );
    expect(localStorage.getItem("gg-project-colour:/work/project")).toBe("Green");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("persists an accepted queued choice after its header unmounts", async () => {
    const { unmount } = render(header());
    const picker = await openPicker();
    const actualSave = projectColourStore.setChoice;
    let finishFirstSave!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      finishFirstSave = resolve;
    });
    vi.spyOn(projectColourStore, "setChoice").mockImplementationOnce(async (cwd, choice) => {
      await firstSave;
      await actualSave(cwd, choice);
    });
    fireEvent.click(within(picker).getByRole("button", { name: "Blue" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Orchid" }));
    unmount();
    await act(async () => {
      finishFirstSave();
      await firstSave;
    });
    await waitFor(() =>
      expect(localStorage.getItem("gg-project-colour:/work/project")).toBe("Orchid"),
    );
  });

  it("keeps the confirmed choice and reports failed persistence", async () => {
    render(header());
    const picker = await openPicker();
    await choose(picker, "Green");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    fireEvent.click(within(picker).getByRole("button", { name: "Blue" }));
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByRole("button", { name: "Project colour: Green" })).toBeDefined();
    expect(localStorage.getItem("gg-project-colour:/work/project")).toBe("Green");
    expect(within(picker).getByRole("button", { name: "Blue" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});
