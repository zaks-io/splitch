import { OrgPaymentCard } from "#components/org-payment-card";
import { OrgQuotaCard } from "#components/org-quota-card";
import { OrgUsageCard } from "#components/org-usage-card";
import type { OrgBillingView } from "#lib/org-billing";

/** The Billing & Usage screen: `/{orgSlug}/billing`. */
export function OrgBillingPage({ view }: { view: OrgBillingView }) {
  return (
    <div className="grid gap-6" data-billing-page="ready">
      <div className="grid gap-2">
        {/* The Org shell frame owns the `h1` (the Organization); this screen is
            the Billing section within it. */}
        <h2 className="font-semibold text-3xl text-foreground tracking-tight">Billing & Usage</h2>
        <p className="max-w-2xl text-muted-foreground text-sm leading-6">
          Every Flag Evaluation this Organization served this month, across all of its Apps and
          Environments.
        </p>
      </div>

      <OrgUsageCard usage={view.usage} />

      <div className="grid gap-6 lg:grid-cols-2">
        <OrgQuotaCard />
        <OrgPaymentCard
          hasBillingAccount={view.hasBillingAccount}
          orgRole={view.orgRole}
          plan={view.plan}
        />
      </div>
    </div>
  );
}
