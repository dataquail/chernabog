import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { FlowImportsRepository } from "../../domain/ports/repositories/flow-imports.repository.ts";

// Imports in memory, by `${root}/${flow}`, in `imports`, which saving writes
// to as well, so a test reads back what it saved.
export const FlowImportsRepositoryFake = (imports: Map<string, string>) =>
  Layer.succeed(
    FlowImportsRepository,
    FlowImportsRepository.of({
      findAll: (root) =>
        Effect.sync(
          () =>
            new Map(
              [...imports].flatMap(([key, from]) =>
                Option.toArray(
                  Option.as(
                    Option.liftPredicate(key, (found) => found.startsWith(`${root}/`)),
                    [key.slice(root.length + 1), from] as const,
                  ),
                ),
              ),
            ),
        ),
      save: (root, flow, from) =>
        Effect.sync(() => {
          Option.match(from, {
            onSome: (named) => imports.set(`${root}/${flow}`, named),
            onNone: () => imports.delete(`${root}/${flow}`),
          });
        }),
    }),
  );
