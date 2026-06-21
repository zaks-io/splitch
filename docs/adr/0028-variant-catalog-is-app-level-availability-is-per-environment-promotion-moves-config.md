# Variant catalog is App-level; availability is per-Environment; Promotion moves Flag Configuration between Environments

**Status:** accepted

Given Environment as a first-class axis (ADR-0027), this ADR pins **where a Variant's availability lives**
and **what Promotion is**. The driving use case: a Flag whose value is a user-defined-schema-shaped value
(a model ID, a copy block, a config object) where the wrong value breaks production. The user must be able
to trial Variants in dev and let only vetted ones reach prod — and that safety must be **structural**, not
a procedure someone can forget.

**The Variant catalog is App-level; availability is per-Environment.** A Flag has one **Variant catalog**
(the full set of Variants, defined once against the Flag's schema). Each Environment's **Flag
Configuration** names `available_variant_names` — the subset of the catalog that may be served *in that
Environment*. A Variant not in an Environment's available set **cannot be served there** by any targeting
rule or rollout, and cannot be used by an Experiment Run in that Environment. So a half-tested model name
lives in the catalog, is available and served in dev, and is **structurally unable to reach prod traffic**
until it is promoted — the "extra check for prod" is enforced by the data model, not by discipline.

**Availability lives on the Environment's Flag Configuration, not on the Variant.** The available set is a
field of the per-Environment Flag Configuration (`available_variant_names: string[]`), referencing catalog
Variants by name. It is **not** a per-Variant-per-Environment matrix scattered across Variant rows. This
keeps **one config object per Environment** as the unit that is edited, audited, diffed, and promoted —
rather than reconstructing an environment's state from a matrix.

**Promotion moves Flag Configuration between Environments.** *Promote* is the verb for copying configuration
from a source Environment to a target — either a whole Flag Configuration ("promote this flag's dev config
to prod") or a single Variant's availability ("make `gpt-5` available in prod"). Availability and
value/targeting are **separate promotable acts**: making a Variant *available* in an Environment is distinct
from *setting it to actually be served* (targeting/rollout). The Environment Policy (ADR-0029) decides which
of these acts requires a Confirmation, independently. Promotion is distinct from **Start** (which opens an
Experiment Run for measurement) and from a plain in-place flag edit (which changes one Environment without
reference to another).

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
