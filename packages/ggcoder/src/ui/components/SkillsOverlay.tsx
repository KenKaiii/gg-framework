import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../theme/theme.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ────────────────────────────────────────────────

interface SkillEntry {
  name: string;
  description: string;
  source: "project" | "global";
  path: string;
}

// ── Skill loading ────────────────────────────────────────

async function loadSkillEntries(cwd: string): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];

  // Project skills: {cwd}/.gg/skills/*.md
  await loadFromDir(join(cwd, ".gg", "skills"), "project", entries);

  // Global skills: ~/.gg/skills/*.md
  await loadFromDir(join(homedir(), ".gg", "skills"), "global", entries);

  return entries;
}

async function loadFromDir(
  dir: string,
  source: "project" | "global",
  out: SkillEntry[],
): Promise<void> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return;
  }

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const filePath = join(dir, file);
    try {
      const raw = await readFile(filePath, "utf-8");
      const { name, description } = parseFrontmatter(raw, file);
      out.push({ name, description, source, path: filePath });
    } catch {
      // Skip unreadable files
    }
  }
}

function parseFrontmatter(raw: string, filename: string): { name: string; description: string } {
  let name = filename.replace(/\.md$/, "");
  let description = "";

  if (raw.startsWith("---")) {
    const endIndex = raw.indexOf("---", 3);
    if (endIndex !== -1) {
      const frontmatter = raw.slice(3, endIndex).trim();
      for (const line of frontmatter.split("\n")) {
        const colonIndex = line.indexOf(":");
        if (colonIndex === -1) continue;
        const key = line.slice(0, colonIndex).trim().toLowerCase();
        const value = line.slice(colonIndex + 1).trim();
        if (key === "name") name = value;
        else if (key === "description") description = value;
      }
    }
  }

  return { name, description };
}

// ── Banner ───────────────────────────────────────────────

const SKILL_LOGO = [
  " \u2584\u2580\u2580\u2580 \u2584\u2580\u2580\u2580",
  " \u2588 \u2580\u2588 \u2588 \u2580\u2588",
  " \u2580\u2584\u2584\u2580 \u2580\u2584\u2584\u2580",
];

const GRADIENT = [
  "#a78bfa",
  "#b49afa",
  "#c1a9f4",
  "#ceb8ee",
  "#60a5fa",
  "#ceb8ee",
  "#c1a9f4",
  "#b49afa",
];

const GAP = "   ";
const LOGO_WIDTH = 9;
const SIDE_BY_SIDE_MIN = LOGO_WIDTH + GAP.length + 20;

function SkillGradientText({ text }: { text: string }) {
  const chars: React.ReactNode[] = [];
  let colorIdx = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " ") {
      chars.push(ch);
    } else {
      const color = GRADIENT[colorIdx % GRADIENT.length];
      chars.push(
        <Text key={i} color={color}>
          {ch}
        </Text>,
      );
      colorIdx++;
    }
  }
  return <Text>{chars}</Text>;
}

// ── Component ────────────────────────────────────────────

interface SkillsOverlayProps {
  cwd: string;
  onClose: () => void;
}

export function SkillsOverlay({ cwd, onClose }: SkillsOverlayProps) {
  const theme = useTheme();
  const { columns } = useTerminalSize();
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);

  // Load skills on mount
  useEffect(() => {
    void loadSkillEntries(cwd).then((s) => {
      setSkills(s);
      setLoaded(true);
    });
  }, [cwd]);

  // Clamp index
  useEffect(() => {
    if (skills.length === 0) {
      setSelectedIndex(0);
    } else if (selectedIndex >= skills.length) {
      setSelectedIndex(skills.length - 1);
    }
  }, [skills.length, selectedIndex]);

  useInput((input, key) => {
    // Close overlay
    if (key.escape) {
      onClose();
      return;
    }

    if (key.upArrow || input === "k") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      setExpandedSkill(null);
      return;
    }

    if (key.downArrow || input === "j") {
      setSelectedIndex((i) => Math.min(skills.length - 1, i + 1));
      setExpandedSkill(null);
      return;
    }

    // Toggle expand/collapse skill content preview
    if (key.return || input === " ") {
      const skill = skills[selectedIndex];
      if (skill) {
        setExpandedSkill((prev) => (prev === skill.name ? null : skill.name));
      }
      return;
    }
  });

  const maxVisible = 15;
  const startIdx = Math.max(0, selectedIndex - maxVisible + 1);
  const visibleSkills = skills.slice(startIdx, startIdx + maxVisible);

  const home = process.env.HOME ?? "";
  const displayPath = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
  const projectCount = skills.filter((s) => s.source === "project").length;
  const globalCount = skills.filter((s) => s.source === "global").length;

  return (
    <Box flexDirection="column">
      {/* Banner */}
      {columns < SIDE_BY_SIDE_MIN ? (
        <Box flexDirection="column" marginTop={1} marginBottom={1} width={columns}>
          <SkillGradientText text={SKILL_LOGO[0]} />
          <SkillGradientText text={SKILL_LOGO[1]} />
          <SkillGradientText text={SKILL_LOGO[2]} />
          <Box marginTop={1}>
            <Text color="#a78bfa" bold>
              Skills Pane
            </Text>
          </Box>
          <Text color={theme.textDim} wrap="truncate">
            {displayPath}
          </Text>
          <Text>
            <Text color="#a78bfa">{projectCount} project</Text>
            <Text color={theme.textDim}> · </Text>
            <Text color="#60a5fa">{globalCount} global</Text>
            <Text color={theme.textDim}> · </Text>
            <Text color={theme.text}>{skills.length} total</Text>
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1} marginBottom={1} width={columns}>
          <Box>
            <SkillGradientText text={SKILL_LOGO[0]} />
            <Text>{GAP}</Text>
            <Text color="#a78bfa" bold>
              Skills Pane
            </Text>
          </Box>
          <Box>
            <SkillGradientText text={SKILL_LOGO[1]} />
            <Text>{GAP}</Text>
            <Text color={theme.textDim} wrap="truncate">
              {displayPath}
            </Text>
          </Box>
          <Box>
            <SkillGradientText text={SKILL_LOGO[2]} />
            <Text>{GAP}</Text>
            <Text>
              <Text color="#a78bfa">{projectCount} project</Text>
              <Text color={theme.textDim}> · </Text>
              <Text color="#60a5fa">{globalCount} global</Text>
              <Text color={theme.textDim}> · </Text>
              <Text color={theme.text}>{skills.length} total</Text>
            </Text>
          </Box>
        </Box>
      )}

      {loaded && skills.length === 0 && (
        <Box flexDirection="column">
          <Text color={theme.textDim}>
            {"  No skills found. Add "}
            <Text color={theme.primary}>.md</Text>
            {" files to "}
            <Text color={theme.primary}>.gg/skills/</Text>
          </Text>
          <Text color={theme.textDim}>
            {"  "}
            <Text color={theme.textDim}>Skills are invoked by the agent via the skill tool.</Text>
          </Text>
        </Box>
      )}

      {visibleSkills.map((skill, vi) => {
        const realIdx = startIdx + vi;
        const selected = realIdx === selectedIndex;
        const prefix = selected ? "❯ " : "  ";
        const sourceTag = skill.source === "project" ? "local" : "global";
        const sourceColor = skill.source === "project" ? "#a78bfa" : "#60a5fa";
        const isExpanded = expandedSkill === skill.name;

        return (
          <Box key={skill.path} flexDirection="column">
            <Text color={selected ? theme.primary : theme.text} bold={selected}>
              {prefix}
              <Text color={selected ? theme.primary : "#e5e7eb"}>{skill.name}</Text>
              <Text color={theme.textDim}> </Text>
              <Text color={sourceColor} dimColor={!selected}>
                [{sourceTag}]
              </Text>
            </Text>
            {isExpanded && skill.description && (
              <Box marginLeft={4}>
                <Text color={theme.text}>{skill.description}</Text>
              </Box>
            )}
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text color={theme.textDim}>
          <Text color={theme.primary}>↑↓</Text>
          {" move · "}
          <Text color={theme.primary}>Enter</Text>
          {" expand · "}
          <Text color={theme.primary}>ESC</Text>
          {" close"}
        </Text>
      </Box>
    </Box>
  );
}
