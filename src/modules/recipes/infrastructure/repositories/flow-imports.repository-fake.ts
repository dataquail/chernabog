import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { type FlowImportRoot } from "../../domain/flow-import/flow-import.root.ts";
import { FlowImportsRepository } from "../../domain/flow-import/flow-imports.repository.ts";

const same = (left: FlowImportRoot, right: FlowImportRoot) =>
  left.root === right.root && left.flow === right.flow;

// Imports in memory, starting from `imports`; one per checkout and flow.
export const FlowImportsRepositoryFake = (imports: ReadonlyArray<FlowImportRoot>) =>
  Layer.effect(
    FlowImportsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(imports);

      return FlowImportsRepository.of({
        findMany: (spec) => Ref.get(store).pipe(Effect.map((stored) => stored.filter(spec))),
        upsertOne: (flowImport) =>
          Ref.update(store, (stored) => {
            if (!stored.some((known) => same(known, flowImport))) {
              return [...stored, flowImport];
            }

            return stored.map((known) =>
              Option.getOrElse(
                Option.liftPredicate(flowImport, () => same(known, flowImport)),
                () => known,
              ),
            );
          }),
        deleteOne: (flowImport) =>
          Ref.update(store, (stored) => stored.filter((known) => !same(known, flowImport))),
      });
    }),
  );
