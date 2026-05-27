export function pickDurationVerb(toolsUsed: string[]): string {
  const has = (name: string) => toolsUsed.includes(name);
  const hasAny = (...names: string[]) => names.some(has);
  const writing = has("edit") || has("write");
  const reading = has("read") || has("grep") || has("find") || has("ls");

  if (has("subagent") && writing) return "Orchestrated changes for";
  if (has("subagent")) return "Delegated work for";
  if (has("web-fetch") && writing) return "Researched & coded for";
  if (has("web-fetch") && reading) return "Researched for";
  if (has("web-fetch")) return "Fetched the web for";
  if (has("bash") && writing) return "Built & ran for";
  if (has("edit") && has("write")) return "Crafted code for";
  if (has("edit") && has("bash")) return "Refactored & tested for";
  if (has("edit") && reading) return "Refactored for";
  if (has("edit")) return "Refactored for";
  if (has("write") && has("bash")) return "Wrote & ran for";
  if (has("write") && reading) return "Wrote code for";
  if (has("write")) return "Wrote code for";
  if (has("bash") && has("grep")) return "Hacked away for";
  if (has("bash") && reading) return "Ran & investigated for";
  if (has("bash")) return "Executed commands for";
  if (hasAny("task-output", "task-stop")) return "Managed background processes for";
  if (has("grep") && has("read")) return "Investigated for";
  if (has("grep") && has("find")) return "Scoured the codebase for";
  if (has("grep")) return "Searched for";
  if (has("read") && has("find")) return "Explored for";
  if (has("read")) return "Studied the code for";
  if (has("find") || has("ls")) return "Browsed files for";

  const phrases = [
    "Pondered for",
    "Thought for",
    "Reasoned for",
    "Mulled it over for",
    "Noodled on it for",
    "Brewed up a response in",
    "Cooked up an answer in",
    "Worked out a reply in",
    "Channeled wisdom for",
    "Conjured a response in",
  ];
  return phrases[Math.floor(Math.random() * phrases.length)] ?? "Worked for";
}
