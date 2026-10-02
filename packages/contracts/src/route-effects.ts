/**
 * Audited behavioral metadata for a registry route. Declared per operation, never
 * inferred from the HTTP method: `client_key_get` is a GET that provisions a
 * credential, and `experiment_results_post` / `flags_test_eval` are POSTs that
 * write nothing.
 *
 * Reversibility is annotation and result metadata only (plan D8). It does not
 * gate calls. ADR-0029 kill-switch-off remains ungated on `flag_config_update`.
 */

export const reversibilityClasses = ["reversible", "compensable", "irreversible"] as const;
export type ReversibilityClass = (typeof reversibilityClasses)[number];

export interface RouteEffects {
  readonly mutates: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
  readonly reversibility: ReversibilityClass;
}

export const readOnlyClosed = {
  mutates: false,
  destructive: false,
  idempotent: true,
  openWorld: false,
  reversibility: "reversible",
} as const satisfies RouteEffects;

export const readOnlyOpen = {
  ...readOnlyClosed,
  openWorld: true,
} as const satisfies RouteEffects;

function writes(effects: {
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly reversibility: ReversibilityClass;
  readonly openWorld?: boolean;
}): RouteEffects {
  return {
    mutates: true,
    destructive: effects.destructive,
    idempotent: effects.idempotent,
    openWorld: effects.openWorld ?? false,
    reversibility: effects.reversibility,
  };
}

/**
 * Create that mints a fresh resource id (or otherwise accumulates on retry).
 * Prefer `createIdempotentClosed` only when the route requires an idempotency
 * key and the handler proves exact replay.
 */
export const createClosed = writes({
  destructive: false,
  idempotent: false,
  reversibility: "compensable",
});
/** Create with required idempotency and handler-level exact replay. */
export const createIdempotentClosed = writes({
  destructive: false,
  idempotent: true,
  reversibility: "compensable",
});
export const updateClosed = writes({
  destructive: false,
  idempotent: true,
  reversibility: "reversible",
});
export const deleteClosed = writes({
  destructive: true,
  idempotent: true,
  reversibility: "irreversible",
});
export const rotateClosed = writes({
  destructive: true,
  idempotent: false,
  reversibility: "irreversible",
});
export const provisionClosed = writes({
  destructive: false,
  idempotent: true,
  reversibility: "compensable",
});
export const mintSecretClosed = writes({
  destructive: false,
  idempotent: false,
  reversibility: "irreversible",
});
export const membershipRemoveClosed = writes({
  destructive: true,
  idempotent: true,
  reversibility: "compensable",
});
export const startRunClosed = writes({
  destructive: false,
  idempotent: true,
  reversibility: "compensable",
});
export const sealRunClosed = writes({
  destructive: false,
  idempotent: true,
  reversibility: "irreversible",
});
export const publishVersionClosed = writes({
  destructive: false,
  idempotent: true,
  reversibility: "irreversible",
});
export const recordEventClosed = writes({
  destructive: false,
  idempotent: false,
  reversibility: "irreversible",
});
export const exposureWriteClosed = writes({
  destructive: false,
  idempotent: true,
  reversibility: "irreversible",
});
export const mintTicketsClosed = writes({
  destructive: false,
  idempotent: true,
  reversibility: "compensable",
});

export function openWorld(base: RouteEffects): RouteEffects {
  return { ...base, openWorld: true };
}

export interface McpToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export function mcpToolAnnotations(effects: RouteEffects): McpToolAnnotations {
  return {
    readOnlyHint: !effects.mutates,
    destructiveHint: effects.destructive,
    idempotentHint: effects.idempotent,
    openWorldHint: effects.openWorld,
  };
}

export function mcpReversibilityMeta(effects: RouteEffects): {
  reversibilityClass: ReversibilityClass;
} {
  return { reversibilityClass: effects.reversibility };
}

export function assertRouteEffects(route: { operationId: string; effects?: RouteEffects }): void {
  const effects = route.effects;
  if (!effects) {
    throw new Error(`route-registry: route "${route.operationId}" is missing effects`);
  }
  for (const key of ["mutates", "destructive", "idempotent", "openWorld"] as const) {
    if (typeof effects[key] !== "boolean") {
      throw new Error(
        `route-registry: route "${route.operationId}" effects.${key} must be boolean`,
      );
    }
  }
  if (!reversibilityClasses.includes(effects.reversibility)) {
    throw new Error(
      `route-registry: route "${route.operationId}" has unknown reversibility "${String(effects.reversibility)}"`,
    );
  }
  if (!effects.mutates && effects.destructive) {
    throw new Error(
      `route-registry: route "${route.operationId}" is read-only but marked destructive`,
    );
  }
}
