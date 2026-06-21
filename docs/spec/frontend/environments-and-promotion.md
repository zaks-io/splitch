# Environments & promotion UX

> **Status: stub — deferred to the Control Panel UX design session.** The domain model
> (ADR-0027/0028/0029) and the control-plane endpoints are pinned; the _screens_ are not yet
> designed. This file exists so cross-references resolve and lists what the UX session must cover.

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

## What the UX session must design (open)

- **The environment switcher** — placement, what it shows, dev-vs-prod affordance.
- **The promotion screen + diff view** — the dev-vs-prod Flag Configuration diff that drives a
  Promotion (the safest entry point per ADR-0028); how availability-only vs whole-config promotion
  is chosen; how a single Variant is promoted.
- **The Confirmation UX** — how a Policy-gated change surfaces its confirm step in the panel (and the
  parity confirm step over CLI/MCP).
- **Environment Policy editor** — how a user configures per-change-type gates per Environment.
- **Per-Environment flag screen** — how the App-level catalog and the per-Environment available set /
  targeting are shown together without confusing "defined" vs "available here".

## Sources

- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [ADR-0028](../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md)
- [ADR-0029](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md)
