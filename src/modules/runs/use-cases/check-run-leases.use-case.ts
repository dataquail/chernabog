import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { FlowsClient } from "../domain/ports/clients/flows.client.ts";
import { RunMarkersRepository } from "../domain/ports/repositories/run-markers.repository.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { CLAIM_REF_MARKER, ClaimRefArgs } from "../domain/schedule/lease.value-object.ts";
import { type LeaseView, RunLeases } from "./check-run-leases.result.ts";

const unchecked = RunLeases.cases.Unchecked.make({});

// Reads, or with `renew` renews for that long from now, the lease on each
// claim a run in flight holds (the claim-ref markers it holds), as the run's
// persona. A claim another run took over is Lost, and the run must end; one
// nobody holds any more, such as one the run is about to take, is passed
// over. A read or renewal that fails is CheckFailed, never Lost. Ending a lost
// run is the caller's, through cancelRunUseCase.
export const checkRunLeasesUseCase = Effect.fn("checkRunLeasesUseCase")(function* (
  runId: RunId,
  renew: Option.Option<Duration.Duration>,
) {
  const flows = yield* FlowsClient;

  const run = Option.filter(yield* (yield* RunsRepository).findOne(runId), RunRootOps.isRunning);
  const executing = Option.flatMap(run, (found) => found.executionId);

  if (Option.isNone(run) || Option.isNone(executing)) {
    return unchecked;
  }

  const found = run.value;

  const held = yield* (yield* RunMarkersRepository).findAll({
    runId: Option.some(found.id),
    status: Option.some("held"),
  });

  const items = held.flatMap((marker) =>
    Option.toArray(
      Option.filter(
        Schema.decodeUnknownOption(ClaimRefArgs)(marker.args),
        (args) => marker.name === CLAIM_REF_MARKER && args.runId === found.id,
      ),
    ).map((args) => args.item),
  );

  if (items.length === 0) {
    return unchecked;
  }

  const flow = { repo: found.repo, flow: found.flow, persona: found.persona };

  const question = {
    runId: found.id,
    executionId: executing.value,
    item: Option.getOrElse(found.item, () => ({ key: found.itemKey, data: {} })),
    pullRequest: found.pullRequest,
  };

  const leases: Array<LeaseView> = [];

  for (const item of items) {
    const lease = yield* Effect.result(flows.lease(flow, question, item, renew));

    if (Result.isFailure(lease)) {
      return RunLeases.cases.CheckFailed.make({ message: lease.failure.message });
    }

    const state = lease.success;

    if (state.status === "lost") {
      return RunLeases.cases.Lost.make({ item, reason: state.reason });
    }

    if (state.status === "held") {
      leases.push({ item, expiresAt: state.expiresAt, renewedAt: state.renewedAt });
    }
  }

  return RunLeases.cases.Held.make({ leases });
});
