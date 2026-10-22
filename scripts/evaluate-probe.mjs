#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const BASE_URL = "https://edge.preview.splitch.dev";
const REQUESTS = 5;

export function readConfig(env) {
  const clientKey = env.SPLITCH_SMOKE_CLIENT_KEY;
  if (typeof clientKey !== "string" || clientKey.trim().length === 0) {
    throw new Error(
      "SPLITCH_SMOKE_CLIENT_KEY is required, reuse the existing smoke Environment Client Key",
    );
  }
  return { clientKey };
}

/** Shared preview is fixed here so scheduling cannot accidentally target production. */
export async function runEvaluateProbe(config, deps = { fetch, now: () => performance.now() }) {
  const runId = randomUUID();
  const measurements = [];
  for (let index = 0; index < REQUESTS; index += 1) {
    const started = deps.now();
    let response;
    let body;
    try {
      response = await deps.fetch(`${BASE_URL}/api/sdk/evaluate`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${config.clientKey}`,
          "content-type": "application/json",
          "idempotency-key": `evaluate-probe-${runId}-${index}`,
        },
        body: JSON.stringify({
          flagKey: "shared-preview-smoke",
          targetingKey: `evaluate-probe-${runId}`,
          idType: "user",
          attributes: {},
        }),
      });
      body = await response.json();
    } catch {
      // Provider errors can include request headers. Emit only our bounded diagnostic.
      throw new Error(`evaluate probe request ${index + 1} failed to complete`);
    }
    if (!response.ok) {
      throw new Error(`evaluate probe request ${index + 1} returned HTTP ${response.status}`);
    }
    if (typeof body !== "object" || body === null || !Object.hasOwn(body, "variant")) {
      throw new Error(`evaluate probe request ${index + 1} did not resolve a Variant`);
    }
    measurements.push({
      elapsedMs: Math.round((deps.now() - started) * 100) / 100,
      cfRay: response.headers.get("cf-ray"),
    });
  }
  const ordered = measurements.map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b);
  return {
    platformTarget: "shared-preview",
    route: "POST /api/sdk/evaluate",
    requests: REQUESTS,
    medianMs: ordered[2],
    p95Ms: ordered[4],
    maxMs: ordered[4],
    measurements,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    console.log(JSON.stringify(await runEvaluateProbe(readConfig(process.env)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
