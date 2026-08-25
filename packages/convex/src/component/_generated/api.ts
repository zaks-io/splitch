/* eslint-disable */
import type * as evaluation from "../evaluation";
import type * as integration from "../integration";
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  evaluation: typeof evaluation;
  integration: typeof integration;
}> = anyApi as never;

export const api: FilterApi<typeof fullApi, FunctionReference<any, "public">> = anyApi as never;
export const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">> = anyApi as never;
export const components = componentsGeneric() as unknown as {};
