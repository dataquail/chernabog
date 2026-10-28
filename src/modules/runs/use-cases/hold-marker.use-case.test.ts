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
const label = { runId, name: "chernabog/label", args: { number: 12, label: "x" }, keepOn: [] };

describe("holdMarkerUseCase", () => {
  effect("records a hold once, however often a resumed run holds it", () =>
    Effect.gen(function* () {
      const first = yield* holdMarkerUseCase(label);
      const again = yield* holdMarkerUseCase(label);
      expect(again).toEqual(first);
      expect(first.status).toBe("held");

      expect((yield* listRunMarkersUseCase(runId, Option.none())).markers).toHaveLength(1);
    }).pipe(Effect.provide(RunMarkersRepositoryFake([]))),
  );

  effect("holds one it forgot again", () =>
    Effect.gen(function* () {
      yield* holdMarkerUseCase(label);
      yield* forgetMarkerUseCase(label);
      expect((yield* listRunMarkersUseCase(runId, Option.none())).markers).toEqual([]);

      yield* holdMarkerUseCase(label);
      expect((yield* listRunMarkersUseCase(runId, Option.none())).markers).toHaveLength(1);
    }).pipe(Effect.provide(RunMarkersRepositoryFake([]))),
  );
});
