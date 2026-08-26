"use client";

import type { FunctionReference } from "convex/server";
import { useQuery } from "convex/react";
import type { Value } from "convex/values";
import type {
  LocalResolutionDetails as ResolutionDetails,
  VariantValue,
} from "@splitch/sdk/local-evaluation";

export type ConvexVariantValue = VariantValue & Value;

export type SplitchReactQueryArgs = Record<string, Value> & {
  readonly flagKey: string;
  readonly defaultValue: ConvexVariantValue;
};

export type SplitchReactQuery = FunctionReference<
  "query",
  "public",
  SplitchReactQueryArgs,
  ResolutionDetails
>;

export interface SplitchReactBindings {
  useFlag(flagKey: string, defaultValue: ConvexVariantValue): VariantValue | undefined;
  useFlagDetails(flagKey: string, defaultValue: ConvexVariantValue): ResolutionDetails | undefined;
}

export function createSplitchReact(query: SplitchReactQuery): SplitchReactBindings {
  function useFlagDetails(
    flagKey: string,
    defaultValue: ConvexVariantValue,
  ): ResolutionDetails | undefined {
    return useQuery(query, { flagKey, defaultValue });
  }

  function useFlag(flagKey: string, defaultValue: ConvexVariantValue): VariantValue | undefined {
    return useFlagDetails(flagKey, defaultValue)?.value;
  }

  return { useFlag, useFlagDetails };
}
