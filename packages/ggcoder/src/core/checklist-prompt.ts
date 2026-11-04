// The prompt the app's Checklist screen sends when the user checks one item.
// Generated from the item definition so it can't drift from the list.

import { CHECKLIST_FILE, CHECKLIST_STALE_DAYS, type ChecklistItem } from "./checklist-items.js";

/**
 * Instructions for checking one checklist item, recorded through the `checklist`
 * tool. The check itself is report-only; fixes happen only after the user picks
 * one, and end with the item re-recorded so fixed findings don't linger.
 */
export function checklistRunPrompt(item: ChecklistItem): string {
  const skillStep = item.skill
    ? `Load the \`${item.skill}\` skill with the \`skill\` tool and follow its method in report-only mode.`
    : "No skill applies; use your own judgment.";
  const setupNote = item.setupCommand
    ? ` Say that \`/${item.setupCommand}\` would fix most gaps.`
    : "";
  return `# Checklist: ${item.title}

Check this project for one item of its health checklist and report in plain words. Results are stored in \`${CHECKLIST_FILE}\` at the project root and become due again after ${CHECKLIST_STALE_DAYS} days.

**Check and report only. Do not edit, create, delete, install or commit any project file. Only the \`checklist\` tool writes the record.** This holds until the user picks a fix in step 8.

## The item

- id: \`${item.id}\`
- group: ${item.group}
- what to check: ${item.check}

## Steps

1. The \`checklist\` tool is loaded on demand. Call \`tool_search\` with the query "checklist" first.
2. Profile the project briefly: what it is, its stack, whether it has a UI, a deployment, user data.
3. Decide whether the item applies. If it clearly doesn't (for example design items for a project with no UI), record \`not-applicable\` with a one-line reason and stop.
4. ${skillStep}
5. Inspect the code and config, and run the project's real checks where relevant (lint, typecheck, tests, audits). Don't guess what a command would print: run it. Configuration being present is not a passing check. Do not run fix/write flags or checks that would alter project files.
6. Report in plain words: a bold verdict limited to the reviewed scope, then each finding with file:line, severity and a suggested fix.${setupNote} State what you checked and what you did not check. Never describe a project as safe or fully covered merely because this review found no issues.
7. Call \`checklist\` with \`action: "record"\`, \`id: "${item.id}"\`, \`result\` (\`pass\`, \`issues\` or \`not-applicable\`), a one-line \`summary\`, the \`findings\` (required for \`issues\`, empty for \`pass\`) and \`evidence\`: the commands you ran with their outcome, the files you read, and the skill you loaded. Include one evidence line beginning \`Scope:\` and another beginning \`Not checked:\` describing exclusions or missing access. Loading a skill alone is not review evidence. Keep any limited scope explicit in the summary; a narrow check must not claim to resolve unrelated findings from an earlier review. The tool stamps the date and commit itself.
8. If you recorded \`issues\` and the \`ask_user\` tool is available, end by asking what to fix with \`ask_user\`, never a question in prose. Write options for these findings and this item, each a complete action in plain words: for example "Fix all N findings" (mark it \`recommended\` when the fixes are safe), a narrower option such as fixing only the high-severity findings or one named area, and "Leave as is". Offer an option only if you could carry it out now. Skip the question for \`pass\` or \`not-applicable\`.
9. If the user picks a fix, make it, then run the relevant checks. Re-check every finding recorded in step 7, and call \`checklist\` \`record\` for \`${item.id}\` again: \`pass\` only when every finding is fixed and verified, otherwise \`issues\` listing what remains. Use evidence from the re-check, not the original review. If they leave it as is, keep the record unchanged.`;
}
