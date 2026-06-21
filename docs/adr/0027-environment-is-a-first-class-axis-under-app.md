# Environment is a first-class axis under App; per-Environment config, credentials, data, and policy

**Status:** accepted

splitch introduces **Environment** as a first-class tier *under* the App: a named deployment context
(`dev`, `prod`, and any others the user defines). An App **spans** one or more Environments. This is the
standard LaunchDarkly/Statsig environment model, and it is a **second axis** orthogonal to the Flag
catalog: the App axis says *which product*, the Environment axis says *which deployment context*.

The original model (ADR-0017, CONTEXT.md) said "the five runtimes of one product share a single App —
define a flag once, consume it everywhere." That remains true for the Flag's **definition**, but it was
silently carrying a second job it should not: it implied one live configuration per Flag. Real use needs
the *same* Flag (a model-ID string, a copy block, a gating boolean) to carry **different live values in
dev and prod** — you trial a model in dev, vet it, and only then let it reach production traffic. "Define
once" is a property of the Flag *definition*; the live *configuration* must diverge per Environment.

**What is per-Environment vs. per-App.** The split is drawn so the App axis holds *identity and schema*
(defined once) and the Environment axis holds *live configuration and runtime artifacts* (diverge per
context):

| Concept | Axis |
|---|---|
| Flag existence, key, user-defined schema, Variant catalog, Default Variant | **App** |
| Flag Configuration: available Variants, targeting, rollout, enabled state | **Environment** (ADR-0028) |
| Client Key, API Key | **Environment** |
| Experiments, Experiment Runs, Exposures / analysis data | **Environment** |
| Metric definitions, Segments | **App** (defined once, usable in any Environment) |
| Members, billing, roles | **Org / App** (unchanged, ADR-0021) |
| Environment Policy (confirm gates) | **Environment** (ADR-0029) |

**Credentials are per-Environment.** Both the secret API Key and the public Client Key reach exactly one
Environment's data plane — a prod API Key reads prod config only. This keeps "one credential = one
Environment" true for both key types, which is the clean isolation story; a customer's server runtime
selects its env-scoped API Key the same way it selects any per-environment config (its own `ENV` decides
which key it loads). A single key spanning environments would be a leak vector (staging reading prod) and
a footgun.

**Experiment data is per-Environment.** Exposures, Experiment Runs, and analysis are scoped to an
Environment; dev traffic must never enter prod's analysis. The `app_id` isolation seam (ADR-0018) gains
`environment_id` as a co-scope; the data-access seam scopes by `(app_id, environment_id)`.

**Environment is a URL scope segment, not hidden state.** The control panel routes
`/{orgSlug}/{appSlug}/{env}/…`. The active Environment is in the URL — the same no-hidden-state discipline
as `appId` (the spine, ADR-0019/frontend). An environment switcher swaps the segment. (Slugs are
URL-presentation only; IDs are canonical in code and data — the router resolves slug → ID at the edge.)

## Considered options

- **No Environment tier; one config per Flag (the pre-this-ADR model)** — rejected. There is no home for
  "dev value vs. prod value," no way to vet a Variant before it reaches production, and the "extra check
  for prod" the user wants has nowhere structural to attach. Stretching the single App config to mean both
  dev and prod is the same one-object-two-jobs conflation the glossary exists to prevent.
- **Environment as a separate App per environment** (e.g. `myapp-dev`, `myapp-prod`) — rejected. It breaks
  "define a flag once": the Flag definition would be duplicated across Apps and drift, Metrics/Segments
  would be redefined per env, and Promotion would be a cross-App copy with no shared identity to diff
  against. Environment under one App keeps the definition shared and the configuration diverging.
- **Environment as hidden session/cookie state, not in the URL** — rejected for the same reason `appId` is
  in the URL (frontend spine): a pasted link to a prod flag must not render dev's config depending on the
  viewer's cookie. Scope belongs in the URL.
- **One credential spanning all environments, env chosen per request** — rejected. A single secret that can
  read any environment is a blast-radius and leak problem; per-Environment keys bound the reach of a leaked
  key to one context.

## Consequences

- **CONTEXT.md gains canonical terms** Environment, Flag Configuration, Promotion, Environment Policy,
  Confirmation; App, Variant, and both credential entries are amended to name the Environment axis.
- **D1 gains an Environment tier** under App, and `environment_id` joins `app_id` on the credential tables,
  the Flag Configuration rows, and all experiment/exposure data. The isolation seam scopes by
  `(app_id, environment_id)`.
- **The frontend spine gains a third URL segment** (`/{orgSlug}/{appSlug}/{env}/…`) and an environment
  switcher; `appid-is-the-spine.md` and `session-loader-isolation.md` are reconciled to the two-then-three
  level scope (org → app → env).
- **Promotion (ADR-0028) and Environment Policy (ADR-0029) become possible** — both are defined entirely in
  terms of moving/guarding configuration across this new axis.
- **Slugs are URL-only.** `orgSlug`/`appSlug` (and the `env` segment) are human/agent-readable handles;
  code and data use IDs, resolved once at the router.
