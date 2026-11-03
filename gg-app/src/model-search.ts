import type { ModelOption } from "./agent";
import { groupByProvider, providerLabel } from "./provider-labels";

/** Lower-cased with spaces, dots, dashes and similar dropped, so "opus55" finds "Opus 5.5". */
function squash(text: string): string {
  return text.toLowerCase().replace(/[\s.\-_:/()]/g, "");
}

/**
 * True when every word of `query` appears in the model's name, provider label,
 * id or local endpoint. Each word matches either as typed or with punctuation
 * and spaces ignored, so "kimi code", "gpt 6" and "opus55" all work.
 */
export function modelMatches(model: ModelOption, query: string): boolean {
  const haystack = [model.name, providerLabel(model.provider), model.id, model.endpoint ?? ""]
    .join(" ")
    .toLowerCase();
  const squashed = squash(haystack);
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word) || squashed.includes(squash(word)));
}

export interface ModelGroup {
  key: string;
  provider: string;
  label: string;
  models: ModelOption[];
}

/**
 * The picker's list. With no query: every model, grouped by provider in the
 * same order as the footer's dropdown. With a query: one flat group of the
 * matches, names that start with the query first.
 */
export function searchModels(models: readonly ModelOption[], query: string): ModelGroup[] {
  const q = query.trim();
  if (!q) return groupByProvider(models);
  const lower = q.toLowerCase();
  const hits = models
    .filter((model) => modelMatches(model, q))
    .map((model, index) => ({ model, index, lead: model.name.toLowerCase().startsWith(lower) }))
    .sort((a, b) => Number(b.lead) - Number(a.lead) || a.index - b.index)
    .map(({ model }) => model);
  return [
    {
      key: "matches",
      provider: "matches",
      label: `${hits.length} ${hits.length === 1 ? "match" : "matches"}`,
      models: hits,
    },
  ];
}
