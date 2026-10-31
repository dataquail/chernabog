import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunMarkersRepositoryFake } from "../infrastructure/repositories/run-markers.repository-fake.ts";
import { listRunMarkersHandler } from "../queries/list-run-markers.handler.ts";
import { forgetMarkerHandler } from "./forget-marker.handler.ts";
import { holdMarkerHandler } from "./hold-marker.handler.ts";

const runId = RunId.make("a");
const hold = (number: number) => ({ runId, name: "chernabog/label", args: { number }, keepOn: [] });

describe("forgetMarkerHandler", () => {
  effect(
    "forgets only the hold of that name and those arguments, and one not held is no error",
    () =>
      Effect.gen(function* () {
        yield* holdMarkerHandler(hold(1));
        yield* holdMarkerHandler(hold(2));
        yield* forgetMarkerHandler(hold(1));
        yield* forgetMarkerHandler(hold(3));

        expect(
          (yield* listRunMarkersHandler({ runId, name: Option.none() })).markers.map(
            (marker) => marker.args,
          ),
        ).toEqual([{ number: 2 }]);
      }).pipe(Effect.provide(RunMarkersRepositoryFake([]))),
  );
});
