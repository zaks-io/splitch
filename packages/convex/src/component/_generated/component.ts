/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    evaluation: {
      deleteEntity: FunctionReference<
        "mutation",
        "internal",
        { idType: string; targetingKey: string },
        null,
        Name
      >;
      evaluate: FunctionReference<
        "mutation",
        "internal",
        {
          context: {
            attributes: Record<string, any>;
            idType: string;
            targetingKey: string;
          };
          defaultValue: boolean | string | number | Record<string, any>;
          flagKey: string;
          idempotencyKey: string;
        },
        {
          errorCode?: string;
          errorMessage?: string;
          reason:
            | "SPLIT"
            | "TARGETING_MATCH"
            | "DEFAULT"
            | "DISABLED"
            | "CACHED"
            | "STALE"
            | "ERROR";
          ruleId?: string;
          value: boolean | string | number | Record<string, any>;
          variantName: string | null;
        },
        Name
      >;
      peek: FunctionReference<
        "query",
        "internal",
        {
          context: {
            attributes: Record<string, any>;
            idType: string;
            targetingKey: string;
          };
          defaultValue: boolean | string | number | Record<string, any>;
          flagKey: string;
        },
        {
          errorCode?: string;
          errorMessage?: string;
          reason:
            | "SPLIT"
            | "TARGETING_MATCH"
            | "DEFAULT"
            | "DISABLED"
            | "CACHED"
            | "STALE"
            | "ERROR";
          ruleId?: string;
          value: boolean | string | number | Record<string, any>;
          variantName: string | null;
        },
        Name
      >;
    };
    integration: {
      install: FunctionReference<
        "action",
        "internal",
        {},
        {
          appId: string;
          environmentId: string;
          environmentVersion: number;
          installationId: string;
          status: "active" | "revoked";
        },
        Name
      >;
      rotateSecret: FunctionReference<"action", "internal", {}, null, Name>;
      syncNow: FunctionReference<"action", "internal", {}, number, Name>;
      uninstall: FunctionReference<"action", "internal", {}, null, Name>;
    };
    metric_event: {
      status: FunctionReference<
        "query",
        "internal",
        { eventId: string },
        {
          error?: string;
          eventId: string;
          state: "missing" | "queued" | "accepted" | "terminal" | "suppressed";
        },
        Name
      >;
      track: FunctionReference<
        "mutation",
        "internal",
        {
          dimensions: Record<string, boolean | string | number>;
          eventId: string;
          eventName: string;
          fields: Record<string, any>;
          idType: string;
          targetingKey: string;
        },
        { eventId: string; queued: true },
        Name
      >;
    };
  };
