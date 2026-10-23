// A run's identity: a random UUID, so a few characters of it name the run.
// It says nothing about the run; the run's record says what it runs, and as
// whom.

import * as Schema from "effect/Schema";

import { asSuffix, type Persona } from "./persona.value-object.ts";

export const RunId = Schema.String.pipe(Schema.brand("RunId"));

export type RunId = typeof RunId.Type;

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

// Enough of a run's id to name it, as `logs` and `attach` take it. A run from
// before ids were random keeps its whole, readable id.
export const shortRunId = (id: string) => {
  if (UUID.test(id)) {
    return id.slice(0, 8);
  }

  return id;
};

// What a run is, for people, since its id doesn't say: demo/review pr-12 as bob.
export const runLabel = (run: {
  readonly repo: string;
  readonly flow: string;
  readonly itemKey: string;
  readonly persona: Persona;
}) => `${run.repo}/${run.flow} ${run.itemKey}${asSuffix(run.persona)}`;
