import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { samePersona } from "../../../kernel/persona.value-object.ts";
import { FlowsClient } from "../domain/ports/clients/flows.client.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import {
  describeElsewhere,
  routeItems,
  type Routing,
} from "../domain/routing/routing.value-object.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { type FlowRef, type WorkItem } from "../domain/run/work-item.value-object.ts";
import {
  decideTick,
  freeSlots,
  type TickConditions,
} from "../domain/schedule/tick.value-object.ts";
import { deliverSignalsUseCase } from "./deliver-signals.use-case.ts";
import { TickOutcome } from "./flow.result.ts";
import { listActiveRunsUseCase } from "./list-active-runs.use-case.ts";
import { recordSkipUseCase } from "./record-skip.use-case.ts";
import { type RunView } from "./run.result.ts";
import { startFlowRunUseCase } from "./start-flow-run.use-case.ts";

// What a tick weighs besides the flow's own work: whether to apply the
// machine's gates (a person running a flow now skips them), an item a person
// named, the conditions the gates read, whose work starts here, and the limits
// on runs at once.
export type TickInput = {
  readonly gates: boolean;
  readonly item: Option.Option<string>;
  readonly conditions: Omit<TickConditions, "now">;
  readonly routing: Routing;
  // Who @me is for this persona; none when it isn't known.
  readonly login: Option.Option<string>;
  readonly concurrency: { readonly flow: number; readonly machine: number };
};

const describeQueued = (item: WorkItem) =>
  Option.match(Option.fromUndefinedOr(item.title), {
    onNone: () => item.key,
    onSome: (title) => `${item.key} ${title}`,
  });

// One tick of a persona's flow: unless the machine's gates hold it back, runs
// the flow's trigger, wakes the runs its signals are for, and starts runs for
// the work this machine may take, as many as the limits and the flow's own
// gate let it. Why it starts nothing, when it doesn't, is recorded as a skip.
export const tickFlowUseCase = Effect.fn("tickFlowUseCase")(function* (
  flow: FlowRef,
  input: TickInput,
) {
  const flows = yield* FlowsClient;

  const skip = (
    reason: string,
    itemKey: Option.Option<string>,
    so: { readonly started: ReadonlyArray<RunView>; readonly routed: TickOutcome["routed"] },
  ) =>
    recordSkipUseCase({
      repo: flow.repo,
      persona: flow.persona,
      flow: flow.flow,
      itemKey,
      reason,
    }).pipe(Effect.as(TickOutcome.make({ ...so, skipped: Option.some(reason) })));

  const nothing = { started: [], routed: Option.none() };

  if (input.gates) {
    const decision = decideTick({ ...input.conditions, now: yield* DateTime.now });

    if (!decision.go) {
      return yield* skip(decision.reason, Option.none(), nothing);
    }
  }

  const triggered = yield* Effect.result(flows.trigger(flow));

  if (Result.isFailure(triggered)) {
    return yield* skip(`trigger failed: ${triggered.failure.message}`, Option.none(), nothing);
  }

  const unreported = Option.filter(
    input.item,
    (key) => !triggered.success.some((found) => found.key === key),
  );

  const lookedUp = yield* Effect.result(
    Option.match(unreported, {
      onNone: () => Effect.succeedNone,
      onSome: (key) => flows.find(flow, key),
    }),
  );

  if (Result.isFailure(lookedUp)) {
    return yield* skip(
      `could not find ${Option.getOrElse(input.item, () => "the item")}: ${lookedUp.failure.message}`,
      input.item,
      nothing,
    );
  }

  const items: ReadonlyArray<WorkItem> = [
    ...triggered.success,
    ...Option.toArray(lookedUp.success),
  ];

  yield* deliverSignalsUseCase(flow, items);

  const running = yield* (yield* RunsRepository).findAll({ running: true });

  // The items a run may start for: not only waking one, and without its run already.
  const waiting = items.filter(
    (item) =>
      item.wakeOnly !== true &&
      Option.isNone(
        RunRootOps.activeFor(running, {
          repo: flow.repo,
          persona: flow.persona,
          flow: flow.flow,
          itemKey: item.key,
        }),
      ),
  );

  // Work for others is left to them, unless a person names the item.
  const routed = routeItems(waiting, input.routing, input.login);

  const elsewhere = routed.elsewhere.map(describeElsewhere(input.routing));

  const so = {
    started: [],
    routed: Option.some({ queued: routed.mine.map(describeQueued), elsewhere }),
  };

  const candidates = Option.match(input.item, {
    onNone: () => routed.mine,
    onSome: (key) => waiting.filter((item) => item.key === key),
  });

  if (Option.isNone(input.item) && routed.mine.length === 0 && routed.elsewhere.length > 0) {
    return yield* skip(`only work for others: ${elsewhere.join(", ")}`, Option.none(), so);
  }

  if (candidates.length === 0) {
    return TickOutcome.make({ ...so, skipped: Option.none() });
  }

  let slots = candidates.length;

  if (input.gates) {
    const working = (yield* listActiveRunsUseCase({
      repo: Option.none(),
      persona: Option.none(),
      flow: Option.none(),
    })).runs.filter((active) => !active.parked);

    slots = freeSlots({
      activeForFlow: working.filter(
        (active) =>
          active.repo === flow.repo &&
          samePersona(active.persona, flow.persona) &&
          active.flow === flow.flow,
      ).length,
      flowConcurrency: input.concurrency.flow,
      activeOnMachine: working.length,
      machineConcurrency: input.concurrency.machine,
    });

    if (slots === 0) {
      return yield* skip(
        `at the concurrency limit; waiting: ${candidates.map((item) => item.key).join(", ")}`,
        Option.none(),
        so,
      );
    }
  }

  const started: Array<RunView> = [];

  for (const item of candidates.slice(0, slots)) {
    if (input.gates) {
      // The gate holds back every item this tick, not only this one.
      for (const reason of Option.toArray(yield* flows.gate(flow))) {
        return yield* skip(reason, Option.some(item.key), { ...so, started });
      }
    }

    const outcome = yield* startFlowRunUseCase(flow, item);

    for (const run of Option.toArray(Option.filter(outcome.run, () => outcome.started))) {
      started.push(run);
    }
  }

  return TickOutcome.make({ ...so, started, skipped: Option.none() });
});
