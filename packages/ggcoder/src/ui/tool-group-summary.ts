export interface ToolGroupSummaryTool {
  name: string;
  args: Record<string, unknown>;
  status: "running" | "done";
  isError?: boolean;
  result?: string;
}

export interface SummarySegment {
  text: string;
  bold: boolean;
  /** Semantic tool tone. Resolved to theme colors by each renderer. */
  tone?: "read" | "search" | "write" | "run" | "web" | "agent" | "state" | "source" | "default";
}

type GroupRenderer = (
  tools: readonly ToolGroupSummaryTool[],
  allDone: boolean,
) => SummarySegment[][];

const MAX_DETAIL_ITEMS = 2;
const MAX_DETAIL_LENGTH = 28;
const MAX_LONG_DETAIL_LENGTH = 20;

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

function shortenValue(value: string, maxLength = MAX_DETAIL_LENGTH): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;

  const dottedPathParts = normalized.split(".").filter(Boolean);
  if (dottedPathParts.length > 1) {
    const tail = dottedPathParts.at(-1) ?? "";
    const headBudget = maxLength - tail.length - 1;
    if (headBudget >= 4) return `${normalized.slice(0, headBudget)}…${tail}`;
  }

  const pathParts = normalized.split("/").filter(Boolean);
  if (pathParts.length > 1) {
    const tail = pathParts.at(-1) ?? "";
    if (tail.length <= maxLength - 1) return `…${tail}`;
  }

  const camelTokens = normalized.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g);
  if (camelTokens && camelTokens.length > 1) {
    const first = camelTokens[0] ?? "";
    const last = camelTokens.at(-1) ?? "";
    const compact = `${first}…${last}`;
    if (compact.length <= maxLength) return compact;
  }

  const headLength = Math.ceil((maxLength - 1) * 0.62);
  const tailLength = maxLength - 1 - headLength;
  return `${normalized.slice(0, headLength)}…${normalized.slice(-tailLength)}`;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed.split("/").filter(Boolean).at(-1) ?? trimmed;
}

function uniqueValues(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function detailSuffix(
  values: readonly string[],
  options: { quote?: boolean; maxLength?: number } = {},
): string {
  const unique = uniqueValues(values);
  if (unique.length === 0) return "";
  const visible = unique.slice(0, MAX_DETAIL_ITEMS).map((value) => {
    const shortened = shortenValue(value, options.maxLength ?? MAX_DETAIL_LENGTH);
    return options.quote ? `"${shortened}"` : shortened;
  });
  const hiddenCount = unique.length - visible.length;
  return `: ${visible.join(", ")}${hiddenCount > 0 ? `, +${hiddenCount}` : ""}`;
}

function renderGrepGroup(
  tools: readonly ToolGroupSummaryTool[],
  allDone: boolean,
): SummarySegment[][] {
  const count = tools.length;
  return [
    allDone
      ? [
          { text: "Searched", bold: true, tone: "search" },
          { text: " for ", bold: false },
          { text: String(count), bold: true, tone: "search" },
          {
            text: ` ${plural(count, "pattern")}${detailSuffix(
              tools.map((tool) => String(tool.args.pattern ?? "")),
              { quote: true },
            )}`,
            bold: false,
          },
        ]
      : [
          { text: "Searching", bold: true, tone: "search" },
          { text: " for ", bold: false },
          { text: String(count), bold: true, tone: "search" },
          {
            text: ` ${plural(count, "pattern")}${detailSuffix(
              tools.map((tool) => String(tool.args.pattern ?? "")),
              { quote: true },
            )}`,
            bold: false,
          },
        ],
  ];
}

function renderReadGroup(
  tools: readonly ToolGroupSummaryTool[],
  allDone: boolean,
): SummarySegment[][] {
  const count = tools.filter((tool) => String(tool.args.file_path ?? "").length > 0).length;
  const fileCount = count || tools.length;
  return [
    allDone
      ? [
          { text: "Read", bold: true, tone: "read" },
          { text: " ", bold: false },
          { text: String(fileCount), bold: true, tone: "read" },
          {
            text: ` ${plural(fileCount, "file")}${detailSuffix(tools.map((tool) => basename(String(tool.args.file_path ?? ""))))}`,
            bold: false,
          },
        ]
      : [
          { text: "Reading", bold: true, tone: "read" },
          { text: " ", bold: false },
          { text: String(fileCount), bold: true, tone: "read" },
          {
            text: ` ${plural(fileCount, "file")}${detailSuffix(tools.map((tool) => basename(String(tool.args.file_path ?? ""))))}`,
            bold: false,
          },
        ],
  ];
}

function renderFindGroup(
  tools: readonly ToolGroupSummaryTool[],
  allDone: boolean,
): SummarySegment[][] {
  const count = tools.length;
  return [
    allDone
      ? [
          { text: "Found", bold: true, tone: "search" },
          { text: " files for ", bold: false },
          { text: String(count), bold: true, tone: "search" },
          {
            text: ` ${plural(count, "pattern")}${detailSuffix(
              tools.map((tool) => String(tool.args.pattern ?? "")),
              { quote: true },
            )}`,
            bold: false,
          },
        ]
      : [
          { text: "Finding", bold: true, tone: "search" },
          { text: " files for ", bold: false },
          { text: String(count), bold: true, tone: "search" },
          {
            text: ` ${plural(count, "pattern")}${detailSuffix(
              tools.map((tool) => String(tool.args.pattern ?? "")),
              { quote: true },
            )}`,
            bold: false,
          },
        ],
  ];
}

function renderLsGroup(
  tools: readonly ToolGroupSummaryTool[],
  allDone: boolean,
): SummarySegment[][] {
  const count = tools.length;
  return [
    allDone
      ? [
          { text: "Listed", bold: true, tone: "read" },
          { text: " ", bold: false },
          { text: String(count), bold: true, tone: "read" },
          {
            text: ` ${plural(count, "directory", "directories")}${detailSuffix(
              tools.map((tool) => String(tool.args.path ?? ".")),
              { maxLength: MAX_LONG_DETAIL_LENGTH },
            )}`,
            bold: false,
          },
        ]
      : [
          { text: "Listing", bold: true, tone: "read" },
          { text: " ", bold: false },
          { text: String(count), bold: true, tone: "read" },
          {
            text: ` ${plural(count, "directory", "directories")}${detailSuffix(
              tools.map((tool) => String(tool.args.path ?? ".")),
              { maxLength: MAX_LONG_DETAIL_LENGTH },
            )}`,
            bold: false,
          },
        ],
  ];
}

function renderKencodeQueryGroup(
  tools: readonly ToolGroupSummaryTool[],
  allDone: boolean,
  labels: { running: string; done: string },
): SummarySegment[][] {
  const count = tools.length;
  return [
    [
      { text: allDone ? labels.done : labels.running, bold: true, tone: "web" },
      { text: " with ", bold: false },
      { text: String(count), bold: true, tone: "web" },
      {
        text: ` ${plural(count, "query", "queries")}${detailSuffix(
          tools.map((tool) =>
            String(tool.args.query ?? tool.args.domain ?? tool.args.category ?? ""),
          ),
          { quote: true, maxLength: MAX_LONG_DETAIL_LENGTH },
        )}`,
        bold: false,
      },
    ],
  ];
}

function renderSearchCodeGroup(
  tools: readonly ToolGroupSummaryTool[],
  allDone: boolean,
): SummarySegment[][] {
  return renderKencodeQueryGroup(tools, allDone, {
    running: "Searching code",
    done: "Searched code",
  });
}

function renderReferenceSourcesGroup(
  tools: readonly ToolGroupSummaryTool[],
  allDone: boolean,
): SummarySegment[][] {
  return renderKencodeQueryGroup(tools, allDone, {
    running: "Finding references",
    done: "Found references",
  });
}

function renderDiscoverReposGroup(
  tools: readonly ToolGroupSummaryTool[],
  allDone: boolean,
): SummarySegment[][] {
  return renderKencodeQueryGroup(tools, allDone, {
    running: "Discovering repos",
    done: "Discovered repos",
  });
}

/** Registry of group renderers by tool name. Add entries to support new grouped summaries. */
const GROUP_RENDERERS: Record<string, GroupRenderer> = {
  grep: renderGrepGroup,
  read: renderReadGroup,
  find: renderFindGroup,
  ls: renderLsGroup,
  "mcp__kencode-search__searchCode": renderSearchCodeGroup,
  "mcp__kencode-search__referenceSources": renderReferenceSourcesGroup,
  "mcp__kencode-search__discoverRepos": renderDiscoverReposGroup,
};

export function buildToolGroupSummary(
  tools: readonly ToolGroupSummaryTool[],
  allDone: boolean,
): SummarySegment[] {
  const byName: Record<string, ToolGroupSummaryTool[]> = {};
  for (const tool of tools) {
    (byName[tool.name] ??= []).push(tool);
  }

  const parts: SummarySegment[][] = [];
  for (const [name, toolsOfType] of Object.entries(byName)) {
    const renderer = GROUP_RENDERERS[name];
    if (renderer) {
      parts.push(...renderer(toolsOfType, allDone));
    }
  }

  if (parts.length === 0) {
    return [{ text: allDone ? "Done" : "Working…", bold: false }];
  }

  const firstPart = parts[0];
  if (firstPart && firstPart.length > 0) {
    const firstSegment = firstPart[0];
    if (firstSegment) {
      firstPart[0] = {
        ...firstSegment,
        text: firstSegment.text[0]?.toUpperCase() + firstSegment.text.slice(1),
      };
    }
  }

  const segments: SummarySegment[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (i > 0) segments.push({ text: ", ", bold: false });
    segments.push(...part);
  }

  return segments;
}

export function segmentsToPlainText(segments: readonly SummarySegment[]): string {
  return segments.map((segment) => segment.text).join("");
}
