import type { ControlPanelOperation } from "./control-panel-operation";

/**
 * Shapes for the coverage table. They live apart from the table itself only
 * because the table is one long literal; every explanation of what the table
 * proves stays with the table.
 */

export interface Route {
  method: string;
  pathname: string;
  environmentId?: string;
  search?: string;
}

/**
 * `Extract<ControlPanelOperation, { id: Id }>` is wrong here: several members
 * declare `id` as a union of literals, and such a member is not assignable to
 * `{ id: OneOfThem }`, so Extract silently yields `never` and every row for
 * those ids becomes unwritable. Narrowing the discriminant on a distributive
 * type parameter keeps all of them reachable.
 */
type NarrowById<Members, Id> = Members extends { id: infer Ids }
  ? Id extends Ids
    ? Omit<Members, "id"> & { id: Id }
    : never
  : never;

export type OperationCoverage = {
  [Id in ControlPanelOperation["id"]]: {
    route: Route;
    operation: NarrowById<ControlPanelOperation, Id>;
  };
};
