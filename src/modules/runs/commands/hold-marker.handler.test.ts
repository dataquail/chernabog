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
const label = { runId, name: "chernabog/label", args: { number: 12, label: "x" }, keepOn: [] };

describe("holdMarkerHandler", () => {
  effect("records a hold once, however often a resumed run holds it", () =>
    Effect.gen(function* () {
      const first = yield* holdMarkerHandler(label);
      const again = yield* holdMarkerHandler(label);
      expect(again).toEqual(first);
      expect(first.status).toBe("held");

      expect((yield* listRunMarkersHandler({ runId, name: Option.none() })).markers).toHaveLength(
        1,
      );
    }).pipe(Effect.provide(RunMarkersRepositoryFake([]))),
  );

  effect("holds one it forgot again", () =>
    Effect.gen(function* () {
      yield* holdMarkerHandler(label);
      yield* forgetMarkerHandler(label);
      expect((yield* listRunMarkersHandler({ runId, name: Option.none() })).markers).toEqual([]);

      yield* holdMarkerHandler(label);
      expect((yield* listRunMarkersHandler({ runId, name: Option.none() })).markers).toHaveLength(
        1,
      );
    }).pipe(Effect.provide(RunMarkersRepositoryFake([]))),
  );
});
