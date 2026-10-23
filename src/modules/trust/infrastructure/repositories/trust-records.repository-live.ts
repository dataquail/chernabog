// Trust records in trust.json under the chernabog home, which only approving
// a tree writes. Each read is afresh, since the CLI writes it and the daemon
// reads it; a save rewrites the file with the one record replaced.

import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import * as Schema from 'effect/Schema';

import { Home, homePaths } from '../../../../config.ts';
import { PersistenceFailed } from '../../../../kernel/persistence.errors.ts';
import { type RepoSlug } from '../../../../kernel/repo-slug.id.ts';
import { TrustRecordsRepository } from '../../domain/ports/repositories/trust-records.repository.ts';
import { type TrustRecordRoot } from '../../domain/trust-record/trust-record.root.ts';
import { toEntry, toRoot, TrustFile } from './trust-record.mapper.ts';

export const TrustRecordsRepositoryLive = Layer.effect(
  TrustRecordsRepository,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    const file = homePaths(home.root).trust;

    // A trust.json that's missing or doesn't parse trusts nothing.
    const readAll = Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return Record.empty<string, TrustFile[string]>();

      return Option.getOrElse(Schema.decodeOption(TrustFile)(yield* fs.readFileString(file)), () => Record.empty<string, TrustFile[string]>());
    }).pipe(Effect.orElseSucceed(() => Record.empty<string, TrustFile[string]>()));

    const findOne = (repo: RepoSlug) => readAll.pipe(Effect.map((records) => Option.map(Record.get(records, repo), (entry) => toRoot(repo, entry))));

    const save = (record: TrustRecordRoot) =>
      Effect.gen(function* () {
        const records = { ...(yield* readAll), [record.repo]: toEntry(record) };
        yield* fs.makeDirectory(home.root, { recursive: true });
        yield* fs.writeFileString(file, `${yield* Schema.encodeEffect(TrustFile)(records)}\n`);
      }).pipe(Effect.mapError((error) => new PersistenceFailed({ message: `trust.json: ${error.message}` })));

    return TrustRecordsRepository.of({ findOne, save });
  }),
);
