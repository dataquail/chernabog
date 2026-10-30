import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunMarkerRootOps } from "../domain/run-marker/run-marker.root-ops.ts";
import { RunMarkersRepositoryFake } from "../infrastructure/repositories/run-markers.repository-fake.ts";
import { listRunMarkersHandler } from "./list-run-markers.handler.ts";

const AT = "2026-10-20T00:00:00.000Z";

const marker = (runId: string, name: string, number: number) =>
  RunMarkerRootOps.hold({ runId: RunId.make(runId), name, args: { number }, keepOn: [] }, AT);

describe("listRunMarkersHandler", () => {
  effect("lists what one run still holds, in the order held, of a name if given", () =>
    Effect.gen(function* () {
      const a = RunId.make("a");

      expect(
        (yield* listRunMarkersHandler({ runId: a, name: Option.none() })).markers.map(
          (found) => found.args,
        ),
      ).toEqual([{ number: 1 }, { number: 3 }]);
      expect(
        (yield* listRunMarkersHandler({
          runId: a,
          name: Option.some("chernabog/label"),
        })).markers.map((found) => found.args),
      ).toEqual([{ number: 1 }]);
    }).pipe(
      Effect.provide(
        RunMarkersRepositoryFake([
          marker("a", "chernabog/label", 1),
          RunMarkerRootOps.released(marker("a", "chernabog/label", 2), AT),
          marker("a", "chernabog/assignment", 3),
          marker("b", "chernabog/label", 4),
        ]),
      ),
    ),
  );
});
