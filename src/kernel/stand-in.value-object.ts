// A stand-in answers for the agent at one step of a rehearsal (#115), so a
// flow's wiring runs end to end with no agent session. It is keyed by step
// name, the journal key every activity already has: `implement`, or a
// pattern such as `fix-ci-*` for a step that carries its round.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// A shell command, run in the step's worktree, which may commit. Its answer
// is the last JSON object it prints.
export const ScriptStandIn = Schema.Struct({ script: Schema.String });

// A fixed answer. `commits` are made first, one per message, each touching a
// file under .rehearsal/, for a step whose work must commit something.
export const FixtureStandIn = Schema.Struct({
  fixture: Schema.Json,
  commits: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const StandIn = Schema.Union([ScriptStandIn, FixtureStandIn]);

export type StandIn = typeof StandIn.Type;

export const StandIns = Schema.Record(Schema.String, StandIn);

export type StandIns = typeof StandIns.Type;

export const isScript = (standIn: StandIn): standIn is typeof ScriptStandIn.Type =>
  "script" in standIn;

const escaped = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

// Whether a key matches a step: the same name, or a pattern where `*` is any run of characters.
export const matchesStep = (key: string, step: string) =>
  new RegExp(`^${key.split("*").map(escaped).join(".*")}$`).test(step);

// The stand-in for a step: the one named for it, else the first pattern that matches it.
export const standInFor = (standIns: StandIns, step: string): Option.Option<StandIn> =>
  Option.orElse(Option.fromUndefinedOr(standIns[step]), () =>
    Option.map(
      Arr.findFirst(
        Object.entries(standIns),
        ([key]) => key.includes("*") && matchesStep(key, step),
      ),
      ([, standIn]) => standIn,
    ),
  );

// The steps a set of stand-ins names that no step in `steps` matches.
export const unmatchedKeys = (standIns: StandIns, steps: ReadonlyArray<string>) =>
  Object.keys(standIns).filter((key) => !steps.some((step) => matchesStep(key, step)));
