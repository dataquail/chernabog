// Phases.record carries data for the run that picks the item up next
// (ADR 0021, decision 4): the record keeps it beside the phase, and an item
// already at the phase keeps the data it has.

import { activity } from "@chernabog/core";
import { defineFlow, Phases } from "@chernabog/sdk";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { effect } from "./effect-test.ts";
import { ISSUE, item, makeFake, repo, runToEnd } from "./sdk-fakes.ts";

const ITEM = Phases.issueItem(ISSUE);

// A flow that records `phase` on the issue, with `data` when it has some.
const recording = (phase: string, data?: { readonly [key: string]: number }) =>
  flowHandle(
    repo,
    "record",
    defineFlow({
      trigger: Effect.succeed([]),
      workflow: () =>
        activity("record", Phases.record(ITEM, phase, data)).pipe(Effect.as("recorded")),
    }),
  );

const dataOf = (fake: ReturnType<typeof makeFake>) =>
  Option.flatMap(Option.fromUndefinedOr(fake.records().get(ITEM)), (found) => found.data);

effect("records the data a run passes beside the phase", () =>
  Effect.gen(function* () {
    const fake = makeFake("approve");

    expect((yield* runToEnd(recording("proposed", { round: 2 }), fake, item("issue"))).status).toBe(
      "done",
    );
    expect(fake.phases()[ITEM]).toBe("proposed");
    expect(Option.map(dataOf(fake), (data) => data.round)).toEqual(Option.some(2));
  }),
);

effect("records none when the run passes none", () =>
  Effect.gen(function* () {
    const fake = makeFake("approve");

    yield* runToEnd(recording("proposed"), fake, item("issue"));
    expect(dataOf(fake)).toEqual(Option.none());
  }),
);

effect("leaves an item already at the phase with the data it has", () =>
  Effect.gen(function* () {
    const fake = makeFake("approve");

    yield* runToEnd(recording("proposed", { round: 1 }), fake, item("issue"));
    yield* runToEnd(recording("proposed", { round: 2 }), fake, item("issue"));
    expect(Option.map(dataOf(fake), (data) => data.round)).toEqual(Option.some(1));
  }),
);
