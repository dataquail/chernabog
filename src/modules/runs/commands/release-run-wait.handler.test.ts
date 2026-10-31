import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { RunWaitsRepositoryFake } from "../infrastructure/repositories/run-waits.repository-fake.ts";
import { listRunWaitsHandler } from "../queries/list-run-waits.handler.ts";
import { releaseRunWaitHandler } from "./release-run-wait.handler.ts";

const runId = RunId.make("a");

describe("releaseRunWaitHandler", () => {
  effect("forgets the wait its signal woke, and keeps the run's others", () =>
    Effect.gen(function* () {
      const [first] = (yield* listRunWaitsHandler({ runId, signal: "pushed" })).waits;
      yield* releaseRunWaitHandler({ wait: first });

      expect(
        (yield* listRunWaitsHandler({ runId, signal: "pushed" })).waits.map(
          (wait) => wait.deferred,
        ),
      ).toEqual(["d2"]);
    }).pipe(
      Effect.provide([
        RunWaitsRepositoryFake([
          RunWaitRoot.make({
            runId,
            signal: "pushed",
            deferred: "d1",
            token: "t1",
            parkedAt: Option.none(),
          }),
          RunWaitRoot.make({
            runId,
            signal: "pushed",
            deferred: "d2",
            token: "t2",
            parkedAt: Option.none(),
          }),
        ]),
        PassThroughUnitOfWork,
      ]),
    ),
  );
});
