// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as KleioApi from "./kleioApi";
import {
  createFileShow,
  createLinkShow,
  getShow,
  KleioApiError,
  listAgentFiles,
  startVoiceCall,
  type ShowInfo,
} from "./kleioApi";
import { holdAwake } from "./keepAwake";
import {
  callError,
  callState,
  closeShown,
  endCall,
  functionCall,
  GREETING,
  isWebSearch,
  resetCall,
  startCall,
} from "./voiceCall";

vi.mock("../agent", () => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("./kleioApi", async (importOriginal) => ({
  ...(await importOriginal<typeof KleioApi>()),
  startVoiceCall: vi.fn(),
  listAgentFiles: vi.fn(),
  createFileShow: vi.fn(),
  createLinkShow: vi.fn(),
  getShow: vi.fn(),
}));
const awake = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock("./keepAwake", () => ({ holdAwake: vi.fn(() => awake) }));

describe("callError", () => {
  it("says plainly what stopped the conversation", () => {
    const cases: [unknown, RegExp][] = [
      [new DOMException("denied", "NotAllowedError"), /needs your microphone/],
      [new KleioApiError(409, "no_key"), /Add an OpenAI key in Settings/],
      [new KleioApiError(422, "bad_key"), /didn't accept the key/],
      [new KleioApiError(422, "no_credit"), /out of credit/],
      [new KleioApiError(504, "unreachable"), /couldn't reach OpenAI/],
      [new KleioApiError(0, "offline"), /couldn't reach your host/],
      [new KleioApiError(404, "not_found"), /needs the latest Kleio/],
      [new KleioApiError(502, "rejected", "Model not found"), /OpenAI said: Model not found/],
      [new Error("boom"), /Something went wrong/],
    ];
    for (const [e, want] of cases) expect(callError(e)).toMatch(want);
  });
});

describe("isWebSearch", () => {
  it("spots the backend's hosted web search, and is not a function call", () => {
    const item = { type: "web_search_call", id: "ws1", status: "completed" };
    expect(isWebSearch(item)).toBe(true);
    expect(functionCall(item)).toBeNull();
    expect(isWebSearch({ type: "function_call" })).toBe(false);
    expect(isWebSearch(null)).toBe(false);
  });
});

describe("functionCall", () => {
  it("reads a finished tool call from the backend, and nothing else", () => {
    expect(
      functionCall({
        type: "function_call",
        call_id: "c1",
        name: "draft_plan",
        arguments: '{"to":"Chef","plan":"Eggs."}',
      }),
    ).toEqual({ callId: "c1", name: "draft_plan", args: { to: "Chef", plan: "Eggs." } });
    // Broken arguments: the tool says what's missing.
    expect(
      functionCall({ type: "function_call", call_id: "c2", name: "send_plan", arguments: "{" }),
    ).toEqual({ callId: "c2", name: "send_plan", args: {} });
    expect(functionCall({ type: "message", content: [] })).toBeNull();
    expect(functionCall(null)).toBeNull();
  });
});

describe("startCall", () => {
  afterEach(() => {
    resetCall();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("closing while it connects stops the call and releases the microphone", async () => {
    const track = { stop: vi.fn(), enabled: true };
    const mic = { getAudioTracks: () => [track], getTracks: () => [track] };
    const pcs: { close: ReturnType<typeof vi.fn> }[] = [];
    class FakePC {
      ontrack: unknown = null;
      close = vi.fn();
      constructor() {
        pcs.push(this);
      }
      addTrack(): void {}
      addEventListener(): void {}
      createDataChannel(): unknown {
        return { addEventListener: () => {}, close: () => {}, readyState: "connecting" };
      }
      async createOffer(): Promise<{ type: string; sdp: string }> {
        return { type: "offer", sdp: "v=0\r\n" };
      }
      async setLocalDescription(): Promise<void> {}
      async setRemoteDescription(): Promise<void> {}
    }
    vi.stubGlobal("RTCPeerConnection", FakePC);
    vi.stubGlobal("Audio", class {});
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: async () => mic } });
    let answer: (sdp: string) => void = () => {};
    vi.mocked(startVoiceCall).mockReturnValue(new Promise((r) => (answer = r)));

    const starting = startCall();
    await vi.waitFor(() => expect(startVoiceCall).toHaveBeenCalled());
    expect(callState().phase).toBe("connecting");

    resetCall(); // The user closes the panel before OpenAI answers.
    answer("v=0\r\n");
    await starting;

    expect(callState().phase).toBe("idle");
    expect(track.stop).toHaveBeenCalled();
    expect(pcs[0]?.close).toHaveBeenCalled();
  });

  it("opens with a warm welcome, not a report of what isn't happening", async () => {
    const track = { stop: vi.fn(), enabled: true };
    const mic = { getAudioTracks: () => [track], getTracks: () => [track] };
    let onMessage: (m: { data: string }) => void = () => {};
    const channel = {
      readyState: "open",
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: (type: string, fn: (m: { data: string }) => void) => {
        if (type === "message") onMessage = fn;
      },
    };
    class FakePC {
      ontrack: unknown = null;
      close = vi.fn();
      addTrack(): void {}
      addEventListener(): void {}
      createDataChannel(): unknown {
        return channel;
      }
      async createOffer(): Promise<{ type: string; sdp: string }> {
        return { type: "offer", sdp: "v=0\r\n" };
      }
      async setLocalDescription(): Promise<void> {}
      async setRemoteDescription(): Promise<void> {}
    }
    vi.stubGlobal("RTCPeerConnection", FakePC);
    vi.stubGlobal("Audio", class {});
    vi.stubGlobal("MediaStream", class {});
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: async () => mic } });
    vi.mocked(startVoiceCall).mockResolvedValue("v=0\r\n");

    await startCall();
    onMessage({ data: JSON.stringify({ type: "session.started" }) });

    const sent = channel.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(sent).toContainEqual({
      type: "session.instructions.append",
      delegation_id: null,
      content: GREETING,
    });
    // Welcoming: the time of day, their name, an offer to help; never "nothing is pressing".
    expect(GREETING).toMatch(/welcome/i);
    expect(GREETING).toMatch(/good morning, good afternoon or good evening/);
    expect(GREETING).toMatch(/by name/);
    expect(GREETING).toMatch(/If nothing does, don't say so/);
  });

  it("keeps the same state while her words stream in, so the screen doesn't re-render", async () => {
    const track = { stop: vi.fn(), enabled: true };
    const mic = { getAudioTracks: () => [track], getTracks: () => [track] };
    let onMessage: (m: { data: string }) => void = () => {};
    const channel = {
      readyState: "open",
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: (type: string, fn: (m: { data: string }) => void) => {
        if (type === "message") onMessage = fn;
      },
    };
    class FakePC {
      ontrack: unknown = null;
      close = vi.fn();
      addTrack(): void {}
      addEventListener(): void {}
      createDataChannel(): unknown {
        return channel;
      }
      async createOffer(): Promise<{ type: string; sdp: string }> {
        return { type: "offer", sdp: "v=0\r\n" };
      }
      async setLocalDescription(): Promise<void> {}
      async setRemoteDescription(): Promise<void> {}
    }
    vi.stubGlobal("RTCPeerConnection", FakePC);
    vi.stubGlobal("Audio", class {});
    vi.stubGlobal("MediaStream", class {});
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: async () => mic } });
    vi.mocked(startVoiceCall).mockResolvedValue("v=0\r\n");
    const event = (e: Record<string, unknown>): void => onMessage({ data: JSON.stringify(e) });

    await startCall();
    event({ type: "session.output_transcript.delta", delta: "Morning," });
    const speaking = callState();
    expect(speaking.phase).toBe("speaking");

    event({ type: "session.output_transcript.delta", delta: " Finn." });
    expect(callState()).toBe(speaking);
  });

  it("hangs up after 2 minutes with nobody talking; talking starts the countdown again", async () => {
    vi.useFakeTimers();
    const track = { stop: vi.fn(), enabled: true };
    const mic = { getAudioTracks: () => [track], getTracks: () => [track] };
    let onMessage: (m: { data: string }) => void = () => {};
    const channel = {
      readyState: "open",
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: (type: string, fn: (m: { data: string }) => void) => {
        if (type === "message") onMessage = fn;
      },
    };
    class FakePC {
      ontrack: unknown = null;
      close = vi.fn();
      addTrack(): void {}
      addEventListener(): void {}
      createDataChannel(): unknown {
        return channel;
      }
      async createOffer(): Promise<{ type: string; sdp: string }> {
        return { type: "offer", sdp: "v=0\r\n" };
      }
      async setLocalDescription(): Promise<void> {}
      async setRemoteDescription(): Promise<void> {}
    }
    vi.stubGlobal("RTCPeerConnection", FakePC);
    vi.stubGlobal("Audio", class {});
    vi.stubGlobal("MediaStream", class {});
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: async () => mic } });
    vi.mocked(startVoiceCall).mockResolvedValue("v=0\r\n");
    const event = (e: Record<string, unknown>): void => onMessage({ data: JSON.stringify(e) });

    await startCall();
    expect(callState().phase).toBe("listening");

    vi.advanceTimersByTime(90_000);
    event({ type: "session.input_transcript.delta", delta: "Hello?" }); // The countdown restarts.
    vi.advanceTimersByTime(90_000);
    event({ type: "session.usage.updated", usage: { seconds: 180 } }); // Not anyone talking.
    expect(callState().phase).not.toBe("ended");

    vi.advanceTimersByTime(30_000);
    expect(callState()).toMatchObject({
      phase: "ended",
      error: expect.stringMatching(/2 minutes of quiet/),
    });
    // The session ends at OpenAI too, which stops the billing.
    expect(channel.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "session.close" }));
    expect(track.stop).toHaveBeenCalled();
  });
});

describe("keeping the Mac awake", () => {
  afterEach(() => {
    resetCall();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /** A call whose connection you drive: `to("connected")`, `to("failed")`. */
  async function connecting(): Promise<{
    to: (state: string) => void;
    message: (e: Record<string, unknown>) => void;
  }> {
    const track = { stop: vi.fn(), enabled: true };
    const mic = { getAudioTracks: () => [track], getTracks: () => [track] };
    let onMessage: (m: { data: string }) => void = () => {};
    let onState: () => void = () => {};
    const channel = {
      readyState: "open",
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: (type: string, fn: (m: { data: string }) => void) => {
        if (type === "message") onMessage = fn;
      },
    };
    const pcs: FakePC[] = [];
    class FakePC {
      ontrack: unknown = null;
      connectionState = "new";
      close = vi.fn();
      constructor() {
        pcs.push(this);
      }
      addTrack(): void {}
      addEventListener(type: string, fn: () => void): void {
        if (type === "connectionstatechange") onState = fn;
      }
      createDataChannel(): unknown {
        return channel;
      }
      async createOffer(): Promise<{ type: string; sdp: string }> {
        return { type: "offer", sdp: "v=0\r\n" };
      }
      async setLocalDescription(): Promise<void> {}
      async setRemoteDescription(): Promise<void> {}
    }
    vi.stubGlobal("RTCPeerConnection", FakePC);
    vi.stubGlobal("Audio", class {});
    vi.stubGlobal("MediaStream", class {});
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: async () => mic } });
    vi.mocked(startVoiceCall).mockResolvedValue("v=0\r\n");
    await startCall();
    return {
      to: (state) => {
        const pc = pcs[0];
        if (pc) pc.connectionState = state;
        onState();
      },
      message: (e) => onMessage({ data: JSON.stringify(e) }),
    };
  }

  it("holds the display awake only once the call has really connected", async () => {
    const call = await connecting();
    expect(holdAwake).not.toHaveBeenCalled();
    call.to("connecting");
    expect(holdAwake).not.toHaveBeenCalled();
    call.to("connected");
    call.to("connected"); // A repeat event doesn't take a second hold.
    expect(holdAwake).toHaveBeenCalledTimes(1);
    expect(awake.release).not.toHaveBeenCalled();
  });

  it("lets go when you hang up, and only once", async () => {
    const call = await connecting();
    call.to("connected");
    endCall();
    endCall();
    resetCall();
    expect(awake.release).toHaveBeenCalledTimes(1);
  });

  it("lets go when the connection drops or fails", async () => {
    const dropped = await connecting();
    dropped.to("connected");
    dropped.to("failed");
    expect(callState()).toMatchObject({ phase: "ended", error: expect.any(String) });
    expect(awake.release).toHaveBeenCalledTimes(1);

    resetCall();
    vi.mocked(holdAwake).mockClear();
    awake.release.mockClear();
    const closed = await connecting();
    closed.to("connected");
    closed.to("closed");
    expect(awake.release).toHaveBeenCalledTimes(1);
  });

  it("lets go when OpenAI ends the session, or the screen closes", async () => {
    const ended = await connecting();
    ended.to("connected");
    ended.message({ type: "error", error: { message: "boom" } });
    resetCall();
    expect(awake.release).toHaveBeenCalledTimes(1);

    vi.mocked(holdAwake).mockClear();
    awake.release.mockClear();
    const closing = await connecting();
    closing.to("connected");
    resetCall(); // The voice screen closes (Esc, close, or it unmounts with the window).
    expect(awake.release).toHaveBeenCalledTimes(1);
  });

  it("lets go when the page goes away mid-call (reload or the window closing)", async () => {
    const call = await connecting();
    call.to("connected");
    window.dispatchEvent(new Event("pagehide"));
    expect(callState().phase).toBe("ended");
    expect(awake.release).toHaveBeenCalledTimes(1);
    // The listener goes with the call: a later pagehide does nothing more.
    window.dispatchEvent(new Event("pagehide"));
    expect(awake.release).toHaveBeenCalledTimes(1);
  });

  it("never holds anything for a call that never connected", async () => {
    const call = await connecting();
    call.to("failed");
    resetCall();
    expect(holdAwake).not.toHaveBeenCalled();
    expect(awake.release).not.toHaveBeenCalled();
  });

  it("closing a file she showed leaves the call, and the hold, alone", async () => {
    const call = await connecting();
    call.to("connected");
    closeShown();
    expect(callState().phase).not.toBe("ended");
    expect(awake.release).not.toHaveBeenCalled();
  });
});

describe("what she shows", () => {
  afterEach(() => {
    resetCall();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const NOTES: ShowInfo = {
    id: `sh_${"c".repeat(32)}`,
    kind: "text",
    name: "notes.md",
    state: "ready",
    format: "markdown",
  };

  /** A connected call whose backend you drive: `tool(name, args)` runs a tool call to its end. */
  async function talking(): Promise<{
    tool: (name: string, args: Record<string, unknown>) => Promise<void>;
    said: (text: string) => void;
    sent: () => Record<string, unknown>[];
  }> {
    const track = { stop: vi.fn(), enabled: true };
    const mic = { getAudioTracks: () => [track], getTracks: () => [track] };
    let onMessage: (m: { data: string }) => void = () => {};
    const channel = {
      readyState: "open",
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: (type: string, fn: (m: { data: string }) => void) => {
        if (type === "message") onMessage = fn;
      },
    };
    class FakePC {
      ontrack: unknown = null;
      connectionState = "connected";
      close = vi.fn();
      addTrack(): void {}
      addEventListener(): void {}
      createDataChannel(): unknown {
        return channel;
      }
      async createOffer(): Promise<{ type: string; sdp: string }> {
        return { type: "offer", sdp: "v=0\r\n" };
      }
      async setLocalDescription(): Promise<void> {}
      async setRemoteDescription(): Promise<void> {}
    }
    vi.stubGlobal("RTCPeerConnection", FakePC);
    vi.stubGlobal("Audio", class {});
    vi.stubGlobal("MediaStream", class {});
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: async () => mic } });
    vi.mocked(startVoiceCall).mockResolvedValue("v=0\r\n");
    await startCall();
    const event = (e: Record<string, unknown>): void => onMessage({ data: JSON.stringify(e) });
    let n = 0;
    return {
      tool: async (name, args) => {
        const delegation = `del-${++n}`;
        event({ type: "session.delegation.created", delegation: { id: delegation } });
        event({
          type: "response.event",
          delegation_id: delegation,
          event: {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: `call-${n}`,
              name,
              arguments: JSON.stringify(args),
            },
          },
        });
        event({
          type: "response.event",
          delegation_id: delegation,
          event: { type: "response.completed" },
        });
        await vi.waitFor(() =>
          expect(channel.send.mock.calls.map(([raw]) => String(raw)).join()).toContain(
            `"call_id":"call-${n}"`,
          ),
        );
      },
      said: (text) => {
        event({ type: "session.input_transcript.delta", delta: text });
      },
      sent: () => channel.send.mock.calls.map(([raw]) => JSON.parse(String(raw))),
    };
  }

  it("puts up what she shows and takes it down on hide, while the call keeps going", async () => {
    vi.mocked(listAgentFiles).mockResolvedValue({
      files: [
        {
          path: "notes.md",
          name: "notes.md",
          kind: "text",
          size: 20,
          modified: "2026-10-07T09:00:00.000Z",
          readable: true,
        },
      ],
    });
    vi.mocked(createFileShow).mockResolvedValue(NOTES);
    const call = await talking();
    await call.tool("show", { from: "kleio", file: "notes" });
    expect(callState().shown).toMatchObject({ key: 1, title: "notes.md", show: NOTES });
    expect(callState().phase).not.toBe("ended");

    await call.tool("hide", {});
    expect(callState().shown).toBeNull();
    expect(callState().phase).not.toBe("ended");
    // Her backend heard both results.
    const outputs = call
      .sent()
      .filter((e) => (e.item as { type?: string } | undefined)?.type === "function_call_output")
      .map((e) => JSON.parse(String((e.item as { output: string }).output)));
    expect(outputs).toEqual([expect.objectContaining({ shown: true }), { hidden: true }]);
  });

  it("asks the host for a page at this screen's width, and lands it when it's drawn", async () => {
    const page: ShowInfo = {
      id: `sh_${"d".repeat(32)}`,
      kind: "web",
      name: "example.com",
      host: "example.com",
      state: "capturing",
    };
    vi.mocked(createLinkShow).mockResolvedValue(page);
    vi.mocked(getShow).mockResolvedValue({ ...page, state: "ready" });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const call = await talking();
      call.said("Show me example.com.");
      const done = call.tool("show", { url: "https://example.com/" });
      await vi.waitFor(() => expect(callState().shown?.show?.state).toBe("capturing"));
      await vi.advanceTimersByTimeAsync(700);
      await done;
      expect(createLinkShow).toHaveBeenCalledWith("https://example.com/", "desktop");
      expect(callState().shown).toMatchObject({
        url: "https://example.com/",
        show: { state: "ready" },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
