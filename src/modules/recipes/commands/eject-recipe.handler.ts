import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { FlowImportSpecifications } from "../domain/flow-import/flow-import.specification.ts";
import { FlowImportsRepository } from "../domain/flow-import/flow-imports.repository.ts";
import { ChernabogDirClient } from "../domain/ports/clients/chernabog-dir.client.ts";
import { RecipePackagesClient } from "../domain/ports/clients/recipe-packages.client.ts";
import { FlowNotImported, RecipeFilesFailed } from "../domain/recipe/recipe.errors.ts";
import { RecipeRootOps } from "../domain/recipe/recipe.root-ops.ts";
import { type CopiedRecord, withCopied } from "../domain/recipe/repo-manifest.value-object.ts";
import { type EjectRecipePayload, RecipeEjected } from "./eject-recipe.command.ts";

const MANIFEST = ".chernabog/package.json";

export const ejectRecipeHandler = Effect.fn("ejectRecipeHandler")(
  function* (cmd: EjectRecipePayload) {
    const { flow, root } = cmd;
    const dir = yield* ChernabogDirClient;
    const packages = yield* RecipePackagesClient;
    const imports = yield* FlowImportsRepository;

    const current = yield* imports
      .findMany(FlowImportSpecifications.inCheckout(root))
      .pipe(Effect.mapError((error) => new RecipeFilesFailed({ message: error.message })));

    const flowImport = yield* Effect.fromOption(
      Arr.findFirst(current, FlowImportSpecifications.forFlow(flow)),
    ).pipe(
      Effect.mapError(
        () => new FlowNotImported({ flow, imported: current.map((each) => each.flow) }),
      ),
    );

    const { from } = flowImport;

    yield* packages.restore(root);

    const recipe = yield* Effect.fromResult(
      RecipeRootOps.named(yield* packages.installed(root), from),
    );

    const extension = Option.getOrElse(
      Option.fromNullishOr(/\.\w+$/.exec(recipe.flow)?.[0]),
      () => ".ts",
    );

    const copies = [
      [recipe.flow, `flows/${flow}${extension}`] as const,
      ...[...recipe.prompts, ...recipe.stages].map((file) => [file, file] as const),
    ];

    const files: Array<(typeof RecipeEjected.Type.files)[number]> = [];
    const records: Record<string, Option.Option<CopiedRecord>> = {};
    const ref = RecipeRootOps.refOf(recipe);

    for (const [source, target] of copies) {
      const path = `.chernabog/${target}`;

      if (Option.isSome(yield* dir.read(root, path))) {
        files.push({ file: path, recipe: ref, version: recipe.version, outcome: "kept" });
        continue;
      }

      const text = yield* Effect.fromOption(
        yield* packages.file(root, recipe.package, source),
      ).pipe(
        Effect.mapError(
          () =>
            new RecipeFilesFailed({
              message: `${recipe.package}@${recipe.version} names ${source} for ${recipe.name}, and hasn't it`,
            }),
        ),
      );

      yield* dir.write(root, path, text);
      records[target] = Option.some({
        from: `${recipe.package}/${recipe.name}`,
        version: recipe.version,
        ...Option.match(
          Option.liftPredicate(source, (file) => file !== target),
          {
            onNone: () => ({}),
            onSome: (file) => ({ file }),
          },
        ),
      });
      files.push({ file: path, recipe: ref, version: recipe.version, outcome: "wrote" });
    }

    const manifest = Option.getOrElse(yield* dir.read(root, MANIFEST), () => "{}\n");
    yield* dir.write(root, MANIFEST, yield* Effect.fromResult(withCopied(manifest, records)));
    yield* imports
      .deleteOne(flowImport)
      .pipe(Effect.mapError((error) => new RecipeFilesFailed({ message: error.message })));

    return RecipeEjected.make({ flow, recipe: ref, version: recipe.version, files });
  },
  withUnitOfWork,
  // Its stores are files on this machine: they have no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
