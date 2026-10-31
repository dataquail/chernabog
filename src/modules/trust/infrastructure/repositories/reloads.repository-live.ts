// Reloads in reloaded.json under the chernabog home, which only the daemon
// writes, just before it exits to restart.

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
import { type ReloadRoot } from "../../domain/reload/reload.root.ts";
import { ReloadsRepository } from "../../domain/reload/reloads.repository.ts";
import { ReloadedFile, toRoot } from "./reload.mapper.ts";

export const ReloadsRepositoryLive = Layer.effect(
  ReloadsRepository,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    const file = homePaths(home.root).reloaded;

    // A reloaded.json that's missing or doesn't parse has none.
    const reloadsIn = (text: Option.Option<string>) =>
      Option.getOrElse(Option.flatMap(text, Schema.decodeOption(ReloadedFile)), () =>
        Record.empty<string, string>(),
      );

    const readAll = Effect.gen(function* () {
      if (!(yield* fs.exists(file))) {
        return Record.empty<string, string>();
      }

      return reloadsIn(Option.some(yield* fs.readFileString(file)));
    }).pipe(Effect.orElseSucceed(() => Record.empty<string, string>()));

    const findOne = (spec: Specification<ReloadRoot>) =>
      readAll.pipe(
        Effect.map((reloads) =>
          Arr.findFirst(
            Object.entries(reloads).map(([slug, tree]) => toRoot(slug, tree)),
            spec,
          ),
        ),
      );

    const upsertOne = (record: ReloadRoot) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(home.root, { recursive: true });
        yield* updateFile(fs, file, "recording a restart", (text) =>
          Effect.gen(function* () {
            const reloads = { ...reloadsIn(text), [record.repo]: record.tree };

            return [
              record.repo,
              Option.some(`${yield* Schema.encodeEffect(ReloadedFile)(reloads)}\n`),
            ] as const;
          }),
        );
      }).pipe(
        Effect.mapError(
          (error) => new PersistenceFailed({ message: `reloaded.json: ${error.message}` }),
        ),
      );

    return ReloadsRepository.of({ findOne, upsertOne });
  }),
);
