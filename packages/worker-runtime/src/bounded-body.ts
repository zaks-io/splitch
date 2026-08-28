/**
 * Shared raw-body gate for surfaces that cannot go through the registrar:
 * Auth doors, MCP JSON-RPC, internal Event Ingest, and the Convex webhook.
 *
 * Content-type is checked before any buffering. A trusted Content-Length above
 * the cap is rejected without reading. A chunked or lying Content-Length stream
 * stops at the first over-cap byte and cancels the remainder. Successful reads
 * return the exact bytes so HMAC and form parsers see the same payload the
 * client sent.
 */

export type BoundedBodyFailureReason = "unsupported_content_type" | "too_large";

export type BoundedBodyResult =
  | { ok: true; bytes: Uint8Array; text: string }
  | { ok: false; reason: BoundedBodyFailureReason };

export interface ReadBoundedBodyOptions {
  readonly maxBytes: number;
  readonly allowedMediaTypes: readonly string[];
}

export function mediaTypeOf(contentType: string | null): string | null {
  if (contentType === null) return null;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === undefined || mediaType.length === 0 ? null : mediaType;
}

export function hasAllowedMediaType(
  contentType: string | null,
  allowedMediaTypes: readonly string[],
): boolean {
  const mediaType = mediaTypeOf(contentType);
  if (mediaType === null) return false;
  return allowedMediaTypes.some((allowed) => allowed.toLowerCase() === mediaType);
}

export function trustedContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

export async function readBoundedRequestBytes(
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

export async function readBoundedRequestBody(
  request: Request,
  options: ReadBoundedBodyOptions,
): Promise<BoundedBodyResult> {
  if (!hasAllowedMediaType(request.headers.get("content-type"), options.allowedMediaTypes)) {
    return { ok: false, reason: "unsupported_content_type" };
  }

  const contentLength = trustedContentLength(request.headers.get("content-length"));
  if (contentLength !== null && contentLength > options.maxBytes) {
    return { ok: false, reason: "too_large" };
  }

  const bytes = await readBoundedRequestBytes(request.body, options.maxBytes);
  if (bytes === null) {
    return { ok: false, reason: "too_large" };
  }

  return { ok: true, bytes, text: new TextDecoder().decode(bytes) };
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Rejection is already decided; a broken cancellation cannot reopen the body gate.
  }
}
