import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { PersonaEntry } from "./persona-choices.aggregate.ts";

// A repo enrolled on this machine: its entry in machine config. A dumb value;
// its operations, and the rules they keep, are EnrolledRepoRootOps.
//
// Machine config writes the repo entry's own choices beside its slug and path;
// here they are `defaults`, the choices every persona inherits, so a rule
// about a persona's choices reads the same for the repo entry's.
export class EnrolledRepoRoot extends Schema.Class<
  EnrolledRepoRoot,
  { readonly brand: "EnrolledRepoRoot" }
>("EnrolledRepoRoot")({
  // owner/name on GitHub: the key the entry's settings follow.
  repo: RepoSlug,
  // Where its checkout is now.
  path: Schema.String,
  // A short name, which keeps two clones of one repo apart.
  name: Schema.optionalKey(Schema.String),
  defaults: PersonaEntry,
  // The GitHub personas, by login from machine config's github:, that run
  // this repo's flows, each with its own choices. Defaults to the only one;
  // required when there are several.
  personas: Schema.optionalKey(Schema.Record(Schema.String, PersonaEntry)),
  // A paused repo starts no new runs; the runs in flight continue. Kept apart
  // from machine config, which a person edits, since it's runtime state.
  paused: Schema.Boolean,
}) {}
