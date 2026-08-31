#!/usr/bin/env node

import { createSign, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { LOCAL_E2E_ANALYSIS_INPUTS } from "./local-e2e-analysis-inputs.mjs";

const origin = "http://127.0.0.1:18788";
const audience = "http://127.0.0.1:18790";
const keyId = "local-e2e-analysis";
const readToken = "local-e2e-tinybird-read-token";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), alg: "RS256", kid: keyId, use: "sig" };

export function createAnalysisSourceServer(runId = "local-e2e") {
  return createServer((request, response) => handleRequest(request, response, runId));
}

function handleRequest(request, response, runId) {
  const url = new URL(request.url ?? "/", origin);
  if (servePublicRoute(url.pathname, response, runId)) return;
  if (request.headers.authorization !== `Bearer ${readToken}`) {
    json(response, 401, { error: "unauthorized" }, runId);
    return;
  }
  if (request.method === "POST" && url.pathname === "/v0/events") {
    json(response, 200, { successful_rows: 1, quarantined_rows: 0 }, runId);
    return;
  }
  const pipeName = url.pathname.match(/^\/v0\/pipes\/([^/]+)\.json$/)?.[1];
  if (!pipeName) {
    response.writeHead(404).end("not found");
    return;
  }
  json(response, 200, { data: pipeRows(pipeName, url.searchParams) }, runId);
}

function servePublicRoute(pathname, response, runId) {
  if (pathname === "/health") {
    json(response, 200, { ok: true, service: "local-e2e-analysis-source" }, runId);
    return true;
  }
  if (pathname === "/.well-known/jwks.json") {
    json(response, 200, { keys: [publicJwk] }, runId);
    return true;
  }
  if (pathname === "/token") {
    json(response, 200, { accessToken: analysisAccessToken() }, runId);
    return true;
  }
  return false;
}

function pipeRows(pipeName, params) {
  // A requested run_id must select the fixture, never just filter rows after the
  // fact. Answering the run-inputs pipe with a different Run would hand back one
  // Run's Exposures under another Run's identity.
  const requestedRunId = params.get("run_id");
  const fixture = LOCAL_E2E_ANALYSIS_INPUTS.find(
    (candidate) =>
      candidate.appId === params.get("app_id") &&
      candidate.environmentId === params.get("environment_id") &&
      candidate.experimentId === params.get("experiment_id") &&
      (requestedRunId === null || candidate.runId === requestedRunId),
  );
  if (!fixture) return [];
  if (pipeName === "analysis_run_inputs") {
    return [
      {
        run_id: fixture.runId,
        confidence_level: 0.95,
        horizon: "sequential",
        allocation: JSON.stringify({ control: 50, treatment: 50 }),
        control_variant: "control",
        decision_family: JSON.stringify(fixture.decisionFamily),
        guardrail_decisions: JSON.stringify(fixture.guardrailDecisions),
        metric_variance_config: JSON.stringify(fixture.metricVarianceConfig),
        metric_query_config: JSON.stringify(fixture.metricQueryConfig),
        started_at: "2026-07-18T00:00:00.000Z",
        dimensions: "[]",
      },
    ];
  }
  if (pipeName === "analysis_deduped_exposures" && params.get("run_id") === fixture.runId) {
    return fixture.exposures;
  }
  if (pipeName === "analysis_metric_values" && params.get("run_id") === fixture.runId) {
    // The Analysis Worker issues one read per metric_query_config entry, so a
    // multi-Metric Run would double every row if this returned the whole set.
    const metricId = params.get("metric_id");
    return metricId === null
      ? fixture.metricValues
      : fixture.metricValues.filter((row) => row.metric_id === metricId);
  }
  return [];
}

function analysisAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", kid: keyId, typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: origin,
      aud: audience,
      sub: "user_local_member_e2e",
      scopes: ["app:app_checkout_e2e:member"],
      iat: now,
      exp: now + 3_600,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey, "base64url");
  return `${signingInput}.${signature}`;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function json(response, status, body, runId) {
  response.writeHead(status, {
    "content-type": "application/json",
    "x-splitch-local-e2e-run-id": runId,
  });
  response.end(JSON.stringify(body));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const runId = process.env.SPLITCH_LOCAL_E2E_RUN_ID ?? "local-e2e";
  createAnalysisSourceServer(runId).listen(18788, "127.0.0.1", () => {
    console.log("local-e2e-analysis-source: listening on http://127.0.0.1:18788");
  });
}
