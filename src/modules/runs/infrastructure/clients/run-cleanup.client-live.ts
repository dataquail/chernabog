// What a cancelled run held, cleaned up as its persona: the worktrees its
// item's flow keeps, by the SDK's names for them; its claim ref, when it still
// names the run; its claim on its issue, as the issue's claim marker records
// it; its agent sessions, by the handle each launch recorded, never by a
// process's name; and their containers, by the run's label (ADR 24,
// decision 9), never by a container's name.

import {
  claimMarker,
  Claims,
  Git,
  GitHub,
  latestMarker,
  Repo,
  SandboxName,
  type SetupError,
  Worktree,
} from "@chernabog/core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { type Persona } from "../../../../kernel/persona.value-object.ts";
import { Exec } from "../../../../platform/exec.ts";
import { Home } from "../../../../platform/home.ts";
import {
  type KeptWorktree,
  type LabelledContainer,
  type OpenSession,
  type ReleasedClaim,
  RunCleanupClient,
} from "../../domain/ports/clients/run-cleanup.client.ts";
import { CleanupFailed } from "../../domain/run/run.errors.ts";
import { type RunRoot } from "../../domain/run/run.root.ts";
import { itemTarget } from "../../domain/run/work-item.value-object.ts";
import {
  LaunchRecord,
  launchRuns,
  readDecoded,
  sessionFiles,
} from "../runtime/agents/session-files.ts";
import { runSessions } from "../runtime/agents/sessions.ts";
import { launcherFor } from "../runtime/launchers.ts";
import {
  containerLabelsArgs,
  parseContainerLabels,
  runContainersArgs,
} from "../runtime/launchers/container.ts";
import { type Launcher } from "../runtime/launchers/launcher.ts";

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
        return [Claims.branchFor(target.number)];
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
// commits `base`, the branch it was cut from, doesn't have.
const workOnBranch = (branch: string, base: string) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const repo = yield* Repo;
    const pull = yield* github.pullRequestForBranch(branch);

    if (Option.isSome(pull)) {
      return Option.some(`pull request #${pull.value.number} was opened from it`);
    }

    // A branch deleted since it was found has nothing on it to keep.
    const compared = yield* github
      .request(
        "GET",
        `/repos/${repo.slug}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`,
        Option.none(),
      )
      .pipe(
        Effect.catchTag("GitHubError", (error) =>
          Effect.flatMap(github.branchSha(branch), (sha) =>
            Option.match(sha, {
              onNone: () => Effect.succeed({ ahead_by: 0 }),
              onSome: () => Effect.fail(error),
            }),
          ),
        ),
      );

    const ahead = (yield* Schema.decodeUnknownEffect(Compare)(compared).pipe(
      Effect.mapError(failed),
    )).ahead_by;

    return Option.liftPredicate(`it has ${commits(ahead)} not on ${base}`, () => ahead > 0);
  });

// What finding a session's launch needs of the process.
type Platform = Exec | Home | FileSystem.FileSystem;

// A session's launcher, and the handle it runs under there.
type LaunchOf = Option.Option<{
  readonly launcher: Launcher;
  readonly handle: string;
  readonly withPerson: boolean;
}>;

type ContainerRuntime = "docker" | "podman";

const containerRuntimeOf = (sandbox: Option.Option<SandboxName>) =>
  Option.filter(sandbox, (name): name is ContainerRuntime => name !== "none");

// How long a runtime's CLI may take to answer, as `sandboxUnavailable` gives `info`.
const RUNTIME_TIMEOUT = "30 seconds";

// What a runtime's CLI printed, and what to say if it failed: what it said
// on stderr, or its exit code.
const runtimeSaid = (runtime: ContainerRuntime, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const result = yield* (yield* Exec)
      .run(runtime, args, { timeout: RUNTIME_TIMEOUT })
      .pipe(Effect.mapError(failed));

    const reason = Option.getOrElse(
      Option.liftPredicate(result.stderr.trim().slice(0, 400), (said) => said.length > 0),
      () => `exited ${result.exitCode}`,
    );

    return { ...result, said: `\`${runtime} ${args[0] ?? ""}\` failed: ${reason}` };
  });

// The containers on `runtime` labelled with the run `runId`, or any run, and
// whether each one's session's `__launch` still runs.
const labelledOn = (runtime: ContainerRuntime, runId: Option.Option<string>) =>
  Effect.gen(function* () {
    const listed = yield* runtimeSaid(runtime, runContainersArgs(runId));

    if (listed.exitCode !== 0) {
      return yield* new CleanupFailed({ message: listed.said });
    }

    const ids = listed.stdout.split(/\s+/).filter((id) => id.length > 0);

    if (ids.length === 0) {
      return [];
    }

    // A container removed since it was listed is no longer there to inspect,
    // and the runtime says so with a non-zero exit, but prints the rest.
    const inspected = yield* runtimeSaid(runtime, containerLabelsArgs(ids));
    const home = yield* Home;

    return yield* Effect.forEach(
      parseContainerLabels(inspected.stdout),
      (container): Effect.Effect<LabelledContainer, never, Exec | FileSystem.FileSystem> =>
        Effect.map(
          Option.match(container.sessionId, {
            onNone: () => Effect.succeed(false),
            onSome: (sessionId) => launchRuns(sessionFiles(home.root, sessionId)),
          }),
          (launched) => ({ runtime, ...container, launched }),
        ),
    );
  });

const removeOn = (runtime: string, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const named = containerRuntimeOf(Schema.decodeUnknownOption(SandboxName)(runtime));

    if (Option.isNone(named)) {
      return yield* new CleanupFailed({ message: `${runtime} is no container runtime` });
    }

    if (ids.length === 0) {
      return;
    }

    const removed = yield* runtimeSaid(named.value, ["rm", "-f", ...ids]);

    if (removed.exitCode !== 0) {
      return yield* new CleanupFailed({ message: removed.said });
    }
  });

export const RunCleanupClientLive = (
  services: CleanupServicesFor,
  // The sandboxes this process's repos resolved, whose runtimes the sweep lists.
  sandboxes: ReadonlyArray<SandboxName> = [],
) =>
  Layer.effect(
    RunCleanupClient,
    Effect.gen(function* () {
      const platform = yield* Effect.context<Platform>();
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

      // A session's launcher and handle, from the launch record at `file`.
      const launchAt = (file: string) =>
        Effect.map(readDecoded(LaunchRecord, file), (record) =>
          Option.flatMap(record, (launch) =>
            Option.map(launcherFor(launch.launcher), (launcher) => ({
              launcher,
              handle: launch.handle,
              withPerson: launch.withPerson === true,
            })),
          ),
        );

      // A session's launcher and handle, by its id.
      const launchOf = (sessionId: string) =>
        Effect.flatMap(Home.use(Effect.succeed), (home) =>
          launchAt(sessionFiles(home.root, sessionId).launch),
        );

      // The session, under its launcher, while the launcher says it's open,
      // or can't say: a check that fails (a launcher that didn't start under
      // load, say) is no sign the session is gone, and closing one that is
      // costs a failed close, where skipping one that isn't leaves an agent
      // running for a run that has ended.
      const stillOpen = (sessionId: string, launch: Effect.Effect<LaunchOf, never, Platform>) =>
        Effect.gen(function* () {
          for (const { handle, launcher, withPerson } of Option.toArray(yield* launch)) {
            if (yield* launcher.alive(handle).pipe(Effect.orElseSucceed(() => true))) {
              return Option.some<OpenSession>({
                sessionId,
                launcher: launcher.name,
                handle,
                withPerson,
              });
            }
          }

          return Option.none<OpenSession>();
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
        releaseClaimRef: (run, claim) =>
          asPersona(
            run,
            Claims.releaseFor(claim, run.id).pipe(
              Effect.map((released) => Option.liftPredicate(Claims.refFor(claim), () => released)),
            ),
          ),
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

              // The claim's label is the flow's: its marker releases it.
              const { branch } = ours.value;
              const login = yield* github.login;

              yield* github.request(
                "DELETE",
                `/repos/${repo.slug}/issues/${issue}/assignees`,
                Option.some({ assignees: [login] }),
              );

              if (Option.isNone(yield* github.branchSha(branch))) {
                return Option.some<ReleasedClaim>({ branch, kept: Option.none() });
              }

              // The base the claim recorded; the repo's, for one claimed before claims recorded it.
              const kept = yield* workOnBranch(branch, ours.value.base ?? repo.baseBranch);

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

            return Arr.getSomes(
              yield* Effect.forEach(ids, (sessionId) => stillOpen(sessionId, launchOf(sessionId))),
            );
          }).pipe(Effect.provideContext(platform)),
        openReported: (sessions) =>
          Effect.forEach(
            Arr.dedupeWith(sessions, (one, other) => one.sessionId === other.sessionId),
            (session) => stillOpen(session.sessionId, launchAt(session.launch)),
          ).pipe(Effect.map(Arr.getSomes), Effect.provideContext(platform)),
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
        removeContainers: (run, sparing) =>
          Effect.gen(function* () {
            // The runtime the run's repo's sandbox names, as its persona has it.
            const runtime = containerRuntimeOf(
              Option.map(
                Option.fromUndefinedOr(
                  yield* asPersona(
                    run,
                    Repo.use((repo) => Effect.succeed(repo.sandbox)),
                  ),
                ),
                (sandbox) => sandbox.name,
              ),
            );

            if (Option.isNone(runtime)) {
              return [];
            }

            const removing = (yield* labelledOn(runtime.value, Option.some(run.id))).filter(
              (container) =>
                !Option.exists(container.sessionId, (sessionId) => sparing.includes(sessionId)),
            );

            yield* removeOn(
              runtime.value,
              removing.map((container) => container.id),
            );

            return removing;
          }).pipe(Effect.provideContext(platform)),
        containerRuntimes: Effect.succeed(
          Arr.dedupe(
            sandboxes.flatMap((name) => Option.toArray(containerRuntimeOf(Option.some(name)))),
          ),
        ),
        labelledContainers: (runtime) =>
          Option.match(containerRuntimeOf(Schema.decodeUnknownOption(SandboxName)(runtime)), {
            onNone: () =>
              Effect.fail(new CleanupFailed({ message: `${runtime} is no container runtime` })),
            onSome: (named) => labelledOn(named, Option.none()),
          }).pipe(Effect.provideContext(platform)),
        removeContainer: (container) =>
          removeOn(container.runtime, [container.id]).pipe(Effect.provideContext(platform)),
      });
    }),
  );
