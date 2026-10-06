import { configurationCallbackUrlError } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  configurationCallbackDestinationError,
  postConfigurationCallback,
} from "./configuration-callback-transport";

describe("configuration callback destinations", () => {
  it.each([
    "https://third-cat-295.convex.site/integrations/splitch/configuration",
    "https://gateway.chat.zaks.io/integrations/splitch/configuration",
    "https://customer.workers.dev/configuration",
    "https://customer.example.com/configuration",
  ])("accepts a public HTTPS callback %s", (url) => {
    expect(configurationCallbackUrlError(url)).toBeNull();
    expect(configurationCallbackDestinationError(url)).toBeNull();
  });

  it.each([
    "not a URL",
    "data:text/plain,configuration",
    "http://hooks.example.com/configuration",
    "https://user:pass@hooks.example.com/configuration",
    "https://hooks.example.com:8443/configuration",
    "https://hooks.example.com/configuration?redirect=internal",
    "https://hooks.example.com/configuration#internal",
    "https://hooks.example.com/configuration/",
    "https://hooks.example.com/configuration/other",
    "https://localhost/configuration",
    "https://host.localhost/configuration",
    "https://metadata.google.internal/configuration",
    "https://host.local/configuration",
    "https://host.home.arpa/configuration",
    "https://host.alt/configuration",
    "https://host.test/configuration",
    "https://host.invalid/configuration",
    "https://host.example/configuration",
    "https://host.onion/configuration",
    "https://host/configuration",
    "https://host.example.com./configuration",
    "https://.convex.site/configuration",
    "https://host..convex.site/configuration",
    "https://127.0.0.1/configuration",
    "https://10.0.0.1/configuration",
    "https://169.254.169.254/configuration",
    "https://8.8.8.8/configuration",
    "https://2130706433/configuration",
    "https://0x7f.1/configuration",
    "https://0177.0.0.1/configuration",
    "https://[::1]/configuration",
    "https://[::ffff:127.0.0.1]/configuration",
  ])("rejects an unsafe URL without sending it %s", async (url) => {
    expect(configurationCallbackUrlError(url)).not.toBeNull();
    const fetcher = vi.fn();
    expect(await postConfigurationCallback({ url, body: "{}", headers: {}, fetcher })).toEqual({
      outcome: "rejected",
      status: 400,
      retryable: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "https://splitch.dev/configuration",
    "https://api.splitch.dev/configuration",
    "https://api.preview.splitch.dev/configuration",
    "https://splitch-control-plane-api.account.workers.dev/configuration",
  ])("blocks Splitch's own services %s", (url) => {
    expect(configurationCallbackDestinationError(url)).toContain("own services");
  });

  it("refuses redirects and sends a timeout signal", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/configuration" },
        }),
    );
    await expect(
      postConfigurationCallback({
        url: "https://hooks.example.com/configuration",
        body: "{}",
        headers: {},
        fetcher,
      }),
    ).resolves.toEqual({ outcome: "rejected", status: 302, retryable: false });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
  });
});
