// A test-only wake of runs parked in a test's own engine: what the daemon did
// before a park ended its run (ADR 21 decision 4, ADR 23 decision 2). No
// chernabog process wakes a parked run any more: the run ends at its park,
// and a later run takes the item up from its record. The SDK's block tests
// still drive a park and its signal within one run, so this does it for
// them, in their engine alone. Nothing under src/, packages/ or scripts/ may
// import it (`architecture.yaml`'s `only-tests-wake-runs`).
//
// The tests that use it are to move to "the park ends the run, a new run
// takes it up from its record", after which this goes.

import { signalDeferred } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DurableDeferred from "effect/workflow/DurableDeferred";

import { noteInRun } from "../src/interface/daemon/report-fold.server.ts";
import { type Persona } from "../src/kernel/persona.value-object.ts";
import { type RunId } from "../src/kernel/run-id.id.ts";
import {
  decodeSpokeReport,
  RunsCommands,
  SpokeReportCommand,
} from "../src/modules/runs/runs.command-handlers.ts";
import { RunFlowsQueries, RunsQueries, type WorkItem } from "../src/modules/runs/runs.platform.ts";

const decodeToken = Schema.decodeEffect(DurableDeferred.Token);

// The race a wait is part of: its deferred's name without the signal, as
// awaitSignal names one deferred per signal it waits on.
const raceOf = (wait: { readonly signal: string; readonly deferred: string }) =>
  Option.getOrElse(
    Option.map(
      Option.liftPredicate(`${wait.signal}:`, (prefix) => wait.deferred.startsWith(prefix)),
      (prefix) => wait.deferred.slice(prefix.length),
    ),
    () => wait.deferred,
  );

// Every wait the run parked, as its journal recorded them.
const parkedIn = (runId: RunId) =>
  RunFlowsQueries.use((runs) => runs.ReadSpokeReportsQuery({ runId, after: 0 })).pipe(
    Effect.map((found) =>
      found.reports.flatMap((report) =>
        Option.toArray(decodeSpokeReport(SpokeReportCommand.ParkRunCommand, report)),
      ),
    ),
  );

// Forgets the run's waits for `signal` on `deferred`, still in state.db.
const forget = (runId: RunId, signal: string, deferred: string) =>
  Effect.gen(function* () {
    const { waits } = yield* (yield* RunsQueries).ListRunWaitsQuery({ runId, signal });

    for (const wait of waits.filter((one) => one.deferred === deferred)) {
      yield* (yield* RunsCommands).ReleaseRunWaitCommand({ wait });
    }
  });

// Wakes each run of the flow, as `persona` runs it, parked on a signal one of
// `items` carries for its own item, and forgets the waits that lost the race
// to it. How many it woke. Its waits are read from state.db, so the run's
// journal must be folded first (sdk-fakes' `deliverSignals` folds it).
export const wakeParkedRuns = (
  flow: { readonly repo: string; readonly flow: string; readonly persona: Persona },
  items: ReadonlyArray<WorkItem>,
) =>
  Effect.gen(function* () {
    const { runs } = yield* (yield* RunsQueries).ListActiveRunsQuery({
      repo: Option.some(flow.repo),
      persona: Option.some(flow.persona),
      flow: Option.some(flow.flow),
    });

    let count = 0;

    for (const item of items) {
      for (const run of runs.filter((one) => one.itemKey === item.key)) {
        const done = new Set<string>();

        for (const signal of item.signals ?? []) {
          const { waits } = yield* (yield* RunsQueries).ListRunWaitsQuery({
            runId: run.id,
            signal,
          });

          for (const wait of waits.filter((one) => !done.has(raceOf(one)))) {
            yield* DurableDeferred.succeed(signalDeferred(wait.deferred), {
              token: yield* decodeToken(wait.token),
              value: true,
            });

            yield* (yield* RunsCommands).ReleaseRunWaitCommand({ wait });

            const losers = (yield* parkedIn(run.id)).filter(
              (other) => other.deferred !== wait.deferred && raceOf(other) === raceOf(wait),
            );

            for (const loser of losers) {
              yield* forget(run.id, loser.signal, loser.deferred);
            }

            yield* noteInRun(run.id, `signal: ${signal}`);
            done.add(raceOf(wait));
            count += 1;
          }
        }
      }
    }

    return count;
  }).pipe(Effect.orDie);
