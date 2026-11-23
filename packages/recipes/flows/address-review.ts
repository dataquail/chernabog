// Answers a review that asks for changes on a pull request this persona
// wrote, in the session that wrote the code. It considers the findings first:
// when it disagrees, it replies with its reasons and hands the pull request to
// a person, without pushing. Otherwise it makes the changes, runs the local
// gate, pushes, waits for CI and asks the reviewer again, whose re-review
// takes it from there. A run owns the pull request by its claim ref, so
// resolve-conflicts doesn't merge into the branch while it does.
//
// This file is chernabog's address-review recipe, and this repo's to change:
// `chernabog recipes diff` shows how it differs from the recipe's current
// version. The names of its steps ("consider-review-1", "push-review-1") are
// the keys a run in flight resumes by, so renaming one restarts that step.

import {
  Blocks,
  defineFlow,
  Events,
  Implement,
  NeedsHuman,
  PullRequest,
  reportAs,
  Review,
  Routing,
  Settings,
  Skip,
  type WorkItem,
} from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Pull requests this persona wrote whose record says changes asked, by a
// review on the current head, so nothing was pushed since. A review a person
// left moves the record there first.
// A person has one labelled auto:needs-human, and a run of another flow one it
// owns; both are left alone. Each is routed by its assignees and reviewers.
// Then pull requests whose fix a CI job pushed, ending the job while its CI
// ran: each is held until the checks are green or red.
const trigger = Effect.gen(function* () {
  return [...(yield* Review.changesToAddress), ...(yield* Review.fixesAwaitingCi)];
}).pipe(
  // Every record it reads is checked first, as its document's are (ADR 21, decision 5).
  Blocks.checked("review.changesRequested", "author.waitForCi"),
  reportAs("trigger"),
);

const answerReview = (address: Review.AddressItem) =>
  Effect.gen(function* () {
    const review = yield* Review.changesAsked(address);
    const round = review.round ?? 1;
    const author = yield* Review.authorSession(address.pullRequest);

    // A pull request a person worked on with the agent reopens their session in front of them.
    const session = {
      sessionId: Option.some(author.sessionId),
      adapter: Option.some(author.adapter),
      withPerson: author.withPerson === true,
    };

    const worktree = yield* Review.prepareAuthorWorktree(address.headRef);
    const decision = yield* Implement.considerFindings(address.pullRequest, review, session);

    // A dispute is a person's to settle: it never pushes, nor asks the reviewer again.
    if (decision.status === "decline") {
      yield* PullRequest.comment(
        address.pullRequest,
        `Not addressing review ${round}:\n\n${decision.reasons}`,
      );

      return yield* new NeedsHuman({
        reason: `the author disputes review ${round}; see its reasons above`,
      });
    }

    const outcome = yield* Implement.addressFindings(address.pullRequest, review, session);

    if (outcome.status === "needs-clarification") {
      return yield* new NeedsHuman({
        reason: `the author agent needs a person to answer review ${round}:\n\n${outcome.questions ?? outcome.summary}`,
      });
    }

    yield* Review.checkChanged(address.pullRequest, round, address.reviewedSha, worktree);
    yield* Implement.localGate(worktree, {
      id: `review-${round}`,
      session,
      pullRequest: address.pullRequest,
    });
    // Only a fix made in front of a person may touch humanOnlyPaths. A layer
    // of a stack is checked against the layer below, so only its own commits count.
    yield* Implement.push(`push-review-${round}`, worktree, address.headRef, {
      base: address.baseRef,
      withPerson: session.withPerson,
    });
    // In a CI job, still-pending CI ends the job here, and the pull request
    // comes back through Review.fixesAwaitingCi once CI finishes.
    yield* Implement.waitForCi(
      address.pullRequest,
      worktree,
      { ...session, branch: address.headRef, base: address.baseRef },
      { id: `review-${round}`, ...Review.parkOnPullRequest(address.pullRequest) },
    );
    yield* Review.askAgain(address.pullRequest, round, address.reviewer, outcome.summary);

    return `#${address.pullRequest}: addressed review ${round}; asked ${address.reviewer} to review again`;
  });

// The fix is pushed, and a CI job ended while its CI ran, which has finished:
// wait on from the round the record names (a fix of red CI resumes the
// author's session), then ask the reviewer again.
const resumeCi = (address: Review.AddressItem, resumed: Review.ResumingCi) =>
  Effect.gen(function* () {
    const review = yield* Review.changesAsked(address);
    const round = review.round ?? 1;
    const author = yield* Review.authorSession(address.pullRequest);

    const session = {
      sessionId: Option.some(author.sessionId),
      adapter: Option.some(author.adapter),
      withPerson: author.withPerson === true,
    };

    const worktree = yield* Review.prepareAuthorWorktree(address.headRef);
    yield* Implement.waitForCi(
      address.pullRequest,
      worktree,
      { ...session, branch: address.headRef, base: address.baseRef },
      {
        id: `review-${round}`,
        ...Review.parkOnPullRequest(address.pullRequest),
        firstRound: resumed.round,
      },
    );
    yield* Review.askAgain(
      address.pullRequest,
      round,
      address.reviewer,
      "the commits pushed since that review. Their CI finished after the job that pushed them ended.",
    );

    return `#${address.pullRequest}: addressed review ${round}; asked ${address.reviewer} to review again`;
  });

const workflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const address = yield* Review.addressItemOf(item);

    const toPerson = (reason: string) => PullRequest.handToPerson(address.pullRequest, reason);

    // Anything that stops it hands the pull request to a person, unless it
    // closed meanwhile. It owns the pull request throughout, so no other run
    // pushes to the branch under it; one another run owns is skipped.
    const answering = Effect.gen(function* () {
      const resumed = Review.resumingCi(address);

      if (Option.isSome(resumed)) {
        return yield* resumeCi(address, resumed.value);
      }

      return yield* answerReview(address);
    });

    // One that changes a behavior spec no person approved goes to a person,
    // unanswered; a run taking up a fix's wait for CI went past this already.
    const guarded = Effect.gen(function* () {
      if (Option.isNone(Review.resumingCi(address))) {
        yield* PullRequest.specGuard(address.pullRequest);
      }
    }).pipe(Effect.catchTag("NotFound", (gone) => Effect.fail(new Skip({ reason: gone.message }))));

    const answered = answering.pipe(
      Effect.catchTags({
        NeedsHuman: (needsHuman) => toPerson(needsHuman.reason),
        StepFailed: (failed) => toPerson(`${failed.step}: ${failed.message}`),
        NothingCommitted: (nothing) =>
          toPerson(`the author agent committed nothing on ${nothing.branch}`),
        // Its message says how to fix the token, such as one without the workflow scope.
        PushRejected: (rejected) => toPerson(rejected.message),
        CiTimedOut: (timedOut) => toPerson(timedOut.message),
        PullRequestClosed: (closed) => Effect.fail(new Skip({ reason: closed.message })),
        NotFound: (gone) => Effect.fail(new Skip({ reason: gone.message })),
      }),
    );

    return yield* guarded.pipe(Effect.andThen(answered), PullRequest.owning(address.pullRequest));
  });

// What config.yaml may set for this flow, under settings: or flows.<name>.settings.
const settings = Schema.Struct({
  ...Routing.Settings.fields,
  ...Settings.Labels.fields,
  ...Settings.Base.fields,
  ...Settings.LocalGate.fields,
  ...Settings.Rules.fields,
  ...Settings.Ci.fields,
  ...Settings.Reviewers.fields,
});

const flow = defineFlow({
  labels: Settings.declaredLabels,
  settings,
  trigger,
  gate: Implement.gate,
  concurrency: 1,
  // Its trigger finds only pull requests this persona wrote.
  ownWork: true,
  // A pull request closed or merged ends the run as superseded.
  stillValid: Review.stillValid,
  workflow,
});

// The GitHub events that can change what its trigger finds, so it wakes in CI
// rather than only on the schedule: a review submitted, and a finished CI run,
// which frees a fix a CI job left waiting on its CI. Its trigger reads each
// pull request's phase, so a phase event wakes it too.
export default Events.declare(flow, {
  events: [Events.reviewSubmitted, Events.ciCompleted],
  readsPhases: true,
});
