import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { Seeded } from "../domain/scenario/seeded.value-object.ts";

// The work items, by key, a rehearsal may run on.
export class SeededWork extends Schema.Class<SeededWork, { readonly brand: "SeededWork" }>(
  "SeededWork",
)({
  keys: Schema.Array(Schema.String),
}) {}

// The work items, of `keys`, that are about what seeding made: all a
// rehearsal may run on, even on a repo with real work queued.
export const ChooseSeededWorkQuery = Query.make("ChooseSeededWorkQuery", {
  payload: { seeded: Seeded, keys: Schema.Array(Schema.String) },
  success: SeededWork,
});

export type ChooseSeededWorkPayload = Query.Payload<typeof ChooseSeededWorkQuery>;
