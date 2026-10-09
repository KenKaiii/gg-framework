import path from "node:path";

/** File extension → highlight.js language name (all in lowlight's common set). */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  sh: "bash",
  zsh: "bash",
  bash: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  html: "xml",
  xml: "xml",
  css: "css",
  scss: "scss",
  sql: "sql",
  toml: "ini",
  // No dockerfile grammar in the common set; its RUN lines read well as shell.
  dockerfile: "bash",
};

/** Get language from a file path's extension */
export function langFromPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return EXT_TO_LANG[ext];
}
