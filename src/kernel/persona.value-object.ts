// Who a run acts as on GitHub. A login is one of the personas machine config
// lists under github:, whose token comes from `gh auth token --user <login>`.
// None is the implicit persona of a machine config without github:: whoever
// the daemon is (GH_TOKEN, then GITHUB_TOKEN, then gh's active account), as
// before personas existed.

import * as Option from "effect/Option";

export type Persona = Option.Option<string>;

export const IMPLICIT: Persona = Option.none();

export const samePersona = (left: Persona, right: Persona) =>
  Option.getOrNull(left) === Option.getOrNull(right);
