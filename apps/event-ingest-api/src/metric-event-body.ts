/**
 * Reading the Metric Event request body under a hard byte cap, ahead of any
 * config or credential work: an oversized or unparseable body is refused before
 * it can cost a KV read.
 */

import { type MetricEventTrackRequest, MetricEventTrackRequestSchema } from "@splitch/contracts";
import { renderError } from "./errors";

const MAX_BODY_BYTES = 32_768;

export type MetricEventParseResult =
  | { readonly ok: true; readonly value: MetricEventTrackRequest; readonly serializedBytes: number }
  | { readonly ok: false; readonly response: Response; readonly serializedBytes: number | null };

export async function parseMetricEventRequest(request: Request): Promise<MetricEventParseResult> {
  const body = await readMetricEventBody(request);
  if (body === null) {
    return {
      ok: false,
      response: renderError(validation("Metric Event body exceeds 32768 bytes", [])),
      serializedBytes: null,
    };
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(body.text);
  } catch {
    return {
      ok: false,
      response: renderError(validation("Metric Event body must be JSON", [])),
      serializedBytes: body.serializedBytes,
    };
  }
  const parsed = MetricEventTrackRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      response: renderError({
        code: "VALIDATION_ERROR",
        message: "Metric Event request is invalid",
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String),
            message: issue.message,
          })),
        },
      }),
      serializedBytes: body.serializedBytes,
    };
  }
  return { ok: true, value: parsed.data, serializedBytes: body.serializedBytes };
}

async function readMetricEventBody(
  request: Request,
): Promise<{ readonly text: string; readonly serializedBytes: number } | null> {
  if (bodyTooLargeFromHeader(request.headers.get("content-length"))) return null;
  if (request.body === null) return { text: "", serializedBytes: 0 };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > MAX_BODY_BYTES - byteLength) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
      byteLength += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), serializedBytes: byteLength };
}

function bodyTooLargeFromHeader(contentLength: string | null): boolean {
  return /^\d+$/u.test(contentLength ?? "") && Number(contentLength) > MAX_BODY_BYTES;
}

function validation(message: string, path: string[]) {
  return { code: "VALIDATION_ERROR" as const, message, details: { issues: [{ path, message }] } };
}
