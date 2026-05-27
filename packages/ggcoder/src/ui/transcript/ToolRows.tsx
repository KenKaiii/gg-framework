import React from "react";
import { ToolExecution } from "../components/ToolExecution.js";
import { ToolGroupExecution } from "../components/ToolGroupExecution.js";
import { ServerToolExecution } from "../components/ServerToolExecution.js";
import { SubAgentPanel } from "../components/SubAgentPanel.js";
import type {
  ServerToolDoneItem,
  ServerToolStartItem,
  SubAgentGroupItem,
  ToolDoneItem,
  ToolGroupItem,
  ToolStartItem,
} from "../app-items.js";

export function ToolStartRow({ item }: { item: ToolStartItem }) {
  return (
    <ToolExecution
      key={item.id}
      status="running"
      name={item.name}
      args={item.args}
      progressOutput={item.progressOutput}
      animateUntil={item.animateUntil}
    />
  );
}

export function ToolDoneRow({ item }: { item: ToolDoneItem }) {
  return (
    <ToolExecution
      key={item.id}
      status="done"
      name={item.name}
      args={item.args}
      result={item.result}
      isError={item.isError}
      details={item.details}
    />
  );
}

export function ToolGroupRow({ item }: { item: ToolGroupItem }) {
  return <ToolGroupExecution key={item.id} tools={item.tools} />;
}

export function ServerToolStartRow({ item }: { item: ServerToolStartItem }) {
  return (
    <ServerToolExecution
      key={item.id}
      status="running"
      name={item.name}
      input={item.input}
      startedAt={item.startedAt}
      animateUntil={item.animateUntil}
    />
  );
}

export function ServerToolDoneRow({ item }: { item: ServerToolDoneItem }) {
  return (
    <ServerToolExecution
      key={item.id}
      status="done"
      name={item.name}
      input={item.input}
      durationMs={item.durationMs}
      resultType={item.resultType}
    />
  );
}

export function SubAgentGroupRow({ item }: { item: SubAgentGroupItem }) {
  return <SubAgentPanel key={item.id} agents={item.agents} aborted={item.aborted} />;
}
