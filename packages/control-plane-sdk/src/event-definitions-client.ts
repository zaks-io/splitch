import type {
  EventDefinitionsCreateInput,
  EventDefinitionsCreateOutput,
  EventDefinitionsGetInput,
  EventDefinitionsGetOutput,
  EventDefinitionsListInput,
  EventDefinitionsListOutput,
  EventDefinitionsUpdateInput,
  EventDefinitionsUpdateOutput,
  EventDefinitionVersionsCreateInput,
  EventDefinitionVersionsCreateOutput,
  EventDefinitionVersionsGetInput,
  EventDefinitionVersionsGetOutput,
  EventDefinitionVersionsListInput,
  EventDefinitionVersionsListOutput,
} from "@splitch/contracts/route-types";
import {
  type ControlPlaneHcOptions,
  createEventDefinitionsHcClient,
  type EventDefinitionsHcClient,
  hcRequestOptions,
  withAuthorization,
} from "./hc-client";
import { invokeHcRoute } from "./hc-invoke";
import type { ControlPlaneOperationOptions, ControlPlaneOperationResult } from "./operation-result";

type Call<T> = Promise<ControlPlaneOperationResult<T>>;
export interface EventDefinitionsClient {
  list(
    input: EventDefinitionsListInput,
    options?: ControlPlaneOperationOptions,
  ): Call<EventDefinitionsListOutput>;
  create(
    input: EventDefinitionsCreateInput,
    options?: ControlPlaneOperationOptions,
  ): Call<EventDefinitionsCreateOutput>;
  get(
    input: EventDefinitionsGetInput,
    options?: ControlPlaneOperationOptions,
  ): Call<EventDefinitionsGetOutput>;
  update(
    input: EventDefinitionsUpdateInput,
    options?: ControlPlaneOperationOptions,
  ): Call<EventDefinitionsUpdateOutput>;
  publish(
    input: EventDefinitionVersionsCreateInput,
    options?: ControlPlaneOperationOptions,
  ): Call<EventDefinitionVersionsCreateOutput>;
  listVersions(
    input: EventDefinitionVersionsListInput,
    options?: ControlPlaneOperationOptions,
  ): Call<EventDefinitionVersionsListOutput>;
  getVersion(
    input: EventDefinitionVersionsGetInput,
    options?: ControlPlaneOperationOptions,
  ): Call<EventDefinitionVersionsGetOutput>;
}

export function createEventDefinitionsClient(
  options: ControlPlaneHcOptions,
  supplied?: EventDefinitionsHcClient,
): EventDefinitionsClient {
  const client = supplied ?? createEventDefinitionsHcClient(options);
  const call = (callOptions?: ControlPlaneOperationOptions) =>
    hcRequestOptions(withAuthorization(options, callOptions));
  return {
    list: (input, opts) =>
      invokeHcRoute("event_definitions_list", () =>
        client.apps[":appId"]["event-definitions"].$get(
          { param: { appId: input.appId } },
          call(opts),
        ),
      ),
    create: (input, opts) => {
      const { appId, ...body } = input;
      return invokeHcRoute("event_definitions_create", () =>
        client.apps[":appId"]["event-definitions"].$post(
          { param: { appId }, json: body } as never,
          call(opts),
        ),
      );
    },
    get: (input, opts) =>
      invokeHcRoute("event_definitions_get", () =>
        client.apps[":appId"]["event-definitions"][":eventDefinitionId"].$get(
          { param: input },
          call(opts),
        ),
      ),
    update: (input, opts) => {
      const { appId, eventDefinitionId, ...body } = input;
      return invokeHcRoute("event_definitions_update", () =>
        client.apps[":appId"]["event-definitions"][":eventDefinitionId"].$patch(
          { param: { appId, eventDefinitionId }, json: body } as never,
          call(opts),
        ),
      );
    },
    publish: (input, opts) => {
      const { appId, eventDefinitionId, ...body } = input;
      return invokeHcRoute("event_definition_versions_create", () =>
        client.apps[":appId"]["event-definitions"][":eventDefinitionId"].versions.$post(
          { param: { appId, eventDefinitionId }, json: body } as never,
          call(opts),
        ),
      );
    },
    listVersions: (input, opts) =>
      invokeHcRoute("event_definition_versions_list", () =>
        client.apps[":appId"]["event-definitions"][":eventDefinitionId"].versions.$get(
          { param: input },
          call(opts),
        ),
      ),
    getVersion: (input, opts) =>
      invokeHcRoute("event_definition_versions_get", () =>
        client.apps[":appId"]["event-definitions"][":eventDefinitionId"].versions[
          ":versionId"
        ].$get({ param: input }, call(opts)),
      ),
  };
}
