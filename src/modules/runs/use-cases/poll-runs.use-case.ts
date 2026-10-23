import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { pollRunUseCase } from "./poll-run.use-case.ts";
import { RunList } from "./run.result.ts";

// Polls every run in flight, and lists the ones that ended now.
export const pollRunsUseCase = Effect.fn("pollRunsUseCase")(function* () {
  const running = yield* (yield* RunsRepository).findAll({ running: true });
  const polled = yield* Effect.forEach(running, (run) => pollRunUseCase(run.id));

  return RunList.make({
    runs: polled.flatMap((found) =>
      Option.toArray(Option.filter(found.run, (run) => run.status !== "running")),
    ),
  });
});
