import React, { useMemo } from "react";
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

function buildGroupSummary(tools: ToolGroupTool[], allDone: boolean): SummarySegment[] {
  const counts: Record<string, number> = {};
  for (const t of tools) {
    counts[t.name] = (counts[t.name] ?? 0) + 1;
  }

  const parts: SummarySegment[][] = [];

  const BLUE = "#60a5fa";

  if (counts.grep) {
    const n = counts.grep;
    parts.push(
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
    );
  }
  if (counts.read) {
    // Show abbreviated file paths instead of just counts
    const readTools = tools.filter((t) => t.name === "read");
    const paths = readTools
      .map((t) => {
        const fp = String(t.args?.file_path ?? "");
        const segs = fp.split("/");
        return segs.length <= 2 ? fp : "…/" + segs.slice(-2).join("/");
      })
      .filter(Boolean);
    const maxPaths = 3;
    const shown = paths.slice(0, maxPaths);
    const extra = paths.length - maxPaths;

    parts.push(
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
    );
  }
  if (counts.find) {
    const n = counts.find;
    parts.push(
      allDone
        ? [
            { text: "found", bold: true, color: BLUE },
            { text: " files for ", bold: false },
            { text: String(n), bold: true },
            { text: ` pattern${n !== 1 ? "s" : ""}`, bold: false },
          ]
        : [
            { text: "finding", bold: true, color: BLUE },
            { text: " files for ", bold: false },
            { text: String(n), bold: true },
            { text: ` pattern${n !== 1 ? "s" : ""}`, bold: false },
          ],
    );
  }
  if (counts.ls) {
    const n = counts.ls;
    parts.push(
      allDone
        ? [
            { text: "listed", bold: true, color: BLUE },
            { text: " ", bold: false },
            { text: String(n), bold: true },
            { text: ` director${n !== 1 ? "ies" : "y"}`, bold: false },
          ]
        : [
            { text: "listing", bold: true, color: BLUE },
            { text: " ", bold: false },
            { text: String(n), bold: true },
            { text: ` director${n !== 1 ? "ies" : "y"}`, bold: false },
          ],
    );
  }

  if (parts.length === 0) {
    return [{ text: allDone ? "Done" : "Working…", bold: false }];
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

export function ToolGroupExecution({ tools }: { tools: ToolGroupTool[] }) {
  const allDone = tools.every((t) => t.status === "done");
  const doneCount = tools.filter((t) => t.status === "done").length;
  const toolNames = tools.map((t) => t.name).join(",");
  const segments = useMemo(
    () => buildGroupSummary(tools, allDone),
    // Re-compute when tool composition or completion status changes
    [toolNames, doneCount, allDone],
  );

  if (!allDone) {
    return (
      <Box marginTop={1} flexDirection="row">
        <ToolUseLoader status="running" />
        <Text wrap="wrap">
          <SummaryText segments={segments} />
        </Text>
      </Box>
    );
  }

  return (
    <Box marginTop={1} flexDirection="row" flexShrink={1}>
      <ToolUseLoader status="done" />
      <Text wrap="wrap">
        <SummaryText segments={segments} />
      </Text>
    </Box>
  );
}
