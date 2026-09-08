import type { Repository } from "@splitch/db";
import { PRIVACY_EXPORT_DOWNLOAD_TTL_MS } from "./entity-privacy-export-artifact";

const encoder = new TextEncoder();

export async function privacyExportDownloadFields(input: {
  repo: Repository;
  requestId: string;
  requestUrl: string;
  origin?: string;
  secret: string | undefined;
  now?: Date;
}): Promise<{ downloadUrl: string; expiresAt: string } | undefined> {
  const job = await input.repo.privacy.getPrivacyJobByRequestId(input.requestId);
  if (
    job?.kind !== "export" ||
    job.status !== "completed" ||
    !job.artifactKey ||
    !job.artifactSha256 ||
    !job.artifactExpiresAt
  ) {
    return undefined;
  }
  const now = input.now ?? new Date();
  const artifactExpiry = Date.parse(job.artifactExpiresAt);
  if (!Number.isFinite(artifactExpiry) || artifactExpiry <= now.getTime()) return undefined;
  const expiresMs = Math.min(now.getTime() + PRIVACY_EXPORT_DOWNLOAD_TTL_MS, artifactExpiry);
  const expires = Math.floor(expiresMs / 1000);
  const signature = await sign(
    requiredSecret(input.secret),
    signatureMessage(job.requestId, job.artifactKey, expires, job.artifactSha256),
  );
  const url = new URL(
    `/privacy/requests/${encodeURIComponent(job.requestId)}/download`,
    input.origin ?? new URL(input.requestUrl).origin,
  );
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", signature);
  return { downloadUrl: url.toString(), expiresAt: new Date(expires * 1000).toISOString() };
}

export async function handlePrivacyExportDownload(input: {
  repo: Repository;
  bucket: R2Bucket;
  request: Request;
  requestId: string;
  secret: string | undefined;
  now?: Date;
}): Promise<Response> {
  const url = new URL(input.request.url);
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature");
  const now = input.now ?? new Date();
  if (!Number.isSafeInteger(expires) || !signature)
    return new Response("not found", { status: 404 });
  if (expires * 1000 <= now.getTime()) return new Response("download expired", { status: 410 });
  const job = await input.repo.privacy.getPrivacyJobByRequestId(input.requestId);
  if (
    job?.kind !== "export" ||
    job.status !== "completed" ||
    !job.artifactKey ||
    !job.artifactSha256 ||
    !job.artifactExpiresAt ||
    Date.parse(job.artifactExpiresAt) <= now.getTime() ||
    expires * 1000 > Date.parse(job.artifactExpiresAt)
  ) {
    return new Response("not found", { status: 404 });
  }
  const valid = await verify(
    requiredSecret(input.secret),
    signatureMessage(job.requestId, job.artifactKey, expires, job.artifactSha256),
    signature,
  );
  if (!valid) return new Response("not found", { status: 404 });
  const object = await input.bucket.get(job.artifactKey);
  if (!object) return new Response("not found", { status: 404 });
  const headers = new Headers({
    "cache-control": "private, no-store",
    "content-disposition": `attachment; filename="${job.requestId}.json"`,
    "content-type": "application/json",
    "x-content-type-options": "nosniff",
  });
  object.writeHttpMetadata(headers);
  headers.set("content-length", String(object.size));
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}

async function sign(secret: string, message: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(message),
  );
  return toHex(signature);
}

async function verify(secret: string, message: string, signature: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/u.test(signature)) return false;
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    fromHex(signature),
    encoder.encode(message),
  );
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function signatureMessage(
  requestId: string,
  artifactKey: string,
  expires: number,
  artifactSha256: string,
): string {
  return `${requestId}\n${artifactKey}\n${String(expires)}\n${artifactSha256}`;
}

function requiredSecret(secret: string | undefined): string {
  if (!secret) throw new Error("PRIVACY_EXPORT_URL_SECRET is required");
  return secret;
}

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): ArrayBuffer {
  const bytes = new Uint8Array(
    value.match(/.{2}/gu)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
  return bytes.buffer as ArrayBuffer;
}
