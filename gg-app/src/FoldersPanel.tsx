/**
 * The folders added with "Add folder", each with a key to drop it again.
 * Opened by "Remove folder" in the More panel.
 */
export function FoldersPanel({
  roots,
  busy,
  onRemove,
}: {
  roots: readonly string[];
  /** The folder being removed right now, if any. */
  busy: string | null;
  onRemove: (root: string) => void;
}): React.ReactElement {
  if (roots.length === 0) return <p className="deck-note">No folders added.</p>;
  return (
    <ul className="deck-list deck-rows">
      {roots.map((root) => {
        const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
        return (
          <li key={root} className="deck-row">
            <span className="row-main code" title={root}>
              {root}
            </span>
            <span />
            <button
              type="button"
              className="key key-sm"
              aria-label={`Remove ${name}`}
              disabled={busy !== null}
              onClick={() => onRemove(root)}
            >
              Remove
            </button>
          </li>
        );
      })}
    </ul>
  );
}
