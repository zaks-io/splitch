import type { OperationCoverage } from "./control-panel-operation-coverage-types";

/**
 * Integration installation routes. Resource writes name the installation as
 * well as the Environment, so a claim minted for one installation cannot be
 * replayed against another.
 */

const APP = "app_1";
const ENV = "env_1";
const SENTRY = `/apps/${APP}/envs/${ENV}/integrations/sentry/installations`;
const CONVEX = `/apps/${APP}/envs/${ENV}/integrations/convex/installations`;
const CLOUDFLARE = `/apps/${APP}/envs/${ENV}/integrations/cloudflare/installations`;

export const INTEGRATION_ROUTES: Pick<
  OperationCoverage,
  | "sentry_installations_list"
  | "sentry_installations_create"
  | "sentry_installations_delete"
  | "sentry_secret_rotations_create"
  | "convex_installations_list"
  | "convex_installations_revoke"
  | "cloudflare_installations_list"
  | "cloudflare_installations_revoke"
> = {
  sentry_installations_list: {
    route: { method: "GET", pathname: `${SENTRY}` },
    operation: { id: "sentry_installations_list", appId: APP, environmentId: ENV },
  },
  sentry_installations_create: {
    route: { method: "POST", pathname: `${SENTRY}` },
    operation: { id: "sentry_installations_create", appId: APP, environmentId: ENV },
  },
  sentry_installations_delete: {
    route: { method: "DELETE", pathname: `${SENTRY}/inst_1` },
    operation: {
      id: "sentry_installations_delete",
      appId: APP,
      environmentId: ENV,
      installationId: "inst_1",
    },
  },
  sentry_secret_rotations_create: {
    route: { method: "POST", pathname: `${SENTRY}/inst_1/secret-rotations` },
    operation: {
      id: "sentry_secret_rotations_create",
      appId: APP,
      environmentId: ENV,
      installationId: "inst_1",
    },
  },
  convex_installations_list: {
    route: { method: "GET", pathname: CONVEX },
    operation: { id: "convex_installations_list", appId: APP, environmentId: ENV },
  },
  convex_installations_revoke: {
    route: { method: "DELETE", pathname: `${CONVEX}/inst_1` },
    operation: {
      id: "convex_installations_revoke",
      appId: APP,
      environmentId: ENV,
      installationId: "inst_1",
    },
  },
  cloudflare_installations_list: {
    route: { method: "GET", pathname: CLOUDFLARE },
    operation: { id: "cloudflare_installations_list", appId: APP, environmentId: ENV },
  },
  cloudflare_installations_revoke: {
    route: { method: "DELETE", pathname: `${CLOUDFLARE}/inst_1` },
    operation: {
      id: "cloudflare_installations_revoke",
      appId: APP,
      environmentId: ENV,
      installationId: "inst_1",
    },
  },
};
