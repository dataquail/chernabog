import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type Persona } from "../../../kernel/persona.value-object.ts";
import { type RunId } from "../../../kernel/run-id.id.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { type WorkItem } from "../domain/run/work-item.value-object.ts";
import { RunView } from "./run.result.ts";

// A run about to start: a persona's run of a repo's flow on one work item,
// under a fresh id.
export type StartRun = {
  readonly id: RunId;
  // The @chernabog/core version it starts under.
  readonly coreVersion: string;
  // The .chernabog/ tree its flow was loaded from; none from a working copy.
  readonly configTree?: Option.Option<string>;
  readonly repo: string;
  readonly persona: Persona;
  readonly flow: string;
  readonly itemKey: string;
  readonly itemTitle: Option.Option<string>;
  readonly itemUrl: Option.Option<string>;
  readonly item: Option.Option<WorkItem>;
};

// Records a run starting, before its workflow does. Fails when the persona
// already has a run in flight for the item, which is the one to follow.
export const startRunUseCase = Effect.fn("startRunUseCase")(function* (run: StartRun) {
  const runs = yield* RunsRepository;

  const started = yield* Effect.fromResult(
    RunRootOps.start(
      yield* runs.findAll({ running: true }),
      run,
      DateTime.formatIso(yield* DateTime.now),
    ),
  );

  yield* runs.save(started);

  return RunView.make({ ...started });
});
