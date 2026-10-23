// Enrolled repos as this machine stores them: each one's entry in machine
// config (~/.config/chernabog/config.yaml), which a person edits by hand, and
// whether it's paused in paused.json, by slug, which only chernabog writes.
//
// The daemon, the CLI and the person's editor all write machine config, so
// `findAll` reads both files afresh every time. The aggregate is one entry, the
// file is the storage boundary: `save` edits the entry in place, keeping the
// file's comments, and writes machine config only when the entry changed, so
// pausing a repo never rewrites a hand-edited file.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../../kernel/persistence.errors.ts";
import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { updateFile } from "../../../../platform/file-lock.ts";
import { Home, homePaths } from "../../../../platform/home.ts";
import { editMachineConfig, entryFor, loadMachineConfig } from "../../../../repo-config.ts";
import { type EnrolledRepoRoot } from "../../domain/enrolled-repo/enrolled-repo.root.ts";
import { EnrolledReposRepository } from "../../domain/ports/repositories/enrolled-repos.repository.ts";
import { addEntry, applyEntry, sameEntry, toEntry, toRoot } from "./enrolled-repo.mapper.ts";

const PausedFile = Schema.fromJsonString(Schema.Array(RepoSlug));

const failed = (error: { readonly message: string }) =>
  new PersistenceFailed({ message: error.message });

export const EnrolledReposRepositoryLive = Layer.effect(
  EnrolledReposRepository,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    const services = yield* Effect.context<FileSystem.FileSystem | Home>();
    const pausedPath = homePaths(home.root).paused;

    // A paused.json that's missing or doesn't parse pauses nothing.
    const pausedIn = (text: Option.Option<string>) =>
      Option.getOrElse(
        Option.flatMap(text, Schema.decodeOption(PausedFile)),
        (): ReadonlyArray<RepoSlug> => [],
      );

    const readPaused = Effect.gen(function* () {
      if (!(yield* fs.exists(pausedPath))) {
        return [];
      }

      return pausedIn(Option.some(yield* fs.readFileString(pausedPath)));
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<RepoSlug> => []));

    // Pauses or resumes the repo, under paused.json's lock.
    const savePaused = (repo: EnrolledRepoRoot) =>
      updateFile(fs, pausedPath, "pausing repos", (text) =>
        Effect.gen(function* () {
          const paused = pausedIn(text);

          if (paused.includes(repo.repo) === repo.paused) {
            return [repo.repo, Option.none<string>()] as const;
          }

          const slugs = Arr.appendAll(
            paused.filter((slug) => slug !== repo.repo),
            Option.toArray(Option.liftPredicate(repo.repo, () => repo.paused)),
          );

          return [
            repo.repo,
            Option.some(
              `${yield* Schema.encodeEffect(PausedFile)(Arr.sort(slugs, Order.String))}\n`,
            ),
          ] as const;
        }),
      ).pipe(Effect.mapError(failed));

    const findAll = Effect.gen(function* () {
      const machine = yield* loadMachineConfig;
      const paused = yield* readPaused;

      return machine.repos.map((entry) =>
        toRoot(entry, paused.includes(RepoSlug.make(entry.repo))),
      );
    }).pipe(Effect.mapError(failed), Effect.provideContext(services));

    const saveEntry = (repo: EnrolledRepoRoot) =>
      Effect.gen(function* () {
        const found = yield* entryFor((yield* loadMachineConfig).repos, toEntry(repo));

        if (Option.exists(found, ({ entry }) => sameEntry(toRoot(entry, repo.paused), repo))) {
          return;
        }

        yield* editMachineConfig((document, current) =>
          Effect.gen(function* () {
            const now = yield* entryFor(current.repos ?? [], toEntry(repo));

            if (Option.isNone(now)) {
              addEntry(document, repo);

              return;
            }

            applyEntry(document, now.value.index, toRoot(now.value.entry, repo.paused), repo);
          }),
        );
      }).pipe(Effect.mapError(failed), Effect.provideContext(services));

    const remove = (repo: EnrolledRepoRoot) =>
      editMachineConfig((document, current) =>
        Effect.gen(function* () {
          for (const { index } of Option.toArray(
            yield* entryFor(current.repos ?? [], toEntry(repo)),
          )) {
            document.deleteIn(["repos", index]);
          }
        }),
      ).pipe(Effect.mapError(failed), Effect.provideContext(services));

    const save = (repo: EnrolledRepoRoot) =>
      Effect.gen(function* () {
        yield* saveEntry(repo);
        yield* savePaused(repo);
      });

    return EnrolledReposRepository.of({ findAll, save, remove });
  }),
);
