import type { DocBlock } from "./blocks";

/**
 * Public Flags guide: Flag definition vs per-Environment Configuration.
 * Indexed from llms.txt so agents can discover enable/rollout without reverse-engineering.
 */
export const flagsDoc = {
  title: "Flags",
  summary:
    "Per-Environment Configuration: enabled, rollout, availableVariantNames, and Targeting Rules.",
  blocks: [
    {
      kind: "prose",
      text: "A Flag is defined once per App (key, Variants, Default Variant). What each Environment serves is a separate Flag Configuration. Creating a Flag does not turn it on.",
    },
    {
      kind: "heading",
      text: "Fresh Configuration defaults",
    },
    {
      kind: "prose",
      text: 'A newly created Flag starts with Configuration `enabled: false` and `rollout: null` in every Environment. Until you change those, evaluation returns the Default Variant with `reason: "DISABLED"` — that is an inert Flag, not a successful rollout.',
    },
    {
      kind: "code",
      lang: "bash",
      code: "splitch flag-config get new-checkout --json",
    },
    {
      kind: "heading",
      text: "Enable and roll out",
    },
    {
      kind: "prose",
      text: "Flip both controls in one call when you want the non-default Variant for everyone in the Environment:",
    },
    {
      kind: "code",
      lang: "bash",
      code: "splitch flag-config update new-checkout --enabled true --rollout 100",
    },
    {
      kind: "list",
      items: [
        "`--enabled true` — the Flag is live; `false` is the kill switch and always returns the Default Variant with `DISABLED`.",
        '`--rollout 100` — baseline percentage for traffic that matches no Targeting Rule. `100` serves the non-default candidate for everyone; omit or leave `null` to keep the Default Variant after enable (`reason: "DEFAULT"`).',
        "Pass `--rollout none` to clear the baseline. The server owns the bucketing salt; you never set it.",
      ],
    },
    {
      kind: "heading",
      text: "availableVariantNames",
    },
    {
      kind: "prose",
      text: '`availableVariantNames` narrows which catalog Variants this Environment may serve. Empty means never narrowed — the full Flag catalog is eligible — not "nothing is promoted." That is why `--rollout 100` works on a fresh Flag without first listing Variants.',
    },
    {
      kind: "heading",
      text: "Targeting Rules",
    },
    {
      kind: "prose",
      text: "Ordered rules decide matched traffic before the baseline rollout. First match wins. Rules may only target Variants in the Environment's available set (or the full catalog when that set is empty).",
    },
    {
      kind: "code",
      lang: "bash",
      code: "splitch flag-targeting-rules replace new-checkout --body-json '<TargetingRulesReplaceRequest JSON>'",
    },
    {
      kind: "prose",
      text: "A matched rule's own percentage (if any) splits that rule's traffic; the Configuration `rollout` only decides fall-through traffic that matched no rule.",
    },
    {
      kind: "heading",
      text: "Verify what you configured",
    },
    {
      kind: "code",
      lang: "bash",
      code: `splitch flags verify new-checkout --targeting-key test-user-1 --json
# before enable:  {"value":false,"variantName":"off","reason":"DISABLED"}
# after enable+100: {"value":true,"variantName":"on","reason":"SPLIT"}`,
    },
    {
      kind: "prose",
      text: "See the [platform quickstart](/quickstart) for the full zero-to-resolving path.",
    },
  ] as const satisfies readonly DocBlock[],
} as const;
