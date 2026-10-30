import * as Arr from "effect/Array";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { EnrollmentQueries } from "../../../modules/enrollment/enrollment.query-handlers.ts";
import { repointRepoUseCase } from "../../../modules/enrollment/use-cases/repoint-repo.use-case.ts";
import { addRecipePackageUseCase } from "../../../modules/recipes/use-cases/add-recipe-package.use-case.ts";
import {
  OFFICIAL_PACKAGE,
  type RecipePackageAdded,
  type Scaffolded,
} from "../../../modules/recipes/use-cases/recipe.result.ts";
import { scaffoldRepoUseCase } from "../../../modules/recipes/use-cases/scaffold-repo.use-case.ts";
import { daemonReload } from "../../daemon/daemon.client.ts";
import { confirm } from "../asker.prompt.ts";
import { printLines } from "../cli.output.ts";
import { enrollFlags, enrollHere, rootOf } from "../enrollment/enroll.command.ts";
import { bakeRecipes, recipesFlag, refreshSchemas } from "./recipes.command.ts";

const describeScaffold = (scaffolded: Scaffolded) =>
  Option.match(Option.liftPredicate(scaffolded.changes, Arr.isReadonlyArrayNonEmpty), {
    onNone: () => [".chernabog/ is already set up; nothing written"],
    onSome: (changes) =>
      changes.map(({ change, entries, path }) => {
        switch (change) {
          case "written": {
            return `wrote ${path}`;
          }

          case "updated": {
            return `wrote ${path} (updated)`;
          }

          case "ignored": {
            return `wrote ${path} (+ ${entries.join(", ")})`;
          }
        }
      }),
  });

const describePackage = (added: RecipePackageAdded) =>
  Option.toArray(
    Option.liftPredicate(
      `added ${added.package} ${added.version} to .chernabog/package.json, for its recipes`,
      () => added.change === "added",
    ),
  );

const suffix = (value: Option.Option<string>, prefix: string) =>
  Option.match(value, { onNone: () => "", onSome: (text) => `${prefix}${text}` });

// A checkout that moved: its entry in machine config still names where it
// was. Offers to point the entry here, settings and all, and says whether any
// such entry was left where it was.
const offerRepoint = (root: string) =>
  Effect.gen(function* () {
    const { repos } = yield* (yield* EnrollmentQueries).ListMovedReposQuery({ root });
    let declined = false;

    for (const entry of repos) {
      if (
        !(yield* confirm(
          `${entry.name} (${entry.repo}) is enrolled at ${entry.path}, which is gone. Point it here, keeping its settings?`,
        ))
      ) {
        yield* Console.log(
          `${entry.name} is enrolled at ${entry.path}, which is gone; chernabog enroll${suffix(entry.named, " --name ")} here points it here, keeping its settings`,
        );
        declined = true;
        continue;
      }

      yield* repointRepoUseCase(entry.path, root);
      yield* Console.log(`pointed ${entry.name} at ${root}`);
      yield* daemonReload.pipe(Effect.ignore);
    }

    return declined;
  });

export const initCommand = Command.make(
  "init",
  { path: Argument.String("path").pipe(Argument.optional), recipes: recipesFlag, ...enrollFlags },
  ({ path, recipes, ...flags }) =>
    Effect.gen(function* () {
      const root = yield* rootOf(path);

      yield* printLines(describeScaffold(yield* scaffoldRepoUseCase(root)));
      // The recipes init offers.
      yield* printLines(describePackage(yield* addRecipePackageUseCase(root, OFFICIAL_PACKAGE)));
      yield* printLines(yield* bakeRecipes(root, recipes));
      // config.schema.json again, describing the settings of the recipes it added.
      yield* printLines(yield* refreshSchemas(root));

      // Enrolling would point a moved entry here after all, so a checkout that
      // isn't the moved one enrolls only under a name of its own.
      if ((yield* offerRepoint(root)) && Option.isNone(flags.name)) {
        yield* Console.log(
          "Not enrolled: to run this checkout alongside the one that moved, chernabog enroll --name <another name> here",
        );

        return;
      }

      // Enrolling chooses among the repo's flows, so a repo with none waits for one.
      yield* enrollHere(root, flags).pipe(
        Effect.flatMap((repo) =>
          Console.log(
            `Next: commit .chernabog/ if it's new and merge it to the base branch, then chernabog trust ${repo.name}.`,
          ),
        ),
        Effect.catchTag("NoFlows", () =>
          Console.log(
            "Not enrolled: .chernabog/flows/ has no flows. Add recipes with chernabog recipes add (chernabog recipes list names them), or write a flow, then chernabog enroll here.",
          ),
        ),
      );
    }),
).pipe(
  Command.withDescription(
    "Scaffold .chernabog/ in a repo, install @chernabog/recipes there and copy the recipes you choose, enroll it on this machine, and point a moved checkout's settings at it",
  ),
);
