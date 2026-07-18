export interface ControlPanelBindings {
  DB: D1Database;
  SESSION_STORE: KVNamespace;
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
  AUTH_API_ORIGIN: string;
  CONTROL_PLANE_API?: Fetcher;
  SPLITCH_PLATFORM_TARGET?: string;
  SENTRY_DSN?: string;
}

interface ControlPanelMutationBindings extends ControlPanelBindings {
  CONTROL_PLANE_API: Fetcher;
}

export interface ControlPanelLiveUpdateBindings extends ControlPanelBindings {
  CONFIG_STORE_WRITER: {
    getByName(name: string): { fetch(request: Request): Promise<Response> };
  };
}

export function controlPanelBindings(raw: unknown): ControlPanelBindings {
  if (!isBindings(raw)) {
    throw new Error("control-panel Worker bindings are unavailable");
  }

  return {
    DB: raw.DB,
    SESSION_STORE: raw.SESSION_STORE,
    WORKOS_API_KEY: requiredString(raw.WORKOS_API_KEY, "WORKOS_API_KEY"),
    WORKOS_CLIENT_ID: requiredString(raw.WORKOS_CLIENT_ID, "WORKOS_CLIENT_ID"),
    AUTH_API_ORIGIN: requiredString(raw.AUTH_API_ORIGIN, "AUTH_API_ORIGIN"),
    CONTROL_PLANE_API: optionalFetcher(raw.CONTROL_PLANE_API),
    SPLITCH_PLATFORM_TARGET: optionalString(raw.SPLITCH_PLATFORM_TARGET),
    SENTRY_DSN: optionalString(raw.SENTRY_DSN),
  };
}

export function controlPanelMutationBindings(raw: unknown): ControlPanelMutationBindings {
  const bindings = controlPanelBindings(raw);
  if (!bindings.CONTROL_PLANE_API) {
    throw new Error("control-panel missing required CONTROL_PLANE_API binding");
  }
  return { ...bindings, CONTROL_PLANE_API: bindings.CONTROL_PLANE_API };
}

export function controlPanelLiveUpdateBindings(raw: unknown): ControlPanelLiveUpdateBindings {
  const bindings = controlPanelBindings(raw);
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("CONFIG_STORE_WRITER" in raw) ||
    typeof raw.CONFIG_STORE_WRITER !== "object" ||
    raw.CONFIG_STORE_WRITER === null ||
    !("getByName" in raw.CONFIG_STORE_WRITER) ||
    typeof raw.CONFIG_STORE_WRITER.getByName !== "function"
  ) {
    throw new Error("control-panel live update Durable Object binding is unavailable");
  }
  return {
    ...bindings,
    CONFIG_STORE_WRITER:
      raw.CONFIG_STORE_WRITER as ControlPanelLiveUpdateBindings["CONFIG_STORE_WRITER"],
  };
}

function isBindings(value: unknown): value is {
  DB: D1Database;
  SESSION_STORE: KVNamespace;
  WORKOS_API_KEY?: unknown;
  WORKOS_CLIENT_ID?: unknown;
  AUTH_API_ORIGIN?: unknown;
  CONTROL_PLANE_API?: unknown;
  SPLITCH_PLATFORM_TARGET?: unknown;
  SENTRY_DSN?: unknown;
} {
  return typeof value === "object" && value !== null && "DB" in value && "SESSION_STORE" in value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`control-panel missing required ${name} binding`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalFetcher(value: unknown): Fetcher | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function"
  ) {
    return value as Fetcher;
  }
  return undefined;
}
