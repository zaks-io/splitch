/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crypto from "../crypto.js";
import type * as evaluation from "../evaluation.js";
import type * as evaluation_state from "../evaluation_state.js";
import type * as exposure_delivery from "../exposure_delivery.js";
import type * as http from "../http.js";
import type * as integration from "../integration.js";
import type * as integration_cleanup from "../integration_cleanup.js";
import type * as integration_recovery from "../integration_recovery.js";
import type * as integration_remote from "../integration_remote.js";
import type * as integration_state from "../integration_state.js";
import type * as retention from "../retention.js";
import type * as snapshot from "../snapshot.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  crypto: typeof crypto;
  evaluation: typeof evaluation;
  evaluation_state: typeof evaluation_state;
  exposure_delivery: typeof exposure_delivery;
  http: typeof http;
  integration: typeof integration;
  integration_cleanup: typeof integration_cleanup;
  integration_recovery: typeof integration_recovery;
  integration_remote: typeof integration_remote;
  integration_state: typeof integration_state;
  retention: typeof retention;
  snapshot: typeof snapshot;
  validators: typeof validators;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {};
