import { useMemo } from "react";
import { CRITTERS, renderCritterFrame, type CritterDef } from "./critter-sprites";

/**
 * How a popover critter carries itself: hops while busy, stands when idle or
 * done, sits still and dozes while waiting, and tips over when something is
 * wrong. Same poses as the transcript's CritterLine, so a critter means the
 * same thing everywhere.
 */
export type PopCritterPose = "busy" | "idle" | "waiting" | "down";

/** A critter by id; falls back to the first in the roster. */
export function critterById(id: string): CritterDef {
  const found = CRITTERS.find((critter) => critter.id === id) ?? CRITTERS[0];
  if (!found) throw new Error("critter roster is empty");
  return found;
}

/** The little pixel critter that leads a popover row or header. Decorative. */
export function PopCritter({
  critter,
  pose,
  size = 14,
}: {
  critter: CritterDef;
  pose: PopCritterPose;
  size?: number;
}): React.ReactElement {
  const sprite = useMemo(() => renderCritterFrame(critter, 0), [critter]);
  return (
    <span
      className="pop-critter"
      data-pose={pose}
      aria-hidden="true"
      style={{ "--critter-size": `${size}px` } as React.CSSProperties}
    >
      <img src={sprite} alt="" draggable={false} />
    </span>
  );
}
