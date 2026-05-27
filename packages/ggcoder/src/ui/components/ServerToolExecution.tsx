import React from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import { Spinner } from "./Spinner.js";
import { ToolUseLoader } from "./ToolUseLoader.js";
import { MessageResponse } from "./MessageResponse.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { toolNameColor } from "../transcript/tool-presentation.js";

interface ServerToolRunningProps {
  status: "running";
  name: string;
  input: unknown;
  startedAt: number;
  animateUntil?: number;
  marginTop?: number;
}

interface ServerToolDoneProps {
  status: "done";
  name: string;
  input: unknown;
  durationMs: number;
  resultType?: string;
  marginTop?: number;
}

type ServerToolExecutionProps = ServerToolRunningProps | ServerToolDoneProps;

const RESPONSE_LEFT_PADDING = 1;

// ToolUseLoader minWidth={2} = 2 chars
const HEADER_PREFIX = 2;

export function ServerToolExecution(props: ServerToolExecutionProps) {
  const theme = useTheme();
  const { columns } = useTerminalSize();
  const { label, detail } = getHeader(props.name, props.input);
  const staticDisplay = props.status === "running" ? false : true;

  const headerContentWidth = Math.max(10, columns - HEADER_PREFIX);

  const headerContent = (labelColor: string) => (
    <Text wrap="wrap">
      <Text bold color={labelColor}>
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
      <Box
        flexDirection="column"
        paddingLeft={RESPONSE_LEFT_PADDING}
        marginTop={props.marginTop ?? 0}
      >
        <Box flexDirection="row">
          <Box width={HEADER_PREFIX} flexShrink={0}>
            <Spinner staticDisplay={staticDisplay} />
          </Box>
          <Box flexGrow={1} width={headerContentWidth}>
            {headerContent(toolNameColor(theme, props.name))}
          </Box>
        </Box>
        <MessageResponse>
          <Text color={theme.textDim} wrap="wrap">
            Searching...
          </Text>
        </MessageResponse>
      </Box>
    );
  }

  const isAborted = props.resultType === "aborted";
  const duration = Math.round(props.durationMs / 1000);

  return (
    <Box
      flexDirection="column"
      paddingLeft={RESPONSE_LEFT_PADDING}
      marginTop={props.marginTop ?? 0}
    >
      <Box flexDirection="row">
        <ToolUseLoader status={isAborted ? "error" : "done"} />
        <Box flexGrow={1} width={headerContentWidth}>
          {headerContent(isAborted ? theme.error : toolNameColor(theme, props.name))}
        </Box>
      </Box>
      <MessageResponse>
        <Text color={theme.textDim} wrap="wrap">
          {isAborted ? "Stopped." : `Did 1 search in ${duration}s`}
        </Text>
      </MessageResponse>
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
