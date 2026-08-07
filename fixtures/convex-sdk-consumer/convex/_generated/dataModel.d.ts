/* eslint-disable */
/**
 * Generated data model types from `schema.ts`.
 */
import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  SystemTableNames,
  TableNamesInDataModel,
} from "convex/server";
import type { GenericId } from "convex/values";
import schema from "../schema.js";

export type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>;
export type Id<TableName extends TableNames | SystemTableNames> = GenericId<TableName>;
export type TableNames = TableNamesInDataModel<DataModel>;
export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
