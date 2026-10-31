import { describe, expect } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { Spec } from "../../../../kernel/specification.ts";
import { RunMarkerRootOps } from "../../domain/run-marker/run-marker.root-ops.ts";
import { RunMarkerSpecifications } from "../../domain/run-marker/run-marker.specification.ts";
import { RunMarkersRepository } from "../../domain/run-marker/run-markers.repository.ts";
import { RunMarkersRepositoryLive } from "./run-markers.repository-live.ts";

const AT = "2026-10-28T12:00:00.000Z";

const marker = (runId: string, name: string, args: Schema.Json) =>
  RunMarkerRootOps.hold({ runId: RunId.make(runId), name, args, keepOn: [] }, AT);

describe("RunMarkersRepositoryLive", () => {
  effect(
    "upserts markers in the order held, replacing a run's marker of the same name and arguments in place",
    () =>
      Effect.gen(function* () {
        const markers = yield* RunMarkersRepository;
        const label = marker("a", "chernabog/label", { number: 12, label: "auto:in-progress" });
        yield* markers.upsertOne(label);
        yield* markers.upsertOne(marker("a", "chernabog/assignment", { number: 12, login: "bot" }));
        yield* markers.upsertOne(
          marker("b", "chernabog/label", { number: 13, label: "auto:in-progress" }),
        );
        yield* markers.upsertOne(RunMarkerRootOps.released(label, AT));

        const all = yield* markers.findMany(RunMarkerSpecifications.all);
        expect(all.map((found) => [found.runId, found.name, found.status])).toEqual([
          ["a", "chernabog/label", "released"],
          ["a", "chernabog/assignment", "held"],
          ["b", "chernabog/label", "held"],
        ]);
        expect(all[0]?.args).toEqual({ number: 12, label: "auto:in-progress" });

        expect(
          (yield* markers.findMany(
            Spec.and(
              RunMarkerSpecifications.forRun(RunId.make("a")),
              RunMarkerSpecifications.inStatus("held"),
            ),
          )).map((found) => found.name),
        ).toEqual(["chernabog/assignment"]);

        yield* markers.deleteOne(label);
        expect(
          (yield* markers.findMany(RunMarkerSpecifications.forRun(RunId.make("a")))).length,
        ).toBe(1);
      }).pipe(
        Effect.provide(RunMarkersRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void)))),
      ),
  );

  effect("keeps a failed release's attempts, error and when it's tried again", () =>
    Effect.gen(function* () {
      const markers = yield* RunMarkersRepository;
      const held = marker("a", "chernabog/label", { number: 12, label: "x" });
      const failed = RunMarkerRootOps.failed(held, "boom", DateTime.makeUnsafe(AT));
      yield* markers.upsertOne(failed);

      expect(yield* markers.findMany(RunMarkerSpecifications.all)).toEqual([failed]);
    }).pipe(Effect.provide(RunMarkersRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void))))),
  );
});
