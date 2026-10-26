// Loads flows and steps, TypeScript modules in a repo's .chernabog/, into this
// process. Their imports of `effect`, any `effect/*` subpath and
// `@chernabog/sdk` resolve to the copies bundled in the binary, so there is
// always one `effect` version and the binary chooses it, for packages in
// node_modules that import it too. Other npm dependencies resolve from
// .chernabog/node_modules, installed from .chernabog/package.json.
//
// A flow is a file in .chernabog/flows/, named for it, or imported from a
// recipe package: config.yaml's `flows.<name>.from: "<package>/<recipe>"`
// names the recipe whose flow runs under that name, from
// .chernabog/node_modules. A name that is both is refused.

import * as Sdk from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { parseRecipeRef, RecipePackageManifest } from "../kernel/recipe-package.value-object.ts";
import { authorsPullRequests, reviewsPullRequests } from "../kernel/reviewer-pool.value-object.ts";
import { effectModules, effectRoot } from "./effect-modules.ts";

export class LoadError extends Schema.TaggedError<LoadError, { readonly brand: "LoadError" }>()(
  "LoadError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

// A flow that a trigger finds work for, or a manual one a person names its work for.
const FLOW_EXPORT = "defineFlow({ trigger, workflow }) or defineFlow({ item, workflow })";

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

// What a flow module must export: a workflow, and a trigger that finds its
// work, an item lookup a person names it by, or both. Its effects and
// functions are checked by shape, as code can only be.
const FlowDefinition = Schema.declare(
  (module): module is Sdk.Flow =>
    Predicate.hasProperty(module, "workflow") &&
    Predicate.isFunction(module.workflow) &&
    ((Predicate.hasProperty(module, "trigger") && Effect.isEffect(module.trigger)) ||
      (!Predicate.hasProperty(module, "trigger") &&
        Predicate.hasProperty(module, "item") &&
        Predicate.isFunction(module.item))),
  { title: FLOW_EXPORT },
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
const localFlowFiles = (configDir: string) =>
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

// Where an imported flow comes from: the recipe package, as installed, and
// the recipe in it.
export type FlowSource = {
  readonly package: string;
  readonly version: string;
  readonly recipe: string;
  // The package's directory under .chernabog/node_modules.
  readonly dir: string;
};

// How a flow's source reads to a person: `@acme/recipes@2.1.0`.
export const describeSource = (source: FlowSource) => `${source.package}@${source.version}`;

// What the loader reads of config.yaml: the flows imported from packages.
const ImportsFile = Schema.Struct({
  flows: Schema.optionalKey(
    Schema.NullOr(
      Schema.Record(
        Schema.String,
        Schema.NullOr(Schema.Struct({ from: Schema.optionalKey(Schema.String) })),
      ),
    ),
  ),
});

const PackageJson = Schema.fromJsonString(RecipePackageManifest);

// config.yaml's `flows.<name>.from`, by flow name; none without config.yaml.
export const flowImports = (configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${configDir}/config.yaml`;

    if (!(yield* fs.exists(path))) {
      return new Map<string, string>();
    }

    const text = yield* fs.readFileString(path);

    // Read only for `from`; repo-config.ts decodes the whole file.
    const file = yield* Effect.try({
      try: () => Schema.decodeUnknownEffect(ImportsFile)(Bun.YAML.parse(text)),
      catch: (error) => new LoadError({ path, message: Sdk.describeError(error) }),
    }).pipe(
      Effect.flatten,
      Effect.catchTag("SchemaError", (error) =>
        Effect.fail(new LoadError({ path, message: error.message })),
      ),
    );

    return new Map(
      Object.entries(file.flows ?? {}).flatMap(([name, settings]) =>
        Option.toArray(
          Option.map(Option.fromUndefinedOr(settings?.from), (from) => [name, from] as const),
        ),
      ),
    );
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new LoadError({ path: configDir, message: error.message })),
    ),
  );

// Recipe packages to read from a directory of their own, by name, in place of
// the version installed in .chernabog/: a checkout of a package being written,
// which `chernabog rehearse --package` runs.
export type PackageOverrides = ReadonlyMap<string, string>;

const NO_OVERRIDES: PackageOverrides = new Map();

// A recipe package's checkout, read in place of the version installed: its
// name, version and directory; fails when the directory isn't a recipe package.
export const packageOverride = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const real = yield* fs.realPath(dir);

    const manifest = yield* Schema.decodeEffect(PackageJson)(
      yield* fs.readFileString(`${real}/package.json`),
    ).pipe(
      Effect.mapError(
        (error) =>
          new LoadError({
            path: `${real}/package.json`,
            message: `isn't a recipe package: ${error.message}`,
          }),
      ),
    );

    return { name: manifest.name, version: manifest.version, dir: real };
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new LoadError({ path: dir, message: error.message })),
    ),
  );

// Where a recipe package is read from.
export const packageDirOf = (configDir: string, name: string, overrides: PackageOverrides) =>
  Option.getOrElse(
    Option.fromUndefinedOr(overrides.get(name)),
    () => `${configDir}/node_modules/${name}`,
  );

// The flow module `flows.<name>.from` names, and where it comes from; fails,
// naming the package, when it or the recipe isn't installed.
const resolveImport = (
  configDir: string,
  name: string,
  from: string,
  overrides: PackageOverrides,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const ref = parseRecipeRef(from);
    const dir = packageDirOf(configDir, ref.package, overrides);
    const where = `flows.${name}.from in config.yaml names ${from}`;

    if (!(yield* fs.exists(`${dir}/package.json`))) {
      return yield* new LoadError({
        path: `${configDir}/config.yaml`,
        message: `${where}, but ${ref.package} isn't installed in .chernabog/; add it to package.json's dependencies (chernabog recipes add --import ${from} does), install it there and commit the lockfile`,
      });
    }

    const manifest = yield* Schema.decodeEffect(PackageJson)(
      yield* fs.readFileString(`${dir}/package.json`),
    ).pipe(
      Effect.mapError(
        (error) =>
          new LoadError({
            path: `${dir}/package.json`,
            message: `${where}, but ${ref.package} isn't a recipe package: ${error.message}`,
          }),
      ),
    );

    const recipe = yield* Effect.fromOption(
      Option.fromUndefinedOr(manifest.chernabog.recipes[ref.name]),
    ).pipe(
      Effect.mapError(
        () =>
          new LoadError({
            path: `${dir}/package.json`,
            message: `${where}, but ${ref.package} ${manifest.version} has no recipe named ${ref.name} (it has: ${Object.keys(manifest.chernabog.recipes).join(", ")})`,
          }),
      ),
    );

    const source: FlowSource = {
      package: ref.package,
      version: manifest.version,
      recipe: ref.name,
      dir,
    };

    return { path: `${dir}/${recipe.flow}`, source };
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new LoadError({ path: configDir, message: error.message })),
    ),
  );

type FlowFile = {
  readonly name: string;
  readonly path: string;
  readonly source: Option.Option<FlowSource>;
};

// Every flow, local or imported, in name order. A name that is both is refused.
const flowFiles = (configDir: string, overrides: PackageOverrides = NO_OVERRIDES) =>
  Effect.gen(function* () {
    const local = yield* localFlowFiles(configDir);
    const imports = yield* flowImports(configDir);

    const files: Array<FlowFile> = local.map(([name, path]) => ({
      name,
      path,
      source: Option.none(),
    }));

    for (const [name, from] of imports) {
      for (const [, path] of local.filter(([localName]) => localName === name)) {
        return yield* new LoadError({
          path,
          message: `flows.${name} in config.yaml imports ${from}, and ${path.slice(configDir.length + 1)} is a flow of the same name; remove the file, or the from (chernabog recipes eject ${name} copies the imported flow in)`,
        });
      }

      const resolved = yield* resolveImport(configDir, name, from, overrides);
      files.push({ name, path: resolved.path, source: Option.some(resolved.source) });
    }

    return Arr.sort(
      files,
      Order.mapInput(Order.String, (file: FlowFile) => file.name),
    );
  });

// Where each imported flow comes from, by name, without importing any code.
export const flowSources = (configDir: string) =>
  Effect.map(
    flowFiles(configDir),
    (files) =>
      new Map(
        files.flatMap((file) =>
          Option.toArray(Option.map(file.source, (source) => [file.name, source] as const)),
        ),
      ),
  );

// The sources of the flows loadFlows imported, by the flow it exported.
const sources = new WeakMap<Sdk.Flow, FlowSource>();

// Where a loaded flow comes from: its package, for one imported; none for a
// flow in the repo.
export const flowSourceOf = (flow: Sdk.Flow) => Option.fromUndefinedOr(sources.get(flow));

// The names of the flows in <configDir>/flows/, without importing them, so
// listing an untrusted .chernabog/ runs none of its code.
export const flowNames = (configDir: string) =>
  Effect.map(flowFiles(configDir), (files) => files.map((file) => file.name));

// The flows in <configDir>/flows/ whose name and code `test` picks. Their code
// is read, not imported, so it runs nothing; none when the folder can't be read.
const flowsWhere = (configDir: string, test: (name: string, source: string) => boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const picked: Array<string> = [];

    for (const file of yield* flowFiles(configDir)) {
      const source = yield* fs.readFileString(file.path).pipe(Effect.orElseSucceed(() => ""));

      if (test(file.name, source)) {
        picked.push(file.name);
      }
    }

    return picked;
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

// The flows that open pull requests asking the pool for a review.
export const authoringFlows = (configDir: string) => flowsWhere(configDir, authorsPullRequests);

// The flows that review the pull requests asked of their persona.
export const reviewingFlows = (configDir: string) => flowsWhere(configDir, reviewsPullRequests);

// Every flow, by name: those in <configDir>/flows/, by file name, and those
// imported from recipe packages, by the name config.yaml gives them. An
// imported flow is a copy of the package's module, so two names importing one
// recipe each keep their own source.
export const loadFlows = (configDir: string, overrides: PackageOverrides = NO_OVERRIDES) =>
  Effect.gen(function* () {
    const flows = new Map<string, Sdk.Flow>();

    for (const file of yield* flowFiles(configDir, overrides)) {
      const loaded = yield* importDefault(file.path, FlowDefinition, FLOW_EXPORT);

      const flow = Option.match(file.source, {
        onNone: () => loaded,
        onSome: (source) => {
          const imported: Sdk.Flow = { ...loaded };
          sources.set(imported, source);

          return imported;
        },
      });

      flows.set(file.name, flow);
    }

    return flows;
  });

export type StageModule = { readonly kind: "effect" | "shell"; readonly path: string };

// A step is <name>.ts (an Effect step) or an executable <name> (a shell step),
// in <dir>/stages/.
const stageIn = (dir: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    for (const extension of MODULE_EXTENSIONS) {
      const path = `${dir}/stages/${name}${extension}`;

      if (yield* fs.exists(path)) {
        return Option.some<StageModule>({ kind: "effect", path });
      }
    }

    const path = `${dir}/stages/${name}`;

    if (yield* fs.exists(path)) {
      return Option.some<StageModule>({ kind: "shell", path });
    }

    return Option.none<StageModule>();
  }).pipe(Effect.orElseSucceed(() => Option.none<StageModule>()));

// A step, in the repo's .chernabog/stages/, or, for a flow imported from a
// package, in the package's stages/ after it.
export const findStage = (configDir: string, name: string, packageDir = Option.none<string>()) =>
  Effect.gen(function* () {
    for (const dir of [configDir, ...Option.toArray(packageDir)]) {
      const found = yield* stageIn(dir, name);

      if (Option.isSome(found)) {
        return found;
      }
    }

    return Option.none<StageModule>();
  });

export const loadStage = (path: string) =>
  importDefault(path, StageDefinition, "defineStage({ input, output, run })");
