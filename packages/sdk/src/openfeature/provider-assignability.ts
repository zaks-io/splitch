/**
 * Compile-time proof that SplitchOfrepProvider satisfies the official
 * `@openfeature/server-sdk` Provider contract (including ErrorCode + generic
 * object resolution). Wired into `tsc -p tsconfig.openfeature-assignability.json`.
 */
import { OpenFeature, type Provider } from "@openfeature/server-sdk";
import { SplitchOfrepProvider } from "./provider";

const provider: Provider = new SplitchOfrepProvider({
  baseUrl: "https://edge.example",
  credential: "pk_assignability",
});

OpenFeature.setProvider(provider);

export const openFeatureProviderAssignability: true = true;
