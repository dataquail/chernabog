import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunMarkersRepositoryFake } from "../infrastructure/repositories/run-markers.repository-fake.ts";
import { forgetMarkerUseCase } from "./forget-marker.use-case.ts";
import { holdMarkerUseCase } from "./hold-marker.use-case.ts";
import { listRunMarkersUseCase } from "./list-run-markers.use-case.ts";

const runId = RunId.make("a");
const hold = (number: number) => ({ runId, name: "chernabog/label", args: { number }, keepOn: [] });

describe("forgetMarkerUseCase", () => {
  effect(
    "forgets only the hold of that name and those arguments, and one not held is no error",
    () =>
      Effect.gen(function* () {
        yield* holdMarkerUseCase(hold(1));
        yield* holdMarkerUseCase(hold(2));
        yield* forgetMarkerUseCase(hold(1));
        yield* forgetMarkerUseCase(hold(3));

        expect(
          (yield* listRunMarkersUseCase(runId, Option.none())).markers.map((marker) => marker.args),
        ).toEqual([{ number: 2 }]);
      }).pipe(Effect.provide(RunMarkersRepositoryFake([]))),
  );
});
