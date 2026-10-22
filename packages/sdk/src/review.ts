// The building blocks of the default `review` and `re-review` flows, which
// work through GitHub's own review requests: a pull request asks one reviewer
// from the team's pool once its CI is green (Implement.handOff), `review` runs
// as a persona whose review is requested on a pull request it hasn't reviewed,
// and `re-review` as one asked again, resuming its own review session. On the
// automated path (auto:ship), the approving reviewer merges, when that's safe.
// `address-review` is the author's side: it answers a review that asks for
// changes in the session that wrote the code, and asks the reviewer again.

import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

import { RECHECK } from './default-prompts.ts';
import { NeedsHuman, StepFailed } from './errors.ts';
import { activity } from './flow.ts';
import { addressFindings, considerFindings, localGate, push, sessionIdFor, waitForCi } from './implement.ts';
import type { Json } from './json.ts';
import { latestMarker, type ReviewMarker, reviewMarker, SessionMarker, sessionMarker } from './markers.ts';
import { renderPrompt, renderPromptOr } from './prompt.ts';
import * as PullRequestSteps from './pull-request.ts';
import { adapterFor, type RoleOptions } from './roles.ts';
import { Agent, Git, GitHub, type PullRequest, Repo, type ReviewEvent, type ReviewNote, Run, type WorkItem, Worktree } from './services.ts';

export { type ReviewMarker, reviewMarker, type SessionMarker, sessionMarker } from './markers.ts';

// Agent-written pull requests come from claim branches.
export const isAgentBranch = (branch: string) => branch.startsWith('auto/');

export const ReviewItem = Schema.Struct({ pullRequest: Schema.Finite, headRef: Schema.String, agentWritten: Schema.Boolean });

export type ReviewItem = typeof ReviewItem.Type;

const itemData =
  <A>(schema: Schema.Codec<A, Json>) =>
  (item: WorkItem) =>
    Schema.decodeEffect(schema)(item.data).pipe(Effect.mapError((issue) => new StepFailed({ step: 'work item', message: `${item.key}: ${issue.message}` })));

export const pullRequestOf = itemData(ReviewItem);

const reviewItem = (pull: PullRequest, key: string): WorkItem => ({
  key,
  title: pull.title,
  url: pull.url,
  data: { pullRequest: pull.number, headRef: pull.headRef, agentWritten: isAgentBranch(pull.headRef) },
  assignees: pull.assignees,
  reviewers: pull.requestedReviewers,
});

const commentBodies = (pull: PullRequest) => GitHub.use((github) => github.comments(pull.number)).pipe(Effect.map((comments) => comments.map((comment) => comment.body)));

// Whether a run of another flow owns the pull request; the standalone flows leave it alone.
const ownedByARun = (bodies: ReadonlyArray<string>) => PullRequestSteps.ownerOf(bodies).pipe(Effect.map(Option.isSome));

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

// Open pull requests that ask this persona for a review, each with how many
// reviews it has submitted on it so far.
const requestedOfMe = Effect.gen(function* () {
  const github = yield* GitHub;
  const me = yield* github.login;
  const found: Array<{ readonly pull: PullRequest; readonly reviewed: number }> = [];

  for (const pull of yield* github.openPullRequests) {
    if (!pull.requestedReviewers.some((login) => sameLogin(login, me))) continue;

    if (yield* ownedByARun(yield* commentBodies(pull))) continue;

    found.push({ pull, reviewed: (yield* github.reviews(pull.number)).filter((review) => sameLogin(review.author, me)).length });
  }

  return found;
});

// `review`'s work items: pull requests whose review is requested of this
// persona, which it hasn't reviewed yet.
export const trigger = Effect.map(requestedOfMe, (found) => found.flatMap(({ pull, reviewed }) => Option.toArray(Option.liftPredicate(reviewItem(pull, `pr-${pull.number}`), () => reviewed === 0))));

// `re-review`'s work items: pull requests that ask this persona again after it
// reviewed them, one per request, unless a person has them (needs-human).
export const reReviewTrigger = Effect.gen(function* () {
  const repo = yield* Repo;

  return (yield* requestedOfMe).flatMap(({ pull, reviewed }) =>
    Option.toArray(Option.liftPredicate(reviewItem(pull, `pr-${pull.number}-review-${reviewed + 1}`), () => reviewed > 0 && !pull.labels.includes(repo.labels.needsHuman))),
  );
});

export const Verdict = Schema.Struct({
  verdict: Schema.Literals(['approve', 'request-changes']),
  summary: Schema.String,
  comments: Schema.Array(Schema.Struct({ path: Schema.String, line: Schema.Finite, body: Schema.String })),
});

export type Verdict = typeof Verdict.Type;

export const verdictJsonSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request-changes'] },
    summary: { type: 'string', description: 'The review: what is right, what must change and why, in Markdown' },
    comments: {
      type: 'array',
      description: 'Comments on lines the pull request changed',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, line: { type: 'number' }, body: { type: 'string' } },
        required: ['path', 'line', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'summary', 'comments'],
  additionalProperties: false,
} satisfies Json;

const ReviewComments = Schema.Array(Schema.Struct({ path: Schema.String, line: Schema.Finite, body: Schema.String }));

// A posted review: its verdict and the head it saw, and, from Review.round and
// Review.recheck, what it said and the session to resume it in. Those are
// optional only so that results saved before they existed still read back.
export const ReviewResult = Schema.Struct({
  verdict: Schema.Literals(['approve', 'request-changes']),
  sha: Schema.String,
  round: Schema.optionalKey(Schema.Finite),
  summary: Schema.optionalKey(Schema.String),
  comments: Schema.optionalKey(ReviewComments),
  sessionId: Schema.optionalKey(Schema.String),
  adapter: Schema.optionalKey(Schema.String),
});

export type ReviewResult = typeof ReviewResult.Type;

// What a re-check found of each earlier finding.
export const Finding = Schema.Struct({ finding: Schema.String, remediated: Schema.Boolean });

export type Finding = typeof Finding.Type;

export const RecheckResult = Schema.Struct({ ...ReviewResult.fields, findings: Schema.Array(Finding) });

export type RecheckResult = typeof RecheckResult.Type;

const RecheckVerdict = Schema.Struct({ ...Verdict.fields, findings: Schema.Array(Finding) });

export const recheckJsonSchema = {
  ...verdictJsonSchema,
  properties: {
    ...verdictJsonSchema.properties,
    findings: {
      type: 'array',
      description: 'Each finding of the earlier review, and whether the new code remediates it',
      items: {
        type: 'object',
        properties: { finding: { type: 'string' }, remediated: { type: 'boolean' } },
        required: ['finding', 'remediated'],
        additionalProperties: false,
      },
    },
  },
  required: [...verdictJsonSchema.required, 'findings'],
} satisfies Json;


const withoutMarkers = (body: string) => body.replace(/<!--.*?-->/gs, '').trim();

const describeNote = (note: ReviewNote) =>
  Option.match(note.location, {
    onNone: () => `${note.author}: ${withoutMarkers(note.body)}`,
    onSome: (location) => `${note.author} on ${location.path}:${location.line}: ${withoutMarkers(note.body)}`,
  });

const headingFor = (verdict: Verdict['verdict'], reviewer: string) => {
  if (verdict === 'approve') return `Approved by ${reviewer}`;

  return `Changes requested by ${reviewer}`;
};

const eventOf = (verdict: Verdict['verdict']): ReviewEvent => {
  if (verdict === 'approve') return 'APPROVE';

  return 'REQUEST_CHANGES';
};

// Posts a review of the head with its marker: as a real review, approving or
// requesting changes, and as a plain comment, which later runs read back. The
// marker records who reviewed in which session, so a re-review resumes it.
const postReview = (pull: PullRequest, review: ReviewMarker, verdict: Verdict, heading: string) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const marker = reviewMarker.write(review);
    const event = eventOf(verdict.verdict);
    yield* github.review(pull.number, { body: `**${heading}** (review ${review.round})\n\n${verdict.summary}\n\n${marker}`, commitSha: pull.headSha, comments: verdict.comments, event });
    yield* github.comment(pull.number, `${heading} at \`${pull.headSha.slice(0, 7)}\`. ${marker}`);
  });

const reviewAndPost = (pullRequest: number, round: number, role: Option.Option<string>) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const repo = yield* Repo;
    const run = yield* Run;
    const pull = yield* github.pullRequest(pullRequest);
    const worktree = yield* (yield* Worktree).checkout(`review-pr-${pullRequest}`, `origin/${pull.headRef}`);
    const earlier = (yield* github.reviewComments(pullRequest)).filter((note) => note.trusted);

    const prompt = yield* renderPrompt('review', {
      repo: repo.slug,
      pullRequest,
      title: pull.title,
      body: pull.body,
      base: pull.baseRef,
      round,
      earlier: earlier.map(describeNote),
      humanOnly: repo.humanOnly,
      notes: repo.notes,
    });

    const adapter = yield* adapterFor(role);
    const sessionId = sessionIdFor(run.runId, `review-${round}`);

    const result = yield* (yield* Agent).run({
      cwd: worktree,
      prompt,
      sessionId,
      resumePrompt: Option.none(),
      outputSchema: Option.some(verdictJsonSchema),
      adapter,
    });

    const verdict = yield* Schema.decodeUnknownEffect(Verdict)(result.output).pipe(
      Effect.mapError((issue) => new StepFailed({ step: `review-${round}`, message: `reviewer answer: ${issue.message}` })),
    );

    const reviewer = Option.getOrElse(adapter, () => repo.agent);
    const me = yield* github.login;
    yield* postReview(pull, { sha: pull.headSha, round, verdict: verdict.verdict, reviewer: me, sessionId, adapter: reviewer }, verdict, headingFor(verdict.verdict, reviewer));

    return { verdict: verdict.verdict, sha: pull.headSha, round, summary: verdict.summary, comments: verdict.comments, sessionId, adapter: reviewer };
  });

// One review of the pull request's current head, in a detached worktree, in a
// fresh session that is given the earlier reviews. The reviewer is the role's
// adapter (the persona's roles pick, or flows.<flow>.agents), else the flow's
// agent (flows.<flow>.agent). Posts it as a real review.
const reviewOnly = (pullRequest: number, round: number, options: RoleOptions = {}) =>
  activity(`review-${round}`, reviewAndPost(pullRequest, round, Option.fromUndefinedOr(options.role)), ReviewResult);

export { reviewOnly as round };

// Resumes the reviewer's session from `review` with the change since the head
// it saw, and posts what it finds as the next review: a verdict, and whether
// each finding of `review` is remediated. Its prompt is
// .chernabog/prompts/recheck.md, or the SDK's own.
export const recheck = (pullRequest: number, review: ReviewResult) => {
  const round = (review.round ?? 1) + 1;

  return activity(
    `review-${round}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;

      const sessionId = Option.fromUndefinedOr(review.sessionId);

      if (Option.isNone(sessionId)) {
        return yield* new StepFailed({ step: `review-${round}`, message: 'the review carries no session to resume; re-check a review from Review.round or Review.recheck' });
      }

      const pull = yield* github.pullRequest(pullRequest);
      const worktree = yield* (yield* Worktree).checkout(`review-pr-${pullRequest}`, `origin/${pull.headRef}`);
      const prompt = yield* renderPromptOr('recheck', RECHECK, { pullRequest, round: round - 1, reviewedSha: review.sha, headSha: pull.headSha });
      const adapter = Option.fromUndefinedOr(review.adapter);

      const result = yield* (yield* Agent).run({ cwd: worktree, prompt, sessionId: sessionId.value, resumePrompt: Option.some(prompt), outputSchema: Option.some(recheckJsonSchema), adapter });

      const verdict = yield* Schema.decodeUnknownEffect(RecheckVerdict)(result.output).pipe(
        Effect.mapError((issue) => new StepFailed({ step: `review-${round}`, message: `reviewer answer: ${issue.message}` })),
      );

      const reviewer = Option.getOrElse(adapter, () => repo.agent);
      const me = yield* github.login;
      yield* postReview(pull, { sha: pull.headSha, round, verdict: verdict.verdict, reviewer: me, sessionId: sessionId.value, adapter: reviewer }, verdict, headingFor(verdict.verdict, reviewer));

      return { verdict: verdict.verdict, sha: pull.headSha, round, summary: verdict.summary, comments: verdict.comments, sessionId: sessionId.value, adapter: reviewer, findings: verdict.findings };
    }),
    RecheckResult,
  );
};

// Removes the review's checkout of the pull request, once the run is done
// with it; a re-review checks it out again. Review.round and Review.recheck
// leave it, for a flow of your own to remove when it's done.
export const doneReviewing = (pullRequest: number) =>
  activity(
    `clean-up-review-pr-${pullRequest}`,
    Worktree.use((worktree) => worktree.remove(`review-pr-${pullRequest}`)),
  );

// `review`: reviews the pull request as the persona whose review is
// requested, in a fresh session of the reviewer role. An approval on the
// automated path merges; a request for changes goes to the author's
// address-review.
export const workflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const { pullRequest } = yield* pullRequestOf(item);
    const review = yield* reviewOnly(pullRequest, 1, { role: 'reviewer' });
    yield* doneReviewing(pullRequest);

    if (review.verdict === 'approve') return yield* PullRequestSteps.mergeOrLeave(pullRequest);

    return `#${pullRequest}: review 1 requested changes`;
  });

// This persona's latest review of the pull request, as its marker recorded it, to resume.
const myLatestReview = (pullRequest: number) =>
  activity(
    'find-review',
    Effect.gen(function* () {
      const github = yield* GitHub;
      const me = yield* github.login;
      const bodies = (yield* github.comments(pullRequest)).map((comment) => comment.body);
      const mine = latestMarker((body) => Option.filter(reviewMarker.read(body), (marker) => Option.exists(Option.fromUndefinedOr(marker.reviewer), (reviewer) => sameLogin(reviewer, me))), bodies);

      return Option.match(mine, {
        onNone: () => Option.none<ReviewResult>(),
        onSome: (marker) => Option.some<ReviewResult>({ verdict: marker.verdict, sha: marker.sha, round: marker.round, ...Option.match(Option.fromUndefinedOr(marker.sessionId), { onNone: () => ({}), onSome: (sessionId) => ({ sessionId }) }), ...Option.match(Option.fromUndefinedOr(marker.adapter), { onNone: () => ({}), onSome: (adapter) => ({ adapter }) }) }),
      });
    }),
    Schema.Option(ReviewResult),
  );

const listed = (findings: ReadonlyArray<Finding>, remediated: boolean) => findings.flatMap((finding) => Option.toArray(Option.liftPredicate(`- ${finding.finding}`, () => finding.remediated === remediated)));

const reReviews = (count: number) => {
  if (count === 1) return '1 re-review';

  return `${count} re-reviews`;
};

// `re-review`: the persona is asked again after reviewing. It resumes its own
// review session, up to limits.reviewRounds re-reviews, and either approves,
// which merges on the automated path, or requests changes again and hands the
// pull request to a person.
export const reReviewWorkflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const repo = yield* Repo;
    const { pullRequest } = yield* pullRequestOf(item);
    const earlier = yield* myLatestReview(pullRequest);

    // No review of its own to resume, as one posted before markers named their reviewer: review afresh.
    if (Option.isNone(earlier) || Option.isNone(Option.fromUndefinedOr(earlier.value.sessionId))) return yield* workflow(item);

    const done = (earlier.value.round ?? 1) - 1;

    if (done >= repo.limits.reviewRounds) {
      return yield* PullRequestSteps.handToPerson(pullRequest, `asked to review again after ${reReviews(done)}, and limits.reviewRounds is ${repo.limits.reviewRounds}, so a person decides. Review ${earlier.value.round ?? 1}'s findings are in its review above.`);
    }

    const rechecked = yield* recheck(pullRequest, earlier.value);
    yield* doneReviewing(pullRequest);
    yield* PullRequestSteps.comment(pullRequest, [`Review ${earlier.value.round ?? 1}'s findings, re-reviewed.`, '', 'Remediated:', ...listed(rechecked.findings, true), '', 'Still open:', ...listed(rechecked.findings, false)].join('\n'));

    if (rechecked.verdict === 'approve') return yield* PullRequestSteps.mergeOrLeave(pullRequest);

    return yield* PullRequestSteps.handToPerson(pullRequest, `review ${rechecked.round ?? 2} still requests changes after a round of fixes`);
  });


// address-review's work items: pull requests this persona wrote whose latest
// review requests changes on the current head, so nothing was pushed since,
// unless a person has them (needs-human) or another flow's run owns them.
export const addressTrigger = Effect.gen(function* () {
  const github = yield* GitHub;
  const repo = yield* Repo;
  const me = yield* github.login;
  const items: Array<WorkItem> = [];

  for (const pull of yield* github.openPullRequests) {
    if (!sameLogin(pull.author, me) || pull.labels.includes(repo.labels.needsHuman)) continue;

    const decisive = (yield* github.reviews(pull.number)).filter((review) => review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED');
    const latest = Arr.last(decisive);

    if (!Option.exists(latest, (review) => review.state === 'CHANGES_REQUESTED' && review.commitSha === pull.headSha)) continue;

    if (yield* ownedByARun(yield* commentBodies(pull))) continue;

    for (const review of Option.toArray(latest)) {
      items.push({
        key: `pr-${pull.number}-changes-${decisive.length}`,
        title: pull.title,
        url: pull.url,
        data: { pullRequest: pull.number, headRef: pull.headRef, agentWritten: isAgentBranch(pull.headRef), reviewer: review.author, reviewedSha: review.commitSha },
        assignees: pull.assignees,
      });
    }
  }

  return items;
});

export const AddressItem = Schema.Struct({ ...ReviewItem.fields, reviewer: Schema.String, reviewedSha: Schema.String });

export type AddressItem = typeof AddressItem.Type;

const addressItemOf = itemData(AddressItem);

// The author's session, from the marker the implement run left; a fresh one if there is none.
const authorSession = (pullRequest: number) =>
  activity(
    'find-author',
    Effect.gen(function* () {
      const github = yield* GitHub;
      const run = yield* Run;
      const repo = yield* Repo;

      const found = latestMarker(
        sessionMarker.read,
        (yield* github.comments(pullRequest)).map((comment) => comment.body),
      );

      return Option.getOrElse(found, () => ({ adapter: repo.agent, sessionId: sessionIdFor(run.runId, 'address-review'), issue: 0, branch: '' }));
    }),
    SessionMarker,
  );

const prepareWorktree = (headRef: string) =>
  activity(
    'prepare-worktree',
    Effect.gen(function* () {
      const path = yield* (yield* Worktree).ensure(headRef);
      yield* (yield* Git).pull(path, headRef);

      return path;
    }),
    Schema.String,
  );

const describeReviewLine = (note: ReviewNote) =>
  Option.match(note.location, {
    onNone: () => withoutMarkers(note.body),
    onSome: (location) => `${location.path}:${location.line}: ${withoutMarkers(note.body)}`,
  });

// The review that asks for changes, as the author considers it: its round,
// from the reviewer's marker, and what the reviewer said.
const changesAsked = (address: AddressItem) =>
  activity(
    'read-review',
    Effect.gen(function* () {
      const github = yield* GitHub;
      const bodies = (yield* github.comments(address.pullRequest)).map((comment) => comment.body);
      const marker = latestMarker((body) => Option.filter(reviewMarker.read(body), (found) => found.sha === address.reviewedSha), bodies);
      const notes = (yield* github.reviewComments(address.pullRequest)).filter((note) => note.trusted && sameLogin(note.author, address.reviewer));
      const round = Option.getOrElse(Option.map(marker, (found) => found.round), () => 1);

      return { verdict: 'request-changes' as const, sha: address.reviewedSha, round, summary: notes.map(describeReviewLine).join('\n\n') };
    }),
    ReviewResult,
  );

const checkChanged = (pullRequest: number, round: number, reviewedSha: string, worktree: string) =>
  activity(
    `check-changed-${round}`,
    Effect.gen(function* () {
      if ((yield* (yield* Git).headSha(worktree)) === reviewedSha) {
        return yield* new NeedsHuman({ reason: `#${pullRequest}: the author agent committed nothing in answer to review ${round}` });
      }
    }),
  );

// Asks the reviewer who requested the changes to review again, which starts
// their re-review.
const askAgain = (pullRequest: number, round: number, reviewer: string, summary: string) =>
  activity(
    `ask-again-${round}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      yield* github.comment(pullRequest, `Addressed review ${round}: ${summary}`);
      yield* github.requestReviewers(pullRequest, [reviewer]);
    }),
  );

const answerReview = (address: AddressItem) =>
  Effect.gen(function* () {
    const review = yield* changesAsked(address);
    const round = review.round ?? 1;
    const author = yield* authorSession(address.pullRequest);
    // A pull request a person worked on with the agent reopens their session in front of them.
    const session = { sessionId: Option.some(author.sessionId), adapter: Option.some(author.adapter), withPerson: author.withPerson === true };
    const worktree = yield* prepareWorktree(address.headRef);
    const decision = yield* considerFindings(address.pullRequest, review, session);

    // A dispute is a person's to settle: it never pushes, nor asks the reviewer again.
    if (decision.status === 'decline') {
      yield* PullRequestSteps.comment(address.pullRequest, `Not addressing review ${round}:\n\n${decision.reasons}`);

      return yield* new NeedsHuman({ reason: `the author disputes review ${round}; see its reasons above` });
    }

    const outcome = yield* addressFindings(address.pullRequest, review, session);

    if (outcome.status === 'needs-clarification') return yield* new NeedsHuman({ reason: `the author agent needs a person to answer review ${round}:\n\n${outcome.questions ?? outcome.summary}` });

    yield* checkChanged(address.pullRequest, round, address.reviewedSha, worktree);
    yield* localGate(worktree, { id: `review-${round}`, session });
    yield* push(`push-review-${round}`, worktree, address.headRef);
    yield* waitForCi(address.pullRequest, worktree, { ...session, branch: address.headRef }, { id: `review-${round}` });
    yield* askAgain(address.pullRequest, round, address.reviewer, outcome.summary);

    return `#${address.pullRequest}: addressed review ${round}; asked ${address.reviewer} to review again`;
  });

// `address-review`: the author's answer to a review that asks for changes,
// in the session that wrote the code. It considers the findings first: a
// dispute is posted with its reasons and handed to a person; otherwise it
// makes the changes, runs the local gate, pushes, waits for CI and asks the
// reviewer again. Anything that stops it hands the pull request to a person.
export const addressWorkflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const address = yield* addressItemOf(item);

    return yield* answerReview(address).pipe(
      Effect.catchTag('NeedsHuman', (needsHuman) => PullRequestSteps.handToPerson(address.pullRequest, needsHuman.reason)),
      Effect.catchTag('StepFailed', (failed) => PullRequestSteps.handToPerson(address.pullRequest, `${failed.step}: ${failed.message}`)),
    );
  });
