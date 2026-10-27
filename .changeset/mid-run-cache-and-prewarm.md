---
"@kenkaiiii/gg-ai": patch
"@kenkaiiii/ggcoder": patch
---

Stop three prompt-cache rewrites in long sessions. A message sent while the agent is still working (your own steering, or the agent's completion-gate, re-grounding and review nudges) now continues the run instead of starting a new turn, so the run's reasoning is kept and its cached history is reused instead of re-sent. Cache prewarm now applies the stale tool-output prune the next request would make, and skips warming when that request is going to compact anyway, so it no longer writes a whole history that is discarded on the very next request. After pruning old tool output, the long-lived cache breakpoint now moves to the point the prune made stable (new `Message.cacheAnchor` hint in gg-ai), so the next prune re-sends only what follows it instead of the whole run.
