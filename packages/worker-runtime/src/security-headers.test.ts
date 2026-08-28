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

  it("does not overwrite CORS, session, redirect, or route security headers", () => {
    const response = applyResponseHeaders(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://auth.splitch.dev/login",
          "access-control-allow-origin": "*",
          "mcp-session-id": "sess_1",
          "content-security-policy": "frame-ancestors 'self'",
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
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
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
