import { defineFlow, Settings } from "@chernabog/core";
import { expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { effect } from "../../../../../test/effect-test.ts";
import { fixture } from "../../../../../test/fixtures.ts";
import { asPersona, repoAs, settings } from "../../../../../test/sdk-fakes.ts";
import { declaredLabels, desiredLabels, Label, planLabelSync } from "./labels.ts";

const DESIRED = desiredLabels([
  { name: "auto:eligible", color: "0e8a16", description: "Queued for an unattended run" },
  { name: "auto:in-progress", color: "fbca04", description: "An unattended run owns this issue" },
  { name: "auto:needs-human", color: "b60205", description: "A person takes over" },
]);

// The first desired label exists as it should; the second exists with the wrong color.
const asWanted = DESIRED.slice(0, 1).map((label) => ({
  ...label,
  description: Option.some(label.description),
}));

const drifted = DESIRED.slice(1, 2).map((label) => ({
  ...label,
  description: Option.some(label.description),
  color: "FFFFFF",
}));

test("missing labels are created, drifted ones corrected, others left alone", () => {
  const existing = [
    { name: "bug", color: "d73a4a", description: Option.some("Something isn't working") },
    ...asWanted,
    ...drifted,
  ];

  const changes = planLabelSync(existing, DESIRED);

  const actionFor = (name: string) =>
    Option.map(
      Arr.findFirst(changes, (change) => change.label.name === name),
      (change) => change.action,
    );

  expect(drifted.map((label) => actionFor(label.name))).toEqual([Option.some("update")]);
  expect(asWanted.map((label) => actionFor(label.name))).toEqual([Option.none()]);
  expect(changes.filter((change) => change.action === "create")).toHaveLength(DESIRED.length - 2);
});

effect("a repo with none of them yet gets all of them", () =>
  Effect.gen(function* () {
    const recorded = yield* fixture("goodbones-labels.json", Schema.Array(Label));
    const changes = planLabelSync(recorded, DESIRED);
    expect(changes.map((change) => change.label.name)).toEqual(DESIRED.map((label) => label.name));
    expect(changes.every((change) => change.action === "create")).toBe(true);
  }),
);

test("a label two flows declare is synced once, with the first one's look", () => {
  const all = desiredLabels([
    { name: "auto:deploy", description: "Deploy once merged" },
    { name: "auto:approved", color: "0e8a16", description: "Approved" },
    { name: "AUTO:APPROVED", color: "000000" },
  ]);

  expect(all).toEqual([
    { name: "auto:deploy", color: "c5def5", description: "Deploy once merged" },
    { name: "auto:approved", color: "0e8a16", description: "Approved" },
  ]);
});

const noop = { trigger: Effect.succeed([]), workflow: () => Effect.void };

effect("only the labels the loaded flows declare are synced, none of core's own", () =>
  Effect.gen(function* () {
    const ship = defineFlow({ ...noop, labels: [{ name: "auto:deploy" }] });
    const quiet = defineFlow(noop);

    const labels = yield* declaredLabels(
      repoAs(settings),
      new Map([
        ["ship", ship],
        ["quiet", quiet],
      ]),
    );

    expect(labels.map((label) => label.name)).toEqual(["auto:deploy"]);
  }),
);

effect("a flow works its labels out from its settings, as each persona runs it", () =>
  Effect.gen(function* () {
    const Own = Schema.Struct({ queue: Schema.optionalKey(Schema.String) });

    const queue = defineFlow({
      ...noop,
      settings: Own,
      labels: Effect.map(Settings.read(Own), (own) => [{ name: own.queue ?? "queued" }]),
    });

    const repo = {
      ...repoAs(settings),
      personas: [
        {
          ...asPersona(settings, Option.some("alice")),
          shared: { queue: "team:queued" },
        },
        {
          ...asPersona(settings, Option.some("bob")),
          shared: { queue: "team:queued" },
          flows: { queue: { settings: { queue: "bob:queued" } } },
        },
      ],
    } as const;

    const labels = yield* declaredLabels(repo, new Map([["queue", queue]]));

    expect(labels.map((label) => label.name)).toEqual(["team:queued", "bob:queued"]);
  }),
);
