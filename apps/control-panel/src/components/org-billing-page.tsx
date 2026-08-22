import { OrgPaymentCard } from "#components/org-payment-card";
import { OrgQuotaCard } from "#components/org-quota-card";
import { OrgUsageCard } from "#components/org-usage-card";
import type { OrgBillingView } from "#lib/org-billing";

/** The Billing & Usage screen: `/{orgSlug}/billing`. */
export function OrgBillingPage({ view }: { view: OrgBillingView }) {
  return (
    <div className="grid gap-6" data-billing-page="ready">
      <p className="max-w-2xl text-muted-foreground text-sm leading-6">
        Every Flag Evaluation this Organization served this month, across all of its Apps and
        Environments.
      </p>

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
