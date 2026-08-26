import type { ControlPanelOperation } from "./control-panel-operation.js";

/**
 * The Sentry change-tracking half of the Panel vocabulary.
 *
 * Every path names the Organization and nothing below it. Sentry stores one
 * signing secret per provider per organization and its flag log has no project
 * or environment axis, so an installation is an Organization-wide wiring and the
 * claim binds exactly that.
 *
 * Reading an installation and rotating its signing secret are separate
 * operations for the same reason the Flag config read and write are: rendering
 * delivery health must not carry the authority to replace the secret.
 */

const INSTALLATIONS_PATH = /^\/orgs\/([^/]+)\/integrations\/sentry\/installations\/?$/;
const INSTALLATION_PATH = /^\/orgs\/([^/]+)\/integrations\/sentry\/installations\/([^/]+)\/?$/;
const SECRET_ROTATIONS_PATH =
  /^\/orgs\/([^/]+)\/integrations\/sentry\/installations\/([^/]+)\/secret-rotations\/?$/;

const COLLECTION_METHODS = {
  GET: "sentry_installations_list",
  POST: "sentry_installations_create",
} as const;

export function parseSentryIntegration(
  method: string,
  pathname: string,
): ControlPanelOperation | null {
  return (
    parseSecretRotation(method, pathname) ??
    parseInstallationResource(method, pathname) ??
    parseInstallationCollection(method, pathname)
  );
}

function parseInstallationCollection(
  method: string,
  pathname: string,
): ControlPanelOperation | null {
  const id = COLLECTION_METHODS[method as keyof typeof COLLECTION_METHODS];
  const match = pathname.match(INSTALLATIONS_PATH);
  const orgId = decodeMatch(match, 1);
  return id && orgId ? { id, orgId } : null;
}

function parseInstallationResource(method: string, pathname: string): ControlPanelOperation | null {
  if (method !== "DELETE") return null;
  const match = pathname.match(INSTALLATION_PATH);
  const orgId = decodeMatch(match, 1);
  const installationId = decodeMatch(match, 2);
  return orgId && installationId
    ? { id: "sentry_installations_delete", orgId, installationId }
    : null;
}

function parseSecretRotation(method: string, pathname: string): ControlPanelOperation | null {
  if (method !== "POST") return null;
  const match = pathname.match(SECRET_ROTATIONS_PATH);
  const orgId = decodeMatch(match, 1);
  const installationId = decodeMatch(match, 2);
  return orgId && installationId
    ? { id: "sentry_secret_rotations_create", orgId, installationId }
    : null;
}

function decodeMatch(match: RegExpMatchArray | null, index: number): string | null {
  const value = match?.[index];
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
