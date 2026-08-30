// biome-ignore lint/performance/noBarrelFile: published @splitch/sdk/local-evaluation package interface
export {
  ConvexConfigChangedSchema,
  ConvexConfigSnapshotSchema,
  ConvexInstallationSchema,
} from "../../../contracts/src/index";
export type {
  ConvexConfigSnapshot,
  EvaluationContext,
  VariantValue,
} from "../../../contracts/src/index";
import type { ResolutionDetails } from "../../../contracts/src/index";
export {
  configSnapshotProvider,
  evaluatePath,
  parseConfigSnapshot,
  resolutionReasonFor,
} from "../../../evaluation-core/src/index";
export type { EvaluateResult, Provider } from "../../../evaluation-core/src/index";

export type LocalResolutionDetails = Omit<ResolutionDetails, "errorCode"> & {
  readonly errorCode?: string;
};
