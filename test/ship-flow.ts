// The composite flow the "Composing a flow" page walks through, as a repo would
// write it in .chernabog/flows/ship.ts: one run implements an issue labelled
// auto:ship, has it reviewed by its reviewer role, answers the review in the
// session that wrote the code, has the reviewer re-check it, and ends by
// merging or by handing it to a person.

import { defineFlow, Implement, NeedsHuman, PullRequest, Review } from '@chernabog/sdk';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';

const SHIP = 'auto:ship';

export default defineFlow({
  trigger: Implement.triggerFor(SHIP),
  gate: Implement.gate,
  concurrency: 1,
  labels: [{ name: SHIP, description: 'Implement, review and merge in one run' }],
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      const { branch } = yield* Implement.claim(issue, { label: SHIP });
      let pullRequest = Option.none<number>();
      const toPerson = (reason: string) => Implement.handToHuman(issue, reason, pullRequest).pipe(Effect.flatMap(Implement.endForPerson));

      return yield* Effect.gen(function* () {
        const worktree = yield* Implement.prepareWorktree(branch);
        const outcome = yield* Implement.implementWithAgent(issue, worktree);

        if (outcome.status === 'needs-clarification') return yield* Implement.askForClarification(issue, outcome, { label: SHIP }).pipe(Effect.flatMap(Implement.endForPerson));

        return yield* Effect.gen(function* () {
          yield* Implement.localGate(worktree);
          yield* Implement.push('push', worktree, branch);
          const opened = yield* Implement.openPullRequest(issue, outcome);
          pullRequest = Option.some(opened.number);
          yield* Implement.waitForCi(opened.number, worktree, { ...Implement.thisRunsSession, branch });
          // This run reviews the pull request itself, so the review flow is not asked to.
          yield* Implement.handOff(issue, opened, outcome, { needsReview: false });

          // While this run works on the pull request, the standalone review and fix flows leave it alone.
          return yield* PullRequest.owning(opened.number)(
            Effect.gen(function* () {
              const review = yield* Review.round(opened.number, 1, { role: 'reviewer' });

              if (review.verdict === 'approve') return yield* PullRequest.merge(opened.number, { method: 'squash' });

              const decision = yield* Implement.considerFindings(opened.number, review, Implement.thisRunsSession);

              if (decision.status === 'decline') {
                yield* PullRequest.comment(opened.number, `Not addressing review 1:\n\n${decision.reasons}`);

                return yield* new NeedsHuman({ reason: 'the author declined review 1' });
              }

              const addressed = yield* Implement.addressFindings(opened.number, review, Implement.thisRunsSession);

              if (addressed.status === 'needs-clarification') return yield* new NeedsHuman({ reason: `the author needs a person to answer review 1: ${addressed.questions ?? addressed.summary}` });

              // The second gate and CI wait in this run need ids of their own.
              yield* Implement.localGate(worktree, { id: 'review-1' });
              yield* Implement.push('push-review-1', worktree, branch);
              yield* Implement.waitForCi(opened.number, worktree, { ...Implement.thisRunsSession, branch }, { id: 'review-1' });

              const recheck = yield* Review.recheck(opened.number, review);

              if (recheck.verdict === 'approve') return yield* PullRequest.merge(opened.number, { method: 'squash' });

              return yield* new NeedsHuman({ reason: 'still changes requested after one fix round' });
            }),
          );
        }).pipe(Effect.catchTag('NeedsHuman', (needsHuman) => toPerson(needsHuman.reason)));
      }).pipe(
        // Any other failure once the issue is claimed hands it to a person, rather
        // than leaving it claimed with nobody working on it.
        Effect.catchTag('StepFailed', (failed) => toPerson(`${failed.step}: ${failed.message}`)),
      );
    }),
});
