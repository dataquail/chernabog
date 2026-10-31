import { Command, CommandBus, Query } from "@effect-server-utils/cqrs";
import { describe, expect } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { applicationModules } from "../src/interface/application-modules.ts";
import { busesOver } from "../src/interface/application-runtime.ts";
import * as enrollmentCommands from "../src/modules/enrollment/enrollment.command-handlers.ts";
import * as enrollmentQueries from "../src/modules/enrollment/enrollment.query-handlers.ts";
import * as machineCommands from "../src/modules/machine/machine.command-handlers.ts";
import * as machineQueries from "../src/modules/machine/machine.query-handlers.ts";
import * as recipesCommands from "../src/modules/recipes/recipes.command-handlers.ts";
import * as recipesQueries from "../src/modules/recipes/recipes.query-handlers.ts";
import * as rehearsalsCommands from "../src/modules/rehearsals/rehearsals.command-handlers.ts";
import * as rehearsalsQueries from "../src/modules/rehearsals/rehearsals.query-handlers.ts";
import * as runsCommands from "../src/modules/runs/runs.command-handlers.ts";
import * as runsQueries from "../src/modules/runs/runs.query-handlers.ts";
import * as trustCommands from "../src/modules/trust/trust.command-handlers.ts";
import * as trustQueries from "../src/modules/trust/trust.query-handlers.ts";
import { effect } from "./effect-test.ts";

// Every module's handler maps, by module.
const handlerMaps = {
  enrollment: [enrollmentCommands, enrollmentQueries],
  machine: [machineCommands, machineQueries],
  recipes: [recipesCommands, recipesQueries],
  rehearsals: [rehearsalsCommands, rehearsalsQueries],
  runs: [runsCommands, runsQueries],
  trust: [trustCommands, trustQueries],
};

// Every group the handler maps declare, read off what they export, so a group
// added to a module but left out of its routes is caught here.
const exported = Object.values(handlerMaps).flatMap((maps) =>
  maps.flatMap((map) => Object.values<unknown>(map)),
);

const declaredCommands = exported.filter(Command.isGroup);
const declaredQueries = exported.filter(Query.isGroup);

const tagsOf = (groups: ReadonlyArray<{ readonly tags: ReadonlyArray<string> }>) =>
  groups.flatMap((group) => group.tags).toSorted();

// Two commands, grouped, and dispatchers that answer one or both of them.
const Ping = Command.make("Ping", { payload: Schema.Struct({ n: Schema.Finite }) });
const Pong = Command.make("Pong", { payload: Schema.Struct({ n: Schema.Finite }) });
const pingPong = Command.group(Ping, Pong);
const answered: Array<string> = [];
const answersPing = { Ping: () => Effect.sync(() => answered.push("Ping")) };
const answersPong = { Pong: () => Effect.sync(() => answered.push("Pong")) };
const noQueries = { groups: [], tables: Effect.succeed([]) };

const busesAnswering = (tables: ReadonlyArray<Record<string, () => Effect.Effect<number>>>) =>
  busesOver({
    commands: { groups: [pingPong], tables: Effect.succeed(tables) },
    queries: noQueries,
  });

// What building the buses died of, as it reads, or that they built.
const outcomeOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, { onSuccess: () => "built", onFailure: (cause) => Cause.pretty(cause) });

// The shared runtime builds one CommandBus and one QueryBus over every
// module's dispatchers (ADR 13), and refuses to build one it can't route.
describe("the application's buses", () => {
  effect("route every group a module declares, each once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL("../src/modules", import.meta.url));
      const routes = applicationModules.routes;
      const engine = applicationModules.engineRoutes;

      expect((yield* fs.readDirectory(root)).toSorted()).toEqual(Object.keys(handlerMaps));
      expect(tagsOf([...routes.commands.groups, ...engine.commands.groups])).toEqual(
        tagsOf(declaredCommands),
      );
      expect(tagsOf([...routes.queries.groups, ...engine.queries.groups])).toEqual(
        tagsOf(declaredQueries),
      );
    }),
  );

  effect("fail to build when a group's tag has no handler", () =>
    Effect.gen(function* () {
      const exit = yield* Layer.build(busesAnswering([answersPing])).pipe(Effect.exit);

      expect(outcomeOf(exit)).toContain("UnroutableTags");
      expect(outcomeOf(exit)).toContain("declared tags that nothing routes: 'Pong'");
    }),
  );

  effect("fail to build when two modules answer one tag", () =>
    Effect.gen(function* () {
      const exit = yield* Layer.build(busesAnswering([answersPing, answersPing])).pipe(Effect.exit);

      expect(outcomeOf(exit)).toContain("DuplicateDispatchTag");
      expect(outcomeOf(exit)).toContain("tag 'Ping' is claimed by more than one module");
    }),
  );

  effect("dispatch a message through the module that answers it", () =>
    Effect.gen(function* () {
      yield* (yield* CommandBus).execute(Pong, { n: 1 });

      expect(answered).toEqual(["Pong"]);
    }).pipe(Effect.provide(busesAnswering([answersPing, answersPong]))),
  );
});
