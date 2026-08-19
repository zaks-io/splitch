#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { getFlagConfig, patchFlagConfig, requireOk } from "./safe-delivery/control-plane.mjs";

const POLL_INTERVAL_MS = 250;
const PROPAGATION_LIMIT_MS = 5_000;
const TOGGLE_COUNT = 6;

export function readConfig(env) {
  if (env.SPLITCH_PROPAGATION_CONFIRM_PRODUCTION !== "I_UNDERSTAND_THIS_MUTATES_PRODUCTION") {
    throw new Error("production mutation confirmation is required");
  }
  return {
    authBaseUrl: "https://auth.splitch.dev",
    controlPlaneBaseUrl: "https://api.splitch.dev",
    evaluationBaseUrl: "https://edge.splitch.dev",
    clientId: required(env, "SPLITCH_PROPAGATION_CLIENT_ID"),
    clientSecret: required(env, "SPLITCH_PROPAGATION_CLIENT_SECRET"),
    appId: required(env, "SPLITCH_PROPAGATION_APP_ID"),
    environmentId: required(env, "SPLITCH_PROPAGATION_ENVIRONMENT_ID"),
    flagId: required(env, "SPLITCH_PROPAGATION_FLAG_ID"),
    flagKey: required(env, "SPLITCH_PROPAGATION_FLAG_KEY"),
    clientKey: required(env, "SPLITCH_PROPAGATION_CLIENT_KEY"),
  };
}

export function median(values) {
  if (values.length === 0) throw new Error("cannot calculate a median with no measurements");
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

export function assertPropagationThresholds(measurements) {
  if (measurements.length !== TOGGLE_COUNT) {
    throw new Error(`expected ${TOGGLE_COUNT} completed toggles, got ${measurements.length}`);
  }
  const durations = measurements.map(({ elapsedMs }) => elapsedMs);
  const summary = { medianMs: median(durations), maxMs: Math.max(...durations) };
  if (summary.medianMs >= PROPAGATION_LIMIT_MS || summary.maxMs >= PROPAGATION_LIMIT_MS) {
    throw new Error(`propagation threshold breached: ${JSON.stringify(summary)}`);
  }
  return summary;
}

async function runProductionPropagationHarness(config, deps = runtimeDeps()) {
  const accessToken = await mintAccessToken(config, deps.fetch);
  const runId = crypto.randomUUID();
  const controlPlane = {
    accessToken,
    controlPlaneBaseUrl: config.controlPlaneBaseUrl,
    fetch: deps.fetch,
    runId,
  };
  const original = await getFlagConfig(
    controlPlane,
    config.appId,
    config.environmentId,
    config.flagId,
  );
  const measurements = [];
  let expectedEnabled = original.enabled;

  try {
    for (let index = 0; index < TOGGLE_COUNT; index += 1) {
      expectedEnabled = !expectedEnabled;
      const write = requireOk(
        await patchFlagConfig(
          controlPlane,
          config.appId,
          config.environmentId,
          config.flagId,
          { enabled: expectedEnabled },
          `propagation-${index + 1}`,
        ),
        `production propagation toggle ${index + 1}`,
      );
      if (write.approvalRequest !== null || write.config?.enabled !== expectedEnabled) {
        throw new Error(`toggle ${index + 1} was not committed directly`);
      }

      measurements.push(
        await waitForResolution(config, deps, {
          runId,
          toggle: index + 1,
          enabled: expectedEnabled,
          version: write.config.version,
        }),
      );
    }
  } finally {
    if (expectedEnabled !== original.enabled) {
      requireOk(
        await patchFlagConfig(
          controlPlane,
          config.appId,
          config.environmentId,
          config.flagId,
          { enabled: original.enabled },
          "propagation-restore",
        ),
        "restore original production Flag state",
      );
    }
  }

  return { measurements, ...assertPropagationThresholds(measurements) };
}

export async function waitForResolution(config, deps, expected) {
  const startedAt = deps.now();
  let polls = 0;
  for (;;) {
    polls += 1;
    const targetingKey = `splitch-propagation-${expected.runId}-${expected.toggle}-${polls}-${crypto.randomUUID()}`;
    const response = await deps.fetch(`${config.evaluationBaseUrl}/api/sdk/verify`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.clientKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        flagKey: config.flagKey,
        targetingKey,
        idType: "user",
        attributes: {},
      }),
    });
    const body = await response.json().catch(() => null);
    const elapsedMs = deps.now() - startedAt;
    // Transient edge faults (live-update connect gaps, STALE → HTTP errors) are
    // expected inside the five-second window; keep polling until the deadline.
    if (response.ok && resolutionMatches(body, expected.enabled)) {
      if (elapsedMs >= PROPAGATION_LIMIT_MS) {
        throw new Error(`toggle ${expected.toggle} reached the edge in ${elapsedMs}ms`);
      }
      return {
        toggle: expected.toggle,
        committedVersion: expected.version,
        enabled: expected.enabled,
        elapsedMs,
        polls,
        cfRay: response.headers.get("cf-ray"),
      };
    }
    if (elapsedMs >= PROPAGATION_LIMIT_MS) {
      throw new Error(
        `toggle ${expected.toggle} timed out after ${elapsedMs}ms` +
          (response.ok
            ? `: ${JSON.stringify(body)}`
            : ` (last HTTP ${response.status}: ${JSON.stringify(body)})`),
      );
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

function resolutionMatches(body, enabled) {
  if (enabled)
    return body?.reason !== "DISABLED" && body?.reason !== "ERROR" && body?.reason !== "STALE";
  return body?.reason === "DISABLED";
}

async function mintAccessToken(config, fetcher) {
  const response = await fetcher(`${config.authBaseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });
  if (!response.ok) throw new Error(`oauth2 token request failed with HTTP ${response.status}`);
  const body = await response.json();
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new Error("oauth2 token response omitted access_token");
  }
  return body.access_token;
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function runtimeDeps() {
  return {
    fetch,
    now: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const result = await runProductionPropagationHarness(readConfig(process.env));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
