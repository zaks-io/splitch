/**
 * One baseline security-header policy for every Worker response.
 *
 * Apps may add headers (Control Panel anti-framing, CORS, MCP session). Merge
 * never overwrites protocol headers. Security headers take the stronger of the
 * existing and applied values so a weaker route CSP cannot re-enable framing.
 */

import { strongerReferrerPolicy } from "./referrer-policy.js";

export const WORKER_BASELINE_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
} as const satisfies Record<string, string>;

/**
 * Baseline plus clickjacking controls and a crawler opt-out. Applied at the
 * Control Panel boundary: every page there is private and authenticated, so no
 * response belongs in a search index.
 */
export const CONTROL_PANEL_SECURITY_HEADERS = {
  ...WORKER_BASELINE_SECURITY_HEADERS,
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow",
} as const satisfies Record<string, string>;

const PROTOCOL_HEADER_NAMES = new Set([
  "location",
  "access-control-allow-origin",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-credentials",
  "access-control-expose-headers",
  "access-control-max-age",
  "mcp-session-id",
  "set-cookie",
  "www-authenticate",
  "retry-after",
  "content-type",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "sec-websocket-accept",
]);

/**
 * Copy `baseline`, then add `extras` only for names the baseline does not
 * already carry (case-insensitive). Baseline keys cannot be weakened here.
 */
export function mergeHeaderRecords(
  baseline: Record<string, string>,
  extras?: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...baseline };
  if (!extras) return merged;
  const present = new Set(Object.keys(merged).map((key) => key.toLowerCase()));
  for (const [key, value] of Object.entries(extras)) {
    if (present.has(key.toLowerCase())) continue;
    merged[key] = value;
    present.add(key.toLowerCase());
  }
  return merged;
}

/**
 * Stamp extra headers onto a Response. Protocol headers already on the response
 * win. Security headers take the stronger value. CSP is a comma-separated
 * policy list (CSP3); each policy is upgraded on its own so a weaker
 * `frame-ancestors` cannot hide behind a comma and ignore a later deny.
 * Unrelated directives stay. A WebSocket upgrade is returned unchanged so the
 * socket is not dropped. A stream keeps its unread body.
 */
export function applyResponseHeaders(response: Response, extra?: Record<string, string>): Response {
  if (!extra) return response;
  if (response.webSocket) return response;
  const headers = new Headers(response.headers);
  const extrasChanged = applyExtraHeaders(headers, extra);
  const cspChanged = normalizeExistingCsp(headers);
  if (!extrasChanged && !cspChanged) return response;
  return cloneResponse(response, headers);
}

function applyExtraHeaders(headers: Headers, extra: Record<string, string>): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(extra)) {
    const current = headers.get(key);
    if (current === null) {
      headers.set(key, value);
      changed = true;
      continue;
    }
    const next = mergeHeaderValue(key, current, value);
    if (next !== current) {
      headers.set(key, next);
      changed = true;
    }
  }
  return changed;
}

function normalizeExistingCsp(headers: Headers): boolean {
  const csp = headers.get("content-security-policy");
  if (csp === null) return false;
  const normalized = normalizeCspHeader(csp);
  if (normalized === csp) return false;
  headers.set("content-security-policy", normalized);
  return true;
}

/**
 * Official fetch wrapper: stamp the Worker baseline on every response path.
 * Hosted Workers may instead import `wrapWorkerHandler` from
 * `@splitch/observability/worker`, which applies this same baseline plus Sentry.
 */
export function wrapWorkerHandler<E = unknown>(handler: {
  fetch(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>;
}): {
  fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response>;
} {
  return {
    async fetch(request, env, ctx) {
      return applyResponseHeaders(await handler.fetch(request, env, ctx), {
        ...WORKER_BASELINE_SECURITY_HEADERS,
      });
    },
  };
}

function mergeHeaderValue(name: string, current: string, extra: string): string {
  const key = name.toLowerCase();
  if (PROTOCOL_HEADER_NAMES.has(key)) return current;
  if (key === "content-security-policy") return mergeContentSecurityPolicy(current, extra);
  if (key === "x-frame-options") return strongerToken(current, extra, xFrameOptionsStrength);
  if (key === "x-content-type-options") {
    return strongerToken(current, extra, (value) => (value.toLowerCase() === "nosniff" ? 1 : 0));
  }
  if (key === "referrer-policy") {
    return strongerReferrerPolicy(current, extra);
  }
  if (key === "x-robots-tag") {
    // Whole-value check. Per-crawler groups (`googlebot: noindex, bingbot: all`)
    // would score as already-noindex and keep the weaker group, which is fine
    // while the Panel policy is this header's only writer in the repo.
    return strongerToken(current, extra, (value) =>
      value.toLowerCase().includes("noindex") ? 1 : 0,
    );
  }
  return current;
}

function strongerToken(
  current: string,
  extra: string,
  strength: (value: string) => number,
): string {
  return strength(extra) > strength(current) ? extra : current;
}

function xFrameOptionsStrength(value: string): number {
  const normalized = value.trim().toLowerCase();
  if (normalized === "deny") return 3;
  if (normalized === "sameorigin") return 2;
  if (normalized.startsWith("allow-from")) return 1;
  return 0;
}

type CspDirective = { name: string; value: string };
type CspPolicy = CspDirective[];

function mergeContentSecurityPolicy(current: string, extra: string): string {
  const extraPolicies = parseCspPolicyList(extra).map(normalizeCspPolicy);
  const currentPolicies = parseCspPolicyList(current).map(normalizeCspPolicy);
  if (currentPolicies.length === 0) return serializeCspPolicyList(extraPolicies);
  const merged = currentPolicies.map((policy) => {
    const directives = policy.map((directive) => ({ ...directive }));
    for (const extraPolicy of extraPolicies) mergeCspDirectives(directives, extraPolicy);
    return normalizeCspPolicy(directives);
  });
  return serializeCspPolicyList(merged);
}

function normalizeCspHeader(header: string): string {
  return serializeCspPolicyList(parseCspPolicyList(header).map(normalizeCspPolicy));
}

/**
 * Collapse duplicate directives. `frame-ancestors` keeps the strongest value so
 * a later weaker source list cannot survive. Other names keep the first value.
 */
function normalizeCspPolicy(policy: CspPolicy): CspPolicy {
  const unique: CspPolicy = [];
  const indexByName = new Map<string, number>();
  for (const directive of policy) {
    const existingIndex = indexByName.get(directive.name);
    if (existingIndex === undefined) {
      indexByName.set(directive.name, unique.length);
      unique.push({ ...directive });
      continue;
    }
    const existing = unique[existingIndex];
    if (!existing) continue;
    if (directive.name === "frame-ancestors") {
      existing.value = strongerFrameAncestors(existing.value, directive.value);
    }
  }
  return unique;
}

function mergeCspDirectives(directives: CspPolicy, extraDirectives: CspPolicy): void {
  for (const extraDirective of extraDirectives) {
    if (extraDirective.name === "frame-ancestors") {
      const existing = directives.find((directive) => directive.name === "frame-ancestors");
      if (!existing) {
        directives.push({ ...extraDirective });
        continue;
      }
      existing.value = strongerFrameAncestors(existing.value, extraDirective.value);
      continue;
    }
    if (!directives.some((directive) => directive.name === extraDirective.name)) {
      directives.push({ ...extraDirective });
    }
  }
}

/** CSP3 serialized CSP list: comma separates policies, semicolon separates directives. */
function parseCspPolicyList(header: string): CspPolicy[] {
  return header
    .split(",")
    .map((policy) => parseCspDirectives(policy))
    .filter((policy) => policy.length > 0);
}

function parseCspDirectives(policy: string): CspPolicy {
  const directives: CspPolicy = [];
  for (const part of policy.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const space = trimmed.search(/\s/);
    if (space === -1) {
      directives.push({ name: trimmed.toLowerCase(), value: "" });
      continue;
    }
    directives.push({
      name: trimmed.slice(0, space).toLowerCase(),
      value: trimmed.slice(space).trim(),
    });
  }
  return directives;
}

function serializeCspPolicyList(policies: CspPolicy[]): string {
  return policies.map((policy) => serializeCspDirectives(policy)).join(", ");
}

function serializeCspDirectives(directives: CspPolicy): string {
  return directives
    .map((directive) => (directive.value ? `${directive.name} ${directive.value}` : directive.name))
    .join("; ");
}

/**
 * `'none'` is strongest. A source list is stronger when it is a strict subset
 * of the other. Incomparable lists take their intersection; an empty
 * intersection is `'none'`.
 */
function strongerFrameAncestors(current: string, extra: string): string {
  const currentSources = frameAncestorSources(current);
  const extraSources = frameAncestorSources(extra);
  if (currentSources === "none") return "'none'";
  if (extraSources === "none") return "'none'";
  if (isSubset(currentSources, extraSources)) return current;
  if (isSubset(extraSources, currentSources)) return extra;
  const intersection = [...currentSources].filter((source) => extraSources.has(source));
  return intersection.length === 0 ? "'none'" : intersection.join(" ");
}

function frameAncestorSources(value: string): "none" | Set<string> {
  const sources = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((source) => source.toLowerCase());
  if (sources.length === 0 || sources.includes("'none'")) return "none";
  return new Set(sources);
}

function isSubset(left: Set<string>, right: Set<string>): boolean {
  for (const source of left) {
    if (!right.has(source)) return false;
  }
  return true;
}

function cloneResponse(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
