// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { openUrl } from "../agent";
import { getVoiceStatus, KleioApiError, setVoiceKey, type VoiceStatus } from "./kleioApi";
import type * as KleioApi from "./kleioApi";
import { VoiceCard } from "./VoiceCard";

vi.mock("../agent", () => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("./VoiceGuide", () => ({ VoiceGuide: () => null }));
vi.mock("./VoiceMode", () => ({ setVoiceReady: vi.fn(), talkToKleio: vi.fn() }));
vi.mock("./kleioApi", async (importOriginal) => {
  const actual = await importOriginal<typeof KleioApi>();
  return {
    KleioApiError: actual.KleioApiError,
    errorText: actual.errorText,
    getVoiceStatus: vi.fn(),
    removeVoiceKey: vi.fn(),
    setVoiceKey: vi.fn(),
    setVoiceName: vi.fn(),
  };
});

function voice(ready: boolean): VoiceStatus {
  return { ready, voice: "marin", model: "gpt-live", voices: ["marin", "cedar"], speed: 1 };
}

async function renderCard(
  ready: boolean,
  canEdit?: boolean,
  onReady?: (ready: boolean | null) => void,
): Promise<void> {
  vi.mocked(getVoiceStatus).mockResolvedValue(voice(ready));
  await act(async () => {
    render(
      canEdit === undefined ? (
        <VoiceCard onReady={onReady} />
      ) : (
        <VoiceCard canEdit={canEdit} onReady={onReady} />
      ),
    );
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("VoiceCard", () => {
  it("lets an admin device add the key, with where to get one", async () => {
    await renderCard(false);
    expect(screen.getByText("Needed")).toBeTruthy();
    const field = screen.getByLabelText("OpenAI API key");
    expect(field.getAttribute("type")).toBe("password");
    expect(field.getAttribute("placeholder")).toBe("OpenAI API key (sk-…)");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(
      screen.getByText("On platform.openai.com, open API keys and create a key."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Get a key" }));
    expect(openUrl).toHaveBeenCalledWith("https://platform.openai.com/api-keys");
  });

  it("tells Setup whether she can talk", async () => {
    const onReady = vi.fn();
    await renderCard(true, true, onReady);
    expect(screen.getByText("Done")).toBeTruthy();
    expect(onReady).toHaveBeenLastCalledWith(true);
  });

  it("saves a key and shows it done", async () => {
    vi.mocked(setVoiceKey).mockResolvedValue(voice(true));
    const onReady = vi.fn();
    await renderCard(false, true, onReady);
    expect(onReady).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "sk-live" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(setVoiceKey).toHaveBeenCalledWith("sk-live");
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
    expect(onReady).toHaveBeenLastCalledWith(true);
  });

  it("puts a refused key in words, under the field", async () => {
    vi.mocked(setVoiceKey).mockRejectedValueOnce(new KleioApiError(422, "bad_key"));
    await renderCard(false);
    fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "nope" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "OpenAI didn't accept that key. Check you copied all of it.",
    );
  });

  it("lets an admin device pick the voice and remove the key", async () => {
    await renderCard(true, true);
    expect(screen.getByLabelText("Kleio's conversation voice")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove OpenAI key" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Talk now" })).toBeTruthy();
  });

  // Setup's note says once, for the whole page, that keys are the admin's.
  it("leaves the key to the admin device on any other", async () => {
    await renderCard(false, false);
    expect(screen.getByText("Needed")).toBeTruthy();
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Get a key" })).toBeNull();
  });

  it("still lets any device talk once the key is set", async () => {
    await renderCard(true, false);
    expect(screen.getByRole("button", { name: "Talk now" })).toBeTruthy();
    expect(screen.queryByLabelText("Kleio's conversation voice")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove OpenAI key" })).toBeNull();
  });
});
