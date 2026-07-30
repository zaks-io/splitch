# V1 billing is an Organization-scoped Evaluation quota

**Status:** accepted

Splitch sells flag management first, with experimentation and production launch control built on the
same flag substrate. Billing has to match that shape. A customer should be able to answer one question:
"How many Evaluations did my Organization use this month?" If the answer requires service connections,
event categories, Exposure multipliers, or Environment-specific quota rules, V1 has already failed the
trust test.

This ADR adopts one customer-facing usage unit for V1: **Evaluations**.

## Decision

V1 billing is scoped to the **Organization**. Every Organization has one monthly Evaluation allowance.
All Apps and all Environments owned by that Organization draw from the same pool.

A billable **Evaluation** is one successful data-plane Flag Evaluation performed by Splitch. It counts
when Splitch resolves one Flag and returns a Variant value to the SDK caller.

The counting rules are deliberately simple:

- One successful data-plane Evaluation of one Flag consumes one Evaluation.
- A batch request that resolves 10 Flags consumes 10 Evaluations.
- Disabled Flags, no-match Default Variant responses, 0% rollouts, and 100% rollouts still count if
  Splitch successfully evaluates the Flag.
- Cached SDK reads, last-known local SDK fallback, and bootstrap/local results consume zero.
- Failed requests consume zero. This includes invalid credentials, validation errors, rate limits,
  quota exhaustion, and provider/server failures.
- Control-plane dry runs such as `test-evaluation` consume zero.
- Exposure side effects consume zero extra. An Evaluation that records an Exposure is still one
  Evaluation total.
- Metric Events and Web Events consume zero extra in V1. They must have operational abuse and
  fairness limits, but those limits are not spend guards, quotas, or a second billing meter.

The monthly included allowance resets on the billing period boundary and unused included Evaluations
expire at reset. Purchased top-up Evaluations are prepaid, non-refundable, expire one year after
purchase, and are consumed only after the monthly included allowance is exhausted.

No V1 billing rule creates service-connection charges, per-Environment quotas, production reserves,
spend guards, seat-based usage charges, App count charges, Flag count charges, Exposure charges,
Metric Event charges, or Web Event charges.

## Usage visibility

The quota is one pool, but the usage view must explain where Evaluations went. The billing and usage UI
must break Evaluation usage down by:

- App
- Environment
- Flag
- SDK/runtime
- batch vs single-Flag Evaluation
- remote data-plane Evaluation vs cached/local SDK result
- Exposure-bearing vs non-Exposure-bearing Evaluation

These are reporting dimensions only. They do not create separate quotas or billing meters.

## Grace and enforcement

Quota exhaustion has three states:

1. **Active**: the Organization has included or purchased Evaluations available.
2. **Grace**: available Evaluations are exhausted, but data-plane Evaluation continues.
3. **Exhausted**: grace has expired, so data-plane Evaluation is rejected explicitly.

Grace duration is:

- 7 days for free Organizations.
- 14 days for paid Organizations.

Grace usage is recorded as negative Evaluation balance. The next monthly included allowance or
purchased top-up first clears that negative balance before new usage proceeds.

After grace expires, the Evaluation Worker returns an explicit quota error such as
`QUOTA_EXHAUSTED`. Splitch must not silently return the Default Variant because billing ran out.
The SDK may apply its own documented failover behavior after receiving the explicit error, but the data
plane must not pretend a successful Evaluation happened.

## Top-ups and payment

V1 supports manual top-ups only. The data model must still allow future auto top-ups without changing
the ledger model.

A top-up purchase has:

- a purchase trigger: `manual` in V1; future values may include `auto_threshold`,
  `admin_grant`, or `enterprise_contract`
- a payment provider, initially `stripe`
- a requested Evaluation quantity
- an expiration timestamp exactly one year after the credit is granted
- a state machine that can represent created, checkout opened, payment pending, paid, credited,
  canceled, expired, failed, refunded, and disputed states

Stripe is the payment rail, not the billing source of truth. Splitch owns purchase state, ledger state,
quota state, grace state, debt, and enforcement.

The Evaluation Worker never calls Stripe and never trusts a Stripe checkout redirect. A verified,
idempotent Stripe webhook or reconciliation job updates Splitch's purchase state. Splitch then writes
the ledger credit. The Evaluation Worker reads Splitch's own quota projection only.

## Ledger and counters

The ledger is the durable billing record. It represents monthly grants, top-up credits, debt
clearance, refunds, disputes, administrative adjustments, and period boundaries.

Do not write one D1 ledger row per Evaluation. High-frequency Evaluation counters follow ADR-0018 and
the storage map: authoritative billable counters live in an exact Splitch-owned counter substrate,
initially a Durable Object counter, and are written to D1 only as periodic rollups. Analytics Engine
may mirror usage for reporting and forecasting, but it is sampled/lossy and must not be authoritative
for quota, debt, credit burn, or enforcement. The hot Evaluation path checks a Splitch-owned quota
projection, not Stripe and not a per-request D1 mutation.

Ledger and counter updates must be idempotent. Billing rollups must tolerate retries and must not
double-charge a batch or a retried successful Evaluation.

## Considered options

- **Service connections**: rejected. They price topology instead of customer value and punish
  serverless, edge, and Worker-heavy architectures.
- **Exposures or metered events as the headline meter**: rejected for V1. That matches an
  experimentation-first product, but Splitch's core flag-management and production launch-control use
  cases create value even when no Experiment is running.
- **Separate charges for Exposures and Metric events**: rejected. Customers would reasonably perceive
  Evaluation plus Exposure billing for the same SDK read as double charging.
- **Per-Environment quotas, production reserves, and spend guards**: rejected. Billing belongs to the
  Organization. Environment-level controls are a customer operating choice, not a V1 billing rule.
- **Stripe as the billing source of truth**: rejected. Stripe processes payment; Splitch owns the
  billing state machine and the enforcement projection.
- **Never-expiring purchased Evaluations**: rejected. That creates long-lived liability. One-year
  expiry is explicit, non-refundable, and visible.

## Done

The V1 billing contract is implemented when:

- Organization billing state includes plan, monthly allowance, purchased balance, debt, grace state,
  and Stripe linkage.
- A successful data-plane Evaluation increments usage once per Flag resolved, including batch
  requests.
- Cached/local SDK reads, failed requests, and `test-evaluation` consume zero.
- Exposures, Metric Events, and Web Events do not consume separate V1 billing units.
- Metric Event and Web Event ingest have operational abuse and fairness limits that are visible to
  the customer but do not create a second billing meter.
- Aggregate Ingest Admission Gate row and byte budgets are operational Tinybird-protection controls,
  not billable usage, plan quota, or customer spend guards.
- All Apps and Environments under an Organization draw from one quota.
- Quota exhaustion enters grace for 7 days on free Organizations and 14 days on paid Organizations.
- Grace usage records negative Evaluation balance.
- After grace expires, the Evaluation Worker returns an explicit quota error and does not silently
  return the Default Variant.
- Manual top-up purchases credit the Splitch ledger only after verified, idempotent Stripe webhook or
  reconciliation evidence.
- Purchased top-ups expire one year after crediting and are non-refundable.
- Usage views break Evaluations down by App, Environment, Flag, SDK/runtime, and relevant reporting
  dimensions without introducing new meters.
- Tests cover counter idempotency, batch counting, failure non-counting, grace transition, debt
  clearance, top-up expiry, webhook retry, dispute/refund reversal, and quota enforcement.

## Consequences

This makes V1 easy to explain and hard to game. The tradeoff is that Splitch absorbs some analysis
cost from Exposure, Metric Event, and Web Event volume inside the Evaluation price. That is
acceptable for V1 because it keeps the contract legible and avoids a second hidden meter.

If Metric Event or Web Event volume becomes the dominant cost later, the next ADR must decide whether
to raise the Evaluation price, introduce a clearly named add-on, or split analytics billing. V1 does
not pre-build that complexity.

## Sources

- [ADR-0018: identity and operational state in D1; hot validation in KV; audit log in Tinybird](./0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0021: Organization is the account/ownership tier above App](./0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md)
- [ADR-0026: test-evaluation endpoint dry-run never exposes](./0026-test-evaluation-endpoint-dry-run-never-exposes.md)
- [Storage map usage counter rule](../spec/platform/storage-map.md)
- [Statsig pricing](https://www.statsig.com/pricing)
- [LaunchDarkly billing calculation docs](https://launchdarkly.com/docs/home/account/calculating-billing)
- [PostHog feature flag billing and quota limiting](https://posthog.com/docs/feature-flags/cutting-costs)
- [Flagsmith billing API usage docs](https://docs.flagsmith.com/administration-and-security/billing-api-usage)
- [ConfigCat billing policy](https://configcat.com/policies/billing/)
- [OpenAI prepaid billing expiration policy](https://help.openai.com/en/articles/8264644-how-can-i-set-up-prepaid-billing)
