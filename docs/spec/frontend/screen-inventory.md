# Control-panel screen inventory

The complete map of control-panel screens: every route, what it shows, what a user does on it.
The [navigation-and-ia.md](./navigation-and-ia.md) doc pins the URL spine and sidebar sections;
this doc pins the **screens** that hang off them. Terms are used exactly as
[`CONTEXT.md`](../../../CONTEXT.md) defines them.

> **Status: laid out.** The Control Panel UX session settled the screen map below, including the
> Overview card set (ship all; thresholds tuned from real data later) and onboarding (agent-first is
> the primary path). What remains is **data-dependent tuning** (numeric thresholds for the attention
> cards) and the **detailed onboarding screen sequence** (its shape — parity, agent-primary — is
> pinned; the individual screens are not). Neither blocks implementation of the screens.

## Every screen is one skin of a three-skin operation

This doc lays out the **panel** (the visual skin), but no capability here is panel-only. Per
ADR-0023 the control plane is operated through **three parity skins** over one Control Plane SDK —
the **panel**, the **CLI** (humans at a terminal), and the **remote MCP server** (agents). Every
operation a screen exposes is the same SDK method the CLI command and MCP tool call; a new
capability becomes a screen affordance _and_ a CLI command _and_ an MCP tool, never one without the
others.

**Parity is at the operations layer, not the presentation layer.** "Everything you can do in the
panel you can do in the CLI" is true of _capability_ — every operation is reachable on all three
skins. It is deliberately **not** true that they look or behave identically: the panel renders
screens, the CLI returns formatted text + exit codes, the MCP server returns typed tool results.
The shared thing is the SDK method; the rendering is audience-appropriate and intentionally
different (ADR-0023 rejected a shared renderer as making all three worse). So when this doc
describes a screen, the capability it exposes is a contract the CLI and MCP inherit — the _screen_
is panel-only, the _operation behind it_ is not.

Crucially, **the dangerous-action protections below are not UI tricks** — they are Worker-enforced
invariants (ADR-0023: "the Control Plane API Worker is the sole guardian of every management
invariant"). The panel renders a locked field; the CLI refuses the same edit with an actionable
error; the MCP server returns the same structured refusal. The safety lives in the Worker, so it
cannot be skinned away. Where a flow below has a notable terminal/agent shape, it is called out
inline as **CLI/MCP parity**.

## Two shells

The panel has two nested shells, matching the two URL scope roots:

- **Org shell** — `/{orgSlug}/...`. The App list, org members, billing. **No environment switcher**
  (environments live under an App). The org switcher (present only for multi-org users) and the
  user menu live in its top bar.
- **App shell** — `/{orgSlug}/{appSlug}/{env}/...`. The persistent left sidebar (Flags, Experiments,
  Segments, Metrics, Settings) and a top bar carrying all **three switchers** (org, app, environment).
  Everything below the App root is scoped to `(appId, environmentId)` resolved from the URL.

## App landing — the Overview

Navigating to a bare `/{orgSlug}/{appSlug}/{env}` (no section) lands on the **App Overview**, a
purpose-built "what needs my attention" dashboard — **not** a redirect to Flags and **not** a
resume-last-section (that would be the hidden session state the spine principle forbids).

The Overview earns its place because splitch's value is statistical rigor as an enforced contract
(ADR-0030), and the dangerous states are precisely the ones nobody is actively looking at. It
surfaces, scoped to the active `(appId, environmentId)`:

- **Experiments needing a decision** — Runs that have reached significance on the goal Metric, or
  whose horizon is up.
- **Experiments in a failure state** — a firing **SRM**, a breached **Guardrail**, or a
  `__multiple__` quarantine rate above threshold. These are loud by design.
- **Recently-changed Flag Configuration** in this Environment (audit-backed).
- **Environment at a glance** — which env you are in, its Policy posture (which change types gate).

**Card set: ship all of the above.** All four cards render from day one — there is no reason to
withhold any, and the Overview's whole job is to consolidate the attention-worthy states. What is
**deliberately deferred is the numeric thresholds**, not the cards: "significance reached," "horizon
up," and especially the `__multiple__` "above threshold" line are tuning constants that cannot be
set responsibly until real traffic shows what normal looks like. They ship with conservative
defaults and are tuned from data later. Pin the cards now; tune the numbers when there are numbers.

The **empty state** (no experiments, nothing changed) shows a calm "nothing needs attention" with a
pointer to create the App's first Experiment or Flag — not an error or a blank.

## Flags

`/{orgSlug}/{appSlug}/{env}/flags` — the per-Environment Flags list. Every Flag's row shows its
key plus **this Environment's** Flag Configuration at a glance: enabled state, the rollout, how
many Variants of the catalog are available here. The list is env-scoped (it hangs off `/{env}`),
so it shows the slice of each App-level Flag that applies to the active Environment.

### Flag detail — env-scoped, with a "Definition" sub-area

`/{orgSlug}/{appSlug}/{env}/flags/{flagKey}` leads with **this Environment's Flag Configuration**
as the primary content — available Variants, Targeting Rules, rollout, enabled/kill switch. That
matches the URL grain (you are always inside an Environment) and the common task (95% of flag work
is editing the active env's config).

The App-level **definition** (key, schema, full [[Variant]] catalog, Default Variant) is a
**secondary, clearly-labeled sub-area** titled **"Definition — shared across all environments"**,
not a co-equal pane. The catalog is edited rarely (Variants are defined once), so it earns a
secondary spot rather than splitting the screen.

The anti-confusion device — directly addressing the "defined vs available here" trap the deferred
stub called out — is that each Variant in the Definition sub-area carries an **"available in
`{env}`"** toggle. _Existence_ of a Variant is App-level (it lives in the catalog); its
_availability_ is per-Environment (the toggle). Putting the toggle on the catalog row makes the
distinction visible exactly where a user would otherwise trip over it. (A Variant not promoted into
this env is structurally unable to be served here — ADR-0028.)

While an Experiment controls a Flag, the experiment-owned fields are read-only with a "Controlled
by Experiment X" banner; the kill switch is never locked. See
[flag-editing-ux.md](./flag-editing-ux.md) for the full editing model.

## Experiments

`/{orgSlug}/{appSlug}/{env}/experiments` — the per-Environment Experiments list. Each row shows
name, lifecycle state (`draft` / `running` / `ended`), the Flag(s) it controls, and — for running
Experiments — a health badge (significance reached, SRM firing, Guardrail breached) so the list
doubles as a triage surface alongside the Overview.

### Experiment detail — one route, tabs, lifecycle-adaptive landing

Results and config live under **one** Experiment detail route as tabs, not separate top-level
screens:

- **Results tab** — per-arm Confidence Interval plot, significance, SRM and Guardrail health, the
  per-Metric table, dimension slices. What you _watch_.
- **Setup tab** — Variants/allocation, Targeting, Targeting Key, Metrics (goal/secondary/guardrail/
  activation), and the **Run history** timeline (the sequence of frozen Runs; "which Run am I
  looking at" scopes the Results). What you _author_.

The landing tab is **lifecycle-adaptive**, because the state is a real URL-addressable property and
a draft vs a running Experiment are genuinely different jobs:

- A **draft** opens to **Setup** — it has no Exposures, so Results would be an empty screen.
- A **running** or **ended** Experiment opens to **Results** — it is something you monitor, and the
  Overview routes you here precisely _because_ a number needs a decision; landing on Setup would
  bury it.

This is not hidden session state — the landing follows the Experiment's own lifecycle state, not a
remembered per-user preference, so a pasted link still renders identically for everyone.

### The edit taxonomy, made hard to get wrong

Editing a running Experiment is **not** uniform. ADR-0003 defines three classes with completely
different consequences:

| Edit class            | Fields                                                                        | Consequence                                                 |
| --------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Assignment edit**   | salt, allocation, Variant set, Targeting, Targeting Key, Activation Metric    | **Ends the current Run and opens the next. Sample resets.** |
| **Measurement edit**  | secondary Metric definitions, Conversion Window, exploratory Guardrail config | Recomputes losslessly over the existing Run. No reset.      |
| **Non-material edit** | description, owner, tags                                                      | Applies in place.                                           |

**Governing principle: destroying a sample is never a side effect of an edit gesture.** A user must
not be able to nuke a two-week-old Run by dragging an allocation slider. Abandoning a sample is a
deliberate, named act with its data-loss consequence spelled out — and anything frozen must _look_
frozen.

The UI realizes this structurally, not with an "are you sure?":

- **Assignment fields on a running Run are read-only and visibly locked** — same affordance as a
  Flag locked by an Experiment: a lock marker plus a one-line "frozen for Run N" explanation. A
  Run's assignment config is immutable by construction (ADR-0002); the UI tells that truth. You
  cannot type into a frozen field, so there is no edit gesture to misfire.
- **Changing them is a separate, deliberate flow** — not an edit but **configuring the next Run**.
  It opens a **draft of the next Run** (the _same_ draft→**Start** flow a brand-new Experiment uses
  — one mechanism, not two). The action is named for what it does to the data: the confirm makes
  plain that **Run N is abandoned and a fresh sample starts from zero** — Runs are independent and
  never pooled (ADR-0006), so the prior Run does not extend, it stops accumulating and becomes a
  frozen archive. This confirm is the Environment Policy "Start a Run" gate (ADR-0029).
- **Measurement edits stay inline-editable** — they genuinely do not touch the frozen config, so
  they save plainly (server 200 → refetch). The UI does not gate what is safe; gating everything
  breeds "are you sure" blindness and would bury the one edit that actually matters.
- **Non-material edits** apply in place, no ceremony.

The win: the dangerous action and the safe action _look different_ and _are reached differently_, so
the easy path is the safe one and the destructive path is deliberately effortful.

**CLI/MCP parity (this is Worker-enforced, ADR-0023).** The protection is not a panel trick — it is
the same invariant on all three skins:

- An assignment-field edit against a running Run **fails at the Worker** with a clear, actionable
  error (ADR-0002/0003), so `splitch experiment edit --allocation ...` on a running Experiment is
  rejected, not silently obeyed — the same refusal the panel renders as a locked field.
- Opening Run N+1 is its own explicit command (e.g. `splitch experiment start-run`), the terminal
  analogue of the draft→Start flow, and it requires confirmation: an interactive
  `--confirm`/prompt that names the data loss ("Run N abandoned, fresh sample from zero"), with a
  non-interactive `--yes` for scripts that exists _only_ because the destructive intent is stated
  explicitly in the command itself. The MCP tool returns the same gate as a structured confirm.
- Measurement edits succeed plainly on every skin (no gate), matching the panel's inline save.

So "make it hard to nuke a Run" holds whether the operator is in the panel, at a terminal, or an
agent — there is no skin on which dragging-a-slider-equivalent quietly resets the sample.

## Results view — rigor enforced at the decision, not at the number

The Results tab is where ADR-0030's "statistical rigor is an enforced contract" becomes pixels. The
design follows industry best practice (Eppo, Statsig, Optimizely, and the Kohavi/Vermeer
trustworthy-experiments literature) and then adds splitch's enforcement seam.

**What the literature and the platforms actually do** (researched, not assumed):

- A firing **SRM** invalidates results — it is one of Kohavi's five trustworthiness criteria; the
  remedy is _diagnose the cause and re-run_, not interpret the lift.
- But no leading platform **hard-hides** the numbers. Eppo shows a warning above the graph; Statsig
  uses a **graduated** severity (yellow at p∈[0.001, 0.01] = "possible imbalance, check again
  tomorrow"; escalates only when it persists) because SRM has a noisy zone that self-resolves, and a
  hard mask would cry wolf and train people to distrust the gate.
- The real value is **diagnostics**: Statsig ships the SRM p-value **trend over time** and
  **auto-generated cuts** (by browser, OS, region, …) to help isolate _where_ the imbalance comes
  from.

**splitch's design — numbers always visible, enforcement on the irreversible action:**

- **Per-arm lift / Confidence Interval is always rendered.** The CI is an always-valid confidence
  sequence (ADR-0014), so continuous peeking is a _feature_: the view states plainly that you may
  read it anytime without penalty.
- **SRM warning is loud and graduated**, matching Statsig's tiers — a possible-imbalance caution vs
  a confirmed, persistent SRM — shown above the result, never hidden.
- **SRM diagnostics are first-class**, not a footnote: the p-value trend and auto-cuts by Dimension
  live in the Results view so the operator can find the _cause_, which is the actually-useful action
  when SRM fires.
- **Enforcement moves off the number and onto the decision.** You may always _look_; you may **not
  "call the experiment" / "promote the winner" while SRM is firing or the result is underpowered**.
  The ship action is blocked, the gate cites the specific failing check, and there is **no "ship
  anyway" escape hatch** — an escape hatch is the thing that quietly turns an enforced contract back
  into an advisory one. This honors "rigor is enforced" exactly where a mistake is irreversible (the
  ship), without the false-positive cost of masking data the operator legitimately needs to debug.
- **Guardrails sit alongside a valid result** (they do not mask the goal-metric number — a Guardrail
  breach is a separate harm signal, not an invalidation), warning on CI-bound breach.
- **Activation-gated Experiments** additionally surface the two activation guardrails (activated-
  population SRM and per-arm activation rate, ADR-0012) with the same loud-warning + decision-gate
  treatment.
- **`__multiple__` quarantine rate** is shown as an experiment health metric; a conflict is always a
  defect (config race, SDK bug, or material-edit violation) and is surfaced loudly.
- Significance is **FDR-controlled** across the goal-metric × Variant family (ADR-0014); the view
  labels which Metrics are in the corrected family vs exploratory.

**CLI/MCP parity (ADR-0023).** The ship-decision gate is a Worker invariant: `splitch experiment
conclude` / `promote-winner` fails with the same cited check when SRM is firing or the result is
underpowered, on every skin. Reading results (numbers, diagnostics) is available on all three skins;
only the rendering differs.

## Experiment creation — a draft, Started into Run 1

Creating an Experiment produces a **`draft`** (no Exposures yet). A guided draft flow collects: the
Flag(s) it controls, Variants + allocation, Targeting and Targeting Key, the goal Metric plus any
Guardrail/Activation Metrics, and the **decision spec** (confidence level, horizon mode, goal-Metric
family, Guardrail thresholds, Primary Dimensions) that locks at Start for decision-valid results
(ADR-0014, CONTEXT.md).

**Start** opens **Run 1**. This is the _same_ draft→Start machinery as "Start a new Run" from a
running Experiment (the edit-taxonomy section above) — one mechanism for "open the next Run," whether
that next Run is the first or the fifth. Starting in a gated Environment is an Approval Request like
any prod-affecting change.

## Segments — App-level, shown under the env-scoped sidebar

`/{orgSlug}/{appSlug}/{env}/segments` — list + a Condition editor (attribute/operator/value, the
reusable traffic slice). Segments are **App-level** (usable in any Environment) even though the
sidebar hangs off `/{env}`, so the section is labeled **"Segments (App-level)"** and an edit visibly
applies across all Environments — the same defined-once honesty device the Flag catalog uses, so a
user never thinks they are editing just this env's Segment.

## Metrics — App-level definitions; role is set per-Experiment

`/{orgSlug}/{appSlug}/{env}/metrics` — list + a Metric editor (the fact + the aggregation;
Binomial / Count / Revenue / Ratio). **App-level**, labeled **"Metrics (App-level)"** with the same
cross-env honesty as Segments. A Metric's _role_ (goal / Guardrail / Activation) is **not** set here
— it is chosen **per-Experiment** when the Experiment is configured. Here you only define the Metric;
the Experiment binds its role.

## Settings — App settings vs per-Environment settings

Split exactly as the IA pins it:

- **App settings** — name, slug, App-level catalog management (the Variant catalog, Flag definitions
  at the App level), and App-level danger zone.
- **Environment settings** (under the active `env`) — the env's **SDK credentials**, its
  **Environment Policy editor**, and Environment management.

### SDK credentials — provision, don't read (ADR-0022)

The active Environment's **Client Key** is **freely displayed and copyable** (public by design). The
**API Key** follows secret discipline: the panel **provisions and revokes** it and **surfaces its
value once at creation**, then shows only metadata (hash prefix, scopes, created/revoked) — never the
full value again. The agent/CLI behaves identically (shares the Client Key, provisions but never reads
an API Key value).

### Environment Policy editor — the grid that grows into approval

A **grid of change-type × level**: rows are the gated change types (Variant availability, targeting/
rollout/value, enabled state, Start a Run); each row is set to **`allow` | `confirm`** (with
**`approve`** present but disabled/"coming soon" so the growth path is visible, ADR-0029). Dev
defaults to all-`allow`; prod defaults to `confirm` on production-affecting rows. The editor is where
"prod is more careful" is configured — structural and per-env, not a hardcoded special case. The
kill-switch-off is shown as **never gated** (incident control always wins) and is not an editable row.

## Onboarding — agent and developer paths, co-equal and parity-shaped

Signup → personal **Organization** → first **App** (provisions `dev` + `prod`) → first **Flag** →
copy an **SDK key** → **verify it resolves** → first real **evaluation**.

**Two first-run personas, one journey.** splitch is built agent-first — the auth.md in-band handshake
and remote MCP server (ADR-0022/0023) exist precisely so an agent can authenticate and provision over
MCP with no human pasting anything, and an agent can spin up a provisional Org and convert it to a
real account later (ADR-0021). But the developer-with-a-key path is **co-equal, not a fallback**:
reducing DX friction is a first-class goal, and the two paths are the same effort because both are
**parity-shaped** — every onboarding step maps 1:1 to a CLI command / MCP tool and to a panel
affordance, never a panel-only wizard (ADR-0023). Whatever a developer can click, an agent can call,
and vice versa.

### The visual quickstart sequence (the developer path, specified)

Each step names the CLI/MCP parity it mirrors. No step is panel-only.

1. **Signup → personal Org** (auto). Lands on an **empty Apps screen** whose empty state is the first
   teaching surface: one primary "Create your first App" action, a one-line explanation of
   App→Environment→Flag, and a "prefer your terminal / agent?" link revealing the equivalent
   `splitch login` + `apps create` + MCP connect snippet. (Parity: `apps_create`.)
2. **Create App.** On submit, **`dev` and `prod` are provisioned automatically** (ADR-0027 default,
   see endpoints-org-app.md). The UI states this ("we created `dev` and `prod` — `dev` is selected so
   you can experiment safely"). The active Environment defaults to **`dev`**, never `prod`. (Parity:
   `apps_create` → `environments_list`.)
3. **Create first Flag.** Guided form: key, a sensible default Variant pre-filled (a boolean
   `enabled`/`disabled` catalog so a first flag needs zero JSON), one Variant marked default. Empty
   state teaches "a Flag is a named toggle with Variants." (Parity: `flags_create`.)
4. **Get your SDK key + install snippet** — the handoff that was the missing link. On flag create,
   a **"Connect your code" card** shows: the active Environment's **Client Key** (public, copyable),
   an `npm i @splitch/sdk` line, and a **pre-filled copy-paste snippet** with the user's real `appId`,
   `clientKey`, and the new `flagKey` already substituted:

   ```ts
   import { createSplitchClient } from "@splitch/sdk";
   const splitch = createSplitchClient({ appId: "app_…", clientKey: "ck_…" });
   const value = await splitch.evaluate("your-flag-key", { targetingKey: user.id });
   ```

   (`idType` defaults to `'user'`, so the snippet is two lines, ADR-0036.) The card links to the
   API-Key flow for server runtimes (provisioned-and-shown-once, ADR-0022). (Parity: `client_key_get`.)

5. **Verify it resolves** — the first green check. An inline **"Test this Flag"** panel on the card
   takes a Targeting Key and calls **`verify`** (ADR-0037): it shows the resolved Variant and a
   plain-language `reason`, **fires no Exposure**, and is **fail-loud** — a misconfiguration or
   unreachable config shows a distinct, self-explaining error, never a silent "looks fine"
   (ADR-0036). The dev confirms the wiring before deploying a single user. (Parity: `splitch flags
verify`; the agent uses `flags_test_eval` for the full-reason tier.)
6. **First real evaluation.** The dev runs their app; the dashboard's empty Exposures state flips to
   "first Exposure received," closing the loop.

### Empty states teach, not just decorate

Every first-run empty surface (Apps, Flags, Experiments, Exposures) carries: a one-line concept
explanation, a single primary next action, and the CLI/MCP equivalent. An experiment-less dashboard
shows a calm "nothing needs attention yet — create a Flag to begin," not a blank panel.

### Mechanics shared by both paths

The **Client Key** is shown for copy-paste (public); the **API Key** is provisioned-and-shown-once
(ADR-0022, agent provisions but never reads an existing value); **`verify`/test-eval** powers the
"see it resolve without firing an Exposure" first moment (ADR-0026/0037); and the active Environment
starts on **`dev`** so the first move never touches production.

## Promotion & the prod-change approval workflow

The governing requirement: **mistakes against production are hard.** Any production-affecting change
— a Promotion, a direct prod Flag edit, a Variant/value change, or starting a Run — does not commit
silently. It becomes an **[[Approval Request]]** (the industry-standard pending-change object;
LaunchDarkly's term, Statsig's "submit for review") carrying a **diff** of proposed-vs-current
config, and it commits only when **[[Reviewed]]**.

### Built for confirm now, grows into second-person approval

This workflow ships at the `confirm` Policy level (single operator) but is **structured for the
future `approve` level without a rewrite** (ADR-0029):

- The **Approval Request object exists from day one**, even under `confirm`. Under `confirm` the
  proposer self-reviews in the same step — feels like one action, but a proposal-was-approved
  record is written.
- Growing to `approve` (a known future direction — reviewer roles, multi-user) is then a
  **permission change** (self-review disallowed → a second principal must Review), not a new
  pipeline. The diff screen, the Approval Request, the audit trail are already there.

This is the explicit "build a system we grow into" choice: confirm-by-default on prod today,
second-person approval slots in later.

### The Promotion screen is the diff

Promotion is framed as a **pull into the target Environment**, not a push from the source. Standing
in the target env (`prod`) on a Flag, you open **"Promote from `{source}`"** → a **side-by-side
diff** of the source's Flag Configuration vs the target's, with **per-change selection**
(checkboxes: this Targeting Rule, that Variant's availability, the rollout). You are standing in the
env that is about to change, seeing exactly what changes, governed by _that_ env's Policy.

The per-change diff answers the deferred stub's three granularities in **one mechanism** — they are
not separate modes, just which boxes you tick:

- **availability-only** — tick only Variant-availability rows
- **whole-config** — tick everything
- **single Variant** — tick one availability row

Ticking and submitting creates the Approval Request; the target env's Policy decides whether it
self-confirms or (future) waits for a reviewer.

The cross-env "all Flags' dev-vs-prod drift at once" bulk view is a useful **secondary** power-user
surface, not the primary promote flow.

**CLI/MCP parity (ADR-0023, Worker-enforced).** Promotion and the approval gate are operations, not
panel features. `splitch flag promote --from dev --to prod --flag checkout-model [--only availability]`
creates the same Approval Request; when the target Policy is `confirm` it prompts (or takes `--yes`),
and when it is `approve` (future) the command reports the request as pending a reviewer rather than
applying. The MCP tool returns the Approval Request as a structured result. The diff, the request,
and the gate live in the Worker; every skin inherits them.

## Sources

- [navigation-and-ia.md](./navigation-and-ia.md) — URL spine, sidebar sections, the three switchers
- [ADR-0029](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md) — Environment Policy, Confirmation/approval levels
- [ADR-0023](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md) — three parity skins, invariants in the Worker
- [ADR-0028](../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md) — catalog App-level, availability per-Environment
- [ADR-0002](../../adr/0002-run-is-the-immutable-unit-of-analysis.md) — Run is the immutable unit of analysis
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md) — Environment axis
- [ADR-0030](../../adr/0030-statistical-rigor-is-an-enforced-product-contract.md) — rigor contract
- [ADR-0036](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md) — fail-loud verify, idType default in the snippet
- [ADR-0037](../../adr/0037-client-side-configuration-verification-tiered-by-credential.md) — verify powers the first green check
