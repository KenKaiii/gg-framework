/**
 * Every file an `edit` call targets, in order, from raw (unvalidated) args.
 * An edit is either single-file (`file_path` + `edits`) or multi-file
 * (`files: [{ file_path, edits }]`). Anything that tracks or displays edited
 * files must use this instead of reading `file_path`, which a multi-file call
 * does not have.
 */
export function editTargetPaths(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  const paths: string[] = [];
  if (typeof args.file_path === "string" && args.file_path) paths.push(args.file_path);
  if (Array.isArray(args.files)) {
    for (const entry of args.files) {
      const filePath = (entry as { file_path?: unknown } | null)?.file_path;
      if (typeof filePath === "string" && filePath) paths.push(filePath);
    }
  }
  return paths;
}

/** One display label for an edit call: the file, or "first +N more" for several. */
export function editTargetLabel(
  args: Record<string, unknown> | undefined,
  format: (filePath: string) => string = (filePath) => filePath,
): string {
  const paths = editTargetPaths(args);
  const [first] = paths;
  if (first === undefined) return "";
  return paths.length === 1 ? format(first) : `${format(first)} +${paths.length - 1} more`;
}
