import { DurableObject } from "cloudflare:workers";
import type { CredentialCacheWriter, CredentialCacheWriterAccess } from "./credential-cache";
import type { ControlPlaneApiEnv } from "./env";

export interface CredentialCacheWriterDurableObjectNamespace {
  getByName(name: string): CredentialCacheWriter;
}

export function durableCredentialCacheWriterAccess(
  namespace: CredentialCacheWriterDurableObjectNamespace,
): CredentialCacheWriterAccess {
  return { writerFor: (key) => namespace.getByName(key) };
}

/** A key-addressed DO makes cache writes linearizable with revoke and restriction updates. */
export class CredentialCacheWriterDurableObject
  extends DurableObject<ControlPlaneApiEnv>
  implements CredentialCacheWriter
{
  async put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
    await this.env.CREDENTIAL_STORE.put(key, value, options);
  }
}
