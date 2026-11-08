// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LoginScreen } from "./LoginScreen";

const native = vi.hoisted(() => ({
  authStatusWithError: vi.fn(async () => ({ providers: [], error: null })),
  subscribe: vi.fn(() => vi.fn()),
  getLocalModels: vi.fn(async () => ({ endpoints: [] })),
  scanLocalModels: vi.fn(async () => ({ endpoints: [] })),
  hfPullStatus: vi.fn(async () => null),
  hfSearch: vi.fn(async () => []),
  hfPull: vi.fn(),
}));
vi.mock("./agent", () => ({ ...native, isHfPullEvent: () => false }));
vi.mock("./toast", () => ({ toast: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("loads local-model and download forms only after selection, without scanning or downloading", async () => {
  render(<LoginScreen onClose={vi.fn()} />);
  const local = await screen.findByRole("button", { name: /Ollama/i });
  // The tiles show the last scan (a cheap read); probing waits for the form.
  await waitFor(() => expect(native.getLocalModels).toHaveBeenCalledTimes(1));
  expect(native.scanLocalModels).not.toHaveBeenCalled();
  expect(native.hfPullStatus).not.toHaveBeenCalled();
  local.focus();
  fireEvent.click(local);
  await screen.findByRole("dialog", { name: /Local models/i });
  await waitFor(() => expect(native.scanLocalModels).toHaveBeenCalledTimes(1));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(local);
  const hub = screen.getByRole("button", { name: /Hugging Face/i });
  hub.focus();
  fireEvent.click(hub);
  await screen.findByRole("combobox", { name: "Search Hugging Face models" });
  // The dialog attaches its Escape listener in an effect that runs after the
  // field appears. Wait for the form's status read (same effect pass), as the
  // Ollama form waits for its scan, or Escape can land before the listener.
  await waitFor(() => expect(native.hfPullStatus).toHaveBeenCalledTimes(1));
  expect(native.hfPull).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(hub);
});
