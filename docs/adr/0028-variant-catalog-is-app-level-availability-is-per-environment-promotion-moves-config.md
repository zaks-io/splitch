# Variant catalog is App-level; availability is per-Environment; Promotion moves Flag Configuration between Environments

**Status:** accepted

Given Environment as a first-class axis (ADR-0027), this ADR pins **where a Variant's availability lives**
and **what Promotion is**. The driving use case: a Flag whose value is a user-defined-schema-shaped value
(a model ID, a copy block, a config object) where the wrong value breaks production. The user must be able
to trial Variants in dev and let only vetted ones reach prod — and that safety must be **structural**, not
a procedure someone can forget.

**The Variant catalog is App-level; availability is per-Environment.** A Flag has one **Variant catalog**
(the full set of Variants, defined once against the Flag's schema). Each Environment's **Flag
Configuration** names `available_variant_names` — the subset of the catalog that may be served _in that
Environment_. A Variant not in an Environment's available set **cannot be served there** by any targeting
rule or rollout, and cannot be used by an Experiment Run in that Environment. So a half-tested model name
lives in the catalog, is available and served in dev, and is **structurally unable to reach prod traffic**
until it is promoted — the "extra check for prod" is enforced by the data model, not by discipline.

**Availability lives on the Environment's Flag Configuration, not on the Variant.** The available set is a
field of the per-Environment Flag Configuration (`available_variant_names: string[]`), referencing catalog
Variants by name. It is **not** a per-Variant-per-Environment matrix scattered across Variant rows. This
keeps **one config object per Environment** as the unit that is edited, audited, diffed, and promoted —
rather than reconstructing an environment's state from a matrix.

**Promotion moves a selected subset of Flag Configuration between Environments.** _Promote_ is the verb for
copying configuration from a source Environment to a target. Because availability and value/targeting are
**separate promotable acts** (making a Variant _available_ is distinct from _setting it to actually be
served_), Promotion is **per-field-group**, not all-or-nothing and not only the two coarse presets "whole
config" / "one Variant." The promotable field-groups are: **each Variant's availability** (one act per
Variant), the **targeting rule list** (atomic — the ordered, first-match-wins list promotes whole or not at
all, never per-rule, so a reordered hybrid can never be produced), the **rollout**, and the **enabled
state**. "Promote whole config" and "promote one Variant's availability" are the two named presets of this
one mechanism, not separate operations. The Environment Policy (ADR-0029) decides which of these acts
requires a Confirmation, independently. Promotion is distinct from **Start** (which opens an Experiment Run
for measurement) and from a plain in-place flag edit (which changes one Environment without reference to
another).

**A promoted subset must leave the target internally consistent — enforced at the Worker, eased in the
panel.** Promoting a targeting rule that routes to a Variant not available in the target is a dangling
reference (ADR-0028: an unavailable Variant is structurally unservable). The Worker **rejects** such an
Approval Request with a structured error naming the missing Variant — fail-loud, no silent fix (ADR-0036).
The panel removes the friction without hiding the act: it **offers** to also tick the depended-on Variant's
availability (visibly, "added because rule X needs it"), but if submitted with the dependency unticked the
Worker still blocks it. Convenience lives in the skin; the invariant lives in the Worker (ADR-0023), so the
strictness cannot be skinned away and the friction-reducing nudge is just a panel affordance the CLI/MCP may
reproduce or not.

## Considered options

- **Availability as a per-Variant-per-Environment matrix** (each Variant row carries its env flags) —
  rejected. The same data, but scattered: an Environment's state can't be read, diffed, or promoted as one
  object; Promotion becomes a fan-out of per-Variant edits instead of one config copy.
- **No availability concept; every catalog Variant servable in every Environment** — rejected. This removes
  the structural safety entirely: a half-tested model name could be targeted in prod the moment it is
  created. The whole point is that unpromoted Variants cannot reach prod.
- **Per-Environment Variant catalogs (no shared catalog)** — rejected. Variants would be redefined per env
  and drift; "define once" is lost and there is no shared identity for Promotion to diff against. The catalog
  is shared; only availability diverges.
- **Promotion as a single all-or-nothing act** (availability and targeting always move together) — rejected.
  The user explicitly wants these separable and independently gated: "make it available" is a smaller,
  safer act than "serve it to 100% of prod." Keeping them distinct lets Policy gate them at different levels.
- **Promotion as only the two coarse presets** (`scope: "config" | "variant"` and nothing between) —
  rejected. It cannot express "promote these two rules' worth of config but not the rollout," which is the
  realistic prod-promotion task. The two presets survive as named buttons over the per-field-group mechanism.
- **Per-targeting-rule promotion** (tick rule #1 and #3, skip #2) — rejected. Targeting is an ordered,
  first-match-wins list; a per-rule subset yields a reordered list that behaves like neither source nor
  target. Targeting promotes as one atomic group.
- **Auto-fixing dangling references silently / allowing them and failing at eval** — both rejected. Silent
  auto-tick is the hidden side effect the edit-taxonomy works to avoid; shipping a known-dangling rule to
  prod violates "mistakes against prod are hard." The chosen path is offer-in-panel, block-at-Worker.

## Consequences

- **Flag Configuration carries `available_variant_names`** (subset of the App-level catalog) alongside
  targeting, rollout, and enabled state — per Environment.
- **The evaluate/serve path enforces availability**: a targeting rule or rollout referencing an unavailable
  Variant in an Environment is rejected/ignored, never served. SDK and control-plane validation both check
  membership in the Environment's available set.
- **Promotion is a first-class control-plane operation** (`promote` in CLI/MCP and the panel), copying a
  source Environment's Flag Configuration (or one Variant's availability) into a target, subject to the
  target's Environment Policy (ADR-0029).
- **CONTEXT.md** gains Flag Configuration and Promotion, and amends Variant to split catalog from
  availability.
- **A diff view is implied** — Promotion is most safely driven from a dev-vs-prod Flag Configuration diff;
  specified in the frontend environments-and-promotion spec.
