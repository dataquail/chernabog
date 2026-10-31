import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { samePersona } from "../../../../kernel/persona.value-object.ts";
import { HoldsRepository } from "../../domain/holds/holds.repository.ts";
import { type HoldsRoot } from "../../domain/holds/holds.root.ts";

const sameFlow = (one: HoldsRoot, other: HoldsRoot) =>
  one.repo === other.repo && one.flow === other.flow && samePersona(one.persona, other.persona);

// Holds in memory, starting from `holds`.
export const HoldsRepositoryFake = (holds: ReadonlyArray<HoldsRoot>) =>
  Layer.effect(
    HoldsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(holds);

      return HoldsRepository.of({
        findMany: (spec) =>
          Ref.get(store).pipe(
            Effect.map((stored) => stored.filter((flow) => flow.items.length > 0 && spec(flow))),
          ),
        upsertOne: (saving: HoldsRoot) =>
          Ref.update(store, (stored) => [
            ...stored.filter((flow) => !sameFlow(flow, saving)),
            saving,
          ]),
      });
    }),
  );
