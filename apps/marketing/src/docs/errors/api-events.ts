import type { ErrorDoc } from "./types";

export const eventErrorDocs = {
  ACTIVATION_NOT_AVAILABLE: {
    remediation:
      "Do not retry unchanged; configure the Activation or call activate after the Entity has a matching Exposure",
    cause:
      "The Metric Event cannot activate a matching Experiment Run. The public response stays coarse so it does not reveal whether the Event Definition participates in Activation or whether the Entity has a matching Exposure.",
    fix: "Check that the Metric Event's Event Definition and Entity type match an Activation Metric, then call `activate()` only after the Entity has an Exposure in that Experiment Run. An API Key response names the permanent condition that failed. A Client Key response intentionally does not.",
    related: ["EVENT_DEFINITION_UNPUBLISHED", "ENTITY_TYPE_MISMATCH", "SERVICE_UNAVAILABLE"],
  },
  EVENT_SCHEMA_MISMATCH: {
    remediation: "Send the fields and Dimensions the published Event Definition Version declares",
    cause:
      "The Metric Event did not match the published Event Definition Version: a field or Dimension was unknown, missing, or the wrong type, or a JSON value violated its declared schema.",
    fix: "Send the declared fields and Dimensions with their published types and constraints. If the Metric Event shape has changed, publish a new Event Definition Version before sending that shape.",
    details:
      "{ eventName: string, eventDefinitionVersionId?: string, issues: Array<{ path: string[], message: string }> }",
    related: ["ENTITY_TYPE_MISMATCH", "EVENT_DEFINITION_UNPUBLISHED", "VALIDATION_ERROR"],
  },
  ENTITY_TYPE_MISMATCH: {
    remediation:
      "Send the Metric Event with the Entity type its published Event Definition Version declares",
    cause:
      "The Metric Event's Entity type did not match the Entity type declared by its published Event Definition Version.",
    fix: "Send the Metric Event with the declared Entity type. If the Event Definition now describes a different Entity type, publish a new Version and then retry.",
    details:
      "{ expectedIdType?: string | null, receivedIdType: string, eventDefinitionId?: string, metricId?: string, runId?: string }",
    related: ["EVENT_SCHEMA_MISMATCH", "EVENT_DEFINITION_UNPUBLISHED", "APP_MISMATCH"],
  },
  EVENT_DEFINITION_UNPUBLISHED: {
    remediation: "Publish an Event Definition Version, then retry the Metric Event unchanged",
    cause:
      "The Event Definition exists, but it has no published Version that can validate and stamp the Metric Event.",
    fix: "Publish an Event Definition Version with the intended Entity, field, and Dimension contract, then retry the Metric Event unchanged.",
    details: "{ eventDefinitionId?: string, eventName: string }",
    related: ["EVENT_DEFINITION_NOT_FOUND", "EVENT_DEFINITION_IMMUTABLE", "EVENT_SCHEMA_MISMATCH"],
  },
  EVENT_DEFINITION_IMMUTABLE: {
    remediation: "Publish the changed contract as the next Event Definition Version",
    cause:
      "The request attempted to change a published Event Definition Version, whose contract is immutable so accepted Metric Events remain traceable.",
    fix: "Publish the changed contract as the next Event Definition Version. Keep the existing Version unchanged for Metric Events it already accepted.",
    details: "{ eventDefinitionId: string, eventDefinitionVersionId: string, attemptedOp: string }",
    related: [
      "EVENT_DEFINITION_UNPUBLISHED",
      "EVENT_DEFINITION_VERSION_NOT_FOUND",
      "VALIDATION_ERROR",
    ],
  },
  EVENT_DEFINITION_NOT_FOUND: {
    remediation: "Author the Event Definition in this App, or use one that already belongs to it",
    cause:
      "No Event Definition in this App matched the requested Metric Event name or Event Definition reference.",
    fix: "Author the Event Definition in this App, or use the name of an Event Definition that already belongs to this App, then retry.",
    related: ["EVENT_DEFINITION_UNPUBLISHED", "EVENT_DEFINITION_VERSION_NOT_FOUND", "APP_MISMATCH"],
  },
  EVENT_DEFINITION_VERSION_NOT_FOUND: {
    remediation:
      "Use a published Version of this Event Definition, or publish the Version you intended",
    cause: "The requested Event Definition Version does not exist under this Event Definition.",
    fix: "List the Event Definition's published Versions and use one of those references. Publish a new Version when the intended contract does not exist yet.",
    related: [
      "EVENT_DEFINITION_NOT_FOUND",
      "EVENT_DEFINITION_UNPUBLISHED",
      "EVENT_DEFINITION_IMMUTABLE",
    ],
  },
} satisfies Record<string, ErrorDoc>;
