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
    const announcementKey = flagAnnouncementKey(config.appId, config.environmentId, flagId);
    const announced = this.announcements.get(announcementKey);
    if (announced !== undefined && version < announced.version) {
      return false;
    }
    const servedVersion = this.servedVersions.get(announcementKey);
    if (servedVersion !== undefined && version < servedVersion) {
      return false;
    }
    this.entries.set(kvKey, { config, flagId, version });
    this.servedVersions.set(announcementKey, Math.max(servedVersion ?? 0, version));
    if (announced !== undefined && version >= announced.version) {
      this.announcements.delete(announcementKey);
    }
    return true;
  }

  invalidate(appId: string, environmentId: string, nudge: DeltaNudge, announcedAt: number): void {
    if (nudge.entity !== "flag") return;

    const announcementKey = flagAnnouncementKey(appId, environmentId, nudge.id);
    this.recordAnnouncement(announcementKey, nudge.version, announcedAt);

    const prefix = environmentPrefix(appId, environmentId);
    for (const [key, entry] of this.entries) {
      if (key.startsWith(prefix) && entry.flagId === nudge.id) this.entries.delete(key);
    }
  }

  private recordAnnouncement(key: string, version: number, announcedAt: number): void {
    const existing = this.announcements.get(key);
    const servedVersion = this.servedVersions.get(key) ?? 0;
    if (version > servedVersion) {
      // Newer version floors the breach clock; same-version nudges keep the
      // original announcedAt so experiment-only refreshes cannot suppress SLO.
      if (existing === undefined || version > existing.version) {
        this.announcements.set(key, { version, announcedAt });
      }
    } else if (existing !== undefined && existing.version <= servedVersion) {
      this.announcements.delete(key);
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
