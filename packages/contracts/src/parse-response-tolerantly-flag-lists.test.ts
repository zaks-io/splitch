import { describe, expect, it } from "vitest";
import { parseResponseTolerantly } from "./parse-response-tolerantly";
import {
  FlagListReadResponseSchema,
  PrincipalFlagListReadResponseSchema,
} from "./resource-envelopes-flag";

const flag = {
  id: "flag_checkout",
  appId: "app_local",
  key: "checkout",
  name: "Checkout",
  variants: [{ id: "var_on", name: "on", value: true }],
  defaultVariantId: "var_on",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
};
const scope = { org: { id: "org_1", slug: "acme" }, app: { id: "app_local", key: "shop" } };
const configuration = {
  environmentId: "env_prod",
  enabled: true,
  availableVariantNames: ["on"],
  targetingRules: [],
  rollout: null,
  experiment: null,
};

function list(item: Record<string, unknown>) {
  return { items: [item], readTruncated: false, readLimit: 200, cursor: null };
}

describe.each([
  ["App Flag list", FlagListReadResponseSchema, flag],
  ["principal Flag list", PrincipalFlagListReadResponseSchema, { ...flag, ...scope }],
] as const)("%s hydration", (_name, schema, item) => {
  it("parses a valid hydrated list unchanged", () => {
    const body = list({ ...item, configurations: [configuration] });
    expect(parseResponseTolerantly(schema, body)).toEqual({ success: true, data: body });
  });

  it("rejects a malformed nested Configuration instead of downgrading to a summary list", () => {
    const body = list({ ...item, configurations: [{ ...configuration, enabled: "yes" }] });
    expect(parseResponseTolerantly(schema, body).success).toBe(false);
  });
});
