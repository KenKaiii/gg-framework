import { MOTION_STARTERS } from "./motion-starters";
import { theme } from "./theme";

export function MotionStarters({
  onPick,
}: {
  onPick: (prompt: string) => void;
}): React.ReactElement {
  return (
    <div className="motion-starters" role="group" aria-label="Video ideas to start from">
      {MOTION_STARTERS.map((starter) => (
        <button
          key={starter.label}
          type="button"
          className="btn btn-sm btn-ghost motion-starter"
          style={{ color: theme.text }}
          title={starter.hint}
          onClick={() => onPick(starter.prompt)}
        >
          {starter.label}
        </button>
      ))}
    </div>
  );
}
