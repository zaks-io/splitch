import assert from "node:assert/strict";
import { test } from "node:test";
import { rewriteLocation, safeReturnTo, upstreamHeaders } from "./local-dev-panel.mjs";

const PANEL_ORIGIN = "http://127.0.0.1:18793";
const PUBLIC = "https://sbx-1.example.ts.net:18800";

function tailnetRequest(origin) {
  return {
    headers: {
      host: "sbx-1.example.ts.net:18800",
      "x-forwarded-host": "sbx-1.example.ts.net:18800",
      "x-forwarded-proto": "https",
      ...(origin ? { origin } : {}),
    },
  };
}

test("safeReturnTo keeps same-site paths and refuses everything else", () => {
  assert.equal(safeReturnTo("/acme-labs?x=1"), "/acme-labs?x=1");
  for (const raw of [null, undefined, "", "https://evil.example/", "//evil.example", "/\\evil"]) {
    assert.equal(safeReturnTo(raw), "/");
  }
});

test("upstreamHeaders maps only the gateway's own Origin onto the panel", () => {
  const own = upstreamHeaders(tailnetRequest(PUBLIC));
  assert.equal(own.origin, PANEL_ORIGIN);
  assert.equal(own.host, "127.0.0.1:18793");
  // The dev server takes request.url's scheme from x-forwarded-proto; left in,
  // the panel would see https://127.0.0.1:18793 and refuse the mapped Origin.
  assert.equal(own["x-forwarded-host"], undefined);
  assert.equal(own["x-forwarded-proto"], undefined);

  assert.equal(
    upstreamHeaders(tailnetRequest("https://evil.example")).origin,
    "https://evil.example",
  );
  assert.equal(
    upstreamHeaders(tailnetRequest("http://sbx-1.example.ts.net:18800")).origin,
    "http://sbx-1.example.ts.net:18800",
  );
  assert.equal(upstreamHeaders(tailnetRequest()).origin, undefined);
});

test("upstreamHeaders treats a direct loopback request as plain HTTP", () => {
  const headers = upstreamHeaders({
    headers: { host: "127.0.0.1:18800", origin: "http://127.0.0.1:18800" },
  });
  assert.equal(headers.origin, PANEL_ORIGIN);
});

test("rewriteLocation keeps redirects on the gateway and off WorkOS", () => {
  assert.equal(rewriteLocation(`${PANEL_ORIGIN}/acme-labs`), "/acme-labs");
  assert.equal(rewriteLocation(PANEL_ORIGIN), "/");
  assert.equal(rewriteLocation("/auth/login?returnTo=%2F"), "/__dev/login?returnTo=%2F");
  assert.equal(
    rewriteLocation("https://api.workos.com/user_management/sessions/logout?session_id=x"),
    "/__dev/login",
  );
  assert.equal(rewriteLocation("/acme-labs/checkout-api"), "/acme-labs/checkout-api");
  assert.equal(rewriteLocation("https://splitch.dev/docs"), "https://splitch.dev/docs");
});
