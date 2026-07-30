import type {
  ApprovalRequestReviewsCreateInput,
  ApprovalRequestReviewsCreateOutput,
  ApprovalRequestsGetInput,
  ApprovalRequestsGetOutput,
  ApprovalRequestsListInput,
  ApprovalRequestsListOutput,
} from "@splitch/contracts/route-types";
import {
  type ApprovalsHcClient,
  type ControlPlaneHcOptions,
  createApprovalsHcClient,
  hcRequestOptions,
  withAuthorization,
} from "./hc-client";
import { invokeHcRoute } from "./hc-invoke";
import type { ControlPlaneOperationOptions, ControlPlaneOperationResult } from "./operation-result";

export interface ApprovalsClient {
  list(
    input: ApprovalRequestsListInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<ApprovalRequestsListOutput>>;
  get(
    input: ApprovalRequestsGetInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<ApprovalRequestsGetOutput>>;
  review(
    input: ApprovalRequestReviewsCreateInput,
    options?: ControlPlaneOperationOptions,
  ): Promise<ControlPlaneOperationResult<ApprovalRequestReviewsCreateOutput>>;
}

export function createApprovalsClient(
  hcOptions: ControlPlaneHcOptions,
  client?: ApprovalsHcClient,
): ApprovalsClient {
  const hcClient = client ?? createApprovalsHcClient(hcOptions);
  return {
    list: (input, callOptions) => {
      const { appId, ...query } = input;
      return invokeHcRoute<ApprovalRequestsListOutput>("approval_requests_list", () =>
        hcClient.apps[":appId"]["approval-requests"].$get(
          { param: { appId }, query } as never,
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      );
    },
    get: (input, callOptions) =>
      invokeHcRoute<ApprovalRequestsGetOutput>("approval_requests_get", () =>
        hcClient.apps[":appId"]["approval-requests"][":id"].$get(
          { param: { appId: input.appId, id: input.id } },
          hcRequestOptions(withAuthorization(hcOptions, callOptions)),
        ),
      ),
    review: (input, callOptions) => {
      const { appId, id, ...body } = input;
      return invokeHcRoute<ApprovalRequestReviewsCreateOutput>(
        "approval_request_reviews_create",
        () =>
          hcClient.apps[":appId"]["approval-requests"][":id"].reviews.$post(
            { param: { appId, id }, json: body } as never,
            withIdempotencyHeader(
              hcRequestOptions(withAuthorization(hcOptions, callOptions)),
              body.idempotency_key,
            ),
          ),
      );
    },
  };
}

function withIdempotencyHeader(
  options: ReturnType<typeof hcRequestOptions>,
  idempotencyKey: string,
) {
  return {
    ...options,
    headers: {
      ...options.headers,
      "idempotency-key": idempotencyKey,
    },
  };
}
