import React, { useState, useEffect, useRef } from "react";
import { Box, Text, Static, useInput } from "ink";
import { useTheme } from "../theme/theme.js";
import { Markdown } from "./Markdown.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────

interface PlanEntry {
  name: string;
  path: string;
  modifiedMs: number;
}

// ── Plan loading ─────────────────────────────────────────

async function loadPlanEntries(cwd: string): Promise<PlanEntry[]> {
  const plansDir = join(cwd, ".gg", "plans");
  let files: string[];
  try {
    files = await readdir(plansDir);
  } catch {
    return [];
  }

  const entries: PlanEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const filePath = join(plansDir, file);
    try {
      const { mtimeMs } = await import("node:fs").then((fs) => fs.statSync(filePath));
      entries.push({
        name: file.replace(/\.md$/, ""),
        path: filePath,
        modifiedMs: mtimeMs,
      });
    } catch {
      entries.push({ name: file.replace(/\.md$/, ""), path: filePath, modifiedMs: 0 });
    }
  }

  // Sort newest first
  entries.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return entries;
}

// ── Banner ───────────────────────────────────────────────

const PLAN_LOGO = [
  " \u2584\u2580\u2580\u2580 \u2584\u2580\u2580\u2580",
  " \u2588 \u2580\u2588 \u2588 \u2580\u2588",
  " \u2580\u2584\u2584\u2580 \u2580\u2584\u2584\u2580",
];

const AMBER_GRADIENT = [
  "#f59e0b",
  "#fbbf24",
  "#f59e0b",
  "#d97706",
  "#f59e0b",
  "#fbbf24",
  "#d97706",
];

const GAP = "   ";
const LOGO_WIDTH = 9;
const SIDE_BY_SIDE_MIN = LOGO_WIDTH + GAP.length + 20;

function PlanGradientText({ text }: { text: string }) {
  const chars: React.ReactNode[] = [];
  let colorIdx = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " ") {
      chars.push(ch);
    } else {
      const color = AMBER_GRADIENT[colorIdx % AMBER_GRADIENT.length];
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

// ── Prefix width — matches AssistantMessage / StreamingArea ──
const PREFIX_WIDTH = 2;

// ── Static items for the expanded view ───────────────────

interface BannerStaticItem {
  kind: "banner";
  id: string;
}

interface PlanHeaderStaticItem {
  kind: "plan_header";
  name: string;
  id: string;
}

interface PlanContentStaticItem {
  kind: "plan_content";
  content: string;
  markdownWidth: number;
  id: string;
}

type StaticItem = BannerStaticItem | PlanHeaderStaticItem | PlanContentStaticItem;

// ── Component ────────────────────────────────────────────

interface PlanOverlayProps {
  cwd: string;
  onClose: () => void;
  autoExpandNewest?: boolean;
  onApprove?: (planPath: string) => void;
  onReject?: (planPath: string, feedback: string) => void;
  onDeletePlan?: (planPath: string) => void;
}

export function PlanOverlay({
  cwd,
  onClose,
  autoExpandNewest,
  onApprove,
  onReject,
  onDeletePlan,
}: PlanOverlayProps) {
  const theme = useTheme();

  const { columns } = useTerminalSize();
  // Pre-compute the width available for Markdown — same as AssistantMessage.
  // Prefix (2) = 2 chars overhead.
  const markdownWidth = Math.max(40, columns - PREFIX_WIDTH);

  const [plans, setPlans] = useState<PlanEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);

  // Expanded view state
  const [expandedPlan, setExpandedPlan] = useState<PlanEntry | null>(null);
  const [staticItems, setStaticItems] = useState<StaticItem[]>([]);

  // Action state
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState("");

  const autoExpandedRef = useRef(false);
  const nextIdRef = useRef(0);
  const getId = () => String(nextIdRef.current++);

  // Load plans on mount
  useEffect(() => {
    void loadPlanEntries(cwd).then((p) => {
      setPlans(p);
      setLoaded(true);
    });
  }, [cwd]);

  // Auto-expand newest plan on first load
  useEffect(() => {
    if (autoExpandNewest && loaded && plans.length > 0 && !autoExpandedRef.current) {
      autoExpandedRef.current = true;
      expandPlan(plans[0]);
    }
  }, [autoExpandNewest, loaded, plans]);

  // Clamp index
  useEffect(() => {
    if (plans.length === 0) {
      setSelectedIndex(0);
    } else if (selectedIndex >= plans.length) {
      setSelectedIndex(plans.length - 1);
    }
  }, [plans.length, selectedIndex]);

  function expandPlan(plan: PlanEntry) {
    void readFile(plan.path, "utf-8")
      .then((content) => {
        setExpandedPlan(plan);
        setStaticItems([
          { kind: "banner", id: getId() },
          { kind: "plan_header", name: plan.name, id: getId() },
          { kind: "plan_content", content, markdownWidth, id: getId() },
        ]);
      })
      .catch(() => {
        setExpandedPlan(plan);
        setStaticItems([
          { kind: "banner", id: getId() },
          { kind: "plan_header", name: plan.name, id: getId() },
          { kind: "plan_content", content: "(could not read plan)", markdownWidth, id: getId() },
        ]);
      });
  }

  function collapsePlan() {
    setExpandedPlan(null);
    setStaticItems([]);
    setRejectMode(false);
    setRejectFeedback("");
  }

  useInput((input, key) => {
    // Reject feedback input mode
    if (rejectMode) {
      if (key.return) {
        if (expandedPlan) {
          onReject?.(expandedPlan.path, rejectFeedback || "Please revise the plan.");
        }
        setRejectMode(false);
        setRejectFeedback("");
        return;
      }
      if (key.escape) {
        setRejectMode(false);
        setRejectFeedback("");
        return;
      }
      if (key.backspace || key.delete) {
        setRejectFeedback((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setRejectFeedback((prev) => prev + input);
      }
      return;
    }

    // Confirm delete mode
    if (confirmDelete) {
      if (input === "y" || input === "Y") {
        const plan = expandedPlan ?? plans[selectedIndex];
        if (plan) {
          void unlink(plan.path).catch(() => {});
          onDeletePlan?.(plan.path);
          setPlans((prev) => prev.filter((p) => p.path !== plan.path));
          if (expandedPlan) collapsePlan();
        }
        setConfirmDelete(false);
        return;
      }
      setConfirmDelete(false);
      return;
    }

    // Close overlay
    if (key.escape) {
      if (expandedPlan) {
        collapsePlan();
      } else {
        onClose();
      }
      return;
    }

    // ── Expanded view actions ──
    if (expandedPlan) {
      if (input === "a") {
        onApprove?.(expandedPlan.path);
        return;
      }
      if (input === "r") {
        setRejectMode(true);
        setRejectFeedback("");
        return;
      }
      if (input === "d") {
        setConfirmDelete(true);
        return;
      }
      // q or Enter → back to list
      if (input === "q" || key.return) {
        collapsePlan();
        return;
      }
      return;
    }

    // ── List view navigation ──
    if (key.upArrow || input === "k") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (key.downArrow || input === "j") {
      setSelectedIndex((i) => Math.min(plans.length - 1, i + 1));
      return;
    }

    // Expand selected plan
    if (key.return || input === " ") {
      const plan = plans[selectedIndex];
      if (plan) expandPlan(plan);
      return;
    }

    // Delete plan
    if (input === "d") {
      const plan = plans[selectedIndex];
      if (plan) setConfirmDelete(true);
      return;
    }
  });

  // ── Expanded view ──
  if (expandedPlan) {
    return (
      <Box flexDirection="column">
        {/* Plan content rendered into scrollback via Static */}
        <Static items={staticItems}>
          {(item) => {
            if (item.kind === "banner") {
              return columns < SIDE_BY_SIDE_MIN ? (
                <Box
                  key={item.id}
                  flexDirection="column"
                  marginTop={1}
                  marginBottom={1}
                  width={columns}
                >
                  <PlanGradientText text={PLAN_LOGO[0]} />
                  <PlanGradientText text={PLAN_LOGO[1]} />
                  <PlanGradientText text={PLAN_LOGO[2]} />
                  <Box marginTop={1}>
                    <Text color={theme.planPrimary} bold>
                      Plan Pane
                    </Text>
                  </Box>
                </Box>
              ) : (
                <Box
                  key={item.id}
                  flexDirection="column"
                  marginTop={1}
                  marginBottom={1}
                  width={columns}
                >
                  <Box>
                    <PlanGradientText text={PLAN_LOGO[0]} />
                    <Text>{GAP}</Text>
                    <Text color={theme.planPrimary} bold>
                      Plan Pane
                    </Text>
                  </Box>
                  <Box>
                    <PlanGradientText text={PLAN_LOGO[1]} />
                  </Box>
                  <Box>
                    <PlanGradientText text={PLAN_LOGO[2]} />
                  </Box>
                </Box>
              );
            }
            if (item.kind === "plan_header") {
              return (
                <Box key={item.id} marginBottom={1}>
                  <Text color={theme.planPrimary} bold>
                    {"◆ "}
                    {item.name}
                  </Text>
                </Box>
              );
            }
            if (item.kind === "plan_content") {
              return (
                <Box key={item.id} flexDirection="row" marginTop={1} paddingRight={1}>
                  <Box width={PREFIX_WIDTH} flexShrink={0}>
                    <Text color={theme.planPrimary}>{"◇ "}</Text>
                  </Box>
                  <Box flexDirection="column" flexGrow={1} width={item.markdownWidth}>
                    <Markdown width={item.markdownWidth}>{item.content}</Markdown>
                  </Box>
                </Box>
              );
            }
            return null;
          }}
        </Static>

        {/* Live area — action bar */}
        {confirmDelete && (
          <Box marginTop={1}>
            <Text color={theme.error}>
              {"  Delete "}
              <Text bold>{expandedPlan.name}</Text>
              {"? (y/N)"}
            </Text>
          </Box>
        )}

        {rejectMode ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.planPrimary}>{"Feedback (Enter to submit, Esc to cancel):"}</Text>
            <Box>
              <Text color={theme.text}>
                {"> "}
                {rejectFeedback}
                {"\u258D"}
              </Text>
            </Box>
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text color={theme.textDim}>
              <Text color={theme.success}>a</Text>
              {" approve · "}
              <Text color={theme.error}>r</Text>
              {" reject · "}
              <Text color={theme.planPrimary}>d</Text>
              {" delete · "}
              <Text color={theme.planPrimary}>q</Text>
              {" back · "}
              <Text color={theme.planPrimary}>ESC</Text>
              {" close"}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // ── List view ──
  const maxVisible = 15;
  const startIdx = Math.max(0, selectedIndex - maxVisible + 1);
  const visiblePlans = plans.slice(startIdx, startIdx + maxVisible);

  return (
    <Box flexDirection="column">
      {/* Banner */}
      {columns < SIDE_BY_SIDE_MIN ? (
        <Box flexDirection="column" marginTop={1} marginBottom={1} width={columns}>
          <PlanGradientText text={PLAN_LOGO[0]} />
          <PlanGradientText text={PLAN_LOGO[1]} />
          <PlanGradientText text={PLAN_LOGO[2]} />
          <Box marginTop={1}>
            <Text color={theme.planPrimary} bold>
              Plan Pane
            </Text>
          </Box>
          <Text color={theme.textDim}>
            {plans.length} plan{plans.length !== 1 ? "s" : ""} in .gg/plans/
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1} marginBottom={1} width={columns}>
          <Box>
            <PlanGradientText text={PLAN_LOGO[0]} />
            <Text>{GAP}</Text>
            <Text color={theme.planPrimary} bold>
              Plan Pane
            </Text>
          </Box>
          <Box>
            <PlanGradientText text={PLAN_LOGO[1]} />
            <Text>{GAP}</Text>
            <Text color={theme.textDim}>
              {plans.length} plan{plans.length !== 1 ? "s" : ""} in .gg/plans/
            </Text>
          </Box>
          <Box>
            <PlanGradientText text={PLAN_LOGO[2]} />
          </Box>
        </Box>
      )}

      {loaded && plans.length === 0 && (
        <Box flexDirection="column">
          <Text color={theme.textDim}>
            {"  No plans found. Plans are written to "}
            <Text color={theme.planPrimary}>.gg/plans/</Text>
          </Text>
          <Text color={theme.textDim}>
            {"  Use "}
            <Text color={theme.planPrimary}>/plan</Text>
            {" or let the agent call "}
            <Text color={theme.planPrimary}>enter_plan</Text>
            {" to start planning."}
          </Text>
        </Box>
      )}

      {visiblePlans.map((plan, vi) => {
        const realIdx = startIdx + vi;
        const selected = realIdx === selectedIndex;
        const prefix = selected ? "❯ " : "  ";
        const date = new Date(plan.modifiedMs);
        const timeStr =
          plan.modifiedMs > 0
            ? `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`
            : "";

        return (
          <Text key={plan.path} color={selected ? theme.planPrimary : theme.text} bold={selected}>
            {prefix}
            <Text color={selected ? theme.planPrimary : "#e5e7eb"}>{plan.name}</Text>
            {timeStr && (
              <Text color={theme.textDim} dimColor={!selected}>
                {" "}
                {timeStr}
              </Text>
            )}
          </Text>
        );
      })}

      {/* Confirm delete prompt */}
      {confirmDelete && (
        <Box marginTop={1}>
          <Text color={theme.error}>
            {"  Delete "}
            <Text bold>{plans[selectedIndex]?.name}</Text>
            {"? (y/N)"}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.textDim}>
          <Text color={theme.planPrimary}>↑↓</Text>
          {" move · "}
          <Text color={theme.planPrimary}>Enter</Text>
          {" view · "}
          <Text color={theme.planPrimary}>d</Text>
          {" delete · "}
          <Text color={theme.planPrimary}>ESC</Text>
          {" close"}
        </Text>
      </Box>
    </Box>
  );
}
