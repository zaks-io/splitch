import type { z } from "@hono/zod-openapi";
import type {
  EventDefinitionDetailSchema,
  EventDefinitionListResponseSchema,
  EventDefinitionSchema,
  EventDefinitionVersionListResponseSchema,
  EventDefinitionVersionSchema,
} from "./event-definition";
import type {
  CreateEventDefinitionRequestSchema,
  PatchEventDefinitionRequestSchema,
  PublishEventDefinitionVersionRequestSchema,
} from "./event-definition-write";
import type { AppParams } from "./routes/route-shapes";

type EventDefinitionPath = z.infer<typeof AppParams> & { eventDefinitionId: string };
type EventDefinitionVersionPath = EventDefinitionPath & { versionId: string };
export type EventDefinitionsListInput = z.infer<typeof AppParams>;
export type EventDefinitionsListOutput = z.infer<typeof EventDefinitionListResponseSchema>;
export type EventDefinitionsCreateInput = z.infer<typeof AppParams> &
  z.infer<typeof CreateEventDefinitionRequestSchema>;
export type EventDefinitionsCreateOutput = z.infer<typeof EventDefinitionSchema>;
export type EventDefinitionsGetInput = EventDefinitionPath;
export type EventDefinitionsGetOutput = z.infer<typeof EventDefinitionDetailSchema>;
export type EventDefinitionsUpdateInput = EventDefinitionPath &
  z.infer<typeof PatchEventDefinitionRequestSchema>;
export type EventDefinitionsUpdateOutput = z.infer<typeof EventDefinitionSchema>;
export type EventDefinitionVersionsCreateInput = EventDefinitionPath &
  z.infer<typeof PublishEventDefinitionVersionRequestSchema>;
export type EventDefinitionVersionsCreateOutput = z.infer<typeof EventDefinitionVersionSchema>;
export type EventDefinitionVersionsListInput = EventDefinitionPath;
export type EventDefinitionVersionsListOutput = z.infer<
  typeof EventDefinitionVersionListResponseSchema
>;
export type EventDefinitionVersionsGetInput = EventDefinitionVersionPath;
export type EventDefinitionVersionsGetOutput = z.infer<typeof EventDefinitionVersionSchema>;
