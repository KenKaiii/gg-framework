import type { Provider, Usage } from "@kenkaiiii/gg-ai";

export interface ToolSessionStats {
  totalCalls: number;
  totalSuccess: number;
  totalFail: number;
  totalDurationMs: number;
  byName: Record<string, { calls: number; success: number; fail: number; durationMs: number }>;
}

export interface SessionStats {
  sessionId?: string;
  startedAt: number;
  turns: number;
  totalUsage: Usage;
  tools: ToolSessionStats;
  serverToolCalls: number;
  linesChanged: { added: number; removed: number };
}

export interface SessionSummary {
  title: string;
  sessionId?: string;
  provider: Provider;
  model: string;
  cwd: string;
  wallDurationMs: number;
  turns: number;
  usage: Usage;
  tools: ToolSessionStats;
  serverToolCalls: number;
  linesChanged: { added: number; removed: number };
  footer?: string;
}

export function createSessionStats(
  options: { sessionId?: string; now?: () => number } = {},
): SessionStats {
  return {
    sessionId: options.sessionId,
    startedAt: options.now?.() ?? Date.now(),
    turns: 0,
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    tools: {
      totalCalls: 0,
      totalSuccess: 0,
      totalFail: 0,
      totalDurationMs: 0,
      byName: {},
    },
    serverToolCalls: 0,
    linesChanged: { added: 0, removed: 0 },
  };
}

export function recordTurnEnd(stats: SessionStats, usage: Usage): void {
  stats.turns += 1;
  stats.totalUsage.inputTokens += usage.inputTokens;
  stats.totalUsage.outputTokens += usage.outputTokens;
  stats.totalUsage.cacheRead = (stats.totalUsage.cacheRead ?? 0) + (usage.cacheRead ?? 0);
  stats.totalUsage.cacheWrite = (stats.totalUsage.cacheWrite ?? 0) + (usage.cacheWrite ?? 0);

  const existingServerToolUse = stats.totalUsage.serverToolUse;
  if (usage.serverToolUse || existingServerToolUse) {
    stats.totalUsage.serverToolUse = {
      webSearchRequests:
        (existingServerToolUse?.webSearchRequests ?? 0) +
        (usage.serverToolUse?.webSearchRequests ?? 0),
      webFetchRequests:
        (existingServerToolUse?.webFetchRequests ?? 0) +
        (usage.serverToolUse?.webFetchRequests ?? 0),
    };
  }
}

export function recordToolEnd(
  stats: SessionStats,
  toolName: string,
  isError: boolean,
  durationMs: number,
): void {
  stats.tools.totalCalls += 1;
  stats.tools.totalDurationMs += durationMs;
  if (isError) stats.tools.totalFail += 1;
  else stats.tools.totalSuccess += 1;

  const current = stats.tools.byName[toolName] ?? { calls: 0, success: 0, fail: 0, durationMs: 0 };
  stats.tools.byName[toolName] = {
    calls: current.calls + 1,
    success: current.success + (isError ? 0 : 1),
    fail: current.fail + (isError ? 1 : 0),
    durationMs: current.durationMs + durationMs,
  };
}

export function recordServerToolCall(stats: SessionStats): void {
  stats.serverToolCalls += 1;
}

export function addLinesChanged(
  stats: SessionStats,
  delta: { added: number; removed: number },
): void {
  stats.linesChanged.added += delta.added;
  stats.linesChanged.removed += delta.removed;
}

export function buildSessionSummary(options: {
  stats: SessionStats;
  provider: Provider;
  model: string;
  cwd: string;
  now?: () => number;
  footer?: string;
}): SessionSummary {
  const now = options.now?.() ?? Date.now();
  return {
    title: "GG Coder is powering down. Goodbye!",
    sessionId: options.stats.sessionId,
    provider: options.provider,
    model: options.model,
    cwd: options.cwd,
    wallDurationMs: Math.max(0, now - options.stats.startedAt),
    turns: options.stats.turns,
    usage: { ...options.stats.totalUsage },
    tools: {
      ...options.stats.tools,
      byName: { ...options.stats.tools.byName },
    },
    serverToolCalls: options.stats.serverToolCalls,
    linesChanged: { ...options.stats.linesChanged },
    footer: options.footer,
  };
}

export function getToolSuccessRate(tools: ToolSessionStats): number | null {
  if (tools.totalCalls === 0) return null;
  return (tools.totalSuccess / tools.totalCalls) * 100;
}
