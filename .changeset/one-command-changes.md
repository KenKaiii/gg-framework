---
"@kenkaiiii/ggcoder": patch
---

Faster code changes: when a POSIX `bash` is available, the prompt now asks for each change in one command that writes only what's new (heredoc for a small file, an asserted replace for a few lines of a bigger one, appended tests) and ends with the test command. It replaces the "prefer edit over write" line and the scripted-edit rule; without bash, or under the cmd.exe fallback, those stay. The Environment section also lists the project's files once per session (shallowest 60, from `git ls-files`), so the first call reads the right files instead of listing them. On Claude Haiku 5.5 this ran the benchmark suite about 21% faster on about 19% less usage, with no whole-file rewrites of a one-line fix in a 700-line file.
