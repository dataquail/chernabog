import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import type * as Schema from "effect/Schema";

import { FlowsClient, type MarkerLease } from "../../domain/ports/clients/flows.client.ts";
import { FlowFailed, PersonaNotReady } from "../../domain/run/run.errors.ts";
import {
  type FlowRef,
  type ItemValidity,
  type ValidityQuestion,
  type WorkItem,
} from "../../domain/run/work-item.value-object.ts";
import { MarkerUnreleasable } from "../../domain/run-marker/run-marker.errors.ts";
import { type LeaseState } from "../../domain/schedule/lease.value-object.ts";

// A flow as a test has it: the work its trigger reports (or why it fails),
// the items it finds by key, and why its gate holds runs back, if it does.
export type FakeFlow = {
  readonly items: ReadonlyArray<WorkItem>;
  // Why its trigger fails, when it does.
  readonly fails?: string;
  // Why its persona can't run it here, when it can't.
  readonly notReady?: string;
  readonly findable?: ReadonlyArray<WorkItem>;
  readonly gate?: string;
  // What its stillValid answers, if it has one, or why it fails; and the
  // runs it was asked about, which the fake appends to.
  readonly validity?: ItemValidity;
  readonly validityFails?: string;
  readonly asked?: Array<ValidityQuestion>;
  // The markers it defines; each release a run asks of it is appended to
  // `releases`, and fails with the first of `releaseFails` while it has one.
  readonly markers?: ReadonlyArray<string>;
  readonly releases?: Array<{
    readonly runId: string;
    readonly name: string;
    readonly args: Schema.Json;
  }>;
  readonly releaseFails?: Array<string>;
  // The markers whose definitions declare a lease, the claim ref's by default.
  // What each lease is found to be, by what it is on (the arguments' `item`,
  // else the marker's name), released when it isn't listed; why reading all of
  // them fails, or the one on `leaseFailsOn`; each ask is appended to `leaseAsks`.
  readonly leased?: ReadonlyArray<string>;
  readonly leases?: Readonly<Record<string, LeaseState>>;
  readonly leaseFails?: string;
  readonly leaseFailsOn?: string;
  readonly leaseAsks?: Array<{
    readonly runId: string;
    readonly item: string;
    readonly renew: Option.Option<Duration.Duration>;
  }>;
};

const keyOf = (flow: FlowRef) => `${flow.repo}/${flow.flow}`;

// What a test's marker's lease is on: its arguments' `item`, else its name.
const onOf = (name: string, args: Schema.Json) => {
  if (Predicate.isObject(args) && Predicate.hasProperty(args, "item")) {
    return String(args.item);
  }

  return name;
};

// Flows by repo/flow; a flow not listed fails as one never loaded.
export const FlowsClientFake = (flows: Readonly<Record<string, FakeFlow>>) => {
  const flowOf = (flow: FlowRef) =>
    Effect.fromOption(Record.get(flows, keyOf(flow))).pipe(
      Effect.mapError(() => new FlowFailed({ message: `no flow ${keyOf(flow)}` })),
    );

  return Layer.succeed(
    FlowsClient,
    FlowsClient.of({
      trigger: (flow) =>
        Effect.flatMap(
          flowOf(flow),
          (found): Effect.Effect<ReadonlyArray<WorkItem>, FlowFailed | PersonaNotReady> => {
            if (Predicate.isNotUndefined(found.notReady)) {
              return Effect.fail(new PersonaNotReady({ message: found.notReady }));
            }

            return Option.match(Option.fromUndefinedOr(found.fails), {
              onNone: () => Effect.succeed(found.items),
              onSome: (message) => Effect.fail(new FlowFailed({ message })),
            });
          },
        ),
      find: (flow, key) =>
        Effect.map(flowOf(flow), (found) =>
          Option.fromUndefinedOr((found.findable ?? []).find((item) => item.key === key)),
        ),
      stillValid: (flow, run) =>
        Effect.flatMap(
          flowOf(flow),
          (found): Effect.Effect<Option.Option<ItemValidity>, FlowFailed> => {
            found.asked?.push(run);

            return Option.match(Option.fromUndefinedOr(found.validityFails), {
              onNone: () => Effect.succeed(Option.fromUndefinedOr(found.validity)),
              onSome: (message) => Effect.fail(new FlowFailed({ message })),
            });
          },
        ),
      releaseMarker: (flow, run, name, args) =>
        Effect.flatMap(
          flowOf(flow),
          (found): Effect.Effect<void, FlowFailed | MarkerUnreleasable> => {
            if (!(found.markers ?? []).includes(name)) {
              return Effect.fail(
                new MarkerUnreleasable({
                  message: `${flow.flow} no longer defines marker ${name}`,
                }),
              );
            }

            return Option.match(Option.fromUndefinedOr(found.releaseFails?.[0]), {
              onSome: (message) => Effect.fail(new FlowFailed({ message })),
              onNone: () =>
                Effect.sync(() => {
                  found.releases?.push({ runId: run.runId, name, args });
                }),
            });
          },
        ),
      markerLease: (flow, run, name, args, renew) =>
        Effect.flatMap(
          flowOf(flow),
          (found): Effect.Effect<Option.Option<MarkerLease>, FlowFailed> => {
            if (!(found.leased ?? ["chernabog/claim-ref"]).includes(name)) {
              return Effect.succeedNone;
            }

            const on = onOf(name, args);

            found.leaseAsks?.push({ runId: run.runId, item: on, renew });

            const failing = Option.orElse(Option.fromUndefinedOr(found.leaseFails), () =>
              Option.liftPredicate(
                `reading the lease on ${on} failed`,
                () => found.leaseFailsOn === on,
              ),
            );

            return Option.match(failing, {
              onSome: (message) => Effect.fail(new FlowFailed({ message })),
              onNone: () =>
                Effect.succeedSome({
                  on,
                  state: Option.getOrElse(Record.get(found.leases ?? {}, on), (): LeaseState => ({
                    status: "released",
                  })),
                }),
            });
          },
        ),
      gate: (flow) =>
        flowOf(flow).pipe(
          Effect.map((found) => Option.fromUndefinedOr(found.gate)),
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
    }),
  );
};
