// The building blocks of the default `review` and `re-review` flows, which
// work through GitHub's own review requests: a pull request asks one reviewer
// from the team's pool once its CI is green (Implement.handOff), `review` runs
// as a persona whose review is requested on a pull request it hasn't reviewed,
// and `re-review` as one asked again, resuming its own review session. On the
// automated path (auto:ship), the approving reviewer merges, when that's safe.
// The `fix` flow is the author, for pull requests an agent wrote: it resumes
// the session that implemented them, addresses the review, pushes, and asks
// the reviewer again.

import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

import { RECHECK } from './default-prompts.ts';
import { NeedsHuman, StepFailed } from './errors.ts';
import { activity } from './flow.ts';
import { fixWithAgent, push, sessionIdFor, waitForCi } from './implement.ts';
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

export const FixItem = Schema.Struct({ ...ReviewItem.fields, round: Schema.Finite, reviewedSha: Schema.String });

export type FixItem = typeof FixItem.Type;

const itemData =
  <A>(schema: Schema.Codec<A, Json>) =>
  (item: WorkItem) =>
    Schema.decodeEffect(schema)(item.data).pipe(Effect.mapError((issue) => new StepFailed({ step: 'work item', message: `${item.key}: ${issue.message}` })));

export const pullRequestOf = itemData(ReviewItem);
const fixItemOf = itemData(FixItem);

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

// Changes requested on a first review: the author answers. Until address-review
// (#54) answers GitHub's review itself, `fix` finds such pull requests by the
// changes-requested label.
const changesRequested = (pullRequest: number, round: number) =>
  activity(
    `changes-requested-${round}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      yield* github.removeLabel(pullRequest, repo.labels.needsReview);
      yield* github.addLabel(pullRequest, repo.labels.changesRequested);

      return `#${pullRequest}: review ${round} requested changes`;
    }),
    Schema.String,
  );

// `review`: reviews the pull request as the persona whose review is
// requested, in a fresh session of the reviewer role. An approval on the
// automated path merges; a request for changes goes to the author.
export const workflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const { pullRequest } = yield* pullRequestOf(item);
    const review = yield* reviewOnly(pullRequest, 1, { role: 'reviewer' });
    yield* doneReviewing(pullRequest);

    if (review.verdict === 'approve') return yield* PullRequestSteps.mergeOrLeave(pullRequest);

    return yield* changesRequested(pullRequest, 1);
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


// Moves a pull request from some labels to another, saying why when there is something to say.
type Relabel = { readonly remove: ReadonlyArray<string>; readonly add: string; readonly comment: Option.Option<string> };

const relabel = (name: string, pullRequest: number, change: Relabel) =>
  activity(
    name,
    Effect.gen(function* () {
      const github = yield* GitHub;

      for (const label of change.remove) yield* github.removeLabel(pullRequest, label);

      yield* github.addLabel(pullRequest, change.add);

      if (Option.isSome(change.comment)) yield* github.comment(pullRequest, change.comment.value);
    }),
  );

// The fix flow's work items: agent-written pull requests with changes requested
// and no push since, one per review that asked, unless another flow's run owns one.
export const fixTrigger = Effect.gen(function* () {
  const github = yield* GitHub;
  const repo = yield* Repo;
  const items: Array<WorkItem> = [];

  for (const pull of yield* github.pullRequestsLabelled(repo.labels.changesRequested)) {
    const bodies = yield* commentBodies(pull);
    const reviewed = latestMarker(reviewMarker.read, bodies);

    if (isAgentBranch(pull.headRef) && Option.isSome(reviewed) && reviewed.value.sha === pull.headSha && !(yield* ownedByARun(bodies))) {
      items.push({
        key: `pr-${pull.number}-review-${reviewed.value.round}`,
        title: pull.title,
        url: pull.url,
        data: { pullRequest: pull.number, headRef: pull.headRef, agentWritten: true, round: reviewed.value.round, reviewedSha: reviewed.value.sha },
      });
    }
  }

  return items;
});

// Asks the reviewer who requested the changes to review again, which starts
// re-review; needs-review for a person, when the review doesn't say who.
const handBack = (fix: FixItem, summary: string) =>
  activity(
    'hand-back',
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      const bodies = (yield* github.comments(fix.pullRequest)).map((comment) => comment.body);
      const reviewer = Option.flatMap(latestMarker(reviewMarker.read, bodies), (marker) => Option.fromUndefinedOr(marker.reviewer));
      yield* github.removeLabel(fix.pullRequest, repo.labels.changesRequested);
      yield* github.comment(fix.pullRequest, `Addressed review ${fix.round}: ${summary}`);

      yield* Option.match(reviewer, {
        onNone: () => github.addLabel(fix.pullRequest, repo.labels.needsReview),
        onSome: (login) => github.requestReviewers(fix.pullRequest, [login]),
      });
    }),
  );

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

      return Option.getOrElse(found, () => ({ adapter: repo.agent, sessionId: sessionIdFor(run.runId, 'fix'), issue: 0, branch: '' }));
    }),
    SessionMarker,
  );

const prepareFix = (headRef: string) =>
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

const readReview = (fix: FixItem) =>
  activity(
    'read-review',
    Effect.gen(function* () {
      const notes = (yield* (yield* GitHub).reviewComments(fix.pullRequest)).filter((note) => note.trusted);

      return yield* renderPrompt('fix', { pullRequest: fix.pullRequest, round: fix.round, review: notes.map(describeReviewLine) });
    }),
    Schema.String,
  );

const checkChanged = (fix: FixItem, worktree: string) =>
  activity(
    'check-changed',
    Effect.gen(function* () {
      if ((yield* (yield* Git).headSha(worktree)) === fix.reviewedSha) {
        return yield* new NeedsHuman({ reason: `#${fix.pullRequest}: the author agent committed nothing in answer to review ${fix.round}` });
      }
    }),
  );

const fixPullRequest = (fix: FixItem) =>
  Effect.gen(function* () {
    const author = yield* authorSession(fix.pullRequest);
    const session = { sessionId: Option.some(author.sessionId), adapter: Option.some(author.adapter) };
    const worktree = yield* prepareFix(fix.headRef);
    const prompt = yield* readReview(fix);
    const outcome = yield* fixWithAgent(`address-review-${fix.round}`, worktree, prompt, session);

    if (outcome.status === 'needs-clarification') {
      return yield* new NeedsHuman({ reason: `the author agent needs a person to answer review ${fix.round}:\n\n${outcome.questions ?? outcome.summary}` });
    }

    yield* checkChanged(fix, worktree);
    yield* push(`push-fix-${fix.round}`, worktree, fix.headRef);
    yield* waitForCi(fix.pullRequest, worktree, { ...session, branch: fix.headRef });
    yield* handBack(fix, outcome.summary);

    return `#${fix.pullRequest}: addressed review ${fix.round}`;
  });

// Resumes the author's session with the review, pushes the fix once CI is
// green, and hands the pull request back for another review.
export const fixWorkflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const fix = yield* fixItemOf(item);

    return yield* fixPullRequest(fix).pipe(
      Effect.catchTag('NeedsHuman', (needsHuman) =>
        Effect.gen(function* () {
          const repo = yield* Repo;
          yield* relabel('needs-human', fix.pullRequest, {
            remove: [repo.labels.changesRequested],
            add: repo.labels.needsHuman,
            comment: Option.some(`Chernabog stopped and needs a person: ${needsHuman.reason}`),
          });

          return yield* needsHuman;
        }),
      ),
    );
  });
