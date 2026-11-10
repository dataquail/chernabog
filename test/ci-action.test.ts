// What the published action (action/action.yml, #461) runs for each step: a
// plan job runs each CI flow's usage gate, which asks `claude auth status`
// about the subscription token, so claude is installed before `ci plan` as
// well as before `ci run`.

import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as YAML from "yaml";

import { effect } from "./effect-test.ts";

const Step = Schema.Struct({ name: Schema.String, if: Schema.optionalKey(Schema.String) });

type Step = typeof Step.Type;

const Action = Schema.Struct({ runs: Schema.Struct({ steps: Schema.Array(Step) }) });

const steps = Effect.gen(function* () {
  const text = yield* (yield* FileSystem.FileSystem).readFileString("action/action.yml");

  return (yield* Schema.decodeUnknownEffect(Action)(YAML.parse(text))).runs.steps;
});

const TERM = /^inputs\.step (==|!=) '([a-z]+)'$/;

// Whether one `inputs.step == '<name>'` or `!=` term holds for `step`. A term
// this test can't read holds for no step, so a step it guards is never found.
const holds = (text: string, step: string) =>
  Option.match(Option.fromNullishOr(TERM.exec(text.trim())), {
    onNone: () => false,
    onSome: ([, operator, name]) => (operator === "==") === (step === name),
  });

// Whether a step runs for `step`, by its `if:`, which the action writes only as
// terms joined by `||`, or by `&&`.
const runsFor = (found: Step, step: string) =>
  Option.match(Option.fromUndefinedOr(found.if), {
    onNone: () => true,
    onSome: (condition) => {
      if (condition.includes("&&")) {
        return condition.split("&&").every((term) => holds(term, step));
      }

      return condition.split("||").some((term) => holds(term, step));
    },
  });

const stepsFor = (step: string) =>
  steps.pipe(
    Effect.map((all) => all.filter((found) => runsFor(found, step)).map((found) => found.name)),
  );

describe("the action", () => {
  for (const [step, command] of [
    ["plan", "chernabog ci plan"],
    ["run", "chernabog ci run"],
  ] as const) {
    effect(`installs claude before ${command}, which the usage gate needs`, () =>
      Effect.gen(function* () {
        const names = yield* stepsFor(step);

        expect(names).toContain("Install claude");
        expect(names).toContain(command);
        expect(names.indexOf("Install claude")).toBeLessThan(names.indexOf(command));
      }),
    );
  }

  effect("runs nothing but its refusal for any other step", () =>
    Effect.gen(function* () {
      const names = yield* stepsFor("deploy");

      expect(names.filter((name) => !name.startsWith("Install chernabog"))).toEqual([
        "Refuse any other step",
      ]);
    }),
  );
});
