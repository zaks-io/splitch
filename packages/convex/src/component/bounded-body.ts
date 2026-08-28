/**
 * Local copy of the worker-runtime raw-body gate. @splitch/convex is a
 * published package and cannot depend on the private worker-runtime, but the
 * webhook must still reject over-limit and wrong-type bodies before HMAC.
 * Keep the stream-cancel and Content-Length rules aligned with
 * packages/worker-runtime/src/bounded-body.ts.
 */

export const CONVEX_WEBHOOK_MAX_BODY_BYTES = 32 * 1024;

export type BoundedBodyResult =
  | { ok: true; bytes: Uint8Array; text: string }
  | { ok: false; reason: "unsupported_content_type" | "too_large" };

function mediaTypeOf(contentType: string | null): string | null {
  if (contentType === null) return null;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === undefined || mediaType.length === 0 ? null : mediaType;
}

export async function readBoundedRequestBody(
  request: Request,
  maxBytes = CONVEX_WEBHOOK_MAX_BODY_BYTES,
): Promise<BoundedBodyResult> {
  if (mediaTypeOf(request.headers.get("content-type")) !== "application/json") {
    return { ok: false, reason: "unsupported_content_type" };
  }

  const contentLength = trustedContentLength(request.headers.get("content-length"));
  if (contentLength !== null && contentLength > maxBytes) {
    return { ok: false, reason: "too_large" };
  }

  const bytes = await readBoundedRequestBytes(request.body, maxBytes);
  if (bytes === null) {
    return { ok: false, reason: "too_large" };
  }

  return { ok: true, bytes, text: new TextDecoder().decode(bytes) };
}

function trustedContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

async function readBoundedRequestBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > maxBytes - byteLength) {
        await cancelReader(reader);
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
  return bytes;
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Rejection is already decided; a broken cancellation cannot reopen the body gate.
  }
}
