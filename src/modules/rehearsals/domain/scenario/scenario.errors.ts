import * as Schema from "effect/Schema";

import { Seeded } from "./seeded.value-object.ts";

// A scenario file that's missing, doesn't parse, or doesn't fit the flow it
// is rehearsed with. The message says which.
export class ScenarioInvalid extends Schema.TaggedError<
  ScenarioInvalid,
  { readonly brand: "ScenarioInvalid" }
>()("ScenarioInvalid", {
  message: Schema.String,
}) {}

// A scenario that would seed an enrolled repo without saying it means to:
// flows add labels, comment, request reviews and merge there.
export class RehearsesEnrolledRepo extends Schema.TaggedError<
  RehearsesEnrolledRepo,
  { readonly brand: "RehearsesEnrolledRepo" }
>()("RehearsesEnrolledRepo", {
  repo: Schema.String,
  message: Schema.String,
}) {}

// Seeding or cleanup failed on GitHub; the message says what and where.
export class ScratchRepoFailed extends Schema.TaggedError<
  ScratchRepoFailed,
  { readonly brand: "ScratchRepoFailed" }
>()("ScratchRepoFailed", {
  message: Schema.String,
}) {}

// Seeding stopped partway. `seeded` is what it made before, for cleanup to remove.
export class SeedingFailed extends Schema.TaggedError<
  SeedingFailed,
  { readonly brand: "SeedingFailed" }
>()("SeedingFailed", {
  message: Schema.String,
  seeded: Seeded,
}) {}
