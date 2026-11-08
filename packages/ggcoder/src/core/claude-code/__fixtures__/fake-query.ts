import type {
  Options as SdkOptions,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export interface Rpc {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export interface ScriptContext {
  nextInput(): Promise<SDKUserMessage | undefined>;
  callTool(name: string, args: unknown, toolUseId: string): Promise<Rpc>;
  /** Read tools/list the way Claude Code does at start, and on every list_changed. */
  listTools(): Promise<string[]>;
  interrupted: Promise<void>;
}

export interface FakeQueryOptions {
  /** What `interrupt()` resolves to. */
  interruptReceipt?: { still_queued: string[] };
  /** Make `applyFlagSettings` reject. */
  rejectFlagSettings?: boolean;
}

/** A stand-in for the SDK's `query()` that runs `script` and serves our MCP bridge. */
export function fakeQuery(
  script: (ctx: ScriptContext) => AsyncGenerator<SDKMessage>,
  fake: FakeQueryOptions = {},
) {
  const calls = {
    options: undefined as SdkOptions | undefined,
    queries: 0,
    inputs: [] as SDKUserMessage[],
    interrupts: 0,
    closes: 0,
    flagSettings: [] as Record<string, unknown>[],
    /** Tool names of every tools/list Claude Code read, in order. */
    lists: [] as string[][],
  };
  const query = ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: SdkOptions;
  }): Query => {
    calls.options = options;
    calls.queries++;
    const inputs = prompt[Symbol.asyncIterator]();
    let markInterrupted!: () => void;
    let rpc: Promise<(method: string, params: Record<string, unknown>) => Promise<Rpc>> | undefined;
    const list = async () => {
      const response = await (await connect())("tools/list", {});
      const names = (response.result!.tools as { name: string }[]).map((t) => t.name);
      calls.lists.push(names);
      return names;
    };
    const connect = () =>
      (rpc ??= (async () => {
        const pending = new Map<number, (msg: Rpc) => void>();
        const transport = {
          onmessage: undefined as ((m: Rpc) => void) | undefined,
          async send(msg: Rpc) {
            if (msg.method === "notifications/tools/list_changed") void list();
            else pending.get(msg.id!)?.(msg);
          },
        };
        const server = options.mcpServers!.gg as unknown as {
          instance: { connect(t: unknown): Promise<void> };
        };
        await server.instance.connect(transport);
        let nextId = 0;
        return (method: string, params: Record<string, unknown>) =>
          new Promise<Rpc>((resolve) => {
            const id = ++nextId;
            pending.set(id, resolve);
            transport.onmessage!({ jsonrpc: "2.0", id, method, params });
          });
      })());
    const ctx: ScriptContext = {
      async nextInput() {
        const next = await inputs.next();
        if (next.done) return undefined;
        calls.inputs.push(next.value);
        return next.value;
      },
      async callTool(name, args, toolUseId) {
        return (await connect())("tools/call", {
          name,
          arguments: args,
          _meta: { "claudecode/toolUseId": toolUseId },
        });
      },
      listTools: list,
      interrupted: new Promise<void>((resolve) => (markInterrupted = resolve)),
    };
    const generator = script(ctx);
    return Object.assign(generator, {
      interrupt: async () => {
        calls.interrupts++;
        markInterrupted();
        return fake.interruptReceipt;
      },
      applyFlagSettings: async (settings: Record<string, unknown>) => {
        if (fake.rejectFlagSettings) throw new Error("not supported");
        calls.flagSettings.push(settings);
      },
      close: () => {
        calls.closes++;
      },
    }) as unknown as Query;
  };
  return { query, calls };
}

export const result = (extra: Record<string, unknown>): SDKMessage =>
  ({ type: "result", subtype: "success", is_error: false, result: "", ...extra }) as SDKMessage;
