// The flows a checkout imports, in its .chernabog/config.yaml, edited in
// place so the team's comments and other keys stay as they are.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import YAML from "yaml";

import { updateFile } from "../../../../platform/file-lock.ts";
import { FlowImportsRepository } from "../../domain/ports/repositories/flow-imports.repository.ts";
import { RecipeFilesFailed } from "../../domain/recipe/recipe.errors.ts";

const configOf = (root: string) => `${root}/.chernabog/config.yaml`;

const failed = (error: { readonly message: string }) =>
  new RecipeFilesFailed({ message: `.chernabog/config.yaml: ${error.message}` });

// Each flow's `from` in a config.yaml's text.
const importsIn = (text: string) => {
  const flows = YAML.parseDocument(text).get("flows");
  const found = new Map<string, string>();

  if (!YAML.isMap(flows)) {
    return found;
  }

  for (const pair of flows.items) {
    if (YAML.isScalar(pair.key) && YAML.isMap(pair.value)) {
      const from: unknown = pair.value.get("from");

      if (Predicate.isString(from)) {
        found.set(String(pair.key.value), from);
      }
    }
  }

  return found;
};

export const FlowImportsRepositoryLive = Layer.effect(
  FlowImportsRepository,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const findAll = (root: string) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(configOf(root)))) {
          return new Map<string, string>();
        }

        return importsIn(yield* fs.readFileString(configOf(root)));
      }).pipe(Effect.mapError(failed));

    const save = (root: string, flow: string, from: Option.Option<string>) =>
      updateFile(fs, configOf(root), "importing a flow", (current) =>
        Effect.sync(() => {
          const document = YAML.parseDocument(Option.getOrElse(current, () => ""));

          Option.match(from, {
            onSome: (named) => {
              document.setIn(["flows", flow, "from"], named);
            },
            onNone: () => {
              document.deleteIn(["flows", flow, "from"]);
              const left = document.getIn(["flows", flow]);

              // A flow with nothing else set goes, rather than stay as `name: {}`.
              if (YAML.isMap(left) && left.items.length === 0) {
                document.deleteIn(["flows", flow]);
              }
            },
          });

          return [flow, Option.some(document.toString())] as const;
        }),
      ).pipe(Effect.asVoid, Effect.mapError(failed));

    return FlowImportsRepository.of({ findAll, save });
  }),
);
