import { describe, expect, it } from "vitest";
import { getRoute } from "./route-registry";

/**
 * SPL-451: get and write must agree on where every shared field lives, and
 * every named list command must report its own bound. A missing key renders
 * as `null` in jq and disguises a shape mismatch as "not configured."
 */

function objectKeys(schema: unknown): string[] {
  const shape = (schema as { shape?: Record<string, unknown> } | undefined)?.shape;
  return shape ? Object.keys(shape).sort() : [];
}

function resourceKeys(schema: unknown, sideChannels: readonly string[]): string[] {
  return objectKeys(schema).filter((key) => !sideChannels.includes(key));
}

describe("CLI/MCP JSON envelopes agree per verb class (SPL-451)", () => {
  it.each([
    {
      get: "flag_config_get",
      write: "flag_config_update",
      sideChannels: ["approvalRequest"],
    },
    {
      get: "flag_config_get",
      write: "flag_targeting_rules_replace",
      sideChannels: ["approvalRequest"],
    },
    {
      get: "flag_config_get",
      write: "flags_promote",
      sideChannels: ["approvalRequest", "diff"],
    },
    {
      get: "flags_get",
      write: "flags_update",
      sideChannels: [],
    },
    {
      get: "flags_get",
      write: "flag_variants_update",
      sideChannels: ["approvalRequest"],
    },
  ] as const)("$get and $write agree on the location of every shared field", ({
    get,
    write,
    sideChannels,
  }) => {
    const getKeys = objectKeys(getRoute(get)?.output);
    const writeKeys = resourceKeys(getRoute(write)?.output, sideChannels);
    expect(getKeys.length).toBeGreaterThan(0);
    expect(writeKeys).toEqual(getKeys);
  });

  it.each([
    "flags_list",
    "api_keys_list",
    "approval_requests_list",
  ] as const)("%s returns {items, readLimit, readTruncated}", (operationId) => {
    const keys = objectKeys(getRoute(operationId)?.output);
    expect(keys).toEqual(expect.arrayContaining(["items", "readLimit", "readTruncated"]));
  });
});
