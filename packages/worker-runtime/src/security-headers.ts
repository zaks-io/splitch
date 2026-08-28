/**
 * One baseline security-header policy for every Worker response.
 *
 * Apps may add headers (Control Panel anti-framing, CORS, MCP session). Merge
 * never overwrites protocol headers. Security headers take the stronger of the
 * existing and applied values so a weaker route CSP cannot re-enable framing.
 */

export const WORKER_BASELINE_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
} as const satisfies Record<string, string>;

/** Baseline plus clickjacking controls. Applied at the Control Panel boundary. */
export const CONTROL_PANEL_SECURITY_HEADERS = {
  ...WORKER_BASELINE_SECURITY_HEADERS,
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
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

const REFERRER_POLICY_STRENGTH: Record<string, number> = {
  "unsafe-url": 0,
  "no-referrer-when-downgrade": 1,
  "origin-when-cross-origin": 2,
  origin: 3,
  "strict-origin-when-cross-origin": 4,
  "strict-origin": 5,
  "same-origin": 6,
  "no-referrer": 7,
};

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
  if (!changed) return response;
  return cloneResponse(response, headers);
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
    return strongerToken(
      current,
      extra,
      (value) => REFERRER_POLICY_STRENGTH[value.toLowerCase()] ?? 0,
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
  const extraPolicies = parseCspPolicyList(extra);
  const currentPolicies = parseCspPolicyList(current);
  if (currentPolicies.length === 0) return serializeCspPolicyList(extraPolicies);
  const merged = currentPolicies.map((policy) => {
    const directives = policy.map((directive) => ({ ...directive }));
    for (const extraPolicy of extraPolicies) mergeCspDirectives(directives, extraPolicy);
    return directives;
  });
  return serializeCspPolicyList(merged);
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
