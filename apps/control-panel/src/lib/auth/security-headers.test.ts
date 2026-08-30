import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROL_PANEL_SECURITY_HEADERS } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { withControlPanelSecurityHeaders } from "#lib/auth/security-headers";

const srcRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("Control Panel anti-framing and baseline headers", () => {
  it("makes HTML and authenticated error responses unframeable", async () => {
    const html = withControlPanelSecurityHeaders(
      new Response("<html><body>panel</body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const forbidden = withControlPanelSecurityHeaders(
      Response.json({ code: "FORBIDDEN", message: "forbidden", details: {} }, { status: 403 }),
    );

    expect(await html.text()).toContain("panel");
    expectPanelSecurity(html);
    expect(forbidden.status).toBe(403);
    expectPanelSecurity(forbidden);
  });

  it("keeps health and live-update protocol headers while adding the policy", () => {
    const health = withControlPanelSecurityHeaders(
      Response.json(
        { service: "splitch-control-panel" },
        {
          headers: { "x-splitch-local-e2e-run-id": "run_1" },
        },
      ),
    );
    const rejectedUpgrade = withControlPanelSecurityHeaders(
      new Response("expected WebSocket upgrade", { status: 426 }),
    );

    expect(health.headers.get("x-splitch-local-e2e-run-id")).toBe("run_1");
    expectPanelSecurity(health);
    expect(rejectedUpgrade.status).toBe(426);
    expectPanelSecurity(rejectedUpgrade);
  });

  it("upgrades a comma-delimited policy list so frame-ancestors https: cannot remain", () => {
    const response = withControlPanelSecurityHeaders(
      new Response("ok", {
        headers: {
          "content-security-policy": "default-src https:, frame-ancestors https:",
        },
      }),
    );

    expect(response.headers.get("content-security-policy")).toBe(
      "default-src https:; frame-ancestors 'none', frame-ancestors 'none'",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("upgrades a permissive frame-ancestors https: CSP and keeps other directives", () => {
    const response = withControlPanelSecurityHeaders(
      new Response("ok", {
        headers: {
          "content-security-policy": "default-src 'self'; frame-ancestors https:",
        },
      }),
    );

    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'self'; frame-ancestors 'none'",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("is applied at the Worker server response boundary", () => {
    const serverSource = readFileSync(join(srcRoot, "server.ts"), "utf8");
    expect(serverSource).toContain("withControlPanelSecurityHeaders");
    expect(serverSource).toContain("liveUpdateResponse ?? (await startHandler.fetch");
  });
});

function expectPanelSecurity(response: Response): void {
  expect(response.headers.get("content-security-policy")).toBe(
    CONTROL_PANEL_SECURITY_HEADERS["content-security-policy"],
  );
  expect(response.headers.get("x-frame-options")).toBe(
    CONTROL_PANEL_SECURITY_HEADERS["x-frame-options"],
  );
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
}
