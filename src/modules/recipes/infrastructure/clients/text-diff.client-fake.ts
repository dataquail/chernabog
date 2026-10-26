import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { TextDiffClient } from "../../domain/ports/clients/text-diff.client.ts";

// A diff that's empty when the texts match, and otherwise names both; and a
// merge that takes the recipe's side where the repo's is the base, the repo's
// where the recipe's is, and otherwise conflicts, holding all three.
export const TextDiffClientFake = Layer.succeed(
  TextDiffClient,
  TextDiffClient.of({
    diff: (file, recipe, repo) =>
      Effect.succeed(
        Option.getOrElse(
          Option.map(
            Option.liftPredicate(file, () => recipe !== repo),
            (named) => `-${recipe.trimEnd()}\n+${repo.trimEnd()} (${named})`,
          ),
          () => "",
        ),
      ),
    merge: (_file, base, repo, recipe) => {
      if (repo === base || repo === recipe) {
        return Effect.succeed({ text: recipe, conflicts: false });
      }

      if (recipe === base) {
        return Effect.succeed({ text: repo, conflicts: false });
      }

      return Effect.succeed({ text: `<${repo}|${base}|${recipe}>`, conflicts: true });
    },
  }),
);
