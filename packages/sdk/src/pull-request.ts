// Steps on a pull request that any flow can use, whichever flow opened it:
// asking the team's reviewer pool for a review, merging on the automated path,
// and handing it to a person. A flow that works on a pull request itself can
// own it while it does, so the standalone flows leave it alone.

import {
  activity,
  Claims,
  GitHub,
  type Labels,
  latestMarker,
  type MergeMethod,
  MergeRefused,
  NeedsHuman,
  type OwnerMarker,
  ownerMarker,
  pathsMatching,
  type PullRequest,
  PullRequestClosed,
  Repo,
  reviewMarker,
  Run,
  Runs,
  Skip,
} from "@chernabog/core";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

import { commentStep } from "./comment.ts";

// Marks the pull request as this run's: its claim ref, and a comment for people to read.
export const own = (pullRequest: number) =>
  activity(
    `own-pr-${pullRequest}`,
    Effect.gen(function* () {
      const run = yield* Run;
      const item = Claims.pullRequest(pullRequest);
      const claimed = yield* Claims.acquire(item);

      if (!claimed.acquired) {
        return yield* new Skip({
          reason: `#${pullRequest} is owned by another run (${Claims.describeHolder(item, claimed.holder)})`,
        });
      }

      const marker = ownerMarker.write({
        flow: run.flow,
        runId: run.runId,
        released: false,
        ref: true,
      });

      yield* (yield* GitHub).comment(
        pullRequest,
        [
          ...Option.toArray(Option.map(claimed.takenOver, Claims.describeTakeover)),
          `The \`${run.flow}\` run owns this pull request until it ends. ${marker}`,
        ].join(" "),
      );
    }),
  );

// Comments on the pull request, and does nothing else.
export const comment = (pullRequest: number, body: string) => commentStep("pr", pullRequest, body);

// Lets the pull request go, so the standalone flows pick it up again.
export const release = (pullRequest: number) =>
  activity(
    `release-pr-${pullRequest}`,
    Effect.gen(function* () {
      const run = yield* Run;
      yield* Claims.release(Claims.pullRequest(pullRequest));

      const marker = ownerMarker.write({
        flow: run.flow,
        runId: run.runId,
        released: true,
        ref: true,
      });

      yield* (yield* GitHub).comment(
        pullRequest,
        `The \`${run.flow}\` run is done with this pull request. ${marker}`,
      );
    }),
  );

// Owns the pull request for as long as `effect` runs, and releases it however
// that ends. A run waiting on a signal keeps it. A pull request another run
// owns is skipped.
export const owning =
  (pullRequest: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    own(pullRequest).pipe(
      Effect.andThen(
        effect.pipe(
          // A wait suspends the run by interrupting it; that is not an ending.
          Effect.onExit((exit) => {
            if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) {
              return Effect.void;
            }

            return release(pullRequest).pipe(Effect.ignore);
          }),
        ),
      ),
    );

// Whether this machine knows the run has ended; a run it never had, such as
// one on another machine, is taken to be going.
const knownEnded = (runId: string) =>
  Effect.gen(function* () {
    const runs = yield* Effect.serviceOption(Runs);

    const active = yield* Option.match(runs, {
      onNone: () => Effect.succeedNone,
      onSome: (known) => known.isActive(runId),
    });

    return Option.contains(active, false);
  });

// The run that owns the pull request, from its comments: none once it let go,
// or when this machine knows the run has ended.
export const ownerOf = (bodies: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const latest = Option.filter(
      latestMarker(ownerMarker.read, bodies),
      (marker) => !marker.released,
    );

    if (Option.isNone(latest)) {
      return Option.none<OwnerMarker>();
    }

    if (yield* knownEnded(latest.value.runId)) {
      return Option.none<OwnerMarker>();
    }

    return latest;
  });

export type Owner = { readonly flow: string; readonly runId: string };

// The run that owns the pull request: the holder of its claim ref, none when
// this machine knows that run has ended, or its lease expired, so another run
// may take it over. Migration: while runs that owned a
// pull request by comment alone may be in flight, one with no claim ref falls
// back to the latest owner marker that names no ref (ownerOf). Drop the
// fallback a release after owners became claim refs.
export const owner = (pullRequest: number) =>
  Effect.gen(function* () {
    const held = yield* Claims.holder(Claims.pullRequest(pullRequest));
    const now = yield* DateTime.now;

    if (Option.exists(held, (found) => Claims.expired(found, now))) {
      return Option.none<Owner>();
    }

    if (Option.isSome(held)) {
      if (yield* knownEnded(held.value.runId)) {
        return Option.none<Owner>();
      }

      return Option.some<Owner>({ flow: held.value.flow, runId: held.value.runId });
    }

    const bodies = (yield* (yield* GitHub).comments(pullRequest)).map((found) => found.body);
    const legacy = yield* ownerOf(bodies);

    return Option.map(
      Option.filter(legacy, (marker) => marker.ref !== true),
      (marker): Owner => ({ flow: marker.flow, runId: marker.runId }),
    );
  });

export type MergeOptions = { readonly method: MergeMethod };

const refuse = (pullRequest: number, reason: string) => new MergeRefused({ pullRequest, reason });

// Merges the pull request, only when that is safe: it is open, its required
// checks are green on the current head, the latest review approved that very
// head, it touches no humanOnlyPaths, and GitHub's rules for the repo allow it.
// Otherwise it fails with MergeRefused, saying why, or PullRequestClosed for
// one closed without merging. Nothing merges unless a flow calls this.
export const merge = (pullRequest: number, options: MergeOptions) =>
  activity(
    `merge-pr-${pullRequest}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      const pull = yield* github.pullRequest(pullRequest);

      // A rerun after a crash finds its own merge done.
      if (pull.state === "merged") {
        return `#${pullRequest} merged`;
      }

      if (pull.state === "closed") {
        return yield* new PullRequestClosed({ pullRequest, state: "closed" });
      }

      const ci = yield* github.ciState(pullRequest);

      if (ci.state === "red") {
        return yield* refuse(pullRequest, `checks failed: ${ci.failedChecks.join(", ")}`);
      }

      if (ci.state === "pending") {
        return yield* refuse(pullRequest, "checks are still pending");
      }

      const reviewed = latestMarker(
        reviewMarker.read,
        (yield* github.comments(pullRequest)).map((posted) => posted.body),
      );

      if (Option.isNone(reviewed)) {
        return yield* refuse(pullRequest, "it has no review");
      }

      if (reviewed.value.sha !== pull.headSha) {
        return yield* refuse(
          pullRequest,
          `the head moved to \`${pull.headSha.slice(0, 7)}\` since review ${reviewed.value.round} saw \`${reviewed.value.sha.slice(0, 7)}\``,
        );
      }

      if (reviewed.value.verdict !== "approve") {
        return yield* refuse(pullRequest, `review ${reviewed.value.round} requested changes`);
      }

      const touched = pathsMatching(
        yield* github.pullRequestFiles(pullRequest),
        repo.humanOnlyPaths,
      );

      if (touched.length > 0) {
        return yield* refuse(
          pullRequest,
          `it touches paths a person must handle: ${touched.map((path) => `\`${path}\``).join(", ")}`,
        );
      }

      const merged = yield* github.merge(pullRequest, {
        method: options.method,
        sha: pull.headSha,
      });

      return `#${pullRequest} merged (${options.method}) as \`${merged.sha.slice(0, 7)}\``;
    }),
    Schema.String,
  );

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

// Asks one reviewer from the team's pool (reviewers: in config) to review the
// pull request, never its author. The choice is made once, at random, in an
// activity, so a replay asks the same person. Without a pool, or with no one
// in it but the author, it labels the pull request needs-review for a person.
export const requestReview = (pullRequest: number) =>
  activity(
    `request-review-${pullRequest}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      const pull = yield* github.pullRequest(pullRequest);
      const pool = (repo.reviewers ?? []).filter((login) => !sameLogin(login, pull.author));

      if (pool.length === 0) {
        yield* github.addLabel(pullRequest, repo.labels.needsReview);

        return `#${pullRequest}: no reviewer in the pool but its author; labelled ${repo.labels.needsReview} for a person`;
      }

      const reviewer = pool[yield* Random.nextIntBetween(0, pool.length, { halfOpen: true })];
      yield* github.requestReviewers(pullRequest, [reviewer]);

      return `#${pullRequest}: review requested of ${reviewer}`;
    }),
    Schema.String,
  );

// Whether chernabog may merge the pull request: only on the automated path,
// one labelled ship (auto:ship). Anything else, a missing or misspelt label
// included, is left for a person to merge. The one place that decides it.
export const ships = (pull: PullRequest, labels: Labels) => pull.labels.includes(labels.ship);

// Labels the pull request needs-human and says why; no flow picks it up again
// until a person removes the label.
export const handToPerson = (pullRequest: number, reason: string) =>
  activity(
    `needs-human-pr-${pullRequest}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      yield* github.addLabel(pullRequest, repo.labels.needsHuman);
      yield* github.comment(pullRequest, `Chernabog stopped and needs a person: ${reason}`);
    }),
  ).pipe(Effect.andThen(Effect.fail(new NeedsHuman({ reason: `#${pullRequest}: ${reason}` }))));

// Whether chernabog may merge the pull request, as `ships` decides it,
// read once in an activity so a replay decides the same.
export const shipping = (pullRequest: number) =>
  activity(
    `ships-pr-${pullRequest}`,
    Effect.gen(function* () {
      const repo = yield* Repo;

      return ships(yield* (yield* GitHub).pullRequest(pullRequest), repo.labels);
    }),
    Schema.Boolean,
  );

// After an approval: on the automated path, merges the pull request when that
// is safe, and otherwise hands it to a person; any other pull request is left
// for a person to merge, and one closed meanwhile is left alone.
export const mergeOrLeave = (pullRequest: number) =>
  Effect.gen(function* () {
    if (!(yield* shipping(pullRequest))) {
      return `#${pullRequest} approved; a person merges`;
    }

    return yield* merge(pullRequest, { method: "squash" }).pipe(
      Effect.catchTags({
        MergeRefused: (refused) => handToPerson(pullRequest, refused.message),
        PullRequestClosed: (closed) => Effect.succeed(`${closed.message}; nothing to merge`),
      }),
    );
  });
