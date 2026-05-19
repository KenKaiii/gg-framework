import React, { useEffect, useMemo, useState } from "react";
import { Text, Box } from "ink";
import { ToolUseLoader } from "./ToolUseLoader.js";
import type { ToolGroupItem } from "../App.js";

type ToolGroupTool = ToolGroupItem["tools"][number];

interface SummarySegment {
  text: string;
  bold: boolean;
  /** If set, use this color instead of default text color */
  color?: string;
}

const BLUE = "#60a5fa";

// ── Per-tool group renderers (registry pattern) ──────────

type GroupRenderer = (tools: ToolGroupTool[], allDone: boolean) => SummarySegment[][];

function renderGrepGroup(tools: ToolGroupTool[], allDone: boolean): SummarySegment[][] {
  const n = tools.length;
  return [
    allDone
      ? [
          { text: "Searched", bold: true, color: BLUE },
          { text: " for ", bold: false },
          { text: String(n), bold: true },
          { text: ` pattern${n !== 1 ? "s" : ""}`, bold: false },
        ]
      : [
          { text: "Searching", bold: true, color: BLUE },
          { text: " for ", bold: false },
          { text: String(n), bold: true },
          { text: ` pattern${n !== 1 ? "s" : ""}`, bold: false },
        ],
  ];
}

function renderReadGroup(tools: ToolGroupTool[], allDone: boolean): SummarySegment[][] {
  const paths = tools
    .map((t) => {
      const fp = String(t.args?.file_path ?? "");
      const segs = fp.split("/");
      return segs.length <= 2 ? fp : "\u2026/" + segs.slice(-2).join("/");
    })
    .filter(Boolean);
  const maxPaths = 3;
  const shown = paths.slice(0, maxPaths);
  const extra = paths.length - maxPaths;

  return [
    allDone
      ? [
          { text: "Read ", bold: true, color: BLUE },
          { text: shown.join(", "), bold: false },
          ...(extra > 0 ? [{ text: ` +${extra} more`, bold: false }] : []),
        ]
      : [
          { text: "Reading ", bold: true, color: BLUE },
          { text: shown.join(", "), bold: false },
          ...(extra > 0 ? [{ text: ` +${extra} more`, bold: false }] : []),
        ],
  ];
}

function renderFindGroup(tools: ToolGroupTool[], allDone: boolean): SummarySegment[][] {
  const n = tools.length;
  return [
    allDone
      ? [
          { text: "Found", bold: true, color: BLUE },
          { text: " files for ", bold: false },
          { text: String(n), bold: true },
          { text: ` pattern${n !== 1 ? "s" : ""}`, bold: false },
        ]
      : [
          { text: "Finding", bold: true, color: BLUE },
          { text: " files for ", bold: false },
          { text: String(n), bold: true },
          { text: ` pattern${n !== 1 ? "s" : ""}`, bold: false },
        ],
  ];
}

function renderLsGroup(tools: ToolGroupTool[], allDone: boolean): SummarySegment[][] {
  const n = tools.length;
  return [
    allDone
      ? [
          { text: "Listed", bold: true, color: BLUE },
          { text: " ", bold: false },
          { text: String(n), bold: true },
          { text: ` director${n !== 1 ? "ies" : "y"}`, bold: false },
        ]
      : [
          { text: "Listing", bold: true, color: BLUE },
          { text: " ", bold: false },
          { text: String(n), bold: true },
          { text: ` director${n !== 1 ? "ies" : "y"}`, bold: false },
        ],
  ];
}

/** Registry of group renderers by tool name. Add new entries to support grouping for additional tools. */
const GROUP_RENDERERS: Record<string, GroupRenderer> = {
  grep: renderGrepGroup,
  read: renderReadGroup,
  find: renderFindGroup,
  ls: renderLsGroup,
};

// ── Summary builder ──────────────────────────────────────

function buildGroupSummary(tools: ToolGroupTool[], allDone: boolean): SummarySegment[] {
  // Group tools by name
  const byName: Record<string, ToolGroupTool[]> = {};
  for (const t of tools) {
    (byName[t.name] ??= []).push(t);
  }

  const parts: SummarySegment[][] = [];
  for (const [name, toolsOfType] of Object.entries(byName)) {
    const renderer = GROUP_RENDERERS[name];
    if (renderer) {
      parts.push(...renderer(toolsOfType, allDone));
    }
  }

  if (parts.length === 0) {
    return [{ text: allDone ? "Done" : "Working\u2026", bold: false }];
  }

  // Capitalize first segment
  if (parts[0].length > 0) {
    parts[0][0] = {
      ...parts[0][0],
      text: parts[0][0].text[0].toUpperCase() + parts[0][0].text.slice(1),
    };
  }

  // Join parts with ", "
  const segments: SummarySegment[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) segments.push({ text: ", ", bold: false });
    segments.push(...parts[i]);
  }

  return segments;
}

// ── Components ───────────────────────────────────────────

function SummaryText({ segments }: { segments: SummarySegment[] }) {
  return (
    <>
      {segments.map((seg, i) => (
        <Text key={i} bold={seg.bold} color={seg.color}>
          {seg.text}
        </Text>
      ))}
    </>
  );
}

interface ToolGroupExecutionProps {
  tools: ToolGroupTool[];
}

function useStaticAfter(animateUntil: number | undefined): boolean {
  const [isStatic, setIsStatic] = useState(
    () => animateUntil == null || Date.now() >= animateUntil,
  );

  useEffect(() => {
    if (animateUntil == null) {
      setIsStatic(true);
      return undefined;
    }

    const remainingMs = animateUntil - Date.now();
    if (remainingMs <= 0) {
      setIsStatic(true);
      return undefined;
    }

    setIsStatic(false);
    const timer = setTimeout(() => setIsStatic(true), remainingMs);
    return () => clearTimeout(timer);
  }, [animateUntil]);

  return isStatic;
}

export function ToolGroupExecution({ tools }: ToolGroupExecutionProps) {
  const allDone = tools.every((t) => t.status === "done");
  const hasError = tools.some((t) => t.isError);
  const status = allDone ? (hasError ? "error" : "done") : "running";
  const latestAnimateUntil = Math.max(0, ...tools.map((tool) => tool.animateUntil ?? 0));
  const staticAfterDeadline = useStaticAfter(
    latestAnimateUntil > 0 ? latestAnimateUntil : undefined,
  );
  const staticDisplay = status !== "running" || staticAfterDeadline;

  const segments = useMemo(() => buildGroupSummary(tools, allDone), [tools, allDone]);

  return (
    <Box marginTop={1} flexDirection="row">
      <ToolUseLoader status={status} staticDisplay={staticDisplay} />
      <Text wrap="wrap">
        <SummaryText segments={segments} />
      </Text>
    </Box>
  );
}
