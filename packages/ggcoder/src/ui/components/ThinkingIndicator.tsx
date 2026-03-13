import React, { useState, useEffect, useMemo } from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";

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

const PHRASE_INTERVAL = 3000;

interface PhraseSet {
  keywords: RegExp;
  phrases: string[];
}

const CONTEXTUAL_PHRASES: PhraseSet[] = [
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

function selectPhrases(userMessage: string): string[] {
  for (const set of CONTEXTUAL_PHRASES) {
    if (set.keywords.test(userMessage)) {
      return [...set.phrases, ...GENERAL_PHRASES.slice(0, 3)];
    }
  }
  return GENERAL_PHRASES;
}

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// ── Component ─────────────────────────────────────────────

interface ThinkingIndicatorProps {
  userMessage?: string;
}

export function ThinkingIndicator({ userMessage = "" }: ThinkingIndicatorProps) {
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

  // Phrase rotation — pick phrases based on user message, shuffle, rotate
  const phrases = useMemo(() => shuffleArray(selectPhrases(userMessage)), [userMessage]);
  const [phraseIndex, setPhraseIndex] = useState(0);
  useEffect(() => {
    setPhraseIndex(0);
    const timer = setInterval(() => {
      setPhraseIndex((i) => (i + 1) % phrases.length);
    }, PHRASE_INTERVAL);
    return () => clearInterval(timer);
  }, [phrases]);

  const spinnerColor = pulseColors[colorFrame];
  const phrase = phrases[phraseIndex];
  const ellipsis = ELLIPSIS_FRAMES[ellipsisFrame];
  // Pad ellipsis to prevent text from shifting
  const paddedEllipsis = ellipsis + " ".repeat(3 - ellipsis.length);

  return (
    <Box>
      <Text color={spinnerColor} bold>
        {SPINNER_FRAMES[spinnerFrame]}{" "}
      </Text>
      <Text color={spinnerColor} bold>
        {phrase}
      </Text>
      <Text color={theme.textDim}>{paddedEllipsis}</Text>
    </Box>
  );
}
