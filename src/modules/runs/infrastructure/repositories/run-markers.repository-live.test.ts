import { describe, expect } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunMarkersRepository } from "../../domain/ports/repositories/run-markers.repository.ts";
import { RunMarkerRootOps } from "../../domain/run-marker/run-marker.root-ops.ts";
import { RunMarkersRepositoryLive } from "./run-markers.repository-live.ts";

const AT = "2026-10-28T12:00:00.000Z";

const marker = (runId: string, name: string, args: Schema.Json) =>
  RunMarkerRootOps.hold({ runId: RunId.make(runId), name, args, keepOn: [] }, AT);

const every = { runId: Option.none(), status: Option.none() };

describe("RunMarkersRepositoryLive", () => {
  effect(
    "saves markers in the order held, replacing a run's marker of the same name and arguments in place",
    () =>
      Effect.gen(function* () {
        const markers = yield* RunMarkersRepository;
        const label = marker("a", "chernabog/label", { number: 12, label: "auto:in-progress" });
        yield* markers.save(label);
        yield* markers.save(marker("a", "chernabog/assignment", { number: 12, login: "bot" }));
        yield* markers.save(
          marker("b", "chernabog/label", { number: 13, label: "auto:in-progress" }),
        );
        yield* markers.save(RunMarkerRootOps.released(label, AT));

        const all = yield* markers.findAll(every);
        expect(all.map((found) => [found.runId, found.name, found.status])).toEqual([
          ["a", "chernabog/label", "released"],
          ["a", "chernabog/assignment", "held"],
          ["b", "chernabog/label", "held"],
        ]);
        expect(all[0]?.args).toEqual({ number: 12, label: "auto:in-progress" });

        expect(
          (yield* markers.findAll({
            runId: Option.some(RunId.make("a")),
            status: Option.some("held"),
          })).map((found) => found.name),
        ).toEqual(["chernabog/assignment"]);

        yield* markers.remove(label);
        expect(
          (yield* markers.findAll({ ...every, runId: Option.some(RunId.make("a")) })).length,
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
      yield* markers.save(failed);

      expect(yield* markers.findAll(every)).toEqual([failed]);
    }).pipe(Effect.provide(RunMarkersRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void))))),
  );
});
