import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { FlowImportRoot } from "../domain/flow-import/flow-import.root.ts";
import { FlowImportSpecifications } from "../domain/flow-import/flow-import.specification.ts";
import { FlowImportsRepository } from "../domain/flow-import/flow-imports.repository.ts";
import { ChernabogDirClient } from "../domain/ports/clients/chernabog-dir.client.ts";
import { RecipePackagesClient } from "../domain/ports/clients/recipe-packages.client.ts";
import { RecipeFilesFailed } from "../domain/recipe/recipe.errors.ts";
import { RecipeRootOps } from "../domain/recipe/recipe.root-ops.ts";
import {
  decodeRepoManifest,
  dependencyKind,
  withoutDependency,
} from "../domain/recipe/repo-manifest.value-object.ts";
import { type ImportRecipesPayload, RecipesImported } from "./import-recipes.command.ts";

type Imported = (typeof RecipesImported.Type.flows)[number];

const MANIFEST = ".chernabog/package.json";

// A checkout's config.yaml that couldn't be read or written.
const filesFailed = (error: { readonly message: string }) =>
  new RecipeFilesFailed({ message: error.message });

const MODULE = /\.(?:ts|js|mts|mjs)$/;

export const importRecipesHandler = Effect.fn("importRecipesHandler")(
  function* (cmd: ImportRecipesPayload) {
    const { names, root } = cmd;
    const dir = yield* ChernabogDirClient;
    const packages = yield* RecipePackagesClient;
    const imports = yield* FlowImportsRepository;

    yield* packages.restore(root);

    const recipes = yield* Effect.fromResult(
      RecipeRootOps.allNamed(yield* packages.installed(root), names),
    );

    const current = new Map(
      (yield* imports
        .findMany(FlowImportSpecifications.inCheckout(root))
        .pipe(Effect.mapError(filesFailed))).map(
        ({ flow, from }) => [flow, RecipeRootOps.fullRef(from)] as const,
      ),
    );

    const local = (yield* dir.list(root, ".chernabog/flows")).filter((file) => MODULE.test(file));
    const flows: Array<Imported> = [];

    for (const recipe of recipes) {
      const from = `${recipe.package}/${recipe.name}`;

      const said = {
        flow: recipe.name,
        recipe: RecipeRootOps.refOf(recipe),
        version: recipe.version,
      };

      const file = Arr.findFirst(local, (each) => each.replace(MODULE, "") === recipe.name);

      const other = Option.filter(
        Option.fromUndefinedOr(current.get(recipe.name)),
        (named) => named !== from,
      );

      if (Option.isSome(file) || Option.isSome(other)) {
        flows.push({
          ...said,
          outcome: "kept",
          keptFor: Option.orElse(
            Option.map(file, (found) => `.chernabog/flows/${found}`),
            () => other,
          ),
        });
        continue;
      }

      if (current.get(recipe.name) === from) {
        flows.push({ ...said, outcome: "present", keptFor: Option.none() });
        continue;
      }

      yield* imports
        .upsertOne(FlowImportRoot.make({ root, flow: recipe.name, from }))
        .pipe(Effect.mapError(filesFailed));
      flows.push({ ...said, outcome: "imported", keptFor: Option.none() });
    }

    const dependencies: Array<string> = [];

    for (const recipe of Arr.dedupeWith(
      recipes.filter((each) =>
        flows.some((flow) => flow.flow === each.name && flow.outcome === "imported"),
      ),
      (left, right) => left.package === right.package,
    )) {
      const text = yield* Effect.fromOption(yield* dir.read(root, MANIFEST)).pipe(
        Effect.mapError(
          () =>
            new RecipeFilesFailed({
              message: ".chernabog/ has no package.json; run chernabog init",
            }),
        ),
      );

      const kind = dependencyKind(
        yield* Effect.fromResult(decodeRepoManifest(text)),
        recipe.package,
      );

      if (Option.contains(kind, "dependencies")) {
        continue;
      }

      if (Option.contains(kind, "devDependencies")) {
        yield* dir.write(
          root,
          MANIFEST,
          yield* Effect.fromResult(withoutDependency(text, recipe.package, "devDependencies")),
        );
      }

      yield* packages.install(root, recipe.package, recipe.version, "dependencies");
      dependencies.push(recipe.package);
    }

    return RecipesImported.make({ flows, dependencies });
  },
  withUnitOfWork,
  // Its stores are files on this machine: they have no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
