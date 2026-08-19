import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { consumerRoot, withFixture } from "./test-support.mjs";

function decodeHtmlText(value) {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function extractElementText(html, id) {
  const match = html.match(new RegExp(`<[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`));
  if (!match) throw new Error(`rendered page is missing #${id}`);
  return decodeHtmlText(match[1]);
}

function fixtureDocument(html) {
  const elements = new Map(
    ["flag-value", "splitch-bootstrap", "splitch-config"].map((id) => [
      id,
      { textContent: extractElementText(html, id) },
    ]),
  );
  return { getElementById: (id) => elements.get(id) ?? null };
}

test("packed SSR boundary hydrates without an init fetch and redeems one Exposure", async () => {
  await withFixture(async ({ edge, edgeOrigin, ssrOrigin }) => {
    const browserModule = await import(pathToFileURL(join(consumerRoot, "browser.mjs")));
    const html = await (await fetch(ssrOrigin)).text();
    assert.ok(!html.includes("sk_ssr_fixture"));
    assert.ok(html.includes("pk_ssr_fixture"));
    assert.ok(!html.includes("targetingRules"));
    assert.ok(!html.includes("allocation"));
    assert.ok(!html.includes("salt"));
    assert.equal((await fetch(`${ssrOrigin}/browser.mjs`)).status, 200);
    assert.equal((await fetch(`${ssrOrigin}/vendor/sdk/browser/index.js`)).status, 200);
    const preflight = await fetch(`${edgeOrigin}/api/sdk/exposures`, {
      method: "OPTIONS",
      headers: {
        "access-control-request-headers": "authorization, content-type, x-splitch-sdk-runtime",
        "access-control-request-method": "POST",
        origin: ssrOrigin,
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");

    const browserCalls = [];
    const proof = await browserModule.hydratePage(fixtureDocument(html), {
      closeAfterProof: true,
      fetch: async (...args) => {
        browserCalls.push(String(args[0]));
        return fetch(...args);
      },
      beforeFirstRead() {
        assert.equal(browserCalls.length, 0);
      },
      afterFirstRead() {
        assert.equal(browserCalls.length, 0);
      },
    });

    assert.equal(proof.hydratedValueJson, proof.serverValueJson);
    assert.equal(browserCalls.length, 1);
    const evaluateAllCalls = edge.calls.filter((call) => call.path === "/api/sdk/evaluate-all");
    assert.equal(evaluateAllCalls.length, 1);
    assert.match(evaluateAllCalls[0].idempotencyKey, /^[0-9a-f-]{36}$/);
    const exposures = edge.calls.filter((call) => call.path === "/api/sdk/exposures");
    assert.equal(exposures.length, 1);
    assert.equal(exposures[0].authorization, "Bearer pk_ssr_fixture");
    assert.equal(exposures[0].body.exposures.length, 1);
    assert.equal(exposures[0].body.exposures[0].exposureTicket, "ticket-ssr-fixture-1");
    assert.equal(proof.exposureResults.length, 1);
  });
});

test("packed browser client rejects a mismatched bootstrap context at the Node seam", async () => {
  await withFixture(async ({ edge, ssrOrigin }) => {
    const browserModule = await import(pathToFileURL(join(consumerRoot, "browser.mjs")));
    const html = await (await fetch(`${ssrOrigin}/?mismatch=1`)).text();
    await assert.rejects(
      browserModule.hydratePage(fixtureDocument(html), { fetch }),
      (error) => error?.code === "SDK_BOOTSTRAP_CONTEXT_MISMATCH",
    );
    assert.equal(edge.calls.filter((call) => call.path === "/api/sdk/exposures").length, 0);
  });
});
