# @kenkaiiii/ggcoder

## 4.6.1

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.1
  - @kenkaiiii/gg-agent@4.6.1
  - @kenkaiiii/gg-core@4.6.1

## 4.6.0

### Minor Changes

- Add Xiaomi MiMo-V2.5 models with native video analysis. The text-only
  `mimo-v2.5-pro` is now the Xiaomi default, and the omnimodal `mimo-v2.5`
  supports native image and video understanding. Video read through the read
  tool is now delivered to MiMo (and other non-Moonshot OpenAI-compatible video
  models) in a follow-up user message as inline base64 `video_url`, the shape
  the API accepts — fixing the fallback where the model resorted to ffmpeg frame
  extraction. The read tool is also rebuilt on model switch so its video
  capability tracks the active model.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.0
  - @kenkaiiii/gg-agent@4.6.0
  - @kenkaiiii/gg-core@4.6.0

## 4.5.0

### Minor Changes

- Add native video analysis for Kimi K2.6, Gemini, and MiniMax. Attached and read videos are sent to the model in its required format (Kimi file-service upload, Gemini inlineData, MiniMax base64), with per-model size caps and automatic ffmpeg compression for oversized clips. Non-video models now show a clean "this model can't analyze video" message instead of an opaque provider error, and Kimi OAuth login was fixed to pass the coding-endpoint client identity.

### Patch Changes

- @kenkaiiii/gg-ai@4.5.0
- @kenkaiiii/gg-agent@4.5.0
- @kenkaiiii/gg-core@4.5.0

## 4.4.0

### Patch Changes

- Updated dependencies [9e381ad]
  - @kenkaiiii/gg-core@4.4.0
  - @kenkaiiii/gg-ai@4.4.0
  - @kenkaiiii/gg-agent@4.4.0
