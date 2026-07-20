---
"@kenkaiiii/gg-core": patch
---

Cap each long-lived process at 10 MB of debug-log writes so noisy production paths cannot grow the active log without bound.
