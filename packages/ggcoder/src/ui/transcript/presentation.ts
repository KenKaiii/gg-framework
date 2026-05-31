import { LANGUAGE_DISPLAY_NAMES } from "../../core/language-detector.js";
import { BLACK_CIRCLE } from "../constants/figures.js";
import { formatDuration } from "../duration-format.js";
import type {
  DurationItem,
  ErrorItem,
  InfoItem,
  ModelTransitionItem,
  PlanEventItem,
  PlanTransitionItem,
  QueuedItem,
  SetupHintItem,
  StepDoneItem,
  StoppedItem,
  StylePackItem,
  TaskItem,
  ThemeTransitionItem,
  UpdateNoticeItem,
} from "../app-items.js";
import { UPDATE_NOTICE_TEXT } from "../app-items.js";

export interface StatusPresentation {
  glyph: string;
  text: string;
  label?: string;
  detail?: string;
  bold: boolean;
  muted?: boolean;
}

export interface StylePackPresentation {
  headerLabel: string;
  names: string;
  showSetupHint: boolean;
  setupHint: string;
}

export interface SetupHintPresentation {
  headerLabel: string;
  body: string;
  setupHint: string;
}

export interface ErrorPresentation {
  glyph: string;
  headline: string;
  message?: string;
  guidance: string;
}

export interface QueuedPresentation {
  glyph: string;
  label: string;
  text: string;
  suffix: string;
}

export interface UpdateNoticePresentation {
  text: string;
}

export interface StepDonePresentation {
  glyph: string;
  text: string;
  description?: string;
}

export interface DurationPresentation {
  glyph: string;
  text: string;
}

export function normalizeTranscriptStatusText(text: string): string {
  return text.replace(/\\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

export function presentStylePack(item: StylePackItem): StylePackPresentation {
  return {
    headerLabel: item.added.length > 1 ? "STYLE PACKS ACTIVE" : "STYLE PACK ACTIVE",
    names: item.added.map((id) => LANGUAGE_DISPLAY_NAMES[id] ?? id).join(", "),
    showSetupHint: item.showSetupHint,
    setupHint: " to audit this project against the active pack(s)",
  };
}

export function presentSetupHint(_item?: SetupHintItem): SetupHintPresentation {
  return {
    headerLabel: "NO STYLE PACKS DETECTED",
    body: "This directory has no recognized language manifest at its root.",
    setupHint: " to audit project hygiene or bootstrap a new project from scratch",
  };
}

export function presentError(item: ErrorItem): ErrorPresentation {
  return {
    glyph: "✗ ",
    headline: item.headline,
    message: item.message && item.message !== item.headline ? item.message : undefined,
    guidance: `→ ${item.guidance}`,
  };
}

export function presentInfo(item: InfoItem): StatusPresentation {
  return { glyph: "○ ", text: normalizeTranscriptStatusText(item.text), bold: false, muted: true };
}

export function presentTask(item: TaskItem): StatusPresentation {
  return { glyph: "▸ ", label: "Task: ", text: item.title, bold: true };
}

export function presentPlanTransition(item: PlanTransitionItem): StatusPresentation {
  return { glyph: `${BLACK_CIRCLE} `, text: normalizeTranscriptStatusText(item.text), bold: true };
}

export function presentModelTransition(item: ModelTransitionItem): StatusPresentation {
  return { glyph: "▸ ", label: "Switched to ", text: item.modelName, bold: true };
}

export function presentThemeTransition(item: ThemeTransitionItem): StatusPresentation {
  return { glyph: "◐ ", label: "Theme switched to ", text: item.themeName, bold: true };
}

export function presentPlanEvent(item: PlanEventItem): StatusPresentation {
  const labels = {
    approved: "Plan approved",
    rejected: "Plan rejected",
    dismissed: "Plan dismissed",
  } satisfies Record<PlanEventItem["event"], string>;
  return {
    glyph: "○ ",
    text: labels[item.event],
    detail: item.detail ? ` — "${item.detail}"` : undefined,
    bold: true,
  };
}

export function presentStopped(item: StoppedItem): StatusPresentation {
  return { glyph: "⊘ ", text: normalizeTranscriptStatusText(item.text), bold: true };
}

export function presentQueued(item: QueuedItem): QueuedPresentation {
  return {
    glyph: "• ",
    label: "Queued: ",
    text: item.text || "(empty)",
    suffix: item.imageCount ? ` (+${item.imageCount} image${item.imageCount > 1 ? "s" : ""})` : "",
  };
}

export function presentUpdateNotice(_item?: UpdateNoticeItem): UpdateNoticePresentation {
  return { text: UPDATE_NOTICE_TEXT };
}

export function presentStepDone(item: StepDoneItem): StepDonePresentation {
  return {
    glyph: "✓ ",
    text: `Step ${item.stepNum} done`,
    description: item.description ? ` — ${item.description}` : undefined,
  };
}

export function presentDuration(item: DurationItem): DurationPresentation {
  return { glyph: "✻ ", text: `${item.verb} ${formatDuration(item.durationMs)}` };
}
