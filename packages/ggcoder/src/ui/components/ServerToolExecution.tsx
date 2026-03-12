import React from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import { Spinner } from "./Spinner.js";

interface ServerToolRunningProps {
  status: "running";
  name: string;
  input: unknown;
  startedAt: number;
}

interface ServerToolDoneProps {
  status: "done";
  name: string;
  input: unknown;
  durationMs: number;
}

type ServerToolExecutionProps = ServerToolRunningProps | ServerToolDoneProps;

export function ServerToolExecution(props: ServerToolExecutionProps) {
  const theme = useTheme();
  const { label, detail } = getHeader(props.name, props.input);

  const header = (
    <Text>
      <Text color={theme.primary}>{"⏺ "}</Text>
      <Text bold color={theme.toolName}>
        {label}
      </Text>
      {detail && (
        <Text color={theme.text}>
          {"("}
          <Text color={theme.textDim}>{'"'}</Text>
          {detail}
          <Text color={theme.textDim}>{'"'}</Text>
          {")"}
        </Text>
      )}
    </Text>
  );

  if (props.status === "running") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>{header}</Box>
        <Box paddingLeft={2}>
          <Text color={theme.textDim}>{"⎿  "}</Text>
          <Spinner label="Searching..." />
        </Box>
      </Box>
    );
  }

  const duration = Math.round(props.durationMs / 1000);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>{header}</Box>
      <Box paddingLeft={2}>
        <Text color={theme.textDim}>
          {"⎿  "}Did 1 search in {duration}s
        </Text>
      </Box>
    </Box>
  );
}

function getHeader(name: string, input: unknown): { label: string; detail: string } {
  const inp = (input ?? {}) as Record<string, unknown>;
  if (name === "web_search") {
    const query = String(inp.query ?? "");
    const trunc = query.length > 60 ? query.slice(0, 57) + "…" : query;
    return { label: "Web Search", detail: trunc };
  }
  return { label: name, detail: "" };
}
