import { env } from "cloudflare:workers";
import type { LocalBindings } from "../src/test-fixtures";

/**
 * `makeLocalBindings` for tests running INSIDE workerd.
 *
 * The `src/` variant boots a Miniflare instance and reaches D1/KV through the
 * magic proxy, where "accessing a property on a proxy will result in a
 * synchronous GET operation to the proxy server" (cloudflare/miniflare#639).
 * That is one loopback TCP connection per database operation, and it is what
 * exhausted the ephemeral port range and produced EADDRNOTAVAIL.
 *
 * Under the Workers pool the bindings are the real in-process ones, so the same
 * suite costs zero sockets. The signature matches `makeLocalBindings` so the
 * migrated tests read identically; `dispose` is a no-op because there is no
 * runtime to tear down.
 */
export async function makePoolBindings(): Promise<LocalBindings> {
  return {
    d1: env.DB,
    kv: env.SESSION_STORE,
    credentialKv: env.CREDENTIAL_STORE,
    dispose: async () => {},
  };
}
