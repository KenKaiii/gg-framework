import { CRITTERS, renderCritterFrame } from "./critter-sprites";

// The footer's "Critters" mark is the builder: GG Goals' workers are the ones
// who build. Built once; the art never changes.
const BUILDER = CRITTERS.find((critter) => critter.id === "builder") ?? CRITTERS[0];
const SRC = BUILDER ? renderCritterFrame(BUILDER, 0) : "";

/** A small critter, beside the footer's Critters model picker. Decorative. */
export function CritterIcon({ size = 18 }: { size?: number }): React.ReactElement {
  return (
    <span className="critter-icon" style={{ width: size, height: size }} aria-hidden="true">
      <img src={SRC} alt="" draggable={false} />
    </span>
  );
}
