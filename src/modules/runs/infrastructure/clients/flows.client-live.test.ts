import { defineFlow, gone, Run, RunLog, Skip, valid } from "@chernabog/core";
import { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { item, makeFake, repo } from "../../../../../test/sdk-fakes.ts";
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
        return gone(`${work.key} was closed under run ${run.runId} (#${run.pullRequest ?? 0})`);
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

const quietLog = Layer.succeed(
  RunLog,
  RunLog.of({ log: () => Effect.void, step: () => Effect.void, stepDone: () => Effect.void }),
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
        ],
        services: (_repo, persona) =>
          Option.liftPredicate(Effect.succeed(services), () => Option.contains(persona, "bob")),
      },
      { stillValidTimeout: "50 millis" },
    );
  }),
).pipe(Layer.provide(RunsRepositoryFake([])));

const as = (flow: string, persona = Option.some("bob")) => ({ repo: "demo", flow, persona });

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

  const question = (key: string) => ({
    runId: RunId.make("run-1"),
    executionId: "execution-1",
    item: item(key),
    pullRequest: Option.some(9),
  });

  effect("asks a flow's stillValid about a run, as the run, and none of a flow without one", () =>
    Effect.gen(function* () {
      const client = yield* FlowsClient;

      expect(yield* client.stillValid(as("checking"), question("pr-closed"))).toEqual(
        Option.some({ valid: false, reason: "pr-closed was closed under run run-1 (#9)" }),
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
});
