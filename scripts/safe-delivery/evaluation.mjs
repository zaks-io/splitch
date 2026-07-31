/**
 * Data-plane resolution helpers. The tracer only ever calls `sdk_verify`, which
 * resolves a Flag WITHOUT firing an Exposure: this proof is about delivery
 * safety, not measurement, so it must not pollute the Exposure log.
 */

import { assertVariant, POLL_INTERVAL_MS } from "./constants.mjs";

async function verifyResolution(deps, options) {
  const response = await deps.fetch(`${deps.evaluationBaseUrl}/api/sdk/verify`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.clientKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      flagKey: options.flagKey,
      targetingKey: options.targetingKey,
      idType: options.idType ?? "user",
      attributes: options.attributes ?? {},
    }),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`sdk_verify failed with HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

/** Assert a resolution that must already be settled (no propagation expected). */
export async function assertResolvesNow(deps, options, expected, label) {
  assertVariant(await verifyResolution(deps, options), expected, label);
}

/**
 * Poll until the expected Variant appears, bounded by the documented KV
 * propagation window. Used only after a write that is expected to change
 * resolution.
 */
export async function waitForVariant(deps, options, expected, label, windowMs) {
  const deadline = Date.now() + windowMs;
  let lastError;
  for (;;) {
    try {
      assertVariant(await verifyResolution(deps, options), expected, label);
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() > deadline) break;
      await sleep(deps, POLL_INTERVAL_MS);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${label}: Variant did not propagate within ${windowMs}ms`);
}

/**
 * Assert a resolution stays put for the whole propagation window. This is the
 * negative half of "prod changes only after a valid confirm Review": a single
 * sample right after the write could pass simply because nothing propagated yet.
 */
export async function assertVariantStable(deps, options, expected, label, windowMs) {
  const deadline = Date.now() + windowMs;
  for (;;) {
    assertVariant(await verifyResolution(deps, options), expected, label);
    if (Date.now() >= deadline) return;
    await sleep(deps, POLL_INTERVAL_MS);
  }
}

function sleep(deps, ms) {
  if (deps.sleep) return deps.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
