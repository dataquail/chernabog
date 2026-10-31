// Trust records in trust.json under the chernabog home, which only approving
// a tree writes. Each read is afresh, since the CLI writes it and the daemon
// reads it; a save rewrites the file with the one record replaced.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../../kernel/persistence.errors.ts";
import { type Specification } from "../../../../kernel/specification.ts";
import { updateFile } from "../../../../platform/file-lock.ts";
import { Home, homePaths } from "../../../../platform/home.ts";
import { type TrustRecordRoot } from "../../domain/trust-record/trust-record.root.ts";
import { TrustRecordsRepository } from "../../domain/trust-record/trust-records.repository.ts";
import { toEntry, toRoot, TrustFile } from "./trust-record.mapper.ts";

export const TrustRecordsRepositoryLive = Layer.effect(
  TrustRecordsRepository,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    const file = homePaths(home.root).trust;

    // A trust.json that's missing or doesn't parse trusts nothing.
    const recordsIn = (text: Option.Option<string>) =>
      Option.getOrElse(Option.flatMap(text, Schema.decodeOption(TrustFile)), () =>
        Record.empty<string, TrustFile[string]>(),
      );

    const readAll = Effect.gen(function* () {
      if (!(yield* fs.exists(file))) {
        return Record.empty<string, TrustFile[string]>();
      }

      return recordsIn(Option.some(yield* fs.readFileString(file)));
    }).pipe(Effect.orElseSucceed(() => Record.empty<string, TrustFile[string]>()));

    const findOne = (spec: Specification<TrustRecordRoot>) =>
      readAll.pipe(
        Effect.map((records) =>
          Arr.findFirst(
            Object.entries(records).map(([slug, entry]) => toRoot(slug, entry)),
            spec,
          ),
        ),
      );

    // Under trust.json's lock, so two repos trusted at once both stay trusted.
    const upsertOne = (record: TrustRecordRoot) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(home.root, { recursive: true });
        yield* updateFile(fs, file, "trusting a repo", (text) =>
          Effect.gen(function* () {
            const records = { ...recordsIn(text), [record.repo]: toEntry(record) };

            return [
              record.repo,
              Option.some(`${yield* Schema.encodeEffect(TrustFile)(records)}\n`),
            ] as const;
          }),
        );
      }).pipe(
        Effect.mapError(
          (error) => new PersistenceFailed({ message: `trust.json: ${error.message}` }),
        ),
      );

    return TrustRecordsRepository.of({ findOne, upsertOne });
  }),
);
