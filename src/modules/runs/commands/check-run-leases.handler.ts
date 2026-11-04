import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { Spec } from "../../../kernel/specification.ts";
import { FlowsClient } from "../domain/ports/clients/flows.client.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { RunMarkerSpecifications } from "../domain/run-marker/run-marker.specification.ts";
import { RunMarkersRepository } from "../domain/run-marker/run-markers.repository.ts";
import { type LeaseView, RunLeases } from "../domain/schedule/lease.value-object.ts";
import { type CheckRunLeasesPayload } from "./check-run-leases.command.ts";

// The unit of work around this command's reads and writes in state.db alone.
// What it asks of GitHub, git, a launcher or the engine stays outside it: a
// transaction holds state.db's one connection, which the engine's journal
// waits on (docs/adr/0010-commands-declare-their-unit-of-work.md).
const inUnitOfWork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    withUnitOfWork,
    // state.db is a file on this machine: it has no outage to wait out.
    Effect.catchTag("PersistenceUnavailable", Effect.die),
  );

const unchecked = RunLeases.cases.Unchecked.make({});

export const checkRunLeasesHandler = Effect.fn("checkRunLeasesHandler")(function* ({
  renew,
  runId,
}: CheckRunLeasesPayload) {
  const flows = yield* FlowsClient;

  const run = Option.filter(
    yield* RunsRepository.use((runs) => runs.findOne(RunSpecifications.withId(runId))).pipe(
      inUnitOfWork,
    ),
    RunRootOps.isRunning,
  );

  const executing = Option.flatMap(run, (found) => found.executionId);

  if (Option.isNone(run) || Option.isNone(executing)) {
    return unchecked;
  }

  const found = run.value;

  const held = yield* RunMarkersRepository.use((markers) =>
    markers.findMany(
      Spec.and(RunMarkerSpecifications.forRun(found.id), RunMarkerSpecifications.inStatus("held")),
    ),
  ).pipe(inUnitOfWork);

  const flow = { repo: found.repo, flow: found.flow, persona: found.persona };

  const question = {
    runId: found.id,
    executionId: executing.value,
    item: Option.getOrElse(found.item, () => ({ key: found.itemKey, data: {} })),
    subjects: found.subjects,
  };

  const leases: Array<LeaseView> = [];
  const failures: Array<string> = [];
  let leased = false;

  // A failure loses nothing, so it doesn't keep the rest from being renewed.
  for (const marker of held) {
    const lease = yield* Effect.result(
      flows.markerLease(flow, question, marker.name, marker.args, renew),
    );

    if (Result.isFailure(lease)) {
      failures.push(lease.failure.message);
      continue;
    }

    for (const { on, state } of Option.toArray(lease.success)) {
      leased = true;

      if (state.status === "lost") {
        return RunLeases.cases.Lost.make({ item: on, reason: state.reason });
      }

      if (state.status === "held") {
        leases.push({ item: on, expiresAt: state.expiresAt, renewedAt: state.renewedAt });
      }
    }
  }

  if (failures.length > 0) {
    return RunLeases.cases.CheckFailed.make({ message: failures.join("; ") });
  }

  if (!leased) {
    return unchecked;
  }

  return RunLeases.cases.Held.make({ leases });
});
