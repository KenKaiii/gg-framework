interface UiSlashCommandActions {
  openModelSelector: () => void;
  compactConversation: () => Promise<void>;
  quit: () => void;
  clearSession: () => void;
  openThemeSelector: () => void;
  toggleMarkdown: () => void;
  clearApprovedPlan: () => void;
}

export async function handleUiSlashCommand(
  trimmed: string,
  actions: UiSlashCommandActions,
): Promise<boolean> {
  if (trimmed === "/model" || trimmed === "/m" || trimmed === "/models") {
    actions.openModelSelector();
    return true;
  }

  if (trimmed === "/compact" || trimmed === "/c") {
    await actions.compactConversation();
    return true;
  }

  if (trimmed === "/quit" || trimmed === "/q" || trimmed === "/exit") {
    actions.quit();
    return true;
  }

  if (trimmed === "/clear") {
    actions.clearSession();
    return true;
  }

  if (trimmed === "/theme" || trimmed === "/t") {
    actions.openThemeSelector();
    return true;
  }

  if (trimmed === "/markdown" || trimmed === "/md") {
    actions.toggleMarkdown();
    return true;
  }

  if (trimmed === "/clearplan") {
    actions.clearApprovedPlan();
    return true;
  }

  return false;
}
