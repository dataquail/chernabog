// What a cancelled run held, cleaned up as its persona: the worktrees its
// item's flow keeps, by the SDK's names for them; its claim on its issue, as
// the issue's claim marker records it; and its agent sessions, by the handle
// each launch recorded, never by a process's name.

import {
  claimMarker,
  Git,
  GitHub,
  latestMarker,
  Repo,
  type SetupError,
  Worktree,
} from "@chernabog/sdk";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { type Persona } from "../../../../kernel/persona.value-object.ts";
import type { Exec } from "../../../../platform/exec.ts";
import { Home } from "../../../../platform/home.ts";
import {
  type KeptWorktree,
  type OpenSession,
  type ReleasedClaim,
  RunCleanupClient,
} from "../../domain/ports/clients/run-cleanup.client.ts";
import { CleanupFailed } from "../../domain/run/run.errors.ts";
import { type RunRoot } from "../../domain/run/run.root.ts";
import { itemTarget } from "../../domain/run/work-item.value-object.ts";
import { knownLaunch, sessionFiles } from "../runtime/agents/session-files.ts";
import { runSessions } from "../runtime/agents/sessions.ts";
import { launcherFor } from "../runtime/launchers.ts";

// What cleaning up uses of a persona's services.
type CleanupServices = GitHub | Repo | Git | Worktree;

// The services a persona's runs of a repo use, which fail with the setup
// error that stops it acting: none for a persona the repo no longer has.
export type CleanupServicesFor = (
  repo: string,
  persona: Persona,
) => Option.Option<Effect.Effect<Context.Context<CleanupServices>, SetupError>>;

const commits = (count: number) => {
  if (count === 1) {
    return "1 commit";
  }

  return `${count} commits`;
};

const failed = (error: { readonly message: string }) =>
  new CleanupFailed({ message: error.message });

// The names the SDK gives the worktrees of a run's item: the claim branch of
// an issue, and the review checkout of a pull request.
const worktreeNames = (run: RunRoot) =>
  Option.match(itemTarget(run.itemKey), {
    onNone: (): ReadonlyArray<string> => [],
    onSome: (target) => {
      if (target.kind === "issue") {
        return [`auto/issue-${target.number}`];
      }

      return [`review-pr-${target.number}`];
    },
  });

// Why a worktree holds work a person may want, if it does: uncommitted
// changes, or on a branch, commits no remote has.
const workIn = (path: string) =>
  Effect.gen(function* () {
    const git = yield* Git;
    const changes = (yield* git.run(["status", "--porcelain"], path)).trim();

    if (changes.length > 0) {
      return Option.some("it has uncommitted changes");
    }

    // A detached checkout, such as a review's, holds the pull request's
    // commits, which may no longer be on any remote once its branch is gone.
    const onBranch = yield* git.run(["symbolic-ref", "-q", "HEAD"], path).pipe(Effect.result);

    if (Result.isFailure(onBranch)) {
      return Option.none<string>();
    }

    const unpushed = Number(
      (yield* git.run(["rev-list", "--count", "HEAD", "--not", "--remotes"], path)).trim(),
    );

    return Option.liftPredicate(`it has ${commits(unpushed)} not pushed`, () => unpushed > 0);
  });

const Compare = Schema.Struct({ ahead_by: Schema.Finite });

// Why the claim branch holds work, if it does: a pull request from it, or
// commits its base doesn't have.
const workOnBranch = (branch: string) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const repo = yield* Repo;
    const pull = yield* github.pullRequestForBranch(branch);

    if (Option.isSome(pull)) {
      return Option.some(`pull request #${pull.value.number} was opened from it`);
    }

    const compared = yield* github.request(
      "GET",
      `/repos/${repo.slug}/compare/${encodeURIComponent(repo.baseBranch)}...${encodeURIComponent(branch)}`,
      Option.none(),
    );

    const ahead = (yield* Schema.decodeUnknownEffect(Compare)(compared).pipe(
      Effect.mapError(failed),
    )).ahead_by;

    return Option.liftPredicate(
      `it has ${commits(ahead)} not on ${repo.baseBranch}`,
      () => ahead > 0,
    );
  });

export const RunCleanupClientLive = (services: CleanupServicesFor) =>
  Layer.effect(
    RunCleanupClient,
    Effect.gen(function* () {
      const platform = yield* Effect.context<Exec | Home | FileSystem.FileSystem>();
      const fs = yield* FileSystem.FileSystem;

      // Runs `effect` as the run's persona.
      const asPersona = <A, E>(run: RunRoot, effect: Effect.Effect<A, E, CleanupServices>) =>
        Option.match(services(run.repo, run.persona), {
          onNone: () =>
            Effect.fail(
              new CleanupFailed({
                message: `${Option.getOrElse(run.persona, () => "the implicit persona")} no longer runs ${run.repo}`,
              }),
            ),
          onSome: (built) =>
            built.pipe(
              Effect.mapError(failed),
              Effect.flatMap((context) =>
                effect.pipe(
                  Effect.provideContext(context),
                  Effect.mapError((error) => failed({ message: String(error) })),
                ),
              ),
            ),
        });

      // A session's launcher and handle, while its launcher says it's open.
      const launchOf = (sessionId: string) =>
        Effect.gen(function* () {
          const record = yield* knownLaunch(sessionFiles((yield* Home).root, sessionId));

          return Option.flatMap(record, (launch) =>
            Option.map(launcherFor(launch.launcher), (launcher) => ({
              launcher,
              handle: launch.handle,
            })),
          );
        });

      return RunCleanupClient.of({
        removeWorktrees: (run) =>
          asPersona(
            run,
            Effect.gen(function* () {
              const repo = yield* Repo;
              const worktree = yield* Worktree;
              const git = yield* Git;
              const removed: Array<string> = [];
              const kept: Array<KeptWorktree> = [];
              const login = Option.orElse(run.persona, () => Option.fromUndefinedOr(repo.persona));

              for (const name of worktreeNames(run)) {
                const keptBefore = kept.length;

                const paths = Arr.dedupe([
                  worktree.pathFor(name),
                  ...Option.toArray(Option.map(login, (own) => worktree.pathFor(`${name}@${own}`))),
                ]);

                for (const path of paths) {
                  if (!(yield* fs.exists(`${path}/.git`).pipe(Effect.mapError(failed)))) {
                    continue;
                  }

                  const work = yield* workIn(path);

                  if (Option.isSome(work)) {
                    kept.push({ path, reason: work.value });
                    continue;
                  }

                  yield* git.run(["worktree", "remove", "--force", path], repo.path);
                  removed.push(path);
                }

                // The local branch goes with its last worktree; one checked
                // out elsewhere stays, which git says by refusing.
                if (kept.length === keptBefore) {
                  yield* git.run(["branch", "-D", name], repo.path).pipe(Effect.ignore);
                }
              }

              return { removed, kept };
            }),
          ).pipe(Effect.provideContext(platform)),
        releaseClaim: (run, issue) =>
          asPersona(
            run,
            Effect.gen(function* () {
              const github = yield* GitHub;
              const repo = yield* Repo;

              const claim = latestMarker(
                claimMarker.read,
                (yield* github.comments(issue)).map((comment) => comment.body),
              );

              const ours = Option.filter(claim, (marker) => marker.runId === run.id);

              if (Option.isNone(ours)) {
                return Option.none<ReleasedClaim>();
              }

              const { branch } = ours.value;
              yield* github.removeLabel(issue, repo.labels.inProgress);
              const login = yield* github.login;

              yield* github.request(
                "DELETE",
                `/repos/${repo.slug}/issues/${issue}/assignees`,
                Option.some({ assignees: [login] }),
              );

              if (Option.isNone(yield* github.branchSha(branch))) {
                return Option.some<ReleasedClaim>({ branch, kept: Option.none() });
              }

              const kept = yield* workOnBranch(branch);

              if (Option.isNone(kept)) {
                yield* github.deleteBranch(branch);
              }

              return Option.some<ReleasedClaim>({ branch, kept });
            }),
          ),
        openSessions: (run) =>
          Effect.gen(function* () {
            const ids = Arr.dedupe(
              (yield* runSessions(run.id)).map((session) => session.sessionId),
            );

            const open: Array<OpenSession> = [];

            for (const sessionId of ids) {
              for (const { handle, launcher } of Option.toArray(yield* launchOf(sessionId))) {
                if (yield* launcher.alive(handle).pipe(Effect.orElseSucceed(() => false))) {
                  open.push({ sessionId, launcher: launcher.name, handle });
                }
              }
            }

            return open;
          }).pipe(Effect.provideContext(platform)),
        closeSession: (session) =>
          Effect.gen(function* () {
            const launch = yield* launchOf(session.sessionId);

            if (Option.isNone(launch) || launch.value.handle !== session.handle) {
              return yield* new CleanupFailed({
                message: `no record of ${session.launcher} session ${session.handle}`,
              });
            }

            yield* launch.value.launcher.close(launch.value.handle).pipe(Effect.mapError(failed));
          }).pipe(Effect.provideContext(platform)),
      });
    }),
  );
