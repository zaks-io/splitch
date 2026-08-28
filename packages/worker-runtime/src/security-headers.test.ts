import { describe, expect, it } from "vitest";
import {
  applyResponseHeaders,
  CONTROL_PANEL_SECURITY_HEADERS,
  mergeHeaderRecords,
  WORKER_BASELINE_SECURITY_HEADERS,
} from "./security-headers";
import {
  cspAllowsFraming,
  cspHasDuplicateFrameAncestors,
  expectBaseline,
} from "./security-headers-test-support";

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

  it("keeps a stronger comma-delimited Referrer-Policy as the last recognized token", () => {
    const existing = applyResponseHeaders(
      new Response("ok", {
        headers: { "referrer-policy": "unsafe-url, no-referrer" },
      }),
      { "referrer-policy": "strict-origin-when-cross-origin" },
    );
    const extrasOnly = applyResponseHeaders(new Response("ok"), {
      "referrer-policy": "unsafe-url, no-referrer",
    });
    const weakerFinal = applyResponseHeaders(
      new Response("ok", {
        headers: { "referrer-policy": "no-referrer, unsafe-url" },
      }),
      { "referrer-policy": "strict-origin-when-cross-origin" },
    );

    expect(existing.headers.get("referrer-policy")).toBe("unsafe-url, no-referrer");
    expect(extrasOnly.headers.get("referrer-policy")).toBe("unsafe-url, no-referrer");
    expect(weakerFinal.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
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
