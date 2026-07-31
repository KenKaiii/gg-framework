---
"@kenkaiiii/ggcoder": patch
---

Forward MCP image content to the model. Tool responses containing `type: "image"` parts (or embedded resources with an image blob) were reduced to their text parts, so an image-only tool such as a screenshot or design-export server returned `(empty response)`.
