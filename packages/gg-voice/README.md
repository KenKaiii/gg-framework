# @kenkaiiii/gg-voice

Provider-agnostic realtime voice orchestration for GG tools, agents, and remote coding sessions.

## Architecture

`gg-voice` keeps the package root mobile-safe: it exports normalized voice session types, tool conversion helpers, in-memory tests, and platform interfaces without importing Node-only `ggcoder` internals. Provider and bridge integrations live behind subpath exports so Expo, web, desktop, and Node relays can choose only the pieces they need.

Core concepts:

- `VoiceProvider`: creates a realtime `VoiceSession`.
- `VoiceTransport`: injectable WebRTC, WebSocket, or custom transport.
- `VoiceEvent`: normalized session, transcript, text, audio, tool, error, and close events.
- `VoiceTool`: realtime-safe tool contract with optional confirmation policies.
- `VoiceBridgeCommand` / `VoiceBridgeEvent`: small control surface for GG remotes.

## Provider support

The official OpenAI adapter is exported from:

```ts
import { createOpenAIRealtimeProvider } from "@kenkaiiii/gg-voice/providers/openai-realtime";
```

It targets the documented GA Realtime WebRTC flow with `/v1/realtime/calls` and `/v1/realtime/client_secrets`, `session.type: "realtime"`, and current model examples such as `gpt-realtime-2` / `gpt-realtime`. The adapter normalizes GA event names including `response.output_text.delta`, `response.output_audio.delta`, and `response.output_audio_transcript.delta` where applicable, but requires an injected platform transport. Browser, React Native, desktop, and server runtimes wire audio/WebRTC differently, so this package does not ship a universal WebRTC implementation.

The experimental Codex/ChatGPT-backed adapter is isolated at:

```ts
import { createExperimentalCodexRealtimeProvider } from "@kenkaiiii/gg-voice/providers/openai-codex-realtime";
```

This route is intentionally marked experimental because Codex backend request shapes are internal and can change.

## Tools

Convert existing GG tools into realtime function tools:

```ts
import { agentToolToVoiceTool, voiceToolToRealtimeFunctionTool } from "@kenkaiiii/gg-voice";

const voiceTool = agentToolToVoiceTool(agentTool);
const realtimeTool = voiceToolToRealtimeFunctionTool(voiceTool);
```

Execute model-requested tool calls with confirmation support:

```ts
const result = await executeVoiceToolCall({
  tools: [voiceTool],
  call,
  confirmation: async () => ({ approved: true }),
});
await session.sendToolResult(result);
```

Use confirmation policies such as `"always"` or `"destructive"` for high-risk voice actions.

## GG bridges

`@kenkaiiii/gg-voice/bridges/ggcoder-rpc` maps the voice bridge command surface to existing `ggcoder rpc` NDJSON commands such as `prompt`, `get_state`, `abort`, `new_session`, and `switch_model`.

`@kenkaiiii/gg-voice/bridges/ggboss` can wrap an in-process `GGBoss.enqueueUserMessage(text)` target or expose a relay-backed `send_to_ggboss` tool.

## Expo and mobile limitations

Expo apps should consume the package root plus their own platform adapters for secure storage, URL opening, microphone capture, audio playback, and WebRTC. Direct realtime WebRTC in React Native generally requires `react-native-webrtc` and a custom dev/EAS build; Expo Go is unlikely to be enough for production speech-to-speech.

Do not import `@kenkaiiii/ggcoder` directly into a phone bundle. Send voice-derived commands through a relay, `ggcoder rpc`, Agent Home style bridge, or a server-side `AgentSession` wrapper.

## Auth modes

Recommended first path:

1. A trusted backend uses an OpenAI API key to create a Realtime client secret or call session.
2. The mobile/web app uses the ephemeral credential or backend SDP exchange.
3. The app sends local device tools and remote GG bridge tools through `gg-voice`.

Experimental Codex auth should remain behind explicit user opt-in and separate imports.
