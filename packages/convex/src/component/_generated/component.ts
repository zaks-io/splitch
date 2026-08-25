/* eslint-disable */
import type { DefaultFunctionArgs, FunctionReference } from "convex/server";
import type { ResolutionDetails, VariantValue } from "../../public-types";

type Context = { targetingKey: string; idType: string; attributes: Record<string, unknown> };
type Ref<Kind extends "query" | "mutation" | "action", Args extends DefaultFunctionArgs, Result> = FunctionReference<Kind, "internal" | "public", Args, Result>;

export type ComponentApi<Name extends string | undefined = string | undefined> = {
  evaluation: {
    peek: Ref<"query", { flagKey: string; context: Context; defaultValue: VariantValue }, ResolutionDetails>;
    evaluate: Ref<"mutation", { flagKey: string; context: Context; defaultValue: VariantValue; idempotencyKey: string }, ResolutionDetails>;
    deleteEntity: Ref<"mutation", { targetingKey: string; idType: string }, void>;
  };
  integration: {
    install: Ref<"action", {}, { installationId: string; appId: string; environmentId: string; environmentVersion: number; status: "active" | "revoked" }>;
    syncNow: Ref<"action", {}, number>;
    rotateSecret: Ref<"action", {}, void>;
    uninstall: Ref<"action", {}, void>;
  };
};
