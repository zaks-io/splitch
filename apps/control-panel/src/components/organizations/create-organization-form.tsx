import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@splitch/ui/components/dialog";
import { Input } from "@splitch/ui/components/input";
import { type FormEvent, useState } from "react";
import { createControlPanelOrganization } from "#lib/organizations/control-plane-organization-functions";
import {
  type CreateOrganizationDraft,
  draftOrganizationIssues,
  emptyOrganizationDraft,
  organizationIssueFor,
  suggestOrganizationSlug,
} from "#lib/organizations/create-organization-model";
import {
  type CreateOrganizationEffect,
  createOrganizationEffect,
  type CreateOrganizationFailure,
} from "#lib/organizations/create-organization-outcome";
import type { StaleSession } from "#lib/sessions/stale-session";

export function CreateOrganizationForm({
  onCreated,
  onStaleSession,
}: {
  onCreated: (orgSlug: string) => void;
  onStaleSession: (stale: StaleSession) => void;
}) {
  const [draft, setDraft] = useState<CreateOrganizationDraft>(emptyOrganizationDraft);
  const [slugEdited, setSlugEdited] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<CreateOrganizationFailure | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const issues = draftOrganizationIssues(draft);
  const shown = submitted ? issues : [];
  const nameError = organizationIssueFor(shown, "name");
  const slugError = organizationIssueFor(shown, "slug") ?? failure?.slugMessage;

  function edit(next: CreateOrganizationDraft) {
    setDraft(next);
    setFailure(null);
  }

  function settle(effect: CreateOrganizationEffect) {
    if (effect.kind === "created") onCreated(effect.orgSlug);
    else if (effect.kind === "session-stale") {
      onStaleSession({ slug: effect.orgSlug, reason: effect.reason, remedy: effect.remedy });
    } else setFailure(effect.failure);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (issues.length > 0) return;

    setFailure(null);
    setIsSubmitting(true);
    try {
      settle(
        createOrganizationEffect(
          await createControlPanelOrganization({
            data: { name: draft.name.trim(), slug: draft.slug.trim() },
          }),
        ),
      );
    } catch (cause) {
      settle(createOrganizationEffect(cause));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="grid gap-5" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Create Organization</DialogTitle>
        <DialogDescription>
          An Organization is the account boundary: it owns your Apps, your team, and your billing.
          Everything else in splitch lives inside one.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <label className="font-medium text-sm" htmlFor="org-name">
          Organization name
        </label>
        <Input
          aria-invalid={Boolean(nameError)}
          autoComplete="off"
          id="org-name"
          name="name"
          onChange={(event) =>
            edit({
              name: event.target.value,
              slug: slugEdited ? draft.slug : suggestOrganizationSlug(event.target.value),
            })
          }
          placeholder="Acme Labs"
          value={draft.name}
        />
        {nameError ? <p className="text-destructive text-xs">{nameError}</p> : null}
      </div>

      <div className="grid gap-2">
        <label className="font-medium text-sm" htmlFor="org-slug">
          URL handle
        </label>
        <Input
          aria-describedby="org-slug-help"
          aria-invalid={Boolean(slugError)}
          autoComplete="off"
          data-testid="create-organization-slug"
          id="org-slug"
          name="slug"
          onChange={(event) => {
            setSlugEdited(true);
            edit({ ...draft, slug: event.target.value });
          }}
          placeholder="acme-labs"
          value={draft.slug}
        />
        <p
          className={slugError ? "text-destructive text-xs" : "text-muted-foreground text-xs"}
          id="org-slug-help"
        >
          {slugError ?? "Appears in every URL for this Organization. Unique across splitch."}
        </p>
      </div>

      {/* The Worker decides which handles are free and who may create an
          Organization at all, so its refusal is shown verbatim rather than
          reduced to a generic failure (ADR-0023, ADR-0036). A taken handle is a
          normal outcome: nothing here rewrites it, the user picks another. */}
      {failure ? (
        <Alert data-testid="create-organization-error" variant="destructive">
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>
            {failure.message}
            {failure.nextStep ? <span className="block pt-1">{failure.nextStep}</span> : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button data-testid="create-organization-submit" disabled={isSubmitting} type="submit">
          {isSubmitting ? "Creating…" : "Create Organization"}
        </Button>
      </DialogFooter>
    </form>
  );
}
