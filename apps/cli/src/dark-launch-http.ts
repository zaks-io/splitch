import { expect } from "vitest";
import { appScope } from "@splitch/db";
import { quickstartOrigins, type QuickstartHarness } from "./quickstart-local-harness.js";

const FLAG_KEY = "dark-launch-demo";

export type PackedSdk = {
  createSplitchClient(options: { clientKey: string; endpoint: string; fetch: typeof fetch }): {
    verify(
      flagKey: string,
      context: { targetingKey: string; attributes?: Record<string, unknown> },
    ): Promise<{
      value: unknown;
      variantName: string | null;
      reason: string;
      errorCode?: string;
    }>;
    evaluateDetails(
      flagKey: string,
      context: {
        targetingKey: string;
        attributes?: Record<string, unknown>;
        idempotencyKey: string;
      },
    ): Promise<{
      value: unknown;
      variantName: string | null;
      reason: string;
      errorCode?: string;
    }>;
  };
};

export async function expectVariant(
  client: ReturnType<PackedSdk["createSplitchClient"]>,
  targetingKey: string,
  attributes: Record<string, unknown>,
  expectedName: "on" | "off",
): Promise<void> {
  const details = await client.verify(FLAG_KEY, { targetingKey, attributes });
  expect(details.reason).not.toBe("ERROR");
  const name =
    details.variantName ?? (details.value === true ? "on" : details.value === false ? "off" : null);
  expect(name).toBe(expectedName);
}

export async function variantId(
  harness: QuickstartHarness,
  flagId: string,
  name: string,
): Promise<string> {
  const scope = appScope(harness.appId);
  const variants = await harness.repo.flags.listVariants(scope, flagId);
  const variant = variants.find((item) => item.name === name);
  if (!variant) throw new Error(`missing Variant ${name}`);
  return variant.id;
}

export async function controlPlaneGet<T>(
  harness: QuickstartHarness,
  path: string,
  token = harness.accessToken,
): Promise<T> {
  const response = await harness.routingFetch(`${quickstartOrigins.controlPlaneBaseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export async function controlPlanePost<T>(
  harness: QuickstartHarness,
  path: string,
  body: Record<string, unknown>,
  token = harness.accessToken,
): Promise<T> {
  const response = await harness.routingFetch(`${quickstartOrigins.controlPlaneBaseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${path} failed ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export async function controlPlaneDelete(
  harness: QuickstartHarness,
  path: string,
  token = harness.accessToken,
): Promise<void> {
  const response = await harness.routingFetch(`${quickstartOrigins.controlPlaneBaseUrl}${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.ok).toBe(true);
}
