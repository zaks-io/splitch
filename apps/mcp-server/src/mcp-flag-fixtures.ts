import { flagResourceFixture } from "@splitch/contracts/testing";
// Keep MCP-specific values here; the canonical builder owns required wire fields.
export const flagDefinition = flagResourceFixture({
  key: "checkout",
  name: "Checkout",
  id: "flag_checkout",
  appId: "app_local",
  variants: [{ id: "var_on", name: "on", value: true }],
  defaultVariantId: "var_on",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
});

export const flagPage = {
  readTruncated: false,
  readLimit: 200,
  cursor: null,
  items: [
    {
      ...flagDefinition,
      configurations: [
        {
          environmentId: "env_dev",
          enabled: true,
          availableVariantNames: ["on"],
          targetingRules: [],
          rollout: null,
          experiment: { id: "exp_checkout", key: "checkout-copy" },
        },
      ],
    },
  ],
};
