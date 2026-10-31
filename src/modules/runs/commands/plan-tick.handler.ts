import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import { samePersona } from "../../../kernel/persona.value-object.ts";
import { HoldsRoot } from "../domain/holds/holds.root.ts";
import { FlowsClient } from "../domain/ports/clients/flows.client.ts";
import { HoldsRepository } from "../domain/ports/repositories/holds.repository.ts";
import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { SkipsRepository } from "../domain/ports/repositories/skips.repository.ts";
import { describeElsewhere, routeItems } from "../domain/routing/routing.value-object.ts";
import { type FlowFailed, type PersonaNotReady } from "../domain/run/run.errors.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { describeWaiting, mayStart, type WorkItem } from "../domain/run/work-item.value-object.ts";
import { decideTick, freeSlots, TickPlan } from "../domain/schedule/tick.value-object.ts";
import { SkipRoot } from "../domain/skip/skip.root.ts";
import { type PlanTickPayload } from "./plan-tick.command.ts";

// The unit of work around this command's reads and writes in state.db alone.
// What it asks of GitHub, git, a launcher or the engine stays outside it: a
// transaction holds state.db's one connection, which the engine's journal
// waits on (docs/adr/0007-commands-declare-their-unit-of-work.md).
const inUnitOfWork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    withUnitOfWork,
    // state.db is a file on this machine: it has no outage to wait out.
    Effect.catchTag("PersistenceUnavailable", Effect.die),
  );

const describeQueued = (item: WorkItem) =>
  Option.match(Option.fromUndefinedOr(item.title), {
    onNone: () => item.key,
    onSome: (title) => `${item.key} ${title}`,
  });

export const planTickHandler = Effect.fn("planTickHandler")(function* ({
  flow,
  ...input
}: PlanTickPayload) {
  const flows = yield* FlowsClient;
  const skips = yield* SkipsRepository;

  const skip = (reason: string, plan: Pick<TickPlan, "signalled" | "routed">) =>
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
    }).pipe(inUnitOfWork);

  if (input.gates) {
    const decision = decideTick({ ...input.conditions, now: yield* DateTime.now });

    if (!decision.go) {
      return yield* skip(decision.reason, { signalled: [], routed: Option.none() });
    }
  }

  const nothing = { signalled: [], routed: Option.none() };

  // A persona that can't run its flows says why itself, fix included.
  const failedReason = (what: string, failure: FlowFailed | PersonaNotReady) => {
    if (Predicate.isTagged(failure, "PersonaNotReady")) {
      return failure.message;
    }

    return `${what}: ${failure.message}`;
  };

  const triggered = yield* Effect.result(flows.trigger(flow));

  if (Result.isFailure(triggered)) {
    return yield* skip(failedReason("trigger failed", triggered.failure), nothing);
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
      failedReason(
        `could not find ${Option.getOrElse(input.item, () => "the item")}`,
        lookedUp.failure,
      ),
      nothing,
    );
  }

  const items: ReadonlyArray<WorkItem> = [
    ...triggered.success,
    ...Option.toArray(lookedUp.success),
  ];

  const holding = HoldsRoot.make({
    repo: flow.repo,
    persona: flow.persona,
    flow: flow.flow,
    items: items.flatMap((item) =>
      Option.toArray(
        Option.map(Option.fromUndefinedOr(item.held), (reason) => ({
          itemKey: item.key,
          reason,
        })),
      ),
    ),
    at: DateTime.formatIso(yield* DateTime.now),
  });

  yield* HoldsRepository.use((holds) => holds.save(holding)).pipe(inUnitOfWork);

  const running = yield* (yield* RunsRepository).findAll({ running: true });

  // The items a run may start for: not only waking one, not held, and without its run already.
  const waiting = items.filter(
    (item) =>
      mayStart(item) &&
      Option.isNone(
        RunRootOps.activeFor(running, {
          repo: flow.repo,
          persona: flow.persona,
          flow: flow.flow,
          itemKey: item.key,
        }),
      ),
  );

  // Work the flow left for others is theirs, unless a person names the item.
  const routed = routeItems(waiting);

  const elsewhere = routed.elsewhere.map(describeElsewhere);

  const so = {
    signalled: items,
    routed: Option.some({
      queued: routed.mine.map(describeQueued),
      elsewhere,
      waiting: items.flatMap((item) => Option.toArray(describeWaiting(item))),
    }),
  };

  // A person who names a held item hears that it's held, and why.
  const namedHold = Option.flatMap(input.item, (key) =>
    Arr.findFirst(items, (item) =>
      Option.map(
        Option.filter(Option.fromUndefinedOr(item.held), () => item.key === key),
        (reason) => `${key} is held: ${reason}`,
      ),
    ),
  );

  if (Option.isSome(namedHold)) {
    return TickPlan.make({ ...so, start: [], skipped: namedHold });
  }

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
