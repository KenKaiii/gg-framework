/**
 * Strip a single leading UTF-8 byte-order mark (U+FEFF).
 *
 * Windows editors (Notepad, some VS Code configs) prepend a BOM; a BOM before
 * `---` silently breaks frontmatter parsing in skills/agents/commands, and it
 * pollutes instruction-file rendering. Applied at every instruction-file read.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
