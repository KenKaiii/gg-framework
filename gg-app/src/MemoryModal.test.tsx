// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  deleteJiwa,
  deleteMemory,
  isJiwaChangeEvent,
  isMemoryChangeEvent,
  listJiwa,
  listMemories,
  saveJiwa,
  saveMemory,
  subscribe,
  type JiwaSnapshot,
  type Memory,
  type MemorySnapshot,
  type SidecarEvent,
} from "./agent";
import { MemoryModal } from "./MemoryModal";

let eventHandler: ((event: SidecarEvent) => void) | undefined;

vi.mock("./agent", () => ({
  deleteJiwa: vi.fn(),
  deleteMemory: vi.fn(),
  listJiwa: vi.fn(),
  listMemories: vi.fn(),
  saveJiwa: vi.fn(),
  saveMemory: vi.fn(),
  subscribe: vi.fn((handler: (event: SidecarEvent) => void) => {
    eventHandler = handler;
    return vi.fn();
  }),
  isJiwaChangeEvent: vi.fn((event: SidecarEvent) => event.type === "jiwa_change"),
  isMemoryChangeEvent: vi.fn((event: SidecarEvent) => event.type === "memory_change"),
}));

const listMemoriesMock = vi.mocked(listMemories);
const deleteMemoryMock = vi.mocked(deleteMemory);
const listJiwaMock = vi.mocked(listJiwa);
const deleteJiwaMock = vi.mocked(deleteJiwa);
const saveMemoryMock = vi.mocked(saveMemory);
const saveJiwaMock = vi.mocked(saveJiwa);
const subscribeMock = vi.mocked(subscribe);
const isMemoryChangeEventMock = vi.mocked(isMemoryChangeEvent);
const isJiwaChangeEventMock = vi.mocked(isJiwaChangeEvent);

const populatedMemories: MemorySnapshot = {
  softLimit: 60,
  hardLimit: 90,
  memories: [
    {
      id: "memory-1",
      text: "Ken prefers concise, scannable answers.",
      category: "preference",
      importance: 5,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    },
  ],
};

const populatedJiwa: JiwaSnapshot = {
  softLimit: 60,
  hardLimit: 90,
  jiwa: [
    {
      id: "jiwa-1",
      text: "Call yourself Blargo in chat.",
      category: "identity",
      importance: 5,
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    },
  ],
};

const KEN_MEMORY = "Ken prefers concise, scannable answers.";
const OLDER_HOST_MESSAGE =
  "Your host runs an older Kleio, which can't add or edit here. Update Kleio on your host.";
const FULL_NOTE = "Full. Adding one removes the least important.";

function numberedMemory(index: number): Memory {
  return {
    id: `memory-n${index}`,
    text: `Memory number ${index}`,
    category: "other",
    importance: 3,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  eventHandler = undefined;
  listMemoriesMock.mockResolvedValue(populatedMemories);
  deleteMemoryMock.mockResolvedValue({ ...populatedMemories, memories: [] });
  listJiwaMock.mockResolvedValue(populatedJiwa);
  deleteJiwaMock.mockResolvedValue({ ...populatedJiwa, jiwa: [] });
  // Each test that saves says how the sidecar answers.
  saveMemoryMock.mockRejectedValue("unexpected memory save");
  saveJiwaMock.mockRejectedValue("unexpected Jiwa save");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MemoryModal", () => {
  it("presents memories and Jiwa as accessible Brain tabs", async () => {
    render(<MemoryModal onClose={vi.fn()} />);

    expect(await screen.findByText("Ken prefers concise, scannable answers.")).toBeDefined();
    const title = document.querySelector(".memory-modal-title");
    expect(title?.textContent).toContain("Brain");
    expect(title?.querySelector(".badge")?.textContent).toBe("1");
    expect(screen.getByRole("tab", { name: "Memories" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("tab", { name: "Jiwa" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByText("preference")).toBeDefined();
    expect(screen.getByLabelText("Importance 5 of 5")).toBeDefined();
  });

  it("names the category on the iPhone's line under each entry as the editor does", async () => {
    render(<MemoryModal onClose={vi.fn()} />);
    await screen.findByText(KEN_MEMORY);

    const meta = document.querySelector(".memory-meta");
    expect(meta?.querySelector("[aria-hidden='true']")?.textContent).toBe("Preference · 5 / 5");
    expect(meta?.querySelector(".sr-only")?.textContent).toBe("Preference, importance 5 of 5");

    fireEvent.click(screen.getByRole("tab", { name: "Jiwa" }));
    await screen.findByText("Call yourself Blargo in chat.");
    expect(document.querySelector(".memory-meta [aria-hidden='true']")?.textContent).toBe(
      "Identity · 5 / 5",
    );
  });

  it("switches the table and total badge to Jiwa by click or arrow key", async () => {
    render(<MemoryModal onClose={vi.fn()} />);
    await screen.findByText("Ken prefers concise, scannable answers.");
    const memoriesTab = screen.getByRole("tab", { name: "Memories" });

    fireEvent.keyDown(memoriesTab, { key: "ArrowRight" });

    expect(await screen.findByText("Call yourself Blargo in chat.")).toBeDefined();
    expect(screen.getByRole("columnheader", { name: "Instruction" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Jiwa" }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".memory-modal .badge")?.textContent).toBe("1");
  });

  it("deletes exactly one entry from the active table", async () => {
    render(<MemoryModal onClose={vi.fn()} />);
    await screen.findByText("Ken prefers concise, scannable answers.");
    fireEvent.click(screen.getByRole("tab", { name: "Jiwa" }));
    const button = await screen.findByRole("button", {
      name: "Delete Jiwa instruction: Call yourself Blargo in chat.",
    });

    fireEvent.click(button);

    await waitFor(() => expect(deleteJiwaMock).toHaveBeenCalledWith("jiwa-1"));
    expect(deleteMemoryMock).not.toHaveBeenCalled();
    expect(await screen.findByText("No Jiwa instructions yet.")).toBeDefined();
    expect(document.querySelector(".memory-modal .badge")?.textContent).toBe("0");
  });

  it("renders a load error for the active table", async () => {
    listMemoriesMock.mockRejectedValue(new Error("daemon unavailable"));
    render(<MemoryModal onClose={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't load memories: daemon unavailable",
    );
  });

  it("refreshes each table from its matching change event", async () => {
    const refreshedMemories: MemorySnapshot = {
      ...populatedMemories,
      memories: [
        ...populatedMemories.memories,
        {
          ...populatedMemories.memories[0]!,
          id: "memory-2",
          text: "Ken is building durable chat memory.",
          category: "project",
        },
      ],
    };
    const refreshedJiwa: JiwaSnapshot = {
      ...populatedJiwa,
      jiwa: [
        ...populatedJiwa.jiwa,
        {
          ...populatedJiwa.jiwa[0]!,
          id: "jiwa-2",
          text: "Never end with a generic offer to help.",
          category: "boundaries",
        },
      ],
    };
    listMemoriesMock
      .mockResolvedValueOnce(populatedMemories)
      .mockResolvedValueOnce(refreshedMemories);
    listJiwaMock.mockResolvedValueOnce(populatedJiwa).mockResolvedValueOnce(refreshedJiwa);
    render(<MemoryModal onClose={vi.fn()} />);
    await screen.findByText("Ken prefers concise, scannable answers.");

    eventHandler?.({ type: "memory_change", data: { count: 2 } });
    expect(await screen.findByText("Ken is building durable chat memory.")).toBeDefined();
    expect(document.querySelector(".memory-modal .badge")?.textContent).toBe("2");

    eventHandler?.({ type: "jiwa_change", data: { count: 2 } });
    fireEvent.click(screen.getByRole("tab", { name: "Jiwa" }));
    expect(await screen.findByText("Never end with a generic offer to help.")).toBeDefined();
    expect(document.querySelector(".memory-modal .badge")?.textContent).toBe("2");
    expect(isMemoryChangeEventMock).toHaveBeenCalled();
    expect(isJiwaChangeEventMock).toHaveBeenCalled();
    expect(subscribeMock).toHaveBeenCalledOnce();
  });

  it("adds a memory, then returns focus to Add and says so", async () => {
    const added: Memory = {
      id: "memory-2",
      text: "Ken is building durable chat memory.",
      category: "project",
      importance: 4,
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    let finish: (result: MemorySnapshot & { memory: Memory }) => void = () => {};
    saveMemoryMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<MemoryModal onClose={vi.fn()} />);
    await screen.findByText(KEN_MEMORY);

    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));

    const form = screen.getByRole("form", { name: "New memory" });
    const text = within(form).getByRole("textbox", { name: "Memory" });
    // The modal moves focus in an effect after the render that shows its
    // target, so on a busy run it can land a beat after the editor does.
    await waitFor(() => expect(document.activeElement).toBe(text));
    expect(within(form).getByRole("radio", { name: "Other" })).toHaveProperty("checked", true);
    expect(within(form).getByRole("radio", { name: "3" })).toHaveProperty("checked", true);
    expect(within(form).getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);

    fireEvent.change(text, { target: { value: "  Ken is building durable chat memory.  " } });
    fireEvent.click(within(form).getByRole("radio", { name: "Project" }));
    fireEvent.click(within(form).getByRole("radio", { name: "4" }));
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    expect(saveMemoryMock).toHaveBeenCalledWith(null, {
      text: "Ken is building durable chat memory.",
      category: "project",
      importance: 4,
    });
    expect(within(form).getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
    expect(within(form).getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);

    await act(async () => {
      finish({
        ...populatedMemories,
        memories: [...populatedMemories.memories, added],
        memory: added,
      });
    });

    expect(await screen.findByText("Ken is building durable chat memory.")).toBeDefined();
    expect(screen.queryByRole("form")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add memory" })),
    );
    expect(screen.getByRole("status").textContent).toBe("Memory added.");
    expect(document.querySelector(".memory-modal .badge")?.textContent).toBe("2");
    expect(saveJiwaMock).not.toHaveBeenCalled();
  });

  it("edits a memory from its saved values, with Save off until something changes", async () => {
    const [original] = populatedMemories.memories;
    if (!original) throw new Error("fixture has a memory");
    const edited: Memory = { ...original, importance: 4, updatedAt: "2026-07-14T00:00:00.000Z" };
    saveMemoryMock.mockResolvedValue({ ...populatedMemories, memories: [edited], memory: edited });
    render(<MemoryModal onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: `Edit memory: ${KEN_MEMORY}` }));

    const form = screen.getByRole("form", { name: "Edit memory" });
    const text = within(form).getByRole("textbox", { name: "Memory" });
    const save = within(form).getByRole("button", { name: "Save" });
    expect(text).toHaveProperty("value", KEN_MEMORY);
    expect(within(form).getByRole("radio", { name: "Preference" })).toHaveProperty("checked", true);
    expect(within(form).getByRole("radio", { name: "5" })).toHaveProperty("checked", true);
    expect(save).toHaveProperty("disabled", true);
    // The sidecar trims, so trailing spaces alone change nothing.
    fireEvent.change(text, { target: { value: `${KEN_MEMORY}   ` } });
    expect(save).toHaveProperty("disabled", true);

    fireEvent.click(within(form).getByRole("radio", { name: "4" }));
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);

    await waitFor(() =>
      expect(saveMemoryMock).toHaveBeenCalledWith("memory-1", {
        text: KEN_MEMORY,
        category: "preference",
        importance: 4,
      }),
    );
    expect(await screen.findByLabelText("Importance 4 of 5")).toBeDefined();
    // Focus moves back to the row's Edit in an effect after the list renders,
    // so on a busy run it can land a render after the row does.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: `Edit memory: ${KEN_MEMORY}` }),
      ),
    );
    expect(screen.getByRole("status").textContent).toBe("Memory saved.");
  });

  it("keeps the draft and shows the sidecar's reason when a save is refused", async () => {
    const refusal = "Brain already has one like this: “Call yourself Blargo in chat.”";
    saveJiwaMock.mockRejectedValue(refusal);
    render(<MemoryModal onClose={vi.fn()} />);
    await screen.findByText(KEN_MEMORY);
    fireEvent.click(screen.getByRole("tab", { name: "Jiwa" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add instruction" }));
    const form = screen.getByRole("form", { name: "New Jiwa instruction" });
    const text = within(form).getByRole("textbox", { name: "Instruction" });

    fireEvent.change(text, { target: { value: "Call yourself Blargo in chat!" } });
    fireEvent.click(within(form).getByRole("radio", { name: "Identity" }));
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    expect((await within(form).findByRole("alert")).textContent).toBe(refusal);
    expect(saveJiwaMock).toHaveBeenCalledWith(null, {
      text: "Call yourself Blargo in chat!",
      category: "identity",
      importance: 3,
    });
    expect(text).toHaveProperty("value", "Call yourself Blargo in chat!");
    expect(within(form).getByRole("radio", { name: "Identity" })).toHaveProperty("checked", true);
    expect(within(form).getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
    await waitFor(() => expect(document.activeElement).toBe(text));
    expect(saveMemoryMock).not.toHaveBeenCalled();
  });

  it("explains an older host's not found instead of showing it raw", async () => {
    saveMemoryMock.mockRejectedValue("not found");
    render(<MemoryModal onClose={vi.fn()} />);
    await screen.findByText(KEN_MEMORY);
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Memory" }), {
      target: { value: "Works as a GP in Leeds." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toBe(OLDER_HOST_MESSAGE);
    expect(screen.getByRole("textbox", { name: "Memory" })).toHaveProperty(
      "value",
      "Works as a GP in Leeds.",
    );
  });

  it("cancels the editor on Escape without closing the Brain", async () => {
    const onClose = vi.fn();
    render(<MemoryModal onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: `Edit memory: ${KEN_MEMORY}` }));
    const text = screen.getByRole("textbox", { name: "Memory" });
    fireEvent.change(text, { target: { value: "Changed my mind." } });

    fireEvent.keyDown(text, { key: "Escape" });

    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: `Edit memory: ${KEN_MEMORY}` }),
      ),
    );
    expect(screen.getByText(KEN_MEMORY)).toBeDefined();
    expect(saveMemoryMock).not.toHaveBeenCalled();

    // With the editor gone, Escape closes the Brain as before.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps each tab's draft while switching, without moving focus off the tab", async () => {
    render(<MemoryModal onClose={vi.fn()} />);
    await screen.findByText(KEN_MEMORY);
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Memory" }), {
      target: { value: "Half-written memory" },
    });

    fireEvent.click(screen.getByRole("tab", { name: "Jiwa" }));
    expect(await screen.findByText("Call yourself Blargo in chat.")).toBeDefined();
    expect(screen.queryByRole("form")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add instruction" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Instruction" }), {
      target: { value: "Half-written instruction" },
    });

    const jiwaTab = screen.getByRole("tab", { name: "Jiwa" });
    fireEvent.keyDown(jiwaTab, { key: "ArrowLeft" });
    expect(screen.getByRole("textbox", { name: "Memory" })).toHaveProperty(
      "value",
      "Half-written memory",
    );
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Memories" }));

    fireEvent.click(jiwaTab);
    expect(screen.getByRole("textbox", { name: "Instruction" })).toHaveProperty(
      "value",
      "Half-written instruction",
    );
  });

  it("notes a full tab before Add, and only on that tab", async () => {
    listMemoriesMock.mockResolvedValue({
      softLimit: 60,
      hardLimit: 90,
      memories: Array.from({ length: 90 }, (_, index) => numberedMemory(index)),
    });
    render(<MemoryModal onClose={vi.fn()} />);

    expect(await screen.findByText(FULL_NOTE)).toBeDefined();
    expect(screen.getByRole("button", { name: "Add memory" })).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "Jiwa" }));
    await screen.findByText("Call yourself Blargo in chat.");
    expect(screen.queryByText(FULL_NOTE)).toBeNull();
  });

  it("leaves the note off one short of the limit", async () => {
    listMemoriesMock.mockResolvedValue({
      softLimit: 60,
      hardLimit: 90,
      memories: Array.from({ length: 89 }, (_, index) => numberedMemory(index)),
    });
    render(<MemoryModal onClose={vi.fn()} />);

    await screen.findByText("Memory number 88");
    expect(screen.queryByText(FULL_NOTE)).toBeNull();
  });

  it("counts characters from 500, tied to the field", async () => {
    render(<MemoryModal onClose={vi.fn()} />);
    await screen.findByText(KEN_MEMORY);
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    const text = screen.getByRole("textbox", { name: "Memory" });
    expect(text).toHaveProperty("maxLength", 600);

    fireEvent.change(text, { target: { value: "a".repeat(499) } });
    expect(screen.queryByText("499 / 600")).toBeNull();
    expect(text.getAttribute("aria-describedby")).toBeNull();

    fireEvent.change(text, { target: { value: "a".repeat(540) } });
    const counter = screen.getByText("540 / 600");
    expect(text.getAttribute("aria-describedby")).toBe(counter.id);
  });
});
