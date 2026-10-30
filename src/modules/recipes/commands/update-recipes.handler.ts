import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import { ChernabogDirClient } from "../domain/ports/clients/chernabog-dir.client.ts";
import { RecipePackagesClient } from "../domain/ports/clients/recipe-packages.client.ts";
import { TextDiffClient } from "../domain/ports/clients/text-diff.client.ts";
import { planCopyUpdate, type Unrecorded } from "../domain/recipe/copy-update.value-object.ts";
import { RecipeFilesFailed } from "../domain/recipe/recipe.errors.ts";
import { type RecipeRoot } from "../domain/recipe/recipe.root.ts";
import { type Copy, RecipeRootOps } from "../domain/recipe/recipe.root-ops.ts";
import { SDK_PACKAGE } from "../domain/recipe/recipe-package.value-object.ts";
import {
  copiedOf,
  type CopiedRecord,
  decodeRepoManifest,
  dependencyKind,
  type RepoManifest,
  sdkVersionOf,
  withCopied,
} from "../domain/recipe/repo-manifest.value-object.ts";
import { RecipesUpdated, type UpdateRecipesPayload } from "./update-recipes.command.ts";

type Change = (typeof RecipesUpdated.Type.changes)[number];

type Move = (typeof RecipesUpdated.Type.packages)[number];

const MANIFEST = ".chernabog/package.json";

const readManifest = (root: string) =>
  Effect.gen(function* () {
    const dir = yield* ChernabogDirClient;

    const text = yield* Effect.fromOption(yield* dir.read(root, MANIFEST)).pipe(
      Effect.mapError(
        () =>
          new RecipeFilesFailed({ message: ".chernabog/ has no package.json; run chernabog init" }),
      ),
    );

    return { text, manifest: yield* Effect.fromResult(decodeRepoManifest(text)) };
  });

// Moves each installed recipe package to the newest version whose SDK range
// includes `sdk`, in the list that declares it.
const movePackages = (root: string, manifest: RepoManifest, sdk: string) =>
  Effect.gen(function* () {
    const packages = yield* RecipePackagesClient;
    const moves: Array<Move> = [];

    for (const found of yield* packages.installed(root)) {
      const newest = Option.filter(
        yield* packages.newestFor(root, found.name, sdk),
        (version) => version !== found.version,
      );

      for (const [version, kind] of Option.toArray(
        Option.zipWith(
          newest,
          dependencyKind(manifest, found.name),
          (to, list) => [to, list] as const,
        ),
      )) {
        yield* packages.install(root, found.name, version, kind);
        moves.push({ name: found.name, from: found.version, to: version });
      }
    }

    return moves;
  });

// Brings one copied file to its recipe's installed version; what it did, and
// the file's new record, if either changed.
const updateFile = (
  root: string,
  { file, packageFile, recipe }: Copy,
  record: Option.Option<CopiedRecord>,
  unrecorded: Unrecorded,
) =>
  Effect.gen(function* () {
    const dir = yield* ChernabogDirClient;
    const packages = yield* RecipePackagesClient;
    const differ = yield* TextDiffClient;
    const path = `.chernabog/${file}`;

    const target: CopiedRecord = {
      from: `${recipe.package}/${recipe.name}`,
      version: recipe.version,
      ...Option.match(
        Option.liftPredicate(packageFile, (found) => found !== file),
        {
          onNone: () => ({}),
          onSome: (found) => ({ file: found }),
        },
      ),
    };

    const theirs = yield* packages.file(root, recipe.package, packageFile);

    if (Option.isNone(theirs)) {
      return Option.none();
    }

    const ours = yield* dir.read(root, path);
    const plan = planCopyUpdate({ ours, theirs: theirs.value, record, target, unrecorded });

    const changed = (change: Change["change"], text: Option.Option<string>) =>
      Effect.gen(function* () {
        for (const written of Option.toArray(text)) {
          yield* dir.write(root, path, written);
        }

        return Option.some({
          record: target,
          change: Option.some<Change>({
            file: path,
            recipe: RecipeRootOps.refOf(recipe),
            from: Option.map(record, (found) => found.version),
            to: recipe.version,
            change,
          }),
        });
      });

    switch (plan) {
      case "unchanged": {
        return Option.none();
      }

      case "record": {
        return Option.some({ record: target, change: Option.none<Change>() });
      }

      case "written":
      case "replaced": {
        return yield* changed(plan, theirs);
      }

      case "adopted": {
        return yield* changed(plan, Option.none());
      }

      case "merge": {
        const base = yield* Option.match(record, {
          onNone: () => Effect.succeed(Option.none<string>()),
          onSome: (found) => packages.fileAt(root, recipe.package, found.version, packageFile),
        });

        if (Option.isSome(ours) && Option.contains(base, ours.value)) {
          return yield* changed("updated", theirs);
        }

        const merged = yield* differ.merge(
          file,
          Option.getOrElse(base, () => ""),
          Option.getOrElse(ours, () => ""),
          theirs.value,
        );

        return yield* changed(
          Option.getOrElse(
            Option.as(
              Option.liftPredicate(merged, (found) => found.conflicts),
              "conflicted" as const,
            ),
            () => "merged" as const,
          ),
          Option.some(merged.text),
        );
      }
    }
  });

export const updateRecipesHandler = Effect.fn("updateRecipesHandler")(function* (
  cmd: UpdateRecipesPayload,
) {
  const { names, root, unrecorded } = cmd;
  const dir = yield* ChernabogDirClient;
  const packages = yield* RecipePackagesClient;

  yield* packages.restore(root);

  const before = yield* readManifest(root);

  const sdk = yield* Effect.fromOption(sdkVersionOf(before.manifest)).pipe(
    Effect.mapError(
      () =>
        new RecipeFilesFailed({
          message: `.chernabog/package.json doesn't pin ${SDK_PACKAGE}; run chernabog recipes upgrade`,
        }),
    ),
  );

  const moves = yield* movePackages(root, before.manifest, sdk);
  const installed = yield* packages.installed(root);
  // bun rewrote package.json if it installed anything, so it's read again.
  const { manifest, text } = yield* readManifest(root);
  const records = copiedOf(manifest);
  const flows = (yield* dir.list(root, ".chernabog/flows")).map((entry) => `flows/${entry}`);

  const named = yield* Option.match(
    Option.liftPredicate(names, (some) => some.length > 0),
    {
      onSome: (some) => Effect.asSome(Effect.fromResult(RecipeRootOps.allNamed(installed, some))),
      onNone: () => Effect.succeed(Option.none<ReadonlyArray<RecipeRoot>>()),
    },
  );

  const changes: Array<Change> = [];
  const recorded: Record<string, Option.Option<CopiedRecord>> = {};

  // Only what the repo copied: a named recipe it hasn't is left for recipes add.
  const copies = RecipeRootOps.copiesIn(
    installed,
    records,
    (file) => flows.includes(file),
    named,
  ).filter((copy) => flows.includes(copy.recipe.flow) || Record.has(records, copy.file));

  for (const copy of copies) {
    for (const updated of Option.toArray(
      yield* updateFile(root, copy, Record.get(records, copy.file), unrecorded),
    )) {
      recorded[copy.file] = Option.some(updated.record);

      for (const change of Option.toArray(updated.change)) {
        changes.push(change);
      }
    }
  }

  if (!Record.isEmptyRecord(recorded)) {
    yield* dir.write(root, MANIFEST, yield* Effect.fromResult(withCopied(text, recorded)));
  }

  return RecipesUpdated.make({ packages: moves, changes });
});
