# Environments & promotion UX

> **Status: superseded by [screen-inventory.md](./screen-inventory.md).** The Control Panel UX
> session designed these screens there: the Promotion diff screen, the Approval Request / Review
> workflow (confirm now, second-person approve later), the Confirmation UX, and the per-Environment
> flag screen. This file is retained for its settled-domain summary and cross-references; the
> screens live in the inventory.

## What is settled (see the ADRs / control-plane specs)

- **Environment** is a URL scope segment `/{orgSlug}/{appSlug}/{env}/…` with an environment switcher
  (ADR-0027, [navigation-and-ia.md](./navigation-and-ia.md)).
- **Flag Configuration** is per-Environment (available Variants, targeting, rollout, enabled state);
  the Flag _definition_ (key, schema, Variant catalog) is App-level (ADR-0028).
- **Promotion** copies a Flag Configuration — or one Variant's availability — between Environments
  (`POST /apps/{app_id}/envs/{target_environment_id}/flags/{flag_id}/promote`,
  [../control-plane/endpoints-flag-segment.md](../control-plane/endpoints-flag-segment.md)).
- **Environment Policy** gates change types at `allow | confirm`; the **Confirmation** guards the
  commit; the kill-switch-off is never gated (ADR-0029).

## Where these screens are designed (see [screen-inventory.md](./screen-inventory.md))

- **The environment switcher** — placement, contents, dev-vs-prod affordance: in the App-shell top
  bar alongside the org and app switchers, absent from the Org shell
  ([screen-inventory.md](./screen-inventory.md), [navigation-and-ia.md](./navigation-and-ia.md)).
- **The promotion screen + diff view** — the dev-vs-prod Flag Configuration diff that drives a
  Promotion (the safest entry point per ADR-0028), including availability-only vs whole-config
  promotion and single-Variant promotion ([screen-inventory.md](./screen-inventory.md)).
- **The Confirmation UX** — how a Policy-gated change surfaces its confirm step in the panel, with the
  parity confirm step over CLI/MCP ([screen-inventory.md](./screen-inventory.md)).
- **Environment Policy editor** — the per-change-type gate grid that grows into approval
  ([screen-inventory.md](./screen-inventory.md)).
- **Per-Environment flag screen** — how the App-level catalog and the per-Environment available set /
  targeting are shown together without confusing "defined" vs "available here"
  ([screen-inventory.md](./screen-inventory.md)).

## Sources

- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [ADR-0028](../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md)
- [ADR-0029](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md)
