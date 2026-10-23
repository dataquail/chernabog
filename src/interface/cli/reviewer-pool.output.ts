// What doctor and enroll say of a persona whose pull requests go to reviewers
// this machine doesn't act as.

import * as Option from "effect/Option";

import { type Persona } from "../../kernel/persona.value-object.ts";

export const describeUnserved = (author: Persona, reviewers: ReadonlyArray<string>) =>
  `pull requests authored as ${Option.getOrElse(author, () => "the implicit account")} go to ${reviewers.join(", ")}, which this machine doesn't act as; they wait until another machine reviews them`;
