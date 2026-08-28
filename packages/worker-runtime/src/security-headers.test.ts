import { describe, expect, it } from "vitest";
import {
  applyResponseHeaders,
  CONTROL_PANEL_SECURITY_HEADERS,
  mergeHeaderRecords,
  WORKER_BASELINE_SECURITY_HEADERS,
} from "./security-headers";

describe("baseline security header policy", () => {
  it("names nosniff and a restrictive referrer policy", () => {
    expect(WORKER_BASELINE_SECURITY_HEADERS["x-content-type-options"]).toBe("nosniff");
    expect(WORKER_BASELINE_SECURITY_HEADERS["referrer-policy"]).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("adds Control Panel anti-framing on top of the baseline", () => {
    expect(CONTROL_PANEL_SECURITY_HEADERS).toMatchObject(WORKER_BASELINE_SECURITY_HEADERS);
    expect(CONTROL_PANEL_SECURITY_HEADERS["content-security-policy"]).toBe(
      "frame-ancestors 'none'",
    );
    expect(CONTROL_PANEL_SECURITY_HEADERS["x-frame-options"]).toBe("DENY");
  });
});

describe("mergeHeaderRecords", () => {
  it("keeps baseline values when extras try to weaken them", () => {
    const merged = mergeHeaderRecords(WORKER_BASELINE_SECURITY_HEADERS, {
      "X-Content-Type-Options": "none",
      "x-splitch": "on",
    });

    expect(merged["x-content-type-options"]).toBe("nosniff");
    expect(merged["x-splitch"]).toBe("on");
  });

  it("returns a copy of the baseline when extras are omitted", () => {
    const merged = mergeHeaderRecords(WORKER_BASELINE_SECURITY_HEADERS);
    expect(merged).toEqual({ ...WORKER_BASELINE_SECURITY_HEADERS });
    expect(merged).not.toBe(WORKER_BASELINE_SECURITY_HEADERS);
  });
});

describe("applyResponseHeaders", () => {
  it("stamps the baseline onto success and error responses", async () => {
    const success = applyResponseHeaders(Response.json({ ok: true }), {
      ...WORKER_BASELINE_SECURITY_HEADERS,
    });
    const error = applyResponseHeaders(new Response("no", { status: 500 }), {
      ...WORKER_BASELINE_SECURITY_HEADERS,
    });

    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ ok: true });
    expectBaseline(success);
    expect(error.status).toBe(500);
    expect(await error.text()).toBe("no");
    expectBaseline(error);
  });

  it("keeps CORS, session, and redirect headers while upgrading a weaker CSP", () => {
    const response = applyResponseHeaders(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://auth.splitch.dev/login",
          "access-control-allow-origin": "*",
          "mcp-session-id": "sess_1",
          "content-security-policy": "default-src 'self'; frame-ancestors https:",
          "x-content-type-options": "nosniff",
        },
      }),
      {
        ...WORKER_BASELINE_SECURITY_HEADERS,
        "content-security-policy": "frame-ancestors 'none'",
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://auth.splitch.dev/login");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("mcp-session-id")).toBe("sess_1");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'self'; frame-ancestors 'none'",
    );
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("upgrades every comma-delimited CSP policy so frame-ancestors https: cannot remain", () => {
    const response = applyResponseHeaders(
      new Response("ok", {
        headers: {
          "content-security-policy": "default-src https:, frame-ancestors https:",
        },
      }),
      { "content-security-policy": "frame-ancestors 'none'" },
    );

    expect(response.headers.get("content-security-policy")).toBe(
      "default-src https:; frame-ancestors 'none', frame-ancestors 'none'",
    );
    expect(cspAllowsFraming("default-src https:, frame-ancestors https:")).toBe(true);
    expect(
      cspAllowsFraming("default-src https:, frame-ancestors https:; frame-ancestors 'none'"),
    ).toBe(true);
    expect(cspAllowsFraming(response.headers.get("content-security-policy") ?? "")).toBe(false);
    expect(
      cspHasDuplicateFrameAncestors(response.headers.get("content-security-policy") ?? ""),
    ).toBe(false);
  });

  it("upgrades frame-ancestors in every policy of a multi-policy CSP", () => {
    const existing =
      "default-src 'self'; frame-ancestors https:, script-src 'none'; frame-ancestors https:";
    const response = applyResponseHeaders(
      new Response("ok", {
        headers: { "content-security-policy": existing },
      }),
      { "content-security-policy": "frame-ancestors 'none'" },
    );

    const merged = response.headers.get("content-security-policy");
    expect(merged).toBe(
      "default-src 'self'; frame-ancestors 'none', script-src 'none'; frame-ancestors 'none'",
    );
    expect(cspAllowsFraming(existing)).toBe(true);
    expect(cspAllowsFraming(merged ?? "")).toBe(false);
    expect(cspHasDuplicateFrameAncestors(merged ?? "")).toBe(false);
  });

  it("upgrades comma-combined CSP headers the same way as a serialized policy list", () => {
    const headers = new Headers();
    headers.append("content-security-policy", "default-src https:");
    headers.append("content-security-policy", "frame-ancestors https:");
    const response = applyResponseHeaders(new Response("ok", { headers }), {
      "content-security-policy": "frame-ancestors 'none'",
    });

    expect(headers.get("content-security-policy")).toBe(
      "default-src https:, frame-ancestors https:",
    );
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src https:; frame-ancestors 'none', frame-ancestors 'none'",
    );
  });

  it("collapses duplicate frame-ancestors so a later weaker value cannot survive", () => {
    const response = applyResponseHeaders(
      new Response("ok", {
        headers: {
          "content-security-policy":
            "default-src 'self'; frame-ancestors 'none'; frame-ancestors https:, script-src 'none'; frame-ancestors https:; frame-ancestors 'self'",
        },
      }),
      { "content-security-policy": "frame-ancestors 'none'" },
    );

    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'self'; frame-ancestors 'none', script-src 'none'; frame-ancestors 'none'",
    );
    expect(
      cspHasDuplicateFrameAncestors(response.headers.get("content-security-policy") ?? ""),
    ).toBe(false);
    expect(cspAllowsFraming(response.headers.get("content-security-policy") ?? "")).toBe(false);
  });

  it("does not weaken an existing frame-ancestors 'none' when extras are looser", () => {
    const response = applyResponseHeaders(
      new Response("ok", {
        headers: { "content-security-policy": "frame-ancestors 'none'" },
      }),
      { "content-security-policy": "frame-ancestors 'self'" },
    );

    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });

  it("leaves an unread stream readable", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });

    const response = applyResponseHeaders(new Response(stream), {
      ...WORKER_BASELINE_SECURITY_HEADERS,
    });

    expectBaseline(response);
    expect(await response.text()).toBe("chunk");
  });

  it("returns the same Response when every extra header is already present", () => {
    const original = new Response("ok", {
      headers: { ...WORKER_BASELINE_SECURITY_HEADERS },
    });

    expect(applyResponseHeaders(original, { ...WORKER_BASELINE_SECURITY_HEADERS })).toBe(original);
  });

  it("returns the same Response when extras are omitted", () => {
    const original = new Response("ok");
    expect(applyResponseHeaders(original)).toBe(original);
  });

  it("leaves a WebSocket upgrade untouched so the socket is not dropped", () => {
    const socket = {} as WebSocket;
    const upgrade = new Response("switching", { status: 200 });
    Object.defineProperty(upgrade, "webSocket", { value: socket });

    const applied = applyResponseHeaders(upgrade, { ...WORKER_BASELINE_SECURITY_HEADERS });

    expect(applied).toBe(upgrade);
    expect(applied.webSocket).toBe(socket);
    expect(applied.headers.get("x-content-type-options")).toBeNull();
  });
});

function expectBaseline(response: Response): void {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
}

/**
 * Browser CSP policy-list + first-directive-wins. Independent of production
 * serialization so the exact-header regression cannot pass by echoing text.
 */
function cspAllowsFraming(header: string): boolean {
  let allowed: "all" | "none" | Set<string> = "all";
  for (const policyText of header.split(",")) {
    const policyAllowed = policyFrameAncestors(policyText);
    if (!policyAllowed) continue;
    allowed = intersectAllowedAncestors(allowed, policyAllowed);
  }
  return allowed !== "none";
}

function policyFrameAncestors(policyText: string): "none" | Set<string> | undefined {
  const frameAncestors = firstPolicyDirectives(policyText).get("frame-ancestors");
  if (frameAncestors === undefined) return undefined;
  const sources = frameAncestors.toLowerCase().split(/\s+/).filter(Boolean);
  return sources.length === 0 || sources.includes("'none'") ? "none" : new Set(sources);
}

function firstPolicyDirectives(policyText: string): Map<string, string> {
  const directives = new Map<string, string>();
  for (const part of policyText.split(";")) {
    const parsed = parseDirectivePart(part);
    if (parsed && !directives.has(parsed.name)) directives.set(parsed.name, parsed.value);
  }
  return directives;
}

function parseDirectivePart(part: string): { name: string; value: string } | undefined {
  const trimmed = part.trim();
  if (!trimmed) return undefined;
  const space = trimmed.search(/\s/);
  if (space === -1) return { name: trimmed.toLowerCase(), value: "" };
  return { name: trimmed.slice(0, space).toLowerCase(), value: trimmed.slice(space).trim() };
}

function intersectAllowedAncestors(
  left: "all" | "none" | Set<string>,
  right: "none" | Set<string>,
): "all" | "none" | Set<string> {
  if (left === "all") return right;
  if (left === "none" || right === "none") return "none";
  const intersection = [...left].filter((source) => right.has(source));
  return intersection.length === 0 ? "none" : new Set(intersection);
}

function cspHasDuplicateFrameAncestors(header: string): boolean {
  return header.split(",").some((policyText) => {
    const count = policyText
      .split(";")
      .filter((part) => part.trim().toLowerCase().startsWith("frame-ancestors")).length;
    return count > 1;
  });
}
