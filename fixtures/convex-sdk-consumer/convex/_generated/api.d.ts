/* eslint-disable */
/** Generated-shape `api` utility for the offline consumer fixture. */
import type * as checkout from "../checkout.js";
import type * as checkoutProbe from "../checkoutProbe.js";
import type * as flags from "../flags.js";
import type * as http from "../http.js";
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";

declare const fullApi: ApiFromModules<{
  checkout: typeof checkout;
  checkoutProbe: typeof checkoutProbe;
  flags: typeof flags;
  http: typeof http;
}>;

export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;

export declare const components: {};
