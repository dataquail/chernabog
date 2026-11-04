import {
  Claims,
  defineFlow,
  gone,
  Markers,
  Run,
  RunLog,
  Settings,
  Skip,
  valid,
} from "@chernabog/core";
import { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { effect } from "../../../../../test/effect-test.ts";
import { item, makeFake, repo, repoAs, settings } from "../../../../../test/sdk-fakes.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { FlowsClient } from "../../domain/ports/clients/flows.client.ts";
import { RunsRepositoryFake } from "../repositories/runs.repository-fake.ts";
import { flowHandle } from "../runtime/engine.ts";
import { FlowsClientLive } from "./flows.client-live.ts";

const finding = defineFlow({
  trigger: Effect.succeed([item("pr-1")]),
  item: (key) => Effect.succeedSome(item(key)),
  gate: Effect.fail(new Skip({ reason: "usage gate: over the ceiling" })),
  workflow: () => Effect.void,
});

// A hand-written flow's own check, against its own client: here, the run it's
// asked about, which an item key names as gone.
const checking = defineFlow({
  trigger: Effect.succeed([]),
  stillValid: (work) =>
    Effect.gen(function* () {
      const run = yield* Run;

      if (work.key === "pr-closed") {
        const subjects = (run.subjects ?? []).join(", ");

        return gone(
          `${work.key} was closed under run ${run.runId} (${subjects}; #${run.pullRequest ?? 0})`,
        );
      }

      return valid;
    }),
  workflow: () => Effect.void,
});

// A check that never answers, and one that fails.
const hanging = defineFlow({
  trigger: Effect.succeed([]),
  stillValid: () => Effect.never,
  workflow: () => Effect.void,
});

const failing = defineFlow({
  trigger: Effect.succeed([]),
  stillValid: () => Effect.fail(new Skip({ reason: "rate limited" })),
  workflow: () => Effect.void,
});

// A flow of a setting nothing else knows: which queue its trigger reads, and its gate names.
const Queue = Schema.Struct({ queue: Schema.String });

const queueing = defineFlow({
  settings: Queue,
  trigger: Effect.map(Settings.read(Queue), (own) => [item(own.queue)]),
  gate: Effect.flatMap(Settings.read(Queue), (own) =>
    Effect.fail(new Skip({ reason: `holding ${own.queue}` })),
  ),
  workflow: () => Effect.void,
});

// A flow's own lease, and one it reads between renewals; each answer says what
// asked it, to show the run and the TTL reach it. A marker with none, and a
// flow that holds them.
const leased = Markers.define(
  "queue-lease",
  Schema.Struct({ job: Schema.String }),
  () => Effect.void,
  {
    on: (args) => args.job,
    renew: (args, ttl) =>
      Effect.gen(function* () {
        const run = yield* Run;

        if (args.job === "taken") {
          return { status: "lost", reason: `run ${run.runId} lost ${args.job}` } as const;
        }

        if (args.job === "down") {
          return yield* new Skip({ reason: "the queue is down" });
        }

        return { status: "held", expiresAt: `in ${Duration.toMillis(ttl)}` } as const;
      }),
  },
);

const readable = Markers.define(
  "readable-lease",
  Schema.Struct({ job: Schema.String }),
  () => Effect.void,
  {
    renew: () => Effect.succeed({ status: "held" } as const),
    check: (args) => Effect.succeed({ status: "lost", reason: `${args.job} went` } as const),
  },
);

const plain = Markers.define("plain", Schema.Struct({}), () => Effect.void);

const leasing = defineFlow({
  trigger: Effect.succeed([]),
  markers: [leased, readable, plain],
  workflow: () => Effect.void,
});

// The team shares a queue; bob's machine config gives queueing his own.
const [bob] = repoAs(settings, [Option.some("bob")]).personas;

const queues = {
  ...repo,
  personas: [
    {
      ...bob,
      shared: { queue: "team-queue" },
      flows: { queueing: { settings: { queue: "bobs" } } },
    },
  ],
} as const;

const quietLog = Layer.succeed(
  RunLog,
  RunLog.of({
    log: () => Effect.void,
    step: () => Effect.void,
    stepDone: () => Effect.void,
    stepFinished: () => Effect.void,
  }),
);

// The registry a daemon builds: the flows it loaded, and bob's services.
const flows = Layer.unwrap(
  Effect.gen(function* () {
    const services = yield* Layer.build(
      Layer.mergeAll(makeFake("approve").services, quietLog, BunServices.layer),
    );

    return FlowsClientLive(
      {
        handles: [
          flowHandle(repo, "finding", finding),
          flowHandle(repo, "checking", checking),
          flowHandle(repo, "hanging", hanging),
          flowHandle(repo, "failing", failing),
          flowHandle(queues, "queueing", queueing),
          flowHandle(repo, "leasing", leasing),
        ],
        services: (_repo, persona) =>
          Option.liftPredicate(Effect.succeed(services), () => Option.contains(persona, "bob")),
      },
      { stillValidTimeout: "50 millis" },
    );
  }),
).pipe(Layer.provide(RunsRepositoryFake([])));

const as = (flow: string, persona = Option.some("bob")) => ({ repo: "demo", flow, persona });

const inFlight = {
  runId: RunId.make("run-1"),
  executionId: "execution-1",
  item: item("pr-1"),
  subjects: [],
};

const HOUR = Option.some(Duration.hours(1));

describe("FlowsClientLive", () => {
  effect("runs a flow's trigger, its item lookup and its gate with the persona's services", () =>
    Effect.gen(function* () {
      const client = yield* FlowsClient;

      expect((yield* client.trigger(as("finding"))).map((found) => found.key)).toEqual(["pr-1"]);
      expect(
        Option.map(yield* client.find(as("finding"), "issue-7"), (found) => found.key),
      ).toEqual(Option.some("issue-7"));
      expect(yield* client.gate(as("finding"))).toEqual(
        Option.some("usage gate: over the ceiling"),
      );
    }).pipe(Effect.provide(flows)),
  );

  effect("gives the trigger and the gate the flow's settings, as the persona runs it", () =>
    Effect.gen(function* () {
      const client = yield* FlowsClient;

      expect((yield* client.trigger(as("queueing"))).map((found) => found.key)).toEqual(["bobs"]);
      expect(yield* client.gate(as("queueing"))).toEqual(Option.some("holding bobs"));
    }).pipe(Effect.provide(flows)),
  );

  const question = (key: string) => ({
    runId: RunId.make("run-1"),
    executionId: "execution-1",
    item: item(key),
    subjects: ["release-1.4", "pr-9", "pr-10"],
  });

  effect("asks a flow's stillValid about a run, as the run, and none of a flow without one", () =>
    Effect.gen(function* () {
      const client = yield* FlowsClient;

      expect(yield* client.stillValid(as("checking"), question("pr-closed"))).toEqual(
        Option.some({
          valid: false,
          reason: "pr-closed was closed under run run-1 (release-1.4, pr-9, pr-10; #9)",
        }),
      );
      expect(yield* client.stillValid(as("checking"), question("pr-open"))).toEqual(
        Option.some({ valid: true }),
      );
      expect(yield* client.stillValid(as("finding"), question("pr-open"))).toEqual(Option.none());
    }).pipe(Effect.provide(flows)),
  );

  effect("a check that fails or runs past its timeout fails, rather than says gone", () =>
    Effect.gen(function* () {
      const client = yield* FlowsClient;
      const timedOut = yield* Effect.flip(client.stillValid(as("hanging"), question("pr-1")));
      const failed = yield* Effect.flip(client.stillValid(as("failing"), question("pr-1")));

      expect([timedOut._tag, timedOut.message]).toEqual([
        "FlowFailed",
        "stillValid timed out after 50ms",
      ]);
      expect([failed._tag, failed.message]).toEqual(["FlowFailed", "rate limited"]);
    }).pipe(Effect.provide(flows)),
  );

  effect("fails for a flow it didn't load, or a persona the repo has no services for", () =>
    Effect.gen(function* () {
      const client = yield* FlowsClient;

      expect((yield* Effect.flip(client.trigger(as("missing"))))._tag).toBe("FlowFailed");
      expect((yield* Effect.flip(client.trigger(as("finding", Option.some("eve")))))._tag).toBe(
        "FlowFailed",
      );
    }).pipe(Effect.provide(flows)),
  );

  effect("renews a marker's lease by its definition, as the run, for the TTL asked", () =>
    Effect.gen(function* () {
      const client = yield* FlowsClient;

      const leaseOf = (job: string, renew = HOUR) =>
        client.markerLease(as("leasing"), inFlight, "queue-lease", { job }, renew);

      expect(yield* leaseOf("J-1")).toEqual(
        Option.some({
          on: "J-1",
          state: {
            status: "held",
            expiresAt: Option.some("in 3600000"),
            renewedAt: Option.none(),
          },
        }),
      );
      expect(yield* leaseOf("taken")).toEqual(
        Option.some({ on: "taken", state: { status: "lost", reason: "run run-1 lost taken" } }),
      );
      // Failing to renew says so, never lost.
      expect((yield* Effect.flip(leaseOf("down")))._tag).toBe("FlowFailed");
      // With no way to read it between renewals, a check takes it as held.
      expect(yield* leaseOf("taken", Option.none())).toEqual(
        Option.some({
          on: "taken",
          state: { status: "held", expiresAt: Option.none(), renewedAt: Option.none() },
        }),
      );
    }).pipe(Effect.provide(flows)),
  );

  effect("reads a marker's lease by its check, named after the marker unless it says", () =>
    Effect.gen(function* () {
      const client = yield* FlowsClient;

      expect(
        yield* client.markerLease(
          as("leasing"),
          inFlight,
          "readable-lease",
          { job: "J-2" },
          Option.none(),
        ),
      ).toEqual(
        Option.some({ on: "readable-lease", state: { status: "lost", reason: "J-2 went" } }),
      );
    }).pipe(Effect.provide(flows)),
  );

  effect(
    "no lease for a marker without one, unknown, of an unloaded flow, or whose arguments no longer fit",
    () =>
      Effect.gen(function* () {
        const client = yield* FlowsClient;

        for (const [flow, name, args] of [
          ["leasing", "plain", {}],
          ["leasing", "no-such-marker", {}],
          ["missing", "queue-lease", { job: "J-1" }],
          ["leasing", "queue-lease", { changed: true }],
        ] as const) {
          expect(yield* client.markerLease(as(flow), inFlight, name, args, HOUR)).toEqual(
            Option.none(),
          );
        }
      }).pipe(Effect.provide(flows)),
  );

  effect("renews and reads the claim ref by the SDK's marker, whatever the flow lists", () =>
    Effect.gen(function* () {
      const client = yield* FlowsClient;
      const args = { item: "issue-7", runId: "run-1" };

      // Nobody holds it.
      for (const renew of [HOUR, Option.none()]) {
        expect(
          yield* client.markerLease(as("finding"), inFlight, Claims.refMarker.name, args, renew),
        ).toEqual(Option.some({ on: "issue-7", state: { status: "released" } }));
      }

      // A hold naming another run isn't this run's to renew or lose.
      expect(
        yield* client.markerLease(
          as("finding"),
          inFlight,
          Claims.refMarker.name,
          { item: "issue-7", runId: "run-2" },
          HOUR,
        ),
      ).toEqual(Option.some({ on: "issue-7", state: { status: "released" } }));
    }).pipe(Effect.provide(flows)),
  );
});
