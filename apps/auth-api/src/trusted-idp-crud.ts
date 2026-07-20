import type { Repository } from "@splitch/db";

/**
 * Trusted-IdP CRUD — Org `owner` role only (access-control-matrix.md).
 *
 * Authorization intersects the credential's exact Org-owner scope with live D1
 * Org-owner membership (ADR-0018). Neither a stale/forged scope nor a broader
 * live membership can grant access alone. Fail-loud: a non-owner is FORBIDDEN,
 * an unknown Org is FORBIDDEN (we do not leak existence), never a silent allow.
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

interface TrustedIdpActor {
  userId: string;
  scopes: readonly string[];
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
  actor: TrustedIdpActor,
): Promise<CrudResult<true>> {
  if (!actor.scopes.includes(`org:${orgId}:owner`)) {
    return { ok: false, status: 403, code: "FORBIDDEN" };
  }
  const membership = await repo.identity.getOrgMembership(orgId, actor.userId);
  if (membership?.role !== "owner") {
    return { ok: false, status: 403, code: "FORBIDDEN" };
  }
  return { ok: true, value: true };
}

function newIdpId(): string {
  return `idp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export interface TrustedIdpCrud {
  list(orgId: string, actor: TrustedIdpActor): Promise<CrudResult<unknown[]>>;
  create(
    orgId: string,
    actor: TrustedIdpActor,
    input: TrustedIdpInput,
  ): Promise<CrudResult<unknown>>;
  remove(
    orgId: string,
    actor: TrustedIdpActor,
    idpId: string,
  ): Promise<CrudResult<{ deleted: true }>>;
}

export function makeTrustedIdpCrud(repo: Repository, now: () => number): TrustedIdpCrud {
  return {
    async list(orgId, actor) {
      const owner = await assertOwner(repo, orgId, actor);
      if (!owner.ok) {
        return owner;
      }
      // Scoped to the tenant's own rows — never the global seeds or another tenant's.
      return { ok: true, value: await repo.privacy.listTrustedIdps(orgId) };
    },

    async create(orgId, actor, input) {
      const owner = await assertOwner(repo, orgId, actor);
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

    async remove(orgId, actor, idpId) {
      const owner = await assertOwner(repo, orgId, actor);
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
