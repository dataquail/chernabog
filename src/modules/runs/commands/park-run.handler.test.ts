import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { DispatchedEvents, RecordedEvents } from "../../../../test/events.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunNeedsAttention } from "../domain/run/run.events.ts";
import { RunWaitsRepositoryFake } from "../infrastructure/repositories/run-waits.repository-fake.ts";
import { listRunWaitsHandler } from "../queries/list-run-waits.handler.ts";
import { parkRunHandler } from "./park-run.handler.ts";

describe("parkRunHandler", () => {
  effect("parks the run on its signal, until it's released, and keeps when it parked", () =>
    Effect.gen(function* () {
      const runId = RunId.make("a");
      const parked = yield* parkRunHandler({ runId, signal: "pushed", deferred: "d", token: "t" });

      expect(Option.isSome(parked.parkedAt)).toBe(true);

      expect(
        (yield* listRunWaitsHandler({ runId, signal: "pushed" })).waits.map((wait) => wait.token),
      ).toEqual(["t"]);
      expect(yield* DispatchedEvents).toEqual([
        RunNeedsAttention.make({
          eventId: "a:park:d",
          runId,
          signal: "pushed",
          deferred: "d",
          parkedAt: Option.getOrThrow(parked.parkedAt),
        }),
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(RecordedEvents, RunWaitsRepositoryFake([])))),
  );

  effect("a run that parks again on the same deferred, as a resumed one does, tells no one", () =>
    Effect.gen(function* () {
      const runId = RunId.make("a");
      yield* parkRunHandler({ runId, signal: "pushed", deferred: "d", token: "t" });
      yield* parkRunHandler({ runId, signal: "pushed", deferred: "d", token: "t2" });
      yield* parkRunHandler({ runId, signal: "pushed", deferred: "e", token: "t3" });

      expect((yield* DispatchedEvents).map((event) => event.eventId)).toEqual([
        "a:park:d",
        "a:park:e",
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(RecordedEvents, RunWaitsRepositoryFake([])))),
  );
});
