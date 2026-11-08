---
"@kleio/core": patch
---

Timeouts imported selectively from upstream releases after 5.66.2. The engine base stays 5.66.2; `UPSTREAM.md` lists the upstream commits.

- OAuth token requests (Anthropic, Gemini, Kimi, OpenAI and xAI) give up after 30 seconds, so a request that never answers no longer holds the auth file lock.
- Telegram's long poll and Bot API calls are bounded, stop at once, and back off after an HTTP error instead of re-polling in a tight loop. Voice transcription requests are bounded too.
