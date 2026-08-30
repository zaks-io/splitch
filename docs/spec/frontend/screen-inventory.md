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

## One shell

One persistent sidebar wraps every authenticated Organization and App screen. The App switcher and
Environment pills live at the top, App sections follow when an App is active, and the Organization
block plus user row stay at the bottom. The App home resolves `appId` and shows every Environment;
everything below it remains scoped to `(appId, environmentId)` resolved from the URL. The shipped hierarchy and slice boundaries are
pinned in [navigation-redesign.md](./navigation-redesign.md).

**Command palette:** the sidebar trigger and ⌘K or Ctrl+K shortcut open Jump to and Actions groups.
Every row navigates to an App, Environment, Flag, Experiment, section, or Organization screen except
New Flag, which opens the existing Create Flag dialog.

## Org-level screens

The Organization level hangs three screens off `/{orgSlug}`: **Home**, **Members**, and
**Billing & Usage**. Org-scope role gates are the Org role matrix in
[../control-plane/organization-and-membership.md](../control-plane/organization-and-membership.md);
the panel renders locked affordances, the Worker is the guardian (ADR-0023).

### Home: `/{orgSlug}`

Home contains this Organization's navigation and Experiment-health attention only. Apps are never
merged across Organizations (`navigation-and-ia.md`). `/` redirects to the last-visited
Organization's Home (else the first Organization) when the session has at least one Organization,
no pending Organization resync, and a complete Organization list. Zero, pending, or truncated
Organization sessions keep the chooser.

- **Continue where you left off:** rendered only when the `__last_visited` httpOnly hint cookie has
  an entry for this Organization. It names the App, optional Environment, section, relative visit
  time, and exact Resume path. The cookie keeps at most eight Organization entries.
- **Apps table:** one row per App. The App name links to `/{orgSlug}/{appSlug}`. Environment pills
  link to each Environment Overview. The Flags column shows the bounded App catalog count and marks
  truncation. The Attention badge uses the App's existing Experiment-health rollup. Health markers
  remain attached to the affected Environment pills.
- **Needs you:** every Environment with confirmed or unknown Experiment health, ordered with
  confirmed attention first. Each item links to the Environment Overview. An unavailable App read
  produces unknown items and never a calm empty state.
- **Create App:** the Apps table action, owner/admin only (Org role matrix). Provisions `dev` + `prod`
  (ADR-0027). Parity: `apps_create`.
- **Provisional-org claim banner:** if this Org is `is_provisional = 1` (anon door, not yet claimed;
  organization-and-membership.md), a **loud, persistent banner**: "Demo workspace — expires
  `{demo_expires_at}`. Claim it to keep your work," with a one-click entry to the claim ceremony
  (auth-doors.md). Fail-loud: a reaper deletes provisional Orgs at expiry, so silently letting work
  evaporate is exactly the disguised failure the project forbids (ADR-0036).
- **Empty state:** the onboarding teaching surface (see Onboarding below): "Create your first App,"
  the App→Environment→Flag one-liner, and the CLI/agent equivalent.

### Members — `/{orgSlug}/members`

The Org membership list (`org_memberships`): each member's identity (resolved from WorkOS) and Org
role (`owner` | `admin` | `member`). Invite / change-role / remove are **owner/admin** only ("Manage
Org members" in the matrix); a `member` sees the list read-only ("View Org settings"). SSO/SCIM config
for enterprise Orgs lives here too, gated to the roles the matrix allows (`Configure SSO/SCIM`:
owner/admin; `Manage trusted IdPs`: owner). Parity: the same membership operations over CLI/MCP.

> **App membership vs Org membership.** This screen manages who is in the _Org_. Who can touch a
> specific App's config (`app_memberships`, its own role matrix) is managed under that App's Settings,
> not here — the two scopes are distinct (organization-and-membership.md).

### Integrations — `/{orgSlug}/integrations`

Where this Organization's Flag activity is published. **Sentry change tracking** is the one connector
here: Sentry keeps a single signing secret per provider type per Sentry organization and its flag log
has no project or environment axis, so one splitch Organization maps to one Sentry organization and
every App and Environment under it publishes to the same log (ADR-0051). The card holds the two-way
exchange (Sentry's webhook URL in, a once-shown minted secret out), delivery health, **Rotate
secret**, and **Disconnect**. Owner/admin only, matching the Control Plane's own gate; a `member`
sees the role they are missing, not a connector they cannot use. Parity: the same operations over
CLI/MCP.

> Integrations that act on a single Environment's credentials or data — Convex, Cloudflare — stay
> under that Environment's Settings. The axis is the connector's own, not a house style.

### Billing & Usage — `/{orgSlug}/billing` (usage-complete, payment-stubbed)

V1 billing is one Org-scoped **Evaluation** quota (ADR-0033). The screen ships the **usage half now**
because that data exists from day one and is the customer's central question; the **payment half is
the visibly-deferred stub** (the `stripe_*` seam columns exist, integration deferred —
organization-and-membership.md).

- **Usage (real, v1):** current month's Evaluation consumption, with the **usage breakdown**
  ADR-0033 mandates (by App, by Environment, by Flag, by SDK/runtime, batch-vs-single,
  remote-vs-cached, Exposure-bearing-vs-not) as reporting dimensions — _not_ separate meters. Every
  dimension is measured against the month's own total, never rebased to the largest row on screen.
- **Quota (deferred, stated):** the allowance and its **Active / Grace / Exhausted** states
  (ADR-0033) are real runtime states of an enforcement path that does not run yet, so the screen
  says the limit is not enforced instead of naming a state it cannot observe. The month's number is
  a total, not a balance. When enforcement lands, this screen shows the allowance and the state
  loudly — claiming either before then would be the fake status ADR-0036 forbids.
- **Payment (stubbed, loud):** plan, payment method, invoices render a "managed by your account team /
  coming soon" state backed by the present-but-unwired `stripe_*` seam. Stubbed visibly, never faked.
- **Role gate:** "Manage billing/plan" is **owner only**; admin/member see usage read-only.

## App home: `/{orgSlug}/{appSlug}`

The one Environment-less App URL shows the App-level Flag catalog as a matrix across every
Environment. Each Environment cell shows its Flag Configuration, supports the existing gated
enable switch, and links to that Environment's Flag detail. The final column compares the first
Environment with the last and links into Promotion when the source is configured. Creating a Flag
delegates through the first non-guarded Environment, or the first Environment when all are guarded.

## Environment landing: the Overview

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
key plus **this Environment's** Flag Configuration at a glance: an inline enable Switch, the
rollout, and how many Variants of the catalog are available here. Configured rows use the Switch,
not an enabled-state badge. The list is env-scoped (it hangs off `/{env}`), so it shows the slice
of each App-level Flag that applies to the active Environment.

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

### Experiment detail — Run-scoped, one route, tabs, lifecycle-adaptive landing

**Which Run is a URL path segment, not hidden state and not a query string** (the spine discipline —
`appid-is-the-spine.md` — applied to Runs):

- `/{orgSlug}/{appSlug}/{env}/experiments/{experimentId}` renders the **latest Run** — the everyday
  URL. "Latest" is fine here precisely because it is the live working view; you are not pinning
  anything.
- `/{orgSlug}/{appSlug}/{env}/experiments/{experimentId}/runs/{runId}` renders **that specific frozen
  Run** — the shareable, no-drift link. A link copied today still points at _that_ Run next week even
  after Run N+1 opens (LaunchDarkly `/pull/123`, GitHub pinned shape).
- The tab (`results` / `setup`) hangs **below** the Run: Run scopes the screen, tab is the view within
  it. Switching Runs in the timeline keeps the current tab.

Results and config live under **one** Experiment detail route as tabs, not separate top-level
screens, both scoped to the selected Run:

- **Results tab** — per-arm Confidence Interval plot, significance, SRM and Guardrail health, the
  per-Metric table, dimension slices — **for the selected Run** (Runs are never pooled, ADR-0006).
  What you _watch_.
- **Setup tab** — for the selected Run, its **frozen** assignment config (read-only, locked — see the
  edit taxonomy below) plus the Experiment's current measurement config; Variants/allocation,
  Targeting, Targeting Key, Metrics (goal/secondary/guardrail/activation). What you _author_.

When a live Run exists, Setup also renders a generated **code-agent prompt** containing the exact
Flag key, public Client Key, frozen assignment configuration, and Metric bindings. Copying it hands
the desired state to a coding agent, which follows the public code-agent implementation guide and
changes the consumer repository. It does not mutate the splitch control plane. Starting a new Run or
saving measurement changes regenerates this prompt from the reread Worker state.

### The Run-history timeline — a screen-level strip above the tabs

The timeline is **not** a Setup-tab widget; it sits at the **detail-screen level, above the tabs**,
because which-Run scopes _both_ tabs. It is the Run context for the whole screen and a navigation
control: clicking a Run node navigates to that Run's URL (above), keeping the current tab.

It renders the Experiment's Runs (`GET …/runs`, newest-first) as a horizontal sequence. Each node
carries:

- **Run number + status** — "Run 3 · running", "Run 2 · ended"; the selected Run is visibly marked.
- **Date range** — started → ended, or "started X · live". Runs are time-ordered and never pooled
  (ADR-0006), so the gaps are real.
- **Why this Run opened** — the boundary narrative, two layers:
  - **Derived diff (always present, never wrong):** the assignment-config change from Run N-1's
    frozen snapshot to Run N's ("allocation 50/50 → 70/30", "added Variant `v3`"). Computed from the
    frozen snapshots the Runs already store (ADR-0002/0003) — no stored field, always accurate. Run 1
    reads "Experiment started" (no prior).
  - **Optional human note (intent):** if the operator gave a `reason` at Start (`/start` body, see
    endpoints-experiment-run.md), it shows alongside the derived diff ("testing higher exposure to
    v2"). Symmetric with the optional end-reason. The timeline never _requires_ it.

The derived diff is the reliable backbone; the note adds the intent a diff can't express. Together
they turn an opaque list of frozen samples into the narrative of what the experimenter actually
tried.

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
  — one mechanism, not two). The action is named for what it does to the data: the Review makes
  plain that **Run N is abandoned and a fresh sample starts from zero** — Runs are independent and
  never pooled (ADR-0006), so the prior Run does not extend, it stops accumulating and becomes a
  frozen archive. Under `confirm`, this is the proposer performing the Environment Policy
  `approve_and_apply` Review (ADR-0029).
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
  analogue of the draft→Start flow. When Policy requires Review, an interactive `--confirm`/prompt
  names the data loss ("Run N abandoned, fresh sample from zero") and maps to
  `review.action = "approve_and_apply"`. The non-interactive form requires that same action
  explicitly. The MCP tool exposes the same typed Review action.
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
- **Guardrails sit alongside a valid result** and never mask the goal-Metric number. They remain an
  advisory surface and are not part of the shipped decision gate.
- **Activation-gated Experiments** additionally surface the two activation guardrails (activated-
  population SRM and per-arm activation rate, ADR-0012) with the same loud-warning + decision-gate
  treatment.
- **`__multiple__` quarantine rate** is shown as an experiment health metric; a conflict is always a
  defect (config race, SDK bug, or material-edit violation) and is surfaced loudly.
- Significance is **FDR-controlled** across the goal-metric × Variant family (ADR-0014); the view
  labels which Metrics are in the corrected family vs exploratory.

**CLI/MCP parity (ADR-0023).** The decision gate is a Worker invariant: `splitch experiment
conclude` fails with the same cited `control_identity`, `engine_status`, `decision_valid_result`,
`underpowered`, `exposure_srm`, `activated_srm`, or `activation_balance` check on every skin. Reading
Results and diagnostics remains available on all three skins; only the rendering differs. Under
`confirm`, "Conclude Run" is one interaction over the two durable commits specified in
[conclusion-and-winner-promotion.md](../control-plane/conclusion-and-winner-promotion.md).

That interaction requires the operator to choose the target Environment and author the complete
target Flag Configuration: enabled state, available Variant names, ordered Targeting Rules, and
rollout. The selected winner is shown beside those inputs. Submission stays unavailable until the
complete Configuration validates; the Control Panel never derives missing fields from the winner.

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

## Web Analytics

Web Analytics is an Environment-scoped read-only surface, separate from Experiment results. Every App
role may view it under the existing **View config/results** permission.

Its view state is URL-addressable:

- `/{orgSlug}/{appSlug}/{env}/web-analytics` — **Overview** tab;
- `/{orgSlug}/{appSlug}/{env}/web-analytics/sessions` — **Sessions** tab;
- `/{orgSlug}/{appSlug}/{env}/web-analytics/sessions/{sessionIdHash}` — one paginated Web Session
  journey;
- `/{orgSlug}/{appSlug}/{env}/web-analytics/vitals` — **Web Vitals** tab.

The selected time window is explicit in `from` and `to` URL query parameters. Overview also carries
`interval=hour|day`. Sessions carries its optional exact `eventName` and `association` filters in
the URL. Preset controls rewrite those parameters to concrete UTC timestamps; no tab, window, or
filter lives only in component state.

Each explicit `from`/`to` pair is a stable Web Analytics snapshot. The panel does not poll it and
Web Event ingest does not push a per-event WebSocket nudge. **Refresh** reruns the exact same window.
**Latest** advances `to` to the current UTC instant, preserves the selected duration by moving
`from`, updates the URL, and then loads that new snapshot.

- **Overview** shows logical Web Event count, Web Session count, unique visitor count,
  anonymous/associated/ambiguous session counts, associated Entity count, the UTC
  event/session/visitor trend, per-event-name counts, and the top pages, referrers, countries, and
  device classes breakdowns. A multi-day visitor count is labeled as approximate because the
  visitor pseudonym rotates daily.
- **Sessions** shows the cursor-paginated session summaries. Selecting a row navigates to its stable
  detail URL, which pages forward through the complete windowed journey without truncation.
- **Web Vitals** shows p50/p75/p95, exact sample/session counts, and rating counts grouped by Event
  Definition, metric, unit, and navigation type. It labels the percentiles as t-digest estimates.

The screen never presents Web Events as Metric inputs, joins them to Experiment results, or displays
raw Targeting Keys. Empty aggregate and collection reads render a zero state. An unavailable
retention window and a missing session detail render their canonical fail-loud errors with controls
to select a valid window or return to the Sessions list.

Panel loaders call the same `@splitch/control-plane-sdk` operations used by CLI and MCP. The panel
never queries Tinybird directly.

## Metrics — App-level definitions; role is set per-Experiment

`/{orgSlug}/{appSlug}/{env}/metrics` — list + a Metric editor (the fact + the aggregation;
Binomial / Count / Revenue / Ratio). **App-level**, labeled **"Metrics (App-level)"** with the same
cross-env honesty as Segments. A Metric's _role_ (goal / Guardrail / Activation) is **not** set here
— it is chosen **per-Experiment** when the Experiment is configured. Here you only define the Metric;
the Experiment binds its role.

After a Metric create or edit is read back successfully, the panel generates a code-agent prompt
for its exact Event Definition and aggregation contract. Ratio prompts name the operand Metrics and
never teach a made-up ratio event.

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
   an `npm i @splitch/sdk` line, and a **pre-filled copy-paste snippet** with the user's real
   `clientKey` and the new `flagKey` already substituted. The snippet carries no `appId`: App and
   Environment scope come from the credential alone (ADR-0018), and `SplitchClientOptions` has no
   such field.

   The block below is what `renderConnectSnippet` emits, character for character, with the two
   substituted values shown as placeholders. It declares `userId` rather than leaving it free: the
   card promises a copy-paste snippet, so a paste must not throw `ReferenceError`.

   ```ts
   import { createSplitchClient } from "@splitch/sdk";

   const splitch = createSplitchClient({ clientKey: "pk_…" });

   // Whoever you are deciding for. Swap in your own user id.
   const userId = "user-1";

   // One stable id per logical Evaluation. Reuse it when you retry that call,
   // so a retry is not counted as a second Evaluation.
   const evaluationId = crypto.randomUUID();

   const value = await splitch.evaluate("your-flag-key", {
     targetingKey: userId,
     idempotencyKey: evaluationId,
   });
   ```

   (`idType` defaults to `'user'`, so the snippet stays short, ADR-0036.) The card links to the
   API-Key flow for server runtimes (provisioned-and-shown-once, ADR-0022). (Parity: `client_key_get`.)

   The same handoff includes a generated **code-agent prompt** with the real Client Key, Flag key,
   Variant catalog, and Default Variant. The prompt treats those values as data and sends the coding
   agent to the public runtime-specific implementation contract before it edits. Flag detail keeps
   the regenerated prompt available after later catalog or Configuration changes.

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

## Promotion & the Policy-gated Approval workflow

The governing requirement: **mistakes against a careful Environment are hard.** Any change whose
Environment Policy requires Review, including Promotion, a direct Flag Configuration edit, a
Variant/value change, or starting an Experiment Run, does not commit silently. It becomes an
**[[Approval Request]]** carrying an immutable proposed-vs-current diff, target version, proposer,
Policy context, and lifecycle state. It commits only through an authorized Review.

### Built for confirm now, grows into second-person approval

This workflow ships at the `confirm` Policy level (single operator) but is **structured for the
future `approve` level without a rewrite** (ADR-0029):

- The **Approval Request object exists from day one**, even under `confirm`. Under `confirm` the
  proposer invokes `approve_and_apply` in the same step — feels like one action, but the durable
  Approval Request and successful Review are written.
- Growing to `approve` (a known future direction — reviewer roles, multi-user) is then a
  **permission change** (self-review disallowed → a second principal must Review), not a new
  pipeline. The diff screen, the Approval Request, the audit trail are already there.

This is the explicit "build a system we grow into" choice: self-review ships under `confirm` today,
and second-person approval slots in later.

The positive action is always `approve_and_apply`. There is no approve-only state or deferred
application. `decline` is terminal. A changed target version moves the request to terminal `stale`.
Application failure applies nothing, records a failed Review attempt with a machine-stable error,
and leaves the request `pending` for a new authorized attempt.

### The Promotion screen is the diff

Promotion is framed as a **pull into the target Environment**, not a push from the source. Standing
in the target env (`prod`) on a Flag, you open **"Promote from `{source}`"** → a **side-by-side
diff** of the source's Flag Configuration vs the target's, with **per-field-group selection**. You
are standing in the env that is about to change, seeing exactly what changes, governed by _that_
env's Policy.

**The tickable rows are field-groups, not arbitrary changes** (ADR-0028, promote endpoint
`select`):

- **one row per Variant's availability** (`+ checkout-v2`, `− legacy`) — the per-Variant act; the
  one place granularity is genuinely per-item
- **one atomic row for the whole targeting-rule list** — _not_ per-rule. Targeting is ordered and
  first-match-wins, so a per-rule subset would yield a reordered list that behaves like neither env;
  the list promotes whole or not at all
- **one row for the rollout**
- **one row for the enabled state**

The two granularities the deferred stub asked for are just presets over this one mechanism, exposed
as named buttons that pre-tick rows: **"Promote whole config"** (tick everything) and **"Promote
this Variant"** (tick one availability row). "Availability-only" is ticking only availability rows.

**Dependency safety — offer in the panel, block at the Worker (ADR-0028/0036).** Ticking the
targeting row when a promoted rule routes to a Variant not available in the target produces a
dangling reference. The panel detects this and **offers** a one-click "also make `checkout-v2`
available here" (visibly ticking that availability row, labeled "added because rule X needs it") —
friction removed, but never a silent side effect. If you submit anyway with the dependency unticked,
the **Worker rejects** the Approval Request with a structured error naming the missing Variant. The
strictness is the invariant; the nudge is the affordance.

Ticking and submitting creates a durable Approval Request only when the effective Environment
Policy requires Review. Under `allow`, the same validated application seam applies directly and
returns no Approval Request. Under `confirm`, the proposer self-reviews with `approve_and_apply`.
Future `approve` changes only Review authority and waits for a distinct authorized principal.

The cross-env "all Flags' dev-vs-prod drift at once" bulk view is a useful **secondary** power-user
surface, not the primary promote flow.

**CLI/MCP parity (ADR-0023, Worker-enforced).** Promotion and the approval gate are operations, not
panel features. `splitch flag promote --from dev --to prod --flag checkout-model [--only availability]`
creates the same Approval Request; when the target Policy is `confirm` it prompts and sends
`review.action = "approve_and_apply"`, and when it is `approve` (future) the command reports the
request as pending a distinct reviewer rather than applying. The MCP tool returns the Approval
Request as a structured result. The diff, target version, request, Review action, and application
result live in the Worker; every skin inherits them.

## Sources

- [navigation-and-ia.md](./navigation-and-ia.md) — URL spine, sidebar sections, and sidebar controls
- [ADR-0029](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md) — Environment Policy, Confirmation/approval levels
- [ADR-0023](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md) — three parity skins, invariants in the Worker
- [ADR-0028](../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md) — catalog App-level, availability per-Environment
- [ADR-0002](../../adr/0002-run-is-the-immutable-unit-of-analysis.md) — Run is the immutable unit of analysis
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md) — Environment axis
- [ADR-0030](../../adr/0030-statistical-rigor-is-an-enforced-product-contract.md) — rigor contract
- [ADR-0036](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md) — fail-loud verify, idType default in the snippet
- [ADR-0037](../../adr/0037-client-side-configuration-verification-tiered-by-credential.md) — verify powers the first green check
