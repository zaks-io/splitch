import {
  type LiveUpdateAuthorizationContext,
  type LiveUpdateConnectionContext,
  parseLiveUpdateConnectionContext,
} from "@splitch/contracts";

export const LIVE_UPDATE_CONTEXT_HEADER = "x-splitch-live-update-context";

export function parseConfigStoreConnectionContext(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parsePanelSessionContext(raw: unknown): LiveUpdateConnectionContext | null {
  const context = parseLiveUpdateConnectionContext(raw);
  return isPanelSessionContext(context) ? context : null;
}

export function isPanelSessionContext(
  context: LiveUpdateAuthorizationContext | null,
): context is LiveUpdateConnectionContext {
  return context !== null && "sessionTokenHash" in context;
}
