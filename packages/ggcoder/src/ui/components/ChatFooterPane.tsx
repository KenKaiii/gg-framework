import React from "react";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { ContextWindowOptions } from "../../core/model-registry.js";
import type { ThemeName } from "../theme/theme.js";
import { Footer } from "./Footer.js";
import { ModelSelector } from "./ModelSelector.js";
import { ThemeSelector } from "./ThemeSelector.js";

interface ChatFooterPaneProps {
  overlay: string | null;
  onModelSelect: (modelId: string) => void;
  onModelCancel: () => void;
  loggedInProviders: Provider[];
  currentModel: string;
  currentProvider: Provider;
  onThemeSelect: (themeName: ThemeName) => void;
  onThemeCancel: () => void;
  currentTheme: string;
  contextUsed: number;
  contextWindowOptions?: ContextWindowOptions;
  displayedCwd: string;
  gitBranch?: string | null;
  thinkingLevel?: ThinkingLevel;
  planMode: boolean;
  exitPending: boolean;
  renderMarkdown: boolean;
}

export function ChatFooterPane({
  overlay,
  onModelSelect,
  onModelCancel,
  loggedInProviders,
  currentModel,
  currentProvider,
  onThemeSelect,
  onThemeCancel,
  currentTheme,
  contextUsed,
  contextWindowOptions,
  displayedCwd,
  gitBranch,
  thinkingLevel,
  planMode,
  exitPending,
  renderMarkdown,
}: ChatFooterPaneProps) {
  if (overlay === "model") {
    return (
      <ModelSelector
        onSelect={onModelSelect}
        onCancel={onModelCancel}
        loggedInProviders={loggedInProviders}
        currentModel={currentModel}
        currentProvider={currentProvider}
      />
    );
  }

  if (overlay === "theme") {
    return (
      <ThemeSelector
        onSelect={onThemeSelect}
        onCancel={onThemeCancel}
        currentTheme={currentTheme}
      />
    );
  }

  return (
    <Footer
      model={currentModel}
      tokensIn={contextUsed}
      contextWindowOptions={contextWindowOptions}
      cwd={displayedCwd}
      gitBranch={gitBranch}
      thinkingLevel={thinkingLevel}
      planMode={planMode}
      exitPending={exitPending}
      renderMarkdown={renderMarkdown}
    />
  );
}
