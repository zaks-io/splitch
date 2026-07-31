import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MutationErrorSurface } from "#lib/api";
import type { ApprovalGateRecord } from "#lib/approval-gate-record";
import { ApprovalGateBody } from "./approval-gate-dialog";

/**
 * The footer is the only thing on this screen that tells the operator what the
 * proposal's state IS. After a refusal that resolved the Request, offering to
 * apply it and calling it pending would report a state the audit log is not in —
 * the disguised default ADR-0036 forbids, dressed as copy.
 */
describe("ApprovalGateBody", () => {
  it("keeps the gate live and the copy pending while nothing has refused it", () => {
    const html = render(null);

    expect(html).toContain('data-gate-disposition="pending"');
    expect(html).toContain("Confirming records your Review on Approval Request");
    expect(confirmDisabled(html)).toBe(false);
  });

  it("closes the gate once a refusal resolved the Request", () => {
    const html = render({
      kind: "field",
      code: "RUN_FROZEN",
      message: "running Run run_live owns this Flag Configuration field",
      fields: [],
    });

    expect(html).toContain('data-gate-disposition="resolved"');
    expect(html).toContain("so it can no longer be applied");
    expect(html).not.toContain("Confirming records your Review on Approval Request");
    expect(confirmDisabled(html)).toBe(true);
  });

  /**
   * `APPROVAL_REQUEST_RESOLVED` carries HOW it resolved. When another reviewer
   * already applied it, "propose the change again" would have the operator write
   * a second copy of a change that already landed.
   */
  it("does not tell the operator to re-propose a change that already landed", () => {
    const html = render({
      kind: "resolved",
      code: "APPROVAL_REQUEST_RESOLVED",
      message: "Approval Request is already resolved",
      status: "applied",
      fields: [],
    });

    expect(html).toContain('data-gate-disposition="applied"');
    expect(html).toContain("was already applied by another Review");
    expect(html).not.toContain("propose the change again");
    expect(confirmDisabled(html)).toBe(true);
  });

  it("still offers a re-proposal when the Request resolved without applying", () => {
    const html = render({
      kind: "resolved",
      code: "APPROVAL_REQUEST_RESOLVED",
      message: "Approval Request is already resolved",
      status: "declined",
      fields: [],
    });

    expect(html).toContain('data-gate-disposition="resolved"');
    expect(html).toContain("propose the change again");
  });

  /** An ordinary field refusal leaves the proposal pending and re-reviewable. */
  it("leaves the gate live for a refusal that did not resolve the Request", () => {
    const html = render({
      kind: "field",
      code: "VARIANT_NOT_AVAILABLE",
      message: "requested Variants are not available",
      fields: [],
    });

    expect(html).toContain('data-gate-disposition="pending"');
    expect(confirmDisabled(html)).toBe(false);
  });
});

const record: ApprovalGateRecord = {
  id: "aprq_01",
  status: "pending",
  operation: "flag_config.update",
  targetType: "flag_configuration",
  proposerUserId: "user_01",
  proposedAt: "2026-07-30T00:00:00.000Z",
  policyContexts: [{ environmentId: "env_prod", changeTypes: ["flag_config"], level: "confirm" }],
  rows: [
    {
      path: "enabled",
      group: "Flag Configuration",
      field: "enabled",
      before: ["false"],
      after: ["true"],
      hasBefore: true,
      hasAfter: true,
    },
  ],
};

function render(error: MutationErrorSurface | null): string {
  return renderToStaticMarkup(
    <ApprovalGateBody
      confirming={false}
      error={error}
      onCancel={() => undefined}
      onConfirm={() => undefined}
      request={record}
    />,
  );
}

/**
 * Read the attribute off the confirm control's own tag. Matching the word
 * anywhere would pass on the `disabled:` utility classes every Button carries.
 */
function confirmDisabled(html: string): boolean {
  const start = html.indexOf('data-approval-confirm="true"');
  if (start === -1) throw new Error("no confirm button rendered");
  const tag = html.slice(html.lastIndexOf("<button", start), html.indexOf(">", start) + 1);
  return / disabled=""/.test(tag);
}
