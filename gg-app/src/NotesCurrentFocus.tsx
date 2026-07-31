import type { RefObject } from "react";

interface Props {
  value: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange(value: string): void;
}

export function NotesCurrentFocus({ value, inputRef, onChange }: Props): React.ReactElement {
  return (
    <div className="notes-field notes-current-focus">
      <label htmlFor="notes-current-focus">Current focus</label>
      <input
        ref={inputRef}
        id="notes-current-focus"
        value={value}
        placeholder="What matters right now?"
        onChange={(event) => onChange(event.target.value)}
        spellCheck={true}
      />
    </div>
  );
}
