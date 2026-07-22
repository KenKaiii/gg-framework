# @kenkaiiii/gg-boss

## 5.22.3

## 5.22.2

## 5.22.1

## 5.22.0

## 5.21.0

## 5.20.5

## 5.20.4

## 5.20.3

## 5.20.2

## 5.20.1

## 5.20.0

## 5.19.6

## 5.19.5

## 5.19.4

## 5.19.3

## 5.19.2

## 5.19.1

## 5.19.0

## 5.18.0

## 5.17.0

## 5.16.0

## 5.15.1

## 5.15.0

## 5.14.0

## 5.13.3

## 5.13.2

## 5.13.1

## 5.13.0

## 5.12.0

## 5.11.0

## 5.10.1

## 5.10.0

## 5.9.7

## 5.9.6

## 5.9.5

## 5.9.4

## 5.9.3

## 5.9.2

## 5.9.1

## 5.9.0

## 5.8.8

## 5.8.7

## 5.8.6

## 5.8.5

## 5.8.4

## 5.8.3

## 5.8.2

## 5.8.1

## 5.8.0

## 5.7.0

## 5.6.3

## 5.6.2

## 5.6.1

## 5.6.0

## 5.5.1

## 5.5.0

## 5.4.3

## 5.4.2

## 5.4.1

## 5.4.0

## 5.3.0

## 5.2.0

## 5.1.2

## 5.1.1

## 5.1.0

## 5.0.0

## 4.15.0

## 4.14.3

## 4.14.2

## 4.14.1

## 4.14.0

## 4.13.3

## 4.13.2

## 4.13.1

## 4.13.0

### Minor Changes

- Update system prompt talk section for ADHD-readable responses

  Rewrite `renderTalkSection()` so every reply leads with the outcome word
  (Fixed/Done/Broken/Failed), enforces bottom-line-first scanning, one idea
  per line, pick-don't-menu, concrete metrics, no unresolved it-depends, and
  affirmative phrasing. Designed for fast scanning and low working memory.

## 4.12.2

### Patch Changes

- Fix Windows sidecar crash: the session-folder name encoder (`encodeCwd`) now strips Windows extended-length path prefixes (`\\?\` and `\\?\UNC\`) and all reserved filename characters (`<>:"|?*`). Previously, Windows canonicalized cwds (`\\?\C:\Users\brams`) produced illegal folder names containing `?`, causing `mkdir` ENOENT and a fatal sidecar crash on startup — blocking OAuth/login for all Windows users.

## 4.12.1

## 4.12.0

### Minor Changes

- Add generate_image tool: generate and edit images via OpenAI gpt-image-2 through the Codex backend. Conditionally registered when OpenAI is connected. Includes inline image preview in transcript, shimmering skeleton placeholder during generation, 1:1 history reconstruction for tool-produced images and sub-agent groups on session resume, and image path exposure for multi-turn editing.

## 4.11.3

## 4.11.2

## 4.11.1

## 4.11.0

## 4.10.2

## 4.10.1

## 4.10.0

### Minor Changes

- Update Kimi to K2.7 (`kimi-k2.7-code`) as the Moonshot default model, replacing Kimi K2.6 across the registry, CLI, login UI, and docs.

  Harden Kimi OAuth token refresh so it no longer silently falls back to a paid Moonshot API key: refresh reuses the existing refresh token when the server doesn't rotate it, tokens are renewed proactively before expiry (60s skew), `baseUrl` is preserved across refreshes, and a genuinely-dead OAuth credential now logs a warning instead of switching billing silently.

## 4.9.1

## 4.9.0

## 4.8.7

## 4.8.6

## 4.8.5

## 4.8.4

## 4.8.3

## 4.8.2

## 4.8.1

## 4.8.0

## 4.7.0

## 4.6.3

## 4.6.2

### Patch Changes

- Fix OpenAI OAuth account switching by adding prompt=login to authorize URL. Previously, re-running `ggcoder login` with OpenAI would silently re-approve the cached browser session, preventing users from switching accounts.

## 4.6.1

## 4.6.0

## 4.5.0

## 4.4.0
