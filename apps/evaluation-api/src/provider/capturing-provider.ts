import type { FlagConfig, Provider } from "./provider";

export class CapturingProvider implements Provider {
  flag: FlagConfig | null = null;
  private readonly prefetched = new Map<string, Promise<FlagConfig>>();

  constructor(private readonly inner: Provider) {}

  /** Start only the identity-independent read; evaluation still awaits admission. */
  prefetchFlag(appId: string, environmentId: string, flagKey: string): Promise<FlagConfig> {
    const key = JSON.stringify([appId, environmentId, flagKey]);
    let read = this.prefetched.get(key);
    if (!read) {
      read = Promise.resolve().then(() => this.inner.getFlag(appId, environmentId, flagKey));
      this.prefetched.set(key, read);
      // Admission can reject first. Keep the original rejection for getFlag.
      void read.catch(() => {});
    }
    return read;
  }

  async getFlag(appId: string, environmentId: string, flagKey: string) {
    this.flag = await (this.prefetched.get(JSON.stringify([appId, environmentId, flagKey])) ??
      this.inner.getFlag(appId, environmentId, flagKey));
    return this.flag;
  }

  getExperiment(...args: Parameters<Provider["getExperiment"]>) {
    return this.inner.getExperiment(...args);
  }

  getFlags(...args: Parameters<Provider["getFlags"]>) {
    return this.inner.getFlags(...args);
  }
}
