// Implements queued issues: claim the oldest one labelled auto:eligible or
// auto:ship, let the agent implement it in a worktree, run the local gate,
// open the pull request, wait for CI and hand off for review, which asks one
// reviewer from the team's pool. An auto:ship issue's pull request carries the
// label too, so its approving reviewer merges it.
//
// An issue an open pull request on another branch already closes is not
// implemented again: claim adopts that pull request (auto:adopted), and the
// run waits for CI, fixing red in a worktree on its branch, and hands it off.
// A draft waits for its author to mark it ready first. Several, or one on a
// fork, go to a person.
//
// Each block is a durable activity from @chernabog/sdk. Reorder them, leave
// one out, or put a step of your own from .chernabog/stages/ in between with
// `step("name", input, OutputSchema)`. Side effects belong inside activities or
// steps, never in the workflow body, which runs again whenever the run resumes.
//
// This file is chernabog's implement recipe, and this repo's to change:
// `chernabog recipes diff` shows how it differs from the recipe's current
// version. The names of its steps ("claim", "local-gate-1") are the keys a run
// in flight resumes by, so renaming one restarts that step.

import {
  type CiTimedOut,
  Claims,
  defineFlow,
  GitHub,
  Implement,
  NeedsHuman,
  type NothingCommitted,
  type PullRequestClosed,
  type PushRejected,
  reportAs,
  Review,
  Routing,
  Settings,
  Skip,
} from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Issues labelled auto:eligible, then ones labelled auto:ship, the automated
// path, whose pull request chernabog merges once it's approved. Oldest first;
// with a board, only those whose Status is its readyStatus. An issue another
// open issue blocks waits for it, as the tasks of a plan's epic do, and a task
// of an epic that an epic run holds is that run's to start; both are held,
// and `chernabog status` says why. And the issues whose adopted draft its
// author marked ready, which wake their run.
const trigger = Effect.gen(function* () {
  const github = yield* GitHub;
  const labelNames = yield* Settings.labels;

  const eligible = yield* github.queuedIssuesLabelled(labelNames.eligible);

  const shipping = (yield* github.queuedIssuesLabelled(labelNames.ship)).filter(
    (issue) => !eligible.some((queued) => queued.number === issue.number),
  );

  return [
    ...(yield* Implement.queued(eligible)),
    ...(yield* Implement.queued(shipping, Option.some(labelNames.ship))),
    ...(yield* Implement.readied),
  ];
}).pipe(reportAs("trigger"));

// How long an adopted draft waits for its author to mark it ready.
const READY_WITHIN = "14 days";

// What config.yaml may set for this flow, under settings: or flows.<name>.settings.
const settings = Schema.Struct({
  ...Routing.Settings.fields,
  ...Settings.Labels.fields,
  ...Settings.Base.fields,
  ...Settings.Board.fields,
  ...Settings.LocalGate.fields,
  ...Settings.Rules.fields,
  ...Settings.Ci.fields,
  ...Settings.Reviewers.fields,
});

export default defineFlow({
  trigger,
  gate: Implement.gate,
  concurrency: 1,
  labels: Effect.map(Settings.declaredLabels, (set) => [...set, ...Implement.adoptionLabels]),
  settings,
  // Doctor warns when no reviewer its pull requests may ask is a persona here.
  doctor: [Review.poolCheck],
  // An issue closed, or claimed by another run, ends the run as superseded.
  stillValid: Implement.stillValid,
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      const queued = yield* Implement.queuedBy(item);
      let pullRequest = Option.none<number>();

      const toPerson = (reason: string) =>
        Implement.handToHuman(issue, reason, pullRequest).pipe(
          Effect.flatMap(Implement.endForPerson),
        );

      // Nothing to push, a push the token may not make (its message says the
      // fix), CI that never finishes, or a pull request closed under the run:
      // each is a person's to look into.
      const forPerson = {
        NeedsHuman: (needsHuman: NeedsHuman) => toPerson(needsHuman.reason),
        NothingCommitted: (nothing: NothingCommitted) =>
          toPerson(`the agent finished without committing anything on ${nothing.branch}`),
        PushRejected: (rejected: PushRejected) => toPerson(rejected.message),
        CiTimedOut: (timedOut: CiTimedOut) => toPerson(timedOut.message),
        PullRequestClosed: (closed: PullRequestClosed) => toPerson(closed.message),
      };

      return yield* Effect.gen(function* () {
        // The base the claim settled, the repo's base branch here, which the
        // later steps build on; for an adopted pull request, its branch and base.
        const claimed = yield* Implement.claim(issue, { ...queued, adopt: true });
        const { base, branch } = claimed;
        const adoption = Option.fromUndefinedOr(claimed.adopted);

        if (Option.isSome(adoption)) {
          const adopted = adoption.value;
          pullRequest = Option.some(adopted.number);

          return yield* Effect.gen(function* () {
            // A draft is its author's until they mark it ready.
            if (
              adopted.draft &&
              (yield* Implement.awaitReady(issue, adopted.number, READY_WITHIN)) === "timeout"
            ) {
              return yield* new NeedsHuman({
                reason: `#${adopted.number} is still a draft after ${READY_WITHIN}`,
              });
            }

            // The worktree is made only for a fix.
            yield* Implement.waitForCiMaking(
              adopted.number,
              Implement.prepareWorktree(branch, { base }),
              {
                ...Implement.thisRunsSession,
                branch,
                base,
              },
            );

            return yield* Implement.handOff(issue, adopted, Implement.adoptedOutcome(adopted), {
              needsReview: true,
              adoptedBranch: branch,
            });
          }).pipe(Effect.catchTags(forPerson));
        }

        const worktree = yield* Implement.prepareWorktree(branch, { base });
        const outcome = yield* Implement.implementWithAgent(issue, worktree, { base });

        if (outcome.status === "needs-clarification") {
          return yield* Implement.askForClarification(issue, outcome, queued).pipe(
            Effect.flatMap(Implement.endForPerson),
          );
        }

        return yield* Effect.gen(function* () {
          yield* Implement.localGate(worktree);
          yield* Implement.push("push", worktree, branch, { base });
          const opened = yield* Implement.openPullRequest(issue, outcome, { ...queued, base });
          pullRequest = Option.some(opened.number);
          yield* Implement.waitForCi(opened.number, worktree, {
            ...Implement.thisRunsSession,
            branch,
            base,
          });

          return yield* Implement.handOff(issue, opened, outcome);
        }).pipe(Effect.catchTags(forPerson));
      }).pipe(
        // Any other failure once the issue is claimed hands it to a person, rather
        // than leaving it claimed with nobody working on it.
        Effect.catchTag("StepFailed", (failed) => toPerson(`${failed.step}: ${failed.message}`)),
        // However the run ends, its claim on the issue goes; the branch and
        // any pull request stay.
        Claims.releasing(Claims.issue(issue)),
      );
    }).pipe(
      // An issue deleted or transferred under the run leaves nothing to do.
      Effect.catchTag("NotFound", (gone) => Effect.fail(new Skip({ reason: gone.message }))),
    ),
});
