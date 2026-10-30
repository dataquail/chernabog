import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { FlowsClient } from "../domain/ports/clients/flows.client.ts";
import { RunMarkersRepository } from "../domain/ports/repositories/run-markers.repository.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import {
  CLAIM_REF_MARKER,
  ClaimRefArgs,
  type LeaseView,
  RunLeases,
} from "../domain/schedule/lease.value-object.ts";
import { type CheckRunLeasesPayload } from "./check-run-leases.command.ts";

const unchecked = RunLeases.cases.Unchecked.make({});

export const checkRunLeasesHandler = Effect.fn("checkRunLeasesHandler")(function* ({
  renew,
  runId,
}: CheckRunLeasesPayload) {
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
    subjects: found.subjects,
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
