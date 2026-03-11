import React, { useState, useEffect, useMemo } from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import type { ActivityPhase } from "../hooks/useAgentLoop.js";

import { SPINNER_FRAMES, SPINNER_INTERVAL } from "../spinner-frames.js";

// ── Color pulse cycle ─────────────────────────────────────

const DARK_PULSE_COLORS = [
  "#60a5fa", // blue
  "#818cf8", // indigo
  "#a78bfa", // violet
  "#818cf8", // indigo (back)
  "#60a5fa", // blue (back)
  "#38bdf8", // sky
  "#60a5fa", // blue (back)
];

const LIGHT_PULSE_COLORS = [
  "#2563eb", // blue
  "#4f46e5", // indigo
  "#7c3aed", // violet
  "#4f46e5", // indigo (back)
  "#2563eb", // blue (back)
  "#0284c7", // sky
  "#2563eb", // blue (back)
];
const PULSE_INTERVAL = 400;

// ── Ellipsis animation ────────────────────────────────────

const ELLIPSIS_FRAMES = ["", ".", "..", "..."];
const ELLIPSIS_INTERVAL = 500;

// ── Phrase rotation ───────────────────────────────────────

const WAITING_PHRASE_INTERVAL = 3000;
const OTHER_PHRASE_INTERVAL = 4000;

const CONTEXTUAL_PHRASES = [
  {
    keywords: /\b(bug|fix|error|issue|broken|crash|fail|wrong)\b/i,
    phrases: [
      "Investigating",
      "Diagnosing",
      "Tracing the issue",
      "Hunting the bug",
      "Analyzing the problem",
      "Narrowing it down",
    ],
  },
  {
    keywords: /\b(refactor|clean|improve|optimize|simplify|restructure)\b/i,
    phrases: [
      "Studying the code",
      "Planning improvements",
      "Mapping dependencies",
      "Finding patterns",
      "Designing the approach",
    ],
  },
  {
    keywords: /\b(test|spec|coverage|assert|expect|describe|it\()\b/i,
    phrases: [
      "Designing tests",
      "Thinking about edge cases",
      "Planning test coverage",
      "Considering scenarios",
    ],
  },
  {
    keywords: /\b(build|deploy|ci|cd|pipeline|docker|config)\b/i,
    phrases: [
      "Checking the config",
      "Analyzing the pipeline",
      "Working through setup",
      "Reviewing the build",
    ],
  },
  {
    keywords: /\b(style|css|ui|layout|design|color|theme|display|render)\b/i,
    phrases: [
      "Visualizing the layout",
      "Crafting the design",
      "Considering the aesthetics",
      "Sketching it out",
      "Polishing the pixels",
    ],
  },
  {
    keywords: /\b(add|create|new|implement|feature|make|build)\b/i,
    phrases: [
      "Architecting",
      "Drafting the approach",
      "Planning the implementation",
      "Mapping it out",
      "Designing the solution",
    ],
  },
  {
    keywords: /\b(explain|how|why|what|understand|describe)\b/i,
    phrases: [
      "Reading through the code",
      "Connecting the dots",
      "Building understanding",
      "Tracing the logic",
      "Piecing it together",
    ],
  },
  {
    keywords: /\b(delete|remove|drop|clean\s*up|prune|trim)\b/i,
    phrases: ["Identifying dead code", "Marking for removal", "Cleaning house", "Pruning the tree"],
  },
  {
    keywords: /\b(move|rename|reorganize|restructure|migrate)\b/i,
    phrases: ["Planning the move", "Mapping the migration", "Tracing dependencies", "Reorganizing"],
  },
  {
    keywords: /\b(fetch|url|http|api|request|web|download|scrape)\b/i,
    phrases: ["Checking the docs", "Looking it up", "Pulling references", "Gathering info"],
  },
  {
    keywords: /\b(debug|log|trace|inspect|breakpoint|stack\s*trace)\b/i,
    phrases: [
      "Following the trail",
      "Inspecting the stack",
      "Chasing the bug",
      "Tracing execution",
      "Zeroing in",
    ],
  },
  {
    keywords: /\b(type|types|interface|generic|typescript|schema)\b/i,
    phrases: [
      "Mapping the types",
      "Checking the signatures",
      "Modeling the data",
      "Tracing the type graph",
    ],
  },
  {
    keywords: /\b(commit|push|pull|merge|rebase|branch|git|pr)\b/i,
    phrases: [
      "Reviewing the history",
      "Checking the diff",
      "Preparing changes",
      "Sorting out the branch",
    ],
  },
  {
    keywords: /\b(install|dependency|package|upgrade|update|version)\b/i,
    phrases: [
      "Checking dependencies",
      "Reviewing versions",
      "Sorting out packages",
      "Mapping the dep tree",
    ],
  },
];

const GENERAL_PHRASES = [
  "Thinking",
  "Reasoning",
  "Processing",
  "Mulling it over",
  "Working on it",
  "Contemplating",
  "Figuring it out",
  "Crunching",
  "Assembling thoughts",
  "Cooking up a plan",
  "Brewing ideas",
  "Spinning up neurons",
  "Loading wisdom",
  "Parsing the universe",
  "Channeling clarity",
];

const THINKING_PHRASES = [
  "Deep in thought",
  "Reasoning",
  "Contemplating",
  "Pondering",
  "Reflecting",
  "Working through it",
  "Analyzing",
  "Deliberating",
];

const GENERATING_PHRASES = [
  "Writing",
  "Composing",
  "Generating",
  "Crafting a response",
  "Drafting",
  "Putting it together",
  "Formulating",
];

const TOOLS_GENERIC = [
  "Running tools",
  "Executing",
  "Working",
  "Processing",
  "Operating",
  "Carrying out tasks",
];

const TOOL_PHRASES: Record<string, string[]> = {
  bash: ["Running a command", "Executing in the shell", "Running a process"],
  read: ["Reading a file", "Scanning the source", "Studying the code"],
  write: ["Writing a file", "Creating a file", "Laying down code"],
  edit: ["Editing a file", "Applying changes", "Patching the code"],
  grep: ["Searching the codebase", "Scanning for matches", "Grepping"],
  find: ["Locating files", "Searching the tree", "Scanning the directory"],
  ls: ["Listing files", "Browsing the directory", "Scanning contents"],
  subagent: ["Dispatching a subagent", "Delegating work", "Spinning up an agent"],
  "web-fetch": ["Fetching from the web", "Pulling a page", "Downloading content"],
  tasks: ["Managing tasks", "Updating the task list", "Organizing work"],
  "task-output": ["Checking task output", "Reading task results"],
  "task-stop": ["Stopping a task", "Halting a running task"],
};

function selectToolPhrases(activeToolNames: string[]): string[] {
  if (activeToolNames.length === 0) return TOOLS_GENERIC;

  const phrases: string[] = [];
  for (const name of activeToolNames) {
    const specific = TOOL_PHRASES[name];
    if (specific) phrases.push(...specific);
  }
  return phrases.length > 0 ? phrases : TOOLS_GENERIC;
}

function selectPhrases(
  phase: ActivityPhase,
  userMessage: string,
  activeToolNames: string[],
): string[] {
  switch (phase) {
    case "thinking":
      return THINKING_PHRASES;
    case "generating":
      return GENERATING_PHRASES;
    case "tools":
      return selectToolPhrases(activeToolNames);
    default: {
      // waiting / idle — use contextual phrases based on user message
      for (const set of CONTEXTUAL_PHRASES) {
        if (set.keywords.test(userMessage)) {
          return [...set.phrases, ...GENERAL_PHRASES.slice(0, 3)];
        }
      }
      return GENERAL_PHRASES;
    }
  }
}

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// ── Formatting helpers ────────────────────────────────────

function formatElapsed(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

function formatTokenCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}

function buildMetaSuffix(
  elapsedMs: number,
  thinkingMs: number,
  isThinking: boolean,
  tokenEstimate: number,
): string {
  const parts: string[] = [];
  parts.push(formatElapsed(elapsedMs));

  if (tokenEstimate > 0) parts.push(`↓ ${formatTokenCount(tokenEstimate)} tokens`);

  if (isThinking) {
    // Live label — always show while thinking, add duration once >= 1s
    parts.push(thinkingMs >= 1000 ? `thinking for ${formatElapsed(thinkingMs)}` : "thinking");
  } else if (thinkingMs >= 1000) {
    // Frozen — past tense with duration
    parts.push(`thought for ${formatElapsed(thinkingMs)}`);
  }

  return parts.join(" · ");
}

// ── Shimmer effect ────────────────────────────────────────

const SHIMMER_WIDTH = 3;
const SHIMMER_INTERVAL = 100;

const ShimmerText: React.FC<{ text: string; color: string; shimmerPos: number }> = ({
  text,
  color,
  shimmerPos,
}) => (
  <Text>
    {text.split("").map((char, i) => {
      const isBright = Math.abs(i - shimmerPos) <= SHIMMER_WIDTH;
      return (
        <Text bold={isBright} color={color} dimColor={!isBright} key={i}>
          {char}
        </Text>
      );
    })}
  </Text>
);

// ── Component ─────────────────────────────────────────────

interface ActivityIndicatorProps {
  phase: ActivityPhase;
  elapsedMs: number;
  thinkingMs: number;
  isThinking: boolean;
  tokenEstimate: number;
  userMessage?: string;
  activeToolNames?: string[];
}

export function ActivityIndicator({
  phase,
  elapsedMs,
  thinkingMs,
  isThinking,
  tokenEstimate,
  userMessage = "",
  activeToolNames = [],
}: ActivityIndicatorProps) {
  const theme = useTheme();

  // Spinner frame
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // Color pulse
  const pulseColors = theme.name === "light" ? LIGHT_PULSE_COLORS : DARK_PULSE_COLORS;
  const [colorFrame, setColorFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setColorFrame((f) => (f + 1) % pulseColors.length);
    }, PULSE_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // Ellipsis
  const [ellipsisFrame, setEllipsisFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setEllipsisFrame((f) => (f + 1) % ELLIPSIS_FRAMES.length);
    }, ELLIPSIS_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // Shimmer position
  const [shimmerPos, setShimmerPos] = useState(-SHIMMER_WIDTH);

  // Phrase rotation — pick phrases based on phase + user message + active tools, shuffle, rotate
  const toolNamesKey = activeToolNames.sort().join(",");
  const phrases = useMemo(
    () => shuffleArray(selectPhrases(phase, userMessage, activeToolNames)),
    [phase, userMessage, toolNamesKey], // activeToolNames captured via stable string key
  );
  const phraseInterval = phase === "waiting" ? WAITING_PHRASE_INTERVAL : OTHER_PHRASE_INTERVAL;
  const [phraseIndex, setPhraseIndex] = useState(0);
  useEffect(() => {
    setPhraseIndex(0);
    const timer = setInterval(() => {
      setPhraseIndex((i) => (i + 1) % phrases.length);
    }, phraseInterval);
    return () => clearInterval(timer);
  }, [phrases, phraseInterval]);

  const spinnerColor = pulseColors[colorFrame];
  const phrase = phrases[phraseIndex % phrases.length] ?? phrases[0];
  const ellipsis = ELLIPSIS_FRAMES[ellipsisFrame];

  // Shimmer animation — wraps across phrase text length
  useEffect(() => {
    setShimmerPos(-SHIMMER_WIDTH);
    const timer = setInterval(() => {
      setShimmerPos((pos) => {
        const max = phrase.length + SHIMMER_WIDTH;
        return pos >= max ? -SHIMMER_WIDTH : pos + 1;
      });
    }, SHIMMER_INTERVAL);
    return () => clearInterval(timer);
  }, [phrase]);

  // Pad ellipsis to prevent text from shifting
  const paddedEllipsis = ellipsis + " ".repeat(3 - ellipsis.length);

  const meta = buildMetaSuffix(elapsedMs, thinkingMs, isThinking, tokenEstimate);

  return (
    <Box>
      <Text color={spinnerColor} bold>
        {SPINNER_FRAMES[spinnerFrame]}{" "}
      </Text>
      <ShimmerText text={phrase} color={spinnerColor} shimmerPos={shimmerPos} />
      <Text color={theme.textDim}>{paddedEllipsis}</Text>
      {meta && (
        <Text color={theme.textDim}>
          {"  ("}
          {meta}
          {")"}
        </Text>
      )}
    </Box>
  );
}
