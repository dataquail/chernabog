import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { samePersona } from "../../../kernel/persona.value-object.ts";
import { FlowsClient } from "../domain/ports/clients/flows.client.ts";
import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { SkipsRepository } from "../domain/ports/repositories/skips.repository.ts";
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
import { SkipRoot } from "../domain/skip/skip.root.ts";
import { TickPlan } from "./flow.result.ts";

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

// One tick of a persona's flow, up to what it would do: unless the machine's
// gates hold it back, runs the flow's trigger, and says which of the work it
// found carries signals for runs in flight and which this machine may start
// runs for, as many as the limits let it. Why it would start nothing, when it
// wouldn't, is recorded as a skip. Delivering the signals, the flow's own gate
// and starting the runs are left to the caller, one use-case each.
export const planTickUseCase = Effect.fn("planTickUseCase")(function* (
  flow: FlowRef,
  input: TickInput,
) {
  const flows = yield* FlowsClient;
  const skips = yield* SkipsRepository;

  const skip = (
    reason: string,
    plan: { readonly signalled: ReadonlyArray<WorkItem>; readonly routed: TickPlan["routed"] },
  ) =>
    Effect.gen(function* () {
      yield* skips.save(
        SkipRoot.make({
          repo: flow.repo,
          persona: flow.persona,
          flow: flow.flow,
          itemKey: Option.none(),
          reason,
          at: DateTime.formatIso(yield* DateTime.now),
        }),
      );

      return TickPlan.make({ ...plan, start: [], skipped: Option.some(reason) });
    });

  const nothing = { signalled: [], routed: Option.none() };

  if (input.gates) {
    const decision = decideTick({ ...input.conditions, now: yield* DateTime.now });

    if (!decision.go) {
      return yield* skip(decision.reason, nothing);
    }
  }

  const triggered = yield* Effect.result(flows.trigger(flow));

  if (Result.isFailure(triggered)) {
    return yield* skip(`trigger failed: ${triggered.failure.message}`, nothing);
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
      nothing,
    );
  }

  const items: ReadonlyArray<WorkItem> = [
    ...triggered.success,
    ...Option.toArray(lookedUp.success),
  ];

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
    signalled: items,
    routed: Option.some({ queued: routed.mine.map(describeQueued), elsewhere }),
  };

  const candidates = Option.match(input.item, {
    onNone: () => routed.mine,
    onSome: (key) => waiting.filter((item) => item.key === key),
  });

  if (Option.isNone(input.item) && routed.mine.length === 0 && routed.elsewhere.length > 0) {
    return yield* skip(`only work for others: ${elsewhere.join(", ")}`, so);
  }

  if (!input.gates || candidates.length === 0) {
    return TickPlan.make({ ...so, start: candidates, skipped: Option.none() });
  }

  // A run parked on a signal doesn't count against the limits.
  const parked = new Set(
    (yield* (yield* RunWaitsRepository).findAll(Option.none())).map((wait) => wait.runId),
  );

  const working = running.filter((run) => !parked.has(run.id));

  const slots = freeSlots({
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
      so,
    );
  }

  return TickPlan.make({ ...so, start: candidates.slice(0, slots), skipped: Option.none() });
});
