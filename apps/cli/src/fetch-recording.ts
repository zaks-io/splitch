import type { RecordedRequest } from "./test-fixtures.js";

function resolveRequestUrl(input: RequestInfo | URL, request: Request | null): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return request?.url ?? input.url;
}

function parseRequestBody(
  rawBody: string,
  contentType: string | null,
): Record<string, string> | unknown | null {
  if (!rawBody) {
    return null;
  }
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(rawBody));
  }
  return JSON.parse(rawBody);
}

export async function recordFetchRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<RecordedRequest> {
  const request = input instanceof Request ? input : null;
  const url = resolveRequestUrl(input, request);
  const method = request?.method ?? init?.method ?? "GET";
  const headers = new Headers(request?.headers ?? init?.headers);
  const authorization = headers.get("authorization");
  const rawBody = request ? await request.clone().text() : init?.body ? String(init.body) : "";
  const body = parseRequestBody(rawBody, headers.get("content-type"));
  return { url, method, authorization, body };
}
