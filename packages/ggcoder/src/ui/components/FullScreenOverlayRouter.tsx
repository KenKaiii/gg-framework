import React from "react";
import { PixelOverlay } from "./PixelOverlay.js";
import { PlanOverlay } from "./PlanOverlay.js";
import { SkillsOverlay } from "./SkillsOverlay.js";
import type { PixelEntry } from "../../core/pixel.js";

export type FullScreenOverlayKind = "pixel" | "skills" | "plan";

interface FullScreenOverlayRouterProps {
  overlay: FullScreenOverlayKind | null;
  version: string;
  cwd: string;
  agentRunning: boolean;
  planAutoExpand: boolean;
  onClosePixel: () => void;
  onPixelFixOne: (entry: PixelEntry) => void;
  onPixelFixAll: (entries: PixelEntry[]) => void;
  onCloseSkills: () => void;
  onClosePlan: () => void;
  onApprovePlan: (planPath: string) => void;
  onRejectPlan: (planPath: string, feedback: string) => void;
}

export function FullScreenOverlayRouter({
  overlay,
  version,
  cwd,
  agentRunning,
  planAutoExpand,
  onClosePixel,
  onPixelFixOne,
  onPixelFixAll,
  onCloseSkills,
  onClosePlan,
  onApprovePlan,
  onRejectPlan,
}: FullScreenOverlayRouterProps) {
  if (overlay === "pixel") {
    return (
      <PixelOverlay
        version={version}
        agentRunning={agentRunning}
        onClose={onClosePixel}
        onFixOne={onPixelFixOne}
        onFixAll={onPixelFixAll}
      />
    );
  }

  if (overlay === "skills") {
    return <SkillsOverlay cwd={cwd} onClose={onCloseSkills} />;
  }

  if (overlay === "plan") {
    return (
      <PlanOverlay
        cwd={cwd}
        autoExpandNewest={planAutoExpand}
        onClose={onClosePlan}
        onApprove={onApprovePlan}
        onReject={onRejectPlan}
      />
    );
  }

  return null;
}
