import type { DeltaNudge } from "@splitch/contracts";
import type { FlagConfig } from "./provider";

export interface CachedFlagConfig {
  config: FlagConfig;
  flagId: string;
  version: number;
}

export interface AnnouncedFlagVersion {
  announcedAt: number;
  version: number;
}

/** Isolate-wide, version-aware Flag Configuration cache. */
export class FlagConfigCache {
  private readonly entries = new Map<string, CachedFlagConfig>();
  private readonly announcements = new Map<string, AnnouncedFlagVersion>();
  private readonly servedVersions = new Map<string, number>();

  get(kvKey: string): CachedFlagConfig | undefined {
    return this.entries.get(kvKey);
  }

  set(kvKey: string, flagId: string, version: number, config: FlagConfig): boolean {
    const announced = this.announcedVersion(config.appId, config.environmentId, flagId);
    if (announced !== undefined && version < announced.version) {
      return false;
    }
    this.entries.set(kvKey, { config, flagId, version });
    this.servedVersions.set(
      flagAnnouncementKey(config.appId, config.environmentId, flagId),
      version,
    );
    return true;
  }

  invalidate(appId: string, environmentId: string, nudge: DeltaNudge, announcedAt: number): void {
    if (nudge.entity !== "flag") return;

    const announcementKey = flagAnnouncementKey(appId, environmentId, nudge.id);
    const existing = this.announcements.get(announcementKey);
    if (existing === undefined || nudge.version >= existing.version) {
      this.announcements.set(announcementKey, { version: nudge.version, announcedAt });
    }

    const prefix = environmentPrefix(appId, environmentId);
    for (const [key, entry] of this.entries) {
      if (key.startsWith(prefix) && entry.flagId === nudge.id) this.entries.delete(key);
    }
  }

  invalidateEnvironment(appId: string, environmentId: string): void {
    const prefix = environmentPrefix(appId, environmentId);
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  announcedVersion(
    appId: string,
    environmentId: string,
    flagId: string,
  ): AnnouncedFlagVersion | undefined {
    return this.announcements.get(flagAnnouncementKey(appId, environmentId, flagId));
  }

  servedVersion(appId: string, environmentId: string, flagId: string): number | undefined {
    return this.servedVersions.get(flagAnnouncementKey(appId, environmentId, flagId));
  }

  get size(): number {
    return this.entries.size;
  }
}

function environmentPrefix(appId: string, environmentId: string): string {
  return `app:${appId}:${environmentId}:`;
}

function flagAnnouncementKey(appId: string, environmentId: string, flagId: string): string {
  return `${appId}\u0000${environmentId}\u0000${flagId}`;
}
