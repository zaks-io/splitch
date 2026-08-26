/**
 * SSRF boundary for the Sentry change-tracking webhook.
 *
 * `webhookUrl` is customer-supplied and the Worker POSTs to it from inside
 * Cloudflare's network on a cron, unattended. An unvalidated host would let a
 * caller aim splitch's egress at a metadata endpoint or an internal service and
 * read the response status back out of the installation row's error field.
 *
 * Enforced at install time AND again at dispatch time. Install-time alone is not
 * enough: the row outlives the request, and a future migration, restore, or
 * direct D1 write must not be able to smuggle a host past the check.
 */

const SENTRY_SAAS_HOST = "sentry.io";
/** `https://sentry.io/api/0/organizations/<org>/flags/hooks/provider/generic/` */
const SENTRY_PATH = /^\/api\/0\/organizations\/[^/]+\/flags\/hooks\/provider\/generic\/?$/;

export interface SentryUrlPolicy {
  /** Extra hosts for self-hosted Sentry, comma-separated. */
  allowedHosts?: string;
}

export function sentryWebhookUrlError(value: string, policy: SentryUrlPolicy): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "webhookUrl is not a valid URL";
  }
  return (
    shapeError(url) ??
    hostError(url, policy) ??
    // Self-hosted deployments mount the same provider path, so the shape check is
    // not relaxed for them: a matching host pointed at an arbitrary path is still
    // an arbitrary POST target.
    (SENTRY_PATH.test(url.pathname)
      ? null
      : "webhookUrl must be a /flags/hooks/provider/generic/ endpoint")
  );
}

function shapeError(url: URL): string | null {
  if (url.protocol !== "https:") return "webhookUrl must use https";
  if (url.username || url.password) return "webhookUrl must not carry credentials";
  if (url.port) return "webhookUrl must not specify a port";
  if (url.search || url.hash) return "webhookUrl must not carry a query string or fragment";
  return null;
}

function hostError(url: URL, policy: SentryUrlPolicy): string | null {
  const host = url.hostname.toLowerCase();
  const isSaas = host === SENTRY_SAAS_HOST || host.endsWith(`.${SENTRY_SAAS_HOST}`);
  if (isSaas || parseAllowedHosts(policy.allowedHosts).has(host)) return null;
  return "webhookUrl host must be sentry.io, a sentry.io region, or a configured self-hosted host";
}

function parseAllowedHosts(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}
