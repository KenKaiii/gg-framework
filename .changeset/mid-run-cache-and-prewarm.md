---
"@kenkaiiii/gg-ai": patch
"@kenkaiiii/ggcoder": patch
---

Stop three prompt-cache rewrites in long sessions. A message sent while the agent is still working (your own steering, or the agent's completion-gate, re-grounding, stream-recovery and review nudges) now continues the run instead of starting a new turn, so the run's reasoning is kept and its cached history is reused instead of re-sent. Cache prewarm now applies the stale tool-output prune the next request would make, and skips warming when that request (or a post-turn compaction) is going to compact anyway, so it no longer writes a whole history that is discarded on the very next request. On 5-minute cache routes, pruning old tool output now leaves a cache breakpoint at the point the prune made stable (new `Message.cacheAnchor` hint in gg-ai), so the next prune re-sends only what follows it instead of the whole conversation; 1-hour routes keep their existing breakpoints.
