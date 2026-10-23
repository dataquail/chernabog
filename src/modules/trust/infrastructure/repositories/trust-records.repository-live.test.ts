import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effectAtHome } from "../../../../../test/effect-test.ts";
import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { Home, homePaths } from "../../../../platform/home.ts";
import { TrustRecordsRepository } from "../../domain/ports/repositories/trust-records.repository.ts";
import { TrustRecordRoot } from "../../domain/trust-record/trust-record.root.ts";
import { TrustRecordsRepositoryLive } from "./trust-records.repository-live.ts";

const demo = RepoSlug.make("dataquail/demo");
const other = RepoSlug.make("dataquail/other");

const opened = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = homePaths((yield* Home).root).trust;

  return { fs, file, records: yield* TrustRecordsRepository };
}).pipe(Effect.provide(TrustRecordsRepositoryLive));

describe("TrustRecordsRepositoryLive", () => {
  effectAtHome("saves a record by slug and reads it back, keeping the others", () =>
    Effect.gen(function* () {
      const { file, fs, records } = yield* opened;
      yield* records.save(
        TrustRecordRoot.make({ repo: other, tree: "cccc", at: "2026-10-01T00:00:00.000Z" }),
      );
      yield* records.save(
        TrustRecordRoot.make({ repo: demo, tree: "aaaa", at: "2026-10-22T00:00:00.000Z" }),
      );

      expect(yield* records.findOne(demo)).toEqual(
        Option.some(
          TrustRecordRoot.make({ repo: demo, tree: "aaaa", at: "2026-10-22T00:00:00.000Z" }),
        ),
      );
      expect(Option.map(yield* records.findOne(other), (record) => record.tree)).toEqual(
        Option.some("cccc"),
      );
      expect(yield* fs.readFileString(file)).toBe(
        '{\n  "dataquail/other": {\n    "tree": "cccc",\n    "at": "2026-10-01T00:00:00.000Z"\n  },\n  "dataquail/demo": {\n    "tree": "aaaa",\n    "at": "2026-10-22T00:00:00.000Z"\n  }\n}\n',
      );
    }),
  );

  effectAtHome("trusts nothing when trust.json is missing or does not parse", () =>
    Effect.gen(function* () {
      const { file, fs, records } = yield* opened;

      expect(yield* records.findOne(demo)).toEqual(Option.none());

      yield* fs.writeFileString(file, "{ not json");
      expect(yield* records.findOne(demo)).toEqual(Option.none());
    }),
  );
});
