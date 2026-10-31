import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { type TrustRecordRoot } from "../../domain/trust-record/trust-record.root.ts";
import { TrustRecordsRepository } from "../../domain/trust-record/trust-records.repository.ts";

// Trust records in memory, starting from `records`.
export const TrustRecordsRepositoryFake = (records: ReadonlyArray<TrustRecordRoot>) =>
  Layer.effect(
    TrustRecordsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(records);

      return TrustRecordsRepository.of({
        findOne: (spec) =>
          Ref.get(store).pipe(Effect.map((stored) => Option.fromUndefinedOr(stored.find(spec)))),
        upsertOne: (record: TrustRecordRoot) =>
          Ref.update(store, (stored) => [
            ...stored.filter((known) => known.repo !== record.repo),
            record,
          ]),
      });
    }),
  );
