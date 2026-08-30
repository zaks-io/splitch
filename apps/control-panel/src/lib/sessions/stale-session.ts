import type { ResyncRemedy } from "#lib/live-updates/resync-remedy";

/**
 * What a form needs to hand its dialog once `settleAfterCreate` reports
 * `created-session-stale` (SPL-203): the slug so `StaleSessionNotice` can name
 * the resource, and the reason/remedy so the notice can show what actually
 * happened and offer only a remedy that works for it.
 */
export interface StaleSession {
  readonly slug: string;
  readonly reason: string;
  readonly remedy: ResyncRemedy;
}
