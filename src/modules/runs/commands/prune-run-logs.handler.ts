import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { RunLogsClient } from "../domain/ports/clients/run-logs.client.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { RunLogRetention } from "../domain/run/run-log-retention.value-object.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { PrunedRunLogs } from "./prune-run-logs.command.ts";

// The unit of work around this command's read of state.db alone; the logs it
// removes are files, outside it (docs/adr/0010-commands-declare-their-unit-of-work.md).
const inUnitOfWork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    withUnitOfWork,
    // state.db is a file on this machine: it has no outage to wait out.
    Effect.catchTag("PersistenceUnavailable", Effect.die),
  );

export const pruneRunLogsHandler = Effect.fn("pruneRunLogsHandler")(function* () {
  const logs = yield* RunLogsClient;
  const now = yield* Clock.currentTimeMillis;

  const runs = new Map(
    (yield* RunsRepository.use((stored) => stored.findMany(RunSpecifications.all)).pipe(
      inUnitOfWork,
    )).map((run) => [run.id, run]),
  );

  const removed: Array<RunId> = [];

  for (const runId of yield* logs.ids) {
    // A run already pruned has no log left to judge.
    const modifiedAt = yield* logs.modifiedAt(runId);

    if (
      Option.isSome(modifiedAt) &&
      RunLogRetention.expired(Option.fromUndefinedOr(runs.get(runId)), modifiedAt.value, now)
    ) {
      yield* logs.prune(runId);
      removed.push(runId);
    }
  }

  return PrunedRunLogs.make({ removed });
});
