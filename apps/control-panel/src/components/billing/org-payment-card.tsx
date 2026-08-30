import { Badge } from "@splitch/ui/components/badge";
import { Button } from "@splitch/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@splitch/ui/components/tooltip";
import { canManageBilling, planLabel } from "#lib/billing/org-billing";
import type { OrgRole } from "#lib/sessions/session";

/**
 * The payment half, stubbed in the open. The plan is a real D1 column so it is
 * shown; the payment method and invoices are not wired to anything, so they say
 * so rather than rendering a skeleton that pretends to be loading (ADR-0036).
 */
export function OrgPaymentCard({
  hasBillingAccount,
  orgRole,
  plan,
}: {
  hasBillingAccount: boolean;
  orgRole: OrgRole;
  plan: string;
}) {
  return (
    <Card data-payment-state="stubbed">
      <CardHeader>
        <CardTitle>Plan and payment</CardTitle>
        <CardDescription>Your plan, and where payment is handled today.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">Plan</span>
          <Badge data-billing-plan={plan}>{planLabel(plan)}</Badge>
        </div>

        <div className="grid gap-2 text-sm leading-6">
          <p className="text-foreground">
            Payment is handled by your account team. There is no payment method or invoice to show
            here yet.
          </p>
          {hasBillingAccount ? (
            <p className="text-muted-foreground">
              A billing account is on file for this Organization. Your account team can change it.
            </p>
          ) : null}
        </div>

        <ManagePlanAction orgRole={orgRole} />
      </CardContent>
    </Card>
  );
}

/**
 * Two different refusals, each named. An owner is told the surface does not exist
 * yet; everyone else is told it is an owner action, because hiding the control
 * would teach a member nothing about why they cannot use it.
 */
function ManagePlanAction({ orgRole }: { orgRole: OrgRole }) {
  if (!canManageBilling(orgRole)) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button data-testid="manage-plan-locked" disabled type="button" variant="outline" />
          }
        >
          Manage plan (locked)
        </TooltipTrigger>
        <TooltipContent>
          Managing the plan is an Organization owner action. Your role is {orgRole}.
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button data-testid="manage-plan" disabled type="button" variant="outline" />}
      >
        Manage plan
      </TooltipTrigger>
      <TooltipContent>
        Plan changes are not available in this panel yet. Contact your account team.
      </TooltipContent>
    </Tooltip>
  );
}
