import { useEffect, useRef } from "react";
import { CritterBackdrop } from "./CritterBackdrop";
import { createCritterFloor, type CritterFloorController, type FloorAgent } from "./critter-floor";
import { CritterTerrain } from "./CritterTerrain";
import { TERRAIN_CLOSE_MS, TERRAIN_LAND_MS } from "./critter-terrain";
import type { StageOptions } from "./critter-types";
import { displayName, formatSubAgentTokens, type SubAgentLine } from "./SubAgentFeed";
import { useRandomBiome } from "./use-random-biome";

/** The transcript's sub-agent groups, as far as the floor cares. */
export interface CritterGroup {
  readonly id: number;
  readonly agents: readonly SubAgentLine[];
  readonly aborted?: boolean;
}

function floorStatus(agent: SubAgentLine, aborted: boolean): FloorAgent["status"] {
  switch (agent.status) {
    case "starting":
    case "running":
      return aborted ? "interrupted" : "running";
    default:
      return agent.status;
  }
}

/**
 * Flatten the transcript's sub-agent groups into the floor's agent list. Keys
 * carry the group id because resumed history rows reuse positional ids.
 */
export function collectFloorAgents(groups: readonly CritterGroup[]): FloorAgent[] {
  return groups.flatMap((group) =>
    group.agents.map((agent, index): FloorAgent => ({
      key: `${group.id}:${agent.toolCallId}`,
      agentName: agent.agentName,
      label: displayName(agent, index),
      status: floorStatus(agent, group.aborted === true),
      activity: agent.activities[agent.activities.length - 1],
      tokens: formatSubAgentTokens(agent.tokenUsage),
      durationMs: agent.durationMs,
      toolUseCount: agent.toolUseCount,
    })),
  );
}

interface Props {
  /** Every sub-agent group in the transcript, oldest first. */
  groups: readonly CritterGroup[];
  /** Injected for tests; defaults to Math.random. */
  random?: () => number;
  /** How the stage plays this floor (read once, when the floor is built). */
  stage?: StageOptions;
}

const sameGroups = (a: readonly CritterGroup[], b: readonly CritterGroup[]): boolean =>
  a.length === b.length && a.every((group, i) => group === b[i]);

/**
 * The lane sub-agent critters walk in, sitting on top of the pinned live region
 * (its bottom edge is the tool panel's / activity bar's top border). It is 0px
 * tall when nobody is out and eases open when the first critter is summoned,
 * which shrinks the transcript so the chat slides up instead of being covered;
 * the transcript's resize observer keeps the newest message pinned meanwhile.
 * The critters stand on a pixel terrain (meadow, beach, desert…), a fresh random
 * one each time the lane opens: it rises out of the floor, the first critter
 * arrives once the ground is up, and it sinks back after the last one leaves.
 *
 * Decorative: the chat line and the activity bar carry the same information
 * for assistive tech, so the lane is hidden from it.
 */
export function CritterFloor({ groups, random = Math.random, stage }: Props): React.ReactElement {
  const laneRef = useRef<HTMLDivElement>(null);
  // rerollBiome is stable, so the floor below is still created only once.
  const [biome, rerollBiome] = useRandomBiome(random);
  // The first opening keeps the terrain picked on mount.
  const openedRef = useRef(false);
  const controllerRef = useRef<CritterFloorController | null>(null);
  const syncedRef = useRef<readonly CritterGroup[] | null>(null);
  // The critters out on the floor. Kept here, not in the floor: when the chat
  // is hidden behind another view (a goal's Workers) its effects are torn
  // down and the floor rebuilt on return; those critters come straight back
  // instead of being summoned all over again.
  const hereRef = useRef<Set<string>>(new Set());
  const stageRef = useRef(stage);

  useEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const controller = createCritterFloor(lane, {
      reducedMotion,
      landAfterMs: TERRAIN_LAND_MS,
      closeAfterMs: TERRAIN_CLOSE_MS,
      stage: stageRef.current,
      onLaneOpen: () => {
        if (openedRef.current) rerollBiome();
        openedRef.current = true;
      },
      wasHere: (key) => hereRef.current.has(key),
      onPresence: (key, here) => {
        if (here) hereRef.current.add(key);
        else hereRef.current.delete(key);
      },
    });
    controllerRef.current = controller;
    return () => {
      controller.destroy();
      controllerRef.current = null;
      syncedRef.current = null;
    };
  }, [rerollBiome]);

  // The transcript re-renders on every streamed token, but group objects only
  // change identity when an agent actually changes (items update immutably),
  // so an element-wise identity check keeps the floor out of the token stream.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    const previous = syncedRef.current;
    if (previous && sameGroups(previous, groups)) return;
    syncedRef.current = groups;
    controller.sync(collectFloorAgents(groups));
  }, [groups]);

  // The horizon and the terrain come first, so the floor the engine appends
  // after them (the critters) paints on top.
  return (
    <div className="critter-lane with-terrain" ref={laneRef} aria-hidden="true">
      <CritterBackdrop biome={biome} />
      <CritterTerrain biome={biome} />
    </div>
  );
}
