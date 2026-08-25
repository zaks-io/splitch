/* eslint-disable */
import type {
  ActionBuilder,
  GenericActionCtx,
  GenericDatabaseReader,
  GenericDatabaseWriter,
  GenericMutationCtx,
  GenericQueryCtx,
  HttpActionBuilder,
  MutationBuilder,
  QueryBuilder,
} from "convex/server";
import {
  actionGeneric,
  httpActionGeneric,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import type { DataModel } from "./dataModel";

export const query: QueryBuilder<DataModel, "public"> = queryGeneric;
export const internalQuery: QueryBuilder<DataModel, "internal"> = internalQueryGeneric;
export const mutation: MutationBuilder<DataModel, "public"> = mutationGeneric;
export const internalMutation: MutationBuilder<DataModel, "internal"> = internalMutationGeneric;
export const action: ActionBuilder<DataModel, "public"> = actionGeneric;
export const internalAction: ActionBuilder<DataModel, "internal"> = internalActionGeneric;
export const httpAction: HttpActionBuilder = httpActionGeneric;

export interface Env {
  SPLITCH_API_KEY: string;
  SPLITCH_ENDPOINT?: string;
  CONVEX_SITE_URL: string;
  CONVEX_CLOUD_URL: string;
}

export const env: Env = (globalThis as unknown as { process: { env: Env } }).process.env;
export type QueryCtx = GenericQueryCtx<DataModel>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type ActionCtx = GenericActionCtx<DataModel>;
export type DatabaseReader = GenericDatabaseReader<DataModel>;
export type DatabaseWriter = GenericDatabaseWriter<DataModel>;
