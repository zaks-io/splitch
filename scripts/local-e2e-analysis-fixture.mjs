#!/usr/bin/env node

import { createServer } from "node:http";
import { resolve } from "node:path";
import { LOCAL_E2E_ANALYSIS_RESULTS } from "./local-e2e-fixtures.mjs";

const origin = "http://127.0.0.1:8790";

export function createAnalysisFixtureServer(runId = "local-e2e") {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/health") {
      json(response, 200, { ok: true, service: "local-e2e-analysis-fixture" }, runId);
      return;
    }

    const scope = resultScope(url.pathname);
    if (!scope || request.method !== "GET") {
      response.writeHead(404).end("not found");
      return;
    }
    const fixture = LOCAL_E2E_ANALYSIS_RESULTS.find(
      (candidate) =>
        candidate.appId === scope.appId &&
        candidate.environmentId === scope.environmentId &&
        candidate.experimentId === scope.experimentId,
    );
    if (!fixture) {
      response.writeHead(404).end("not found");
      return;
    }
    json(response, 200, fixture.result, runId);
  });
}

function resultScope(pathname) {
  const match = pathname.match(/^\/apps\/([^/]+)\/envs\/([^/]+)\/experiments\/([^/]+)\/results$/);
  if (!match) return null;
  return {
    appId: decodeURIComponent(match[1]),
    environmentId: decodeURIComponent(match[2]),
    experimentId: decodeURIComponent(match[3]),
  };
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
  createAnalysisFixtureServer(runId).listen(8790, "127.0.0.1", () => {
    console.log("local-e2e-analysis-fixture: listening on http://127.0.0.1:8790");
  });
}
