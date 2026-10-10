import { type Flag, FlagSchema } from "../leaf-schemas-flag";

const defaults = {
  id: "flag_1",
  appId: "app_1",
  key: "checkout",
  name: "Checkout",
  variants: [{ id: "var_1", name: "control", value: false }],
  defaultVariantId: "var_1",
  lifecycleClass: "unclassified",
  owner: null,
  expiresAt: null,
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
} satisfies Flag;

export function flagResourceFixture(overrides: Partial<Flag> = {}): Flag {
  return FlagSchema.parse({ ...defaults, ...overrides });
}
