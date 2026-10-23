import { defineFlow, RunLog, Skip } from "@chernabog/sdk";
import { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { item, makeFake, repo } from "../../../../../test/sdk-fakes.ts";
import { flowHandle } from "../../../../engine.ts";
import { FlowsClient } from "../../domain/ports/clients/flows.client.ts";
import { RunsRepositoryFake } from "../repositories/runs.repository-fake.ts";
import { FlowsClientLive } from "./flows.client-live.ts";

const finding = defineFlow({
  trigger: Effect.succeed([item("pr-1")]),
  item: (key) => Effect.succeedSome(item(key)),
  gate: Effect.fail(new Skip({ reason: "usage gate: over the ceiling" })),
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

    return FlowsClientLive({
      handles: [flowHandle(repo, "finding", finding)],
      services: (_repo, persona) =>
        Option.liftPredicate(services, () => Option.contains(persona, "bob")),
    });
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
