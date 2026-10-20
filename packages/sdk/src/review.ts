// The building blocks of the default `review` and `fix` flows. A review run
// stays inside one workflow: after each review it waits on whichever comes
// first, the author's push or the staleness timeout. It ends when the pull
// request closes, the timeout labels it stale, or the loop cap hands it to a
// person. The fix flow is the author, for pull requests an agent wrote: it
// resumes the session that implemented them, addresses the review and pushes.

import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

import { NeedsHuman, StepFailed } from './errors.ts';
import { activity, awaitSignal } from './flow.ts';
import { fixWithAgent, push, sessionIdFor, waitForCi } from './implement.ts';
import type { Json } from './json.ts';
import { latestMarker, reviewMarker, SessionMarker, sessionMarker } from './markers.ts';
import { renderPrompt } from './prompt.ts';
import { adapterFor, type RoleOptions } from './roles.ts';
import { Agent, Git, GitHub, type PullRequest, Repo, type ReviewNote, Run, type WorkItem, Worktree } from './services.ts';

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

const reviewItem = (pull: PullRequest): WorkItem => ({
  key: `pr-${pull.number}`,
  title: pull.title,
  url: pull.url,
  data: { pullRequest: pull.number, headRef: pull.headRef, agentWritten: isAgentBranch(pull.headRef) },
  assignees: pull.assignees,
  reviewers: pull.requestedReviewers,
});

// The head the latest review saw.
const reviewedSha = (pull: PullRequest) =>
  GitHub.use((github) => github.comments(pull.number)).pipe(
    Effect.map((comments) =>
      latestMarker(
        reviewMarker.read,
        comments.map((comment) => comment.body),
      ).pipe(Option.map((marker) => marker.sha)),
    ),
  );

const changedSinceReview = (pull: PullRequest) => reviewedSha(pull).pipe(Effect.map(Option.exists((sha) => sha !== pull.headSha)));

// Pull requests to review, and the signals that wake reviews already waiting:
// "pushed" when a pull request changed since its last review (for one an agent
// wrote, once the fix flow handed it back), "closed" when it merged or closed.
export const trigger = Effect.gen(function* () {
  const github = yield* GitHub;
  const repo = yield* Repo;
  const items: Array<WorkItem> = [];

  for (const pull of yield* github.pullRequestsLabelled(repo.labels.needsReview)) {
    const item = reviewItem(pull);

    if (yield* changedSinceReview(pull)) items.push({ ...item, signals: ['pushed'] });
    else items.push(item);
  }

  for (const pull of yield* github.pullRequestsLabelled(repo.labels.changesRequested)) {
    if (!isAgentBranch(pull.headRef) && (yield* changedSinceReview(pull))) items.push({ ...reviewItem(pull), signals: ['pushed'], wakeOnly: true });
  }

  for (const label of [repo.labels.changesRequested, repo.labels.approved, repo.labels.needsReview]) {
    for (const pull of yield* github.closedPullRequestsLabelled(label)) items.push({ ...reviewItem(pull), signals: ['closed'], wakeOnly: true });
  }

  return items;
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

export const ReviewResult = Schema.Struct({ verdict: Schema.Literals(['approve', 'request-changes']), sha: Schema.String });

export type ReviewResult = typeof ReviewResult.Type;

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

// Reviews the head in a detached worktree and posts the review with its marker.
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

    const result = yield* (yield* Agent).run({
      cwd: worktree,
      prompt,
      sessionId: sessionIdFor(run.runId, `review-${round}`),
      resumePrompt: Option.none(),
      outputSchema: Option.some(verdictJsonSchema),
      adapter,
    });

    const verdict = yield* Schema.decodeUnknownEffect(Verdict)(result.output).pipe(
      Effect.mapError((issue) => new StepFailed({ step: `review-${round}`, message: `reviewer answer: ${issue.message}` })),
    );

    const heading = headingFor(verdict.verdict, Option.getOrElse(adapter, () => repo.agent));
    const marker = reviewMarker.write({ sha: pull.headSha, round, verdict: verdict.verdict });
    yield* github.review(pullRequest, { body: `**${heading}** (review ${round})\n\n${verdict.summary}\n\n${marker}`, commitSha: pull.headSha, comments: verdict.comments });
    // The marker also goes in a plain comment, which the trigger reads back.
    yield* github.comment(pullRequest, `${heading} at \`${pull.headSha.slice(0, 7)}\`. ${marker}`);

    return { verdict: verdict.verdict, sha: pull.headSha };
  });

const moveVerdictLabels = (pullRequest: number, verdict: ReviewResult['verdict']) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const repo = yield* Repo;
    yield* github.removeLabel(pullRequest, repo.labels.needsReview);

    if (verdict === 'approve') yield* github.addLabel(pullRequest, repo.labels.approved);
    else yield* github.addLabel(pullRequest, repo.labels.changesRequested);
  });

// One review of the pull request's current head, in a detached worktree, in a
// fresh session that is given the earlier reviews. The reviewer is the role's
// adapter (flows.<flow>.agents), else the flow's agent (flows.<flow>.agent).
// Posts it and leaves the labels alone; `labelVerdict` moves them.
const reviewOnly = (pullRequest: number, round: number, options: RoleOptions = {}) =>
  activity(`review-${round}`, reviewAndPost(pullRequest, round, Option.fromUndefinedOr(options.role)), ReviewResult);

export { reviewOnly as round };

// Moves the pull request from needs-review to approved or changes-requested, as
// the review said. A verdict that is no longer the latest review on the pull
// request, as when a run from before this step existed replays it, leaves the
// labels to whatever came after.
export const labelVerdict = (pullRequest: number, round: number, review: ReviewResult) =>
  activity(
    `label-review-${round}`,
    Effect.gen(function* () {
      const latest = latestMarker(
        reviewMarker.read,
        (yield* (yield* GitHub).comments(pullRequest)).map((comment) => comment.body),
      );

      if (Option.exists(latest, (marker) => marker.round === round && marker.sha === review.sha)) yield* moveVerdictLabels(pullRequest, review.verdict);
    }),
  );

// `round` and `labelVerdict` in one step: reviews, posts, and moves the labels.
export const reviewRound = (pullRequest: number, round: number) =>
  activity(
    `review-${round}`,
    reviewAndPost(pullRequest, round, Option.none()).pipe(Effect.tap((review) => moveVerdictLabels(pullRequest, review.verdict))),
    ReviewResult,
  );

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

// Removes the worktrees of a pull request that merged or closed: the branch's own and the review's.
export const cleanUp = (pullRequest: number, headRef: string) =>
  activity(
    'clean-up',
    Effect.gen(function* () {
      const worktree = yield* Worktree;
      yield* worktree.remove(`review-pr-${pullRequest}`);
      yield* worktree.remove(headRef);

      return `#${pullRequest} closed; worktrees removed`;
    }),
    Schema.String,
  );

// How long an approved pull request's worktrees wait for it to merge before the run lets go.
const APPROVED_WAIT = '14 days';

const afterApproval = (pullRequest: number, headRef: string) =>
  Effect.gen(function* () {
    const closed = yield* awaitSignal(['closed'], { id: 'approved', timeout: APPROVED_WAIT });

    if (closed === 'closed') return yield* cleanUp(pullRequest, headRef);

    return `#${pullRequest} approved; a person merges`;
  });

export const workflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const repo = yield* Repo;
    const { headRef, pullRequest } = yield* pullRequestOf(item);

    for (let round = 1; ; round++) {
      const review = yield* reviewOnly(pullRequest, round);
      yield* labelVerdict(pullRequest, round, review);

      if (review.verdict === 'approve') return yield* afterApproval(pullRequest, headRef);

      if (round >= repo.limits.reviewRounds) {
        yield* relabel('needs-human', pullRequest, {
          remove: [repo.labels.changesRequested],
          add: repo.labels.needsHuman,
          comment: Option.some(`Still changes requested after ${round} reviews, so a person takes it from here.`),
        });

        return yield* new NeedsHuman({ reason: `#${pullRequest}: still changes requested after ${round} reviews` });
      }

      const woke = yield* awaitSignal(['pushed', 'closed'], { id: `round-${round}`, timeout: repo.limits.staleAfter });

      if (woke === 'closed') return yield* cleanUp(pullRequest, headRef);

      if (woke === 'timeout') {
        yield* relabel(`stale-${round}`, pullRequest, {
          remove: [repo.labels.changesRequested],
          add: repo.labels.stale,
          comment: Option.some('No push since the last review, so this is marked stale.'),
        });

        return `#${pullRequest} went stale waiting for a push`;
      }

      yield* relabel(`re-review-${round}`, pullRequest, { remove: [repo.labels.changesRequested], add: repo.labels.needsReview, comment: Option.none() });
    }
  });

// The fix flow's work items: agent-written pull requests with changes requested
// and no push since, one per review that asked.
export const fixTrigger = Effect.gen(function* () {
  const github = yield* GitHub;
  const repo = yield* Repo;
  const items: Array<WorkItem> = [];

  for (const pull of yield* github.pullRequestsLabelled(repo.labels.changesRequested)) {
    const reviewed = latestMarker(
      reviewMarker.read,
      (yield* github.comments(pull.number)).map((comment) => comment.body),
    );

    if (isAgentBranch(pull.headRef) && Option.isSome(reviewed) && reviewed.value.sha === pull.headSha) {
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
    const repo = yield* Repo;
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
    yield* relabel('hand-back', fix.pullRequest, {
      remove: [repo.labels.changesRequested],
      add: repo.labels.needsReview,
      comment: Option.some(`Addressed review ${fix.round}: ${outcome.summary}`),
    });

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
