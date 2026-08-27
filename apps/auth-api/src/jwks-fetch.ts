/**
 * Destination-aware JWKS fetch.
 *
 * Validation is bound to the socket that will carry the GET. The Worker opens
 * TCP, reads the peer address, and only then upgrades TLS and writes HTTP.
 * A hostname that textually looks public but lands on a non-global A/AAAA
 * (nip.io, DNS rebinding) is rejected on that connection. Redirects are not
 * followed — the 302 is returned as-is so a Location cannot retarget egress.
 */

import { isGlobalRemoteAddress } from "./jwks-ip";
import { parseJwksUrl } from "./jwks-url";

interface OpenedTrustedJwks {
  remoteAddress: string | null;
  send: (url: URL, init: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
}

export type OpenTrustedJwks = (hostname: string) => Promise<OpenedTrustedJwks>;

export async function fetchTrustedJwks(
  url: string | URL,
  init: RequestInit,
  deps: { open?: OpenTrustedJwks } = {},
): Promise<Response> {
  const parsed = parseJwksUrl(String(url));
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const target = new URL(parsed.href);
  const open = deps.open ?? openTrustedJwksSocket;
  const connection = await open(connectHostname(target.hostname));
  try {
    if (!isGlobalRemoteAddress(connection.remoteAddress)) {
      throw new Error("jwks_uri host is not allowed");
    }
    return await connection.send(target, { ...init, redirect: "manual" });
  } finally {
    await connection.close();
  }
}

function connectHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

async function openTrustedJwksSocket(hostname: string): Promise<OpenedTrustedJwks> {
  const { connect } = await import("cloudflare:sockets");
  const socket = connect(
    { hostname, port: 443 },
    { secureTransport: "starttls", allowHalfOpen: false },
  );
  const info = await socket.opened;
  let active: { close(): Promise<void>; readable: ReadableStream; writable: WritableStream } =
    socket;
  return {
    remoteAddress: info.remoteAddress ?? null,
    async send(url, init) {
      const tls = socket.startTls({ expectedServerHostname: hostname });
      active = tls;
      return httpGetOverSocket(tls, url, init);
    },
    async close() {
      await active.close();
    },
  };
}

async function httpGetOverSocket(
  streams: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> },
  url: URL,
  init: RequestInit,
): Promise<Response> {
  const writer = streams.writable.getWriter();
  const path = url.pathname.length > 0 ? url.pathname : "/";
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("Host", url.host);
  headers.set("Connection", "close");
  const lines = [`GET ${path} HTTP/1.1`];
  for (const [name, value] of headers) {
    lines.push(`${name}: ${value}`);
  }
  await writer.write(new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`));
  await writer.close();
  const chunks: Uint8Array[] = [];
  const reader = streams.readable.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    if (next.value) chunks.push(next.value);
  }
  return parseHttpResponse(concatBytes(chunks));
}

function parseHttpResponse(raw: Uint8Array): Response {
  const text = new TextDecoder().decode(raw);
  const split = text.indexOf("\r\n\r\n");
  if (split === -1) {
    throw new Error("trusted IdP JWKS response is truncated");
  }
  const head = text.slice(0, split);
  const [statusLine, ...headerLines] = head.split("\r\n");
  const match = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(statusLine ?? "");
  if (!match) {
    throw new Error("trusted IdP JWKS response is not HTTP");
  }
  const headers = new Headers();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return new Response(raw.slice(split + 4), {
    status: Number(match[1]),
    headers,
  });
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
