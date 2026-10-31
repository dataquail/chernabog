import * as Effect from "effect/Effect";

import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { RunWaitsRepository } from "../domain/run-wait/run-waits.repository.ts";
import { type ReleaseRunWaitPayload } from "./release-run-wait.command.ts";

export const releaseRunWaitHandler = Effect.fn("releaseRunWaitHandler")(function* ({
  wait,
}: ReleaseRunWaitPayload) {
  yield* (yield* RunWaitsRepository).deleteOne(RunWaitRoot.make({ ...wait }));

  return wait;
});
