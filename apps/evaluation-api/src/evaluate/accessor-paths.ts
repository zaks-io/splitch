import { evaluatePath, type EvaluatePathDeps, type EvaluatePathInput } from "./evaluate-path";
import {
  assembleEvaluateExposures,
  type AssembledExposure,
  type ExposureAssemblyDeps,
} from "./exposure-assembly";
import type { EvaluateResult } from "./evaluate-path-types";

export interface EvaluateAccessorResult {
  readonly result: EvaluateResult;
  readonly exposures: readonly AssembledExposure[];
}

export interface NonExposingAccessorResult {
  readonly result: EvaluateResult;
  readonly exposures: readonly [];
}

export async function evaluate(
  input: EvaluatePathInput,
  deps: EvaluatePathDeps,
  exposureDeps: ExposureAssemblyDeps,
): Promise<EvaluateAccessorResult> {
  const result = await evaluatePath(input, deps);
  const exposures = await assembleEvaluateExposures(input, result, exposureDeps);
  return { result, exposures };
}

export async function peekVariant(
  input: EvaluatePathInput,
  deps: EvaluatePathDeps,
): Promise<NonExposingAccessorResult> {
  return resolveWithoutExposure(input, deps);
}

export async function verify(
  input: EvaluatePathInput,
  deps: EvaluatePathDeps,
): Promise<NonExposingAccessorResult> {
  return resolveWithoutExposure(input, deps);
}

async function resolveWithoutExposure(
  input: EvaluatePathInput,
  deps: EvaluatePathDeps,
): Promise<NonExposingAccessorResult> {
  return { result: await evaluatePath(input, deps), exposures: [] };
}
