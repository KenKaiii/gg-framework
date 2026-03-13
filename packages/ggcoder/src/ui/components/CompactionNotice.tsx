import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import { SPINNER_FRAMES, SPINNER_INTERVAL } from "../spinner-frames.js";

// Accent color derived from theme.warning at render time

function formatTokenCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}

// ── In-progress (animated spinner) ──────────────────────

export function CompactionSpinner() {
  const theme = useTheme();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box marginTop={1}>
      <Box
        borderStyle="single"
        borderLeft
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderLeftColor={theme.warning}
        paddingLeft={1}
      >
        <Text color={theme.warning}>{SPINNER_FRAMES[frame]} </Text>
        <Text color={theme.textMuted} italic>
          Compacting conversation
        </Text>
        <Text color={theme.textDim}>...</Text>
      </Box>
    </Box>
  );
}

// ── Completed result ────────────────────────────────────

interface CompactionDoneProps {
  originalCount: number;
  newCount: number;
  tokensBefore: number;
  tokensAfter: number;
}

export function CompactionDone({
  originalCount,
  newCount,
  tokensBefore,
  tokensAfter,
}: CompactionDoneProps) {
  const theme = useTheme();
  const reduction = tokensBefore > 0 ? Math.round((1 - tokensAfter / tokensBefore) * 100) : 0;

  return (
    <Box marginTop={1}>
      <Box
        borderStyle="single"
        borderLeft
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderLeftColor={theme.warning}
        paddingLeft={1}
        flexDirection="column"
      >
        <Box>
          <Text color={theme.warning}>{"⟳ "}</Text>
          <Text color={theme.textMuted}>Conversation compacted</Text>
        </Box>
        <Box marginLeft={2}>
          <Text color={theme.textDim}>
            {originalCount} → {newCount} messages · {formatTokenCount(tokensBefore)} →{" "}
            {formatTokenCount(tokensAfter)} tokens · {reduction}% reduction
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
