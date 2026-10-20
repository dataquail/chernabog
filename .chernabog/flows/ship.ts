// Ships issues labelled auto:ship in one run: implement, review in the
// reviewer role's session, consider the findings in the session that wrote the
// code, fix, and re-check in the reviewer's session. It never merges: an
// approved pull request is labelled auto:approved for a person to merge.

import { defineFlow, Implement, NeedsHuman, PullRequest, Review } from '@chernabog/sdk';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';

const SHIP = 'auto:ship';

export default defineFlow({
  trigger: Implement.triggerFor(SHIP),
  gate: Implement.gate,
  concurrency: 1,
  labels: [{ name: SHIP, description: 'Implement, review and fix in one run; a person merges' }],
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

          return yield* PullRequest.owning(opened.number)(
            Effect.gen(function* () {
              const review = yield* Review.round(opened.number, 1, { role: 'reviewer' });

              // Approved: label it for a person to merge.
              if (review.verdict === 'approve') {
                yield* Review.labelVerdict(opened.number, 1, review);

                return `#${opened.number} approved; a person merges`;
              }

              const decision = yield* Implement.considerFindings(opened.number, review, Implement.thisRunsSession);

              if (decision.status === 'decline') {
                yield* PullRequest.comment(opened.number, `Not addressing review 1:\n\n${decision.reasons}`);

                return yield* new NeedsHuman({ reason: 'the author declined review 1' });
              }

              const addressed = yield* Implement.addressFindings(opened.number, review, Implement.thisRunsSession);

              if (addressed.status === 'needs-clarification') return yield* new NeedsHuman({ reason: `the author needs a person to answer review 1: ${addressed.questions ?? addressed.summary}` });

              yield* Implement.localGate(worktree, { id: 'review-1' });
              yield* Implement.push('push-review-1', worktree, branch);
              yield* Implement.waitForCi(opened.number, worktree, { ...Implement.thisRunsSession, branch }, { id: 'review-1' });

              const recheck = yield* Review.recheck(opened.number, review);
              const listed = (remediated: boolean) => recheck.findings.filter((finding) => finding.remediated === remediated).map((finding) => `- ${finding.finding}`);
              yield* PullRequest.comment(opened.number, ["Review 1's findings after one fix round.", '', 'Remediated:', ...listed(true), '', 'Still open:', ...listed(false)].join('\n'));

              if (recheck.verdict === 'approve') {
                yield* Review.labelVerdict(opened.number, 2, recheck);

                return `#${opened.number} approved after one fix round; a person merges`;
              }

              return yield* new NeedsHuman({ reason: 'one fix round done; review 2 still requests changes' });
            }),
          );
        }).pipe(Effect.catchTag('NeedsHuman', (needsHuman) => toPerson(needsHuman.reason)));
      }).pipe(Effect.catchTag('StepFailed', (failed) => toPerson(`${failed.step}: ${failed.message}`)));
    }),
});
