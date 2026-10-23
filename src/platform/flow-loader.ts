// Loads flows and steps, TypeScript modules in a repo's .chernabog/, into this
// process. Their imports of `effect`, any `effect/*` subpath and
// `@chernabog/sdk` resolve to the copies bundled in the binary, so there is
// always one `effect` version and the binary chooses it, for packages in
// node_modules that import it too. Other npm dependencies resolve from
// .chernabog/node_modules, installed from .chernabog/package.json.

import * as Sdk from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { authorsPullRequests } from "../kernel/reviewer-pool.value-object.ts";
import { effectModules, effectRoot } from "./effect-modules.ts";

export class LoadError extends Schema.TaggedError<LoadError, { readonly brand: "LoadError" }>()(
  "LoadError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

// Registered once, when this module is first imported, before any flow is.
Bun.plugin({
  name: "chernabog-bundled-modules",
  setup(build) {
    build.module("effect", () => ({ exports: { ...effectRoot }, loader: "object" }));

    for (const [specifier, module] of Object.entries(effectModules)) {
      build.module(specifier, () => ({ exports: { ...module }, loader: "object" }));
    }

    build.module("@chernabog/sdk", () => ({ exports: { ...Sdk }, loader: "object" }));
  },
});

// What a flow module must export; its effects and functions are checked by shape, as code can only be.
const FlowDefinition = Schema.declare(
  (module): module is Sdk.Flow =>
    Predicate.hasProperty(module, "trigger") &&
    Predicate.hasProperty(module, "workflow") &&
    Effect.isEffect(module.trigger) &&
    Predicate.isFunction(module.workflow),
  { title: "defineFlow({ trigger, workflow })" },
);

const StageDefinition = Schema.declare(
  (module): module is Sdk.Stage<unknown, unknown, unknown> =>
    Predicate.hasProperty(module, "input") &&
    Predicate.hasProperty(module, "output") &&
    Predicate.hasProperty(module, "run") &&
    Schema.isSchema(module.input) &&
    Schema.isSchema(module.output) &&
    Predicate.isFunction(module.run),
  { title: "defineStage({ input, output, run })" },
);

// A repo's flow or step, imported from its path. Its exports are checked before use.
const importRepoModule = (path: string) => import(path);

const importDefault = <A>(path: string, definition: Schema.Codec<A, A>, what: string) =>
  Effect.tryPromise({
    try: () => importRepoModule(path),
    catch: (error) => new LoadError({ path, message: Sdk.describeError(error) }),
  }).pipe(
    Effect.flatMap((module) =>
      Schema.decodeUnknownEffect(Schema.Struct({ default: definition }))(module),
    ),
    Effect.map((module) => module.default),
    Effect.mapError((error) => {
      if (Schema.is(LoadError)(error)) {
        return error;
      }

      return new LoadError({ path, message: `${what} must be the module's default export` });
    }),
  );

const MODULE_EXTENSIONS = [".ts", ".js", ".mts", ".mjs"];

const flowName = (file: string) =>
  Arr.findFirst(MODULE_EXTENSIONS, (extension) => file.endsWith(extension)).pipe(
    Option.map((extension) => file.slice(0, -extension.length)),
  );

// Each flow module in <configDir>/flows/, as [name, file], in name order.
const flowFiles = (configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = `${configDir}/flows`;

    if (!(yield* fs.exists(directory))) {
      return [];
    }

    return Arr.sort(yield* fs.readDirectory(directory), Order.String).flatMap((file) => {
      if (file.endsWith(".d.ts") || file.includes(".test.")) {
        return [];
      }

      return Option.toArray(
        Option.map(flowName(file), (name) => [name, `${directory}/${file}`] as const),
      );
    });
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new LoadError({ path: configDir, message: error.message })),
    ),
  );

// The names of the flows in <configDir>/flows/, without importing them, so
// listing an untrusted .chernabog/ runs none of its code.
export const flowNames = (configDir: string) =>
  Effect.map(flowFiles(configDir), (files) => files.map(([name]) => name));

// The flows in <configDir>/flows/ that open pull requests asking the pool for
// a review. Their code is read, not imported, so it runs nothing; none when
// the folder can't be read.
export const authoringFlows = (configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const authoring: Array<string> = [];

    for (const [name, path] of yield* flowFiles(configDir)) {
      const source = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));

      if (authorsPullRequests(name, source)) {
        authoring.push(name);
      }
    }

    return authoring;
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

// Every flow in <configDir>/flows/, by file name.
export const loadFlows = (configDir: string) =>
  Effect.gen(function* () {
    const flows = new Map<string, Sdk.Flow>();

    for (const [name, path] of yield* flowFiles(configDir)) {
      flows.set(
        name,
        yield* importDefault(path, FlowDefinition, "defineFlow({ trigger, workflow })"),
      );
    }

    return flows;
  });

export type StageModule = { readonly kind: "effect" | "shell"; readonly path: string };

// A step is <name>.ts (an Effect step) or an executable <name> (a shell step).
export const findStage = (configDir: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    for (const extension of MODULE_EXTENSIONS) {
      const path = `${configDir}/stages/${name}${extension}`;

      if (yield* fs.exists(path)) {
        return Option.some<StageModule>({ kind: "effect", path });
      }
    }

    const path = `${configDir}/stages/${name}`;

    if (yield* fs.exists(path)) {
      return Option.some<StageModule>({ kind: "shell", path });
    }

    return Option.none<StageModule>();
  }).pipe(Effect.orElseSucceed(() => Option.none<StageModule>()));

export const loadStage = (path: string) =>
  importDefault(path, StageDefinition, "defineStage({ input, output, run })");
