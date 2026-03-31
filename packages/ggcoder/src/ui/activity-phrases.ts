import type { ActivityPhase } from "./hooks/useAgentLoop.js";

// ── Phrase lists ────────────────────────────────────────────

const CONTEXTUAL_PHRASES = [
  {
    keywords: /\b(bug|fix|error|issue|broken|crash|fail|wrong)\b/i,
    phrases: [
      "Sleuthing",
      "Autopsying",
      "Exorcising",
      "Defenestrating",
      "Interrogating",
      "Lobotomizing",
    ],
  },
  {
    keywords: /\b(refactor|clean|improve|optimize|simplify|restructure)\b/i,
    phrases: ["Feng-shuiing", "Decluttering", "Liposuctioning", "Tidying", "Unboggling"],
  },
  {
    keywords: /\b(test|spec|coverage|assert|expect|describe|it\()\b/i,
    phrases: ["Hypothesizing", "Stress-testing", "Poking", "Prodding"],
  },
  {
    keywords: /\b(build|deploy|ci|cd|pipeline|docker|config)\b/i,
    phrases: ["Plumbing", "Wrenching", "Scaffolding", "Riveting"],
  },
  {
    keywords: /\b(style|css|ui|layout|design|color|theme|display|render)\b/i,
    phrases: ["Bedazzling", "Glamorizing", "Primping", "Beautifying", "Razzle-dazzling"],
  },
  {
    keywords: /\b(add|create|new|implement|feature|make|build)\b/i,
    phrases: ["Conjuring", "Manifesting", "Birthing", "Forging", "Concocting"],
  },
  {
    keywords: /\b(explain|how|why|what|understand|describe)\b/i,
    phrases: ["Deciphering", "Unraveling", "Demystifying", "Philosophizing", "Pontificating"],
  },
  {
    keywords: /\b(delete|remove|drop|clean\s*up|prune|trim)\b/i,
    phrases: ["Obliterating", "Yeeting", "Vaporizing", "Annihilating"],
  },
  {
    keywords: /\b(move|rename|reorganize|restructure|migrate)\b/i,
    phrases: ["Teleporting", "Transmogrifying", "Shuffleboarding", "Rearranging"],
  },
  {
    keywords: /\b(fetch|url|http|api|request|web|download|scrape)\b/i,
    phrases: ["Spelunking", "Foraging", "Scavenging", "Pilfering"],
  },
  {
    keywords: /\b(debug|log|trace|inspect|breakpoint|stack\s*trace)\b/i,
    phrases: ["Snooping", "Wiretapping", "Surveilling", "Bloodhounding", "Magnifying"],
  },
  {
    keywords: /\b(type|types|interface|generic|typescript|schema)\b/i,
    phrases: ["Taxonomizing", "Cataloguing", "Classifying", "Pigeonholing"],
  },
  {
    keywords: /\b(commit|push|pull|merge|rebase|branch|git|pr)\b/i,
    phrases: ["Bookkeeping", "Chronicling", "Timestamping", "Rubberstamping"],
  },
  {
    keywords: /\b(install|dependency|package|upgrade|update|version)\b/i,
    phrases: ["Stockpiling", "Hoarding", "Wrangling", "Rummaging"],
  },
];

export const PLANNING_PHRASES = [
  "Scheming",
  "Cartographing",
  "Blueprinting",
  "Masterminding",
  "Strategizing",
  "Machinating",
  "Plotting",
];

export const GENERAL_PHRASES = [
  "Cogitating",
  "Ruminating",
  "Percolating",
  "Noodling",
  "Discombobulating",
  "Brainstorming",
  "Marinating",
  "Simmering",
  "Fermenting",
  "Perambulating",
  "Gesticulating",
  "Hallucinating",
  "Pontificating",
  "Amalgamating",
  "Confabulating",
];

export const THINKING_PHRASES = [
  "Cogitating",
  "Ruminating",
  "Meditating",
  "Brooding",
  "Noodling",
  "Percolating",
  "Musing",
  "Wool-gathering",
];

export const GENERATING_PHRASES = [
  "Scribbling",
  "Regurgitating",
  "Channeling",
  "Materializing",
  "Distilling",
  "Secreting",
  "Extruding",
];

export const TOOLS_GENERIC = [
  "Tinkering",
  "Fiddling",
  "Puttering",
  "Rummaging",
  "Monkeywrenching",
  "Gadgeteering",
];

export const TOOL_PHRASES: Record<string, string[]> = {
  bash: ["Incantating", "Summoning", "Invoking"],
  read: ["Absorbing", "Devouring", "Scrutinizing"],
  write: ["Inscribing", "Etching", "Chiseling"],
  edit: ["Surgifying", "Transplanting", "Frankensteining"],
  grep: ["Rummaging", "Sifting", "Bloodhounding"],
  find: ["Dowsing", "Spelunking", "Sniffing"],
  ls: ["Cataloguing", "Inventorying", "Surveying"],
  subagent: ["Cloning", "Spawning", "Mitosing"],
  "web-fetch": ["Pilfering", "Scrounging", "Plundering"],
  tasks: ["Wrangling", "Herding", "Corralling"],
  "task-output": ["Eavesdropping", "Intercepting"],
  "task-stop": ["Guillotining", "Tranquilizing"],
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

export function selectPhrases(
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

export function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
