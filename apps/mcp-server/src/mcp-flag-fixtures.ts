/**
 * The `flags_list` response body the MCP tests hand back from a fake upstream.
 *
 * Shared because it is a wire CONTRACT, not per-test data: every field the
 * Control Plane's bounded Flag list returns has to be here or the SDK rejects
 * the body, and two copies drift the moment the envelope grows a field.
 */
export const flagDefinition = {
  id: "flag_checkout",
  appId: "app_local",
  key: "checkout",
  name: "Checkout",
  variants: [{ id: "var_on", name: "on", value: true }],
  defaultVariantId: "var_on",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

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
