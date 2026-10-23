import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Ref from 'effect/Ref';

import { type RepoSlug } from '../../../../kernel/repo-slug.id.ts';
import { TrustRecordsRepository } from '../../domain/ports/repositories/trust-records.repository.ts';
import { type TrustRecordRoot } from '../../domain/trust-record/trust-record.root.ts';

// Trust records in memory, starting from `records`.
export const TrustRecordsRepositoryFake = (records: ReadonlyArray<TrustRecordRoot>) =>
  Layer.effect(
    TrustRecordsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(records);

      return TrustRecordsRepository.of({
        findOne: (repo: RepoSlug) => Ref.get(store).pipe(Effect.map((stored) => Option.fromUndefinedOr(stored.find((record) => record.repo === repo)))),
        save: (record: TrustRecordRoot) => Ref.update(store, (stored) => [...stored.filter((known) => known.repo !== record.repo), record]),
      });
    }),
  );
