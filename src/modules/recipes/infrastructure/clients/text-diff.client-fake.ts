import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { TextDiffClient } from "../../domain/ports/clients/text-diff.client.ts";

// A diff that's empty when the texts match, and otherwise names both.
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
  }),
);
