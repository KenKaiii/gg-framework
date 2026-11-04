import { z } from "zod";
import { redactValue, type FormattedChatError } from "@kleio/ai";

const timestamp = z.number().int().nonnegative().max(8_640_000_000_000).optional().catch(undefined);
const optionalText = z.string().max(8_000).optional().catch(undefined);
const appErrorSchema = z.object({
  scope: z.string().max(80).default("error"),
  headline: z.string().min(1).max(1_000),
  message: optionalText,
  guidance: optionalText,
  reason: z.string().max(40).optional().catch(undefined),
  source: z.string().max(40).optional().catch(undefined),
  provider: z.string().max(80).optional().catch(undefined),
  statusCode: z.number().int().min(100).max(599).optional().catch(undefined),
  requestId: z.string().max(300).optional().catch(undefined),
  occurredAt: timestamp,
  resetsAt: timestamp,
});
export type AppErrorPayload = z.infer<typeof appErrorSchema>;

/** The same sanitized snapshot goes to SSE and the append-only history marker. */
export function createAppErrorPayload(
  error: FormattedChatError,
  scope: string,
  occurredAt: number,
  secrets: Iterable<string>,
): AppErrorPayload {
  return redactValue(
    {
      scope,
      headline: error.headline,
      message: error.message,
      guidance: error.guidance,
      reason: error.reason,
      source: error.source,
      provider: error.provider,
      statusCode: error.statusCode,
      requestId: error.requestId,
      occurredAt,
      resetsAt: error.resetsAt,
    },
    { secrets, maxStringLength: 8_000 },
  );
}

/** Backward-compatible read: no migration or reclassification of old saved text. */
export function restoreAppErrorPayload(value: unknown): AppErrorPayload | undefined {
  const parsed = appErrorSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
