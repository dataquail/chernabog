import * as Option from "effect/Option";

import { type Persona } from "./kernel/persona.value-object.ts";

export { IMPLICIT, type Persona, samePersona } from "./kernel/persona.value-object.ts";

// " as alice" for a persona, nothing for the implicit one, so output without
// personas reads as it always has.
export const asSuffix = (persona: Persona) =>
  Option.match(persona, { onNone: () => "", onSome: (login) => ` as ${login}` });
