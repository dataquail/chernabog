// The flows a checkout imports, in its .chernabog/config.yaml, edited in
// place so the team's comments and other keys stay as they are. The file is
// the checkout's, so a read finds it by the root its spec pins.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import YAML from "yaml";

import { PersistenceFailed } from "../../../../kernel/persistence.errors.ts";
import { pinnedValue, type Specification } from "../../../../kernel/specification.ts";
import { updateFile } from "../../../../platform/file-lock.ts";
import { FlowImportRoot } from "../../domain/flow-import/flow-import.root.ts";
import { FlowImportsRepository } from "../../domain/flow-import/flow-imports.repository.ts";

const configOf = (root: string) => `${root}/.chernabog/config.yaml`;

const failed = (error: { readonly message: string }) =>
  new PersistenceFailed({ message: `.chernabog/config.yaml: ${error.message}` });

// Each flow's `from` in the config.yaml's text of the checkout at `root`.
const importsIn = (root: string, text: string) => {
  const flows = YAML.parseDocument(text).get("flows");
  const found: Array<FlowImportRoot> = [];

  if (!YAML.isMap(flows)) {
    return found;
  }

  for (const pair of flows.items) {
    if (YAML.isScalar(pair.key) && YAML.isMap(pair.value)) {
      const from: unknown = pair.value.get("from");

      if (Predicate.isString(from)) {
        found.push(FlowImportRoot.make({ root, flow: String(pair.key.value), from }));
      }
    }
  }

  return found;
};

export const FlowImportsRepositoryLive = Layer.effect(
  FlowImportsRepository,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const readAll = (root: string) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(configOf(root)))) {
          return [];
        }

        return importsIn(root, yield* fs.readFileString(configOf(root)));
      }).pipe(Effect.mapError(failed));

    // A spec that names no checkout is a bug in its caller: there is no
    // listing of every checkout's imports.
    const findMany = (spec: Specification<FlowImportRoot>) =>
      Option.match(pinnedValue(spec.criteria, "root"), {
        onNone: () => Effect.die(new Error("flow imports are read by their checkout's root")),
        onSome: (root) => readAll(String(root)).pipe(Effect.map((imports) => imports.filter(spec))),
      });

    const edit = (flowImport: FlowImportRoot, from: Option.Option<string>) =>
      updateFile(fs, configOf(flowImport.root), "importing a flow", (current) =>
        Effect.sync(() => {
          const document = YAML.parseDocument(Option.getOrElse(current, () => ""));
          const { flow } = flowImport;

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

    const upsertOne = (flowImport: FlowImportRoot) =>
      edit(flowImport, Option.some(flowImport.from));

    const deleteOne = (flowImport: FlowImportRoot) => edit(flowImport, Option.none());

    return FlowImportsRepository.of({ findMany, upsertOne, deleteOne });
  }),
);
