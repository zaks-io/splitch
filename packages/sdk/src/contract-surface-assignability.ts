/**
 * Compile-time assignability between hand-maintained mirror types and the
 * contracts Zod-inferred originals. Read by `tsc -p tsconfig.contract-assignability.json`
 * (wired into the package `typecheck` script). Both directions must hold so
 * published `.d.ts` cannot silently drift from contracts.
 */

import type { ErrorCode as ContractErrorCode } from "../../contracts/src/error-code";
import type {
  EvaluateAllEntry as ContractEvaluateAllEntry,
  EvaluateAllReason as ContractEvaluateAllReason,
  EvaluateAllResponse as ContractEvaluateAllResponse,
} from "../../contracts/src/leaves/evaluate-all-wire";
import type {
  DataPlaneEvaluateResponse as ContractDataPlaneEvaluateResponse,
  PeekEvaluateResponse as ContractPeekEvaluateResponse,
} from "../../contracts/src/leaves/data-plane-evaluate-wire";
import type {
  ResolutionDetails as ContractResolutionDetails,
  VariantValue as ContractVariantValue,
} from "../../contracts/src/leaves/resolution-details";
import type { ResolutionReason as ContractResolutionReason } from "../../contracts/src/leaves/resolution-reason";
import type {
  DataPlaneEvaluateResponse,
  ErrorCode,
  EvaluateAllEntry,
  EvaluateAllReason,
  EvaluateAllResponse,
  PeekEvaluateResponse,
  ResolutionDetails,
  ResolutionReason,
  VariantValue,
} from "../scripts/contract-surface-enums";

type Extends<A, B> = A extends B ? true : false;
type Equal<A, B> = Extends<A, B> extends true ? (Extends<B, A> extends true ? true : false) : false;

type AssertTrue<T extends true> = T;

type _ErrorCode = AssertTrue<Equal<ErrorCode, ContractErrorCode>>;
type _ResolutionReason = AssertTrue<Equal<ResolutionReason, ContractResolutionReason>>;
type _EvaluateAllReason = AssertTrue<Equal<EvaluateAllReason, ContractEvaluateAllReason>>;
type _VariantValue = AssertTrue<Equal<VariantValue, ContractVariantValue>>;
type _ResolutionDetails = AssertTrue<Equal<ResolutionDetails, ContractResolutionDetails>>;
type _EvaluateAllEntry = AssertTrue<Equal<EvaluateAllEntry, ContractEvaluateAllEntry>>;
type _DataPlaneEvaluateResponse = AssertTrue<
  Equal<DataPlaneEvaluateResponse, ContractDataPlaneEvaluateResponse>
>;
type _PeekEvaluateResponse = AssertTrue<Equal<PeekEvaluateResponse, ContractPeekEvaluateResponse>>;
type _EvaluateAllResponse = AssertTrue<Equal<EvaluateAllResponse, ContractEvaluateAllResponse>>;

export const contractSurfaceAssignability: {
  errorCode: _ErrorCode;
  resolutionReason: _ResolutionReason;
  evaluateAllReason: _EvaluateAllReason;
  variantValue: _VariantValue;
  resolutionDetails: _ResolutionDetails;
  evaluateAllEntry: _EvaluateAllEntry;
  dataPlaneEvaluateResponse: _DataPlaneEvaluateResponse;
  peekEvaluateResponse: _PeekEvaluateResponse;
  evaluateAllResponse: _EvaluateAllResponse;
} = {
  errorCode: true,
  resolutionReason: true,
  evaluateAllReason: true,
  variantValue: true,
  resolutionDetails: true,
  evaluateAllEntry: true,
  dataPlaneEvaluateResponse: true,
  peekEvaluateResponse: true,
  evaluateAllResponse: true,
};
