import { describe, expect, it } from "vitest";
import { sentryWebhookUrlError } from "./sentry-webhook-url";

const OK = "https://sentry.io/api/0/organizations/acme/flags/hooks/provider/generic/";

describe("Sentry webhook URL guard", () => {
  it("accepts the SaaS endpoint and its regional subdomains", () => {
    expect(sentryWebhookUrlError(OK, {})).toBeNull();
    expect(sentryWebhookUrlError(OK.replace("sentry.io", "us.sentry.io"), {})).toBeNull();
    expect(sentryWebhookUrlError(OK.replace("sentry.io", "de.sentry.io"), {})).toBeNull();
  });

  it("rejects every host that is not Sentry or explicitly allowlisted", () => {
    // The Worker POSTs this URL unattended from inside Cloudflare's network.
    for (const host of ["169.254.169.254", "localhost", "evil.com", "notsentry.io"]) {
      expect(sentryWebhookUrlError(OK.replace("sentry.io", host), {})).not.toBeNull();
    }
    // A suffix match on the bare name would let `evilsentry.io` through.
    expect(sentryWebhookUrlError(OK.replace("sentry.io", "evilsentry.io"), {})).not.toBeNull();
  });

  it("admits a self-hosted host only when configured", () => {
    const url = OK.replace("sentry.io", "sentry.internal.example");
    expect(sentryWebhookUrlError(url, {})).not.toBeNull();
    expect(
      sentryWebhookUrlError(url, { allowedHosts: "other.example, sentry.internal.example" }),
    ).toBeNull();
  });

  it("rejects http, credentials, ports, queries and fragments", () => {
    expect(sentryWebhookUrlError(OK.replace("https:", "http:"), {})).not.toBeNull();
    expect(sentryWebhookUrlError(OK.replace("https://", "https://u:p@"), {})).not.toBeNull();
    expect(sentryWebhookUrlError(OK.replace("sentry.io", "sentry.io:8443"), {})).not.toBeNull();
    expect(sentryWebhookUrlError(`${OK}?x=1`, {})).not.toBeNull();
    expect(sentryWebhookUrlError(`${OK}#x`, {})).not.toBeNull();
  });

  it("rejects an allowed host pointed at some other path", () => {
    expect(sentryWebhookUrlError("https://sentry.io/api/0/organizations/acme/", {})).not.toBeNull();
    expect(sentryWebhookUrlError("https://sentry.io/", {})).not.toBeNull();
  });
});
