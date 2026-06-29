import type { Repository } from "@splitch/db";

/**
 * Trusted-IdP CRUD — Org `owner` role only (access-control-matrix.md).
 *
 * Authorization is single-sourced on D1 Org membership (ADR-0018): a caller may
 * manage an Org's trusted IdPs only if they hold the `owner` role on that Org.
 * The check is the repo's `getOrgMembership` — never a token scope alone, so a
 * forged scope cannot grant access. Fail-loud: a non-owner is FORBIDDEN, an
 * unknown Org is FORBIDDEN (we do not leak existence), never a silent allow.
 *
 * The handlers return a plain result; the route layer maps it to a Response. CRUD
 * here speaks the control-plane shape, not the OAuth-door error namespace — these
 * are authenticated management mutations, not the assertion exchange.
 */

interface TrustedIdpInput {
  issuer: string;
  jwksUri: string;
  clientIds: string[];
  enabled?: boolean;
}

type CrudResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: 403 | 404;
      code: "FORBIDDEN" | "ORGANIZATION_NOT_FOUND" | "CREDENTIAL_NOT_FOUND";
    };

async function assertOwner(
  repo: Repository,
  orgId: string,
  userId: string,
): Promise<CrudResult<true>> {
  const membership = await repo.identity.getOrgMembership(orgId, userId);
  if (!membership || membership.role !== "owner") {
    return { ok: false, status: 403, code: "FORBIDDEN" };
  }
  return { ok: true, value: true };
}

function newIdpId(): string {
  return `idp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export interface TrustedIdpCrud {
  list(orgId: string, userId: string): Promise<CrudResult<unknown[]>>;
  create(orgId: string, userId: string, input: TrustedIdpInput): Promise<CrudResult<unknown>>;
  remove(orgId: string, userId: string, idpId: string): Promise<CrudResult<{ deleted: true }>>;
}

export function makeTrustedIdpCrud(repo: Repository, now: () => number): TrustedIdpCrud {
  return {
    async list(orgId, userId) {
      const owner = await assertOwner(repo, orgId, userId);
      if (!owner.ok) {
        return owner;
      }
      // Scoped to the tenant's own rows — never the global seeds or another tenant's.
      return { ok: true, value: await repo.privacy.listTrustedIdps(orgId) };
    },

    async create(orgId, userId, input) {
      const owner = await assertOwner(repo, orgId, userId);
      if (!owner.ok) {
        return owner;
      }
      // org_id is the AUTHZ'D org, never client-supplied: a tenant can only
      // create IdPs under its own Org (and never a global seed, org_id stays set).
      const row = await repo.privacy.createTrustedIdp({
        idpId: newIdpId(),
        orgId,
        issuer: input.issuer,
        jwksUri: input.jwksUri,
        clientIds: JSON.stringify(input.clientIds),
        enabled: input.enabled ?? true,
        createdAt: new Date(now()).toISOString(),
      });
      return { ok: true, value: row };
    },

    async remove(orgId, userId, idpId) {
      const owner = await assertOwner(repo, orgId, userId);
      if (!owner.ok) {
        return owner;
      }
      // Bound by org_id + idp_id; a 0 count means the row is not THIS tenant's
      // (a global seed or another tenant's). Fail-loud 404 — never a lying
      // {deleted:true} that would mask a cross-tenant delete attempt.
      const deleted = await repo.privacy.deleteTrustedIdp(orgId, idpId);
      if (deleted === 0) {
        return { ok: false, status: 404, code: "CREDENTIAL_NOT_FOUND" };
      }
      return { ok: true, value: { deleted: true } };
    },
  };
}
