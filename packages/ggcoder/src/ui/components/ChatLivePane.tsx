import React from "react";
import type { CompletedItem } from "../app-items.js";
import { ChatLiveArea } from "./ChatLayout.js";
import { StreamingArea } from "./StreamingArea.js";

interface ChatLivePaneProps {
  liveItems: CompletedItem[];
  renderItem: (item: CompletedItem, index: number, items: CompletedItem[]) => React.ReactNode;
  isRunning: boolean;
  visibleStreamingText: string;
  streamingThinking: string;
  thinkingMs: number;
  reserveStreamingSpacing: boolean;
  renderMarkdown: boolean;
  measuredLiveAreaRows: number;
  assistantMarginTop: number;
  streamingContinuation: boolean;
}

export function ChatLivePane({
  liveItems,
  renderItem,
  isRunning,
  visibleStreamingText,
  streamingThinking,
  thinkingMs,
  reserveStreamingSpacing,
  renderMarkdown,
  measuredLiveAreaRows,
  assistantMarginTop,
  streamingContinuation,
}: ChatLivePaneProps) {
  return (
    <ChatLiveArea>
      {liveItems.map((item, index, items) => renderItem(item, index, items))}
      <StreamingArea
        isRunning={isRunning}
        streamingText={visibleStreamingText}
        streamingThinking={streamingThinking}
        thinkingMs={thinkingMs}
        reserveSpacing={reserveStreamingSpacing}
        renderMarkdown={renderMarkdown}
        availableTerminalHeight={measuredLiveAreaRows}
        assistantMarginTop={assistantMarginTop}
        continuation={streamingContinuation}
      />
    </ChatLiveArea>
  );
}
