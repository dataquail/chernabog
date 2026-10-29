// The building blocks of the `review`, `re-review` and `address-review`
// recipes, which work through GitHub's own review requests: a pull request asks one reviewer
// from the team's pool once its CI is green (Implement.handOff), `review` runs
// as a persona whose review is requested on a pull request it hasn't reviewed,
// and `re-review` as one asked again, resuming its own review session. On the
// automated path (auto:ship), the approving reviewer merges, when that's safe.
// `address-review` is the author's side: it answers a review that asks for
// changes in the session that wrote the code, and asks the reviewer again.

import {
  activity,
  adapterFor,
  Agent,
  Git,
  GitHub,
  type Json,
  latestMarker,
  NeedsHuman,
  type PullRequest,
  Repo,
  ReviewerSeat,
  type ReviewEvent,
  type ReviewMarker,
  reviewMarker,
  type ReviewNote,
  type RoleOptions,
  Run,
  SessionMarker,
  sessionMarker,
  StepFailed,
  type SubmittedReview,
  type WorkItem,
  Worktree,
} from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RECHECK } from "./default-prompts.ts";
import { ADOPTED_LABEL, sessionIdFor } from "./implement.ts";
import { renderPrompt, renderPromptOr } from "./prompt.ts";
import * as PullRequestSteps from "./pull-request.ts";
import { pullRequestValidity } from "./still-valid.ts";

export {
  type ReviewMarker,
  reviewMarker,
  type SessionMarker,
  sessionMarker,
} from "@chernabog/core";

// Agent-written pull requests come from claim branches.
export const isAgentBranch = (branch: string) => branch.startsWith("auto/");

export const ReviewItem = Schema.Struct({
  pullRequest: Schema.Finite,
  headRef: Schema.String,
  agentWritten: Schema.Boolean,
});

export type ReviewItem = typeof ReviewItem.Type;

const itemData =
  <A>(schema: Schema.Codec<A, Json>) =>
  (item: WorkItem) =>
    Schema.decodeEffect(schema)(item.data).pipe(
      Effect.mapError(
        (issue) => new StepFailed({ step: "work item", message: `${item.key}: ${issue.message}` }),
      ),
    );

export const pullRequestOf = itemData(ReviewItem);

// Any work item on a pull request: review's, re-review's, address-review's,
// resolve-conflicts'.
const OnPullRequest = Schema.Struct({ pullRequest: Schema.Finite });

// Whether the pull request is still there to work on, for a flow's
// stillValid: it is open, and no other run holds its claim. A run whose pull
// request was closed or merged ends as superseded.
export const stillValid = (item: WorkItem) =>
  itemData(OnPullRequest)(item).pipe(
    Effect.flatMap(({ pullRequest }) => pullRequestValidity(pullRequest)),
  );

// A pull request as a work item, keyed by `key`, for a trigger to report.
export const reviewItem = (pull: PullRequest, key: string): WorkItem => ({
  key,
  title: pull.title,
  url: pull.url,
  data: {
    pullRequest: pull.number,
    headRef: pull.headRef,
    agentWritten: isAgentBranch(pull.headRef),
  },
  assignees: pull.assignees,
  reviewers: pull.requestedReviewers,
});

// Whether a run of another flow owns the pull request, by its claim ref; the standalone flows leave it alone.
export const ownedByARun = (pull: PullRequest) =>
  PullRequestSteps.owner(pull.number).pipe(Effect.map(Option.isSome));

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

// The login this persona reviews as, from its seat in the reviewer pool. A
// flow that uses it, or any block that reviews, requires ReviewerSeat.
export const reviewerLogin = ReviewerSeat.use((seat) => seat.login);

// Open pull requests that ask this persona for a review, each with how many
// reviews it has submitted on it so far. One a run of another flow owns is
// left out. It requires the persona's seat in the reviewer pool.
export const reviewRequests = Effect.gen(function* () {
  const github = yield* GitHub;
  const me = yield* reviewerLogin;
  const found: Array<{ readonly pull: PullRequest; readonly reviewed: number }> = [];

  for (const pull of yield* github.openPullRequests) {
    if (!pull.requestedReviewers.some((login) => sameLogin(login, me))) {
      continue;
    }

    if (yield* ownedByARun(pull)) {
      continue;
    }

    found.push({
      pull,
      reviewed: (yield* github.reviews(pull.number)).filter((review) =>
        sameLogin(review.author, me),
      ).length,
    });
  }

  return found;
});

export const Verdict = Schema.Struct({
  verdict: Schema.Literals(["approve", "request-changes"]),
  summary: Schema.String,
  comments: Schema.Array(
    Schema.Struct({ path: Schema.String, line: Schema.Finite, body: Schema.String }),
  ),
});

export type Verdict = typeof Verdict.Type;

export const verdictJsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "request-changes"] },
    summary: {
      type: "string",
      description: "The review: what is right, what must change and why, in Markdown",
    },
    comments: {
      type: "array",
      description: "Comments on lines the pull request changed",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "number" },
          body: { type: "string" },
        },
        required: ["path", "line", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "summary", "comments"],
  additionalProperties: false,
} satisfies Json;

const ReviewComments = Schema.Array(
  Schema.Struct({ path: Schema.String, line: Schema.Finite, body: Schema.String }),
);

// A posted review: its verdict and the head it saw, and, from Review.round and
// Review.recheck, what it said and the session to resume it in. Those are
// optional only so that results saved before they existed still read back.
export const ReviewResult = Schema.Struct({
  verdict: Schema.Literals(["approve", "request-changes"]),
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

export const RecheckResult = Schema.Struct({
  ...ReviewResult.fields,
  findings: Schema.Array(Finding),
});

export type RecheckResult = typeof RecheckResult.Type;

const RecheckVerdict = Schema.Struct({ ...Verdict.fields, findings: Schema.Array(Finding) });

export const recheckJsonSchema = {
  ...verdictJsonSchema,
  properties: {
    ...verdictJsonSchema.properties,
    findings: {
      type: "array",
      description: "Each finding of the earlier review, and whether the new code remediates it",
      items: {
        type: "object",
        properties: { finding: { type: "string" }, remediated: { type: "boolean" } },
        required: ["finding", "remediated"],
        additionalProperties: false,
      },
    },
  },
  required: [...verdictJsonSchema.required, "findings"],
} satisfies Json;

// Cuts out each <!-- … --> and looks again from the start, so a marker nested
// in another can't survive the outer one's removal. An unclosed one hides the
// rest of the body, as it would in the rendered comment.
const withoutMarkers = (body: string): string => {
  const start = body.indexOf("<!--");

  if (start === -1) {
    return body.trim();
  }

  const end = body.indexOf("-->", start + "<!--".length);

  if (end === -1) {
    return body.slice(0, start).trim();
  }

  return withoutMarkers(body.slice(0, start) + body.slice(end + "-->".length));
};

const describeNote = (note: ReviewNote) =>
  Option.match(note.location, {
    onNone: () => `${note.author}: ${withoutMarkers(note.body)}`,
    onSome: (location) =>
      `${note.author} on ${location.path}:${location.line}: ${withoutMarkers(note.body)}`,
  });

const headingFor = (verdict: Verdict["verdict"], reviewer: string) => {
  if (verdict === "approve") {
    return `Approved by ${reviewer}`;
  }

  return `Changes requested by ${reviewer}`;
};

const eventOf = (verdict: Verdict["verdict"]): ReviewEvent => {
  if (verdict === "approve") {
    return "APPROVE";
  }

  return "REQUEST_CHANGES";
};

// Posts a review of the head with its marker: as a real review, approving or
// requesting changes, and as a plain comment, which later runs read back. The
// marker records who reviewed in which session, so a re-review resumes it.
const postReview = (pull: PullRequest, review: ReviewMarker, verdict: Verdict, heading: string) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const marker = reviewMarker.write(review);
    const event = eventOf(verdict.verdict);
    yield* github.review(pull.number, {
      body: `**${heading}** (review ${review.round})\n\n${verdict.summary}\n\n${marker}`,
      commitSha: pull.headSha,
      comments: verdict.comments,
      event,
    });
    yield* github.comment(pull.number, `${heading} at \`${pull.headSha.slice(0, 7)}\`. ${marker}`);
  });

const reviewAndPost = (pullRequest: number, round: number, role: Option.Option<string>) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const repo = yield* Repo;
    const run = yield* Run;
    const pull = yield* github.pullRequest(pullRequest);

    const worktree = yield* (yield* Worktree).checkout(
      `review-pr-${pullRequest}`,
      `origin/${pull.headRef}`,
    );

    const earlier = (yield* github.reviewComments(pullRequest)).filter((note) => note.trusted);

    const prompt = yield* renderPrompt("review", {
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
      Effect.mapError(
        (issue) =>
          new StepFailed({ step: `review-${round}`, message: `reviewer answer: ${issue.message}` }),
      ),
    );

    const by = Option.getOrElse(adapter, () => repo.agent);
    const me = yield* reviewerLogin;
    yield* postReview(
      pull,
      { sha: pull.headSha, round, verdict: verdict.verdict, reviewer: me, sessionId, adapter: by },
      verdict,
      headingFor(verdict.verdict, by),
    );

    return {
      verdict: verdict.verdict,
      sha: pull.headSha,
      round,
      summary: verdict.summary,
      comments: verdict.comments,
      sessionId,
      adapter: by,
    };
  });

// One review of the pull request's current head, in a detached worktree, in a
// fresh session that is given the earlier reviews. The reviewer is the role's
// adapter (the persona's roles pick, or flows.<flow>.agents), else the flow's
// agent (flows.<flow>.agent). Posts it as a real review.
const reviewOnly = (pullRequest: number, round: number, options: RoleOptions = {}) =>
  activity(
    `review-${round}`,
    reviewAndPost(pullRequest, round, Option.fromUndefinedOr(options.role)),
    ReviewResult,
  );

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
        return yield* new StepFailed({
          step: `review-${round}`,
          message:
            "the review carries no session to resume; re-check a review from Review.round or Review.recheck",
        });
      }

      const pull = yield* github.pullRequest(pullRequest);

      const worktree = yield* (yield* Worktree).checkout(
        `review-pr-${pullRequest}`,
        `origin/${pull.headRef}`,
      );

      const prompt = yield* renderPromptOr("recheck", RECHECK, {
        pullRequest,
        round: round - 1,
        reviewedSha: review.sha,
        headSha: pull.headSha,
      });

      const adapter = Option.fromUndefinedOr(review.adapter);

      const result = yield* (yield* Agent).run({
        cwd: worktree,
        prompt,
        sessionId: sessionId.value,
        resumePrompt: Option.some(prompt),
        outputSchema: Option.some(recheckJsonSchema),
        adapter,
      });

      const verdict = yield* Schema.decodeUnknownEffect(RecheckVerdict)(result.output).pipe(
        Effect.mapError(
          (issue) =>
            new StepFailed({
              step: `review-${round}`,
              message: `reviewer answer: ${issue.message}`,
            }),
        ),
      );

      const by = Option.getOrElse(adapter, () => repo.agent);
      const me = yield* reviewerLogin;
      yield* postReview(
        pull,
        {
          sha: pull.headSha,
          round,
          verdict: verdict.verdict,
          reviewer: me,
          sessionId: sessionId.value,
          adapter: by,
        },
        verdict,
        headingFor(verdict.verdict, by),
      );

      return {
        verdict: verdict.verdict,
        sha: pull.headSha,
        round,
        summary: verdict.summary,
        comments: verdict.comments,
        sessionId: sessionId.value,
        adapter: by,
        findings: verdict.findings,
      };
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

// This persona's latest review of the pull request, as its marker recorded
// it, to resume: none when it has none, or one posted before markers named
// their reviewer.
export const latestOwnReview = (pullRequest: number) =>
  activity(
    "find-review",
    Effect.gen(function* () {
      const github = yield* GitHub;
      const me = yield* reviewerLogin;
      const bodies = (yield* github.comments(pullRequest)).map((comment) => comment.body);

      const mine = latestMarker(
        (body) =>
          Option.filter(reviewMarker.read(body), (marker) =>
            Option.exists(Option.fromUndefinedOr(marker.reviewer), (reviewer) =>
              sameLogin(reviewer, me),
            ),
          ),
        bodies,
      );

      return Option.match(mine, {
        onNone: () => Option.none<ReviewResult>(),
        onSome: (marker) =>
          Option.some<ReviewResult>({
            verdict: marker.verdict,
            sha: marker.sha,
            round: marker.round,
            ...Option.match(Option.fromUndefinedOr(marker.sessionId), {
              onNone: () => ({}),
              onSome: (sessionId) => ({ sessionId }),
            }),
            ...Option.match(Option.fromUndefinedOr(marker.adapter), {
              onNone: () => ({}),
              onSome: (adapter) => ({ adapter }),
            }),
          }),
      });
    }),
    Schema.Option(ReviewResult),
  );

// Open pull requests this persona wrote, and those it adopted for an issue
// they close (Implement.ADOPTED_LABEL, with the persona assigned).
export const authoredByMe = Effect.gen(function* () {
  const github = yield* GitHub;
  const me = yield* github.login;

  return (yield* github.openPullRequests).filter(
    (pull) =>
      sameLogin(pull.author, me) ||
      (pull.labels.includes(ADOPTED_LABEL) && pull.assignees.some((login) => sameLogin(login, me))),
  );
});

// The pull request's approvals and requests for changes, oldest first; comments don't count.
export const decisiveReviews = (pullRequest: number) =>
  GitHub.use((github) => github.reviews(pullRequest)).pipe(
    Effect.map((reviews) =>
      reviews.filter(
        (review) => review.state === "APPROVED" || review.state === "CHANGES_REQUESTED",
      ),
    ),
  );

// address-review's work item for a review that asks for changes, the
// `count`th decisive review of the pull request.
export const addressItem = (
  pull: PullRequest,
  review: SubmittedReview,
  count: number,
): WorkItem => ({
  key: `pr-${pull.number}-changes-${count}`,
  title: pull.title,
  url: pull.url,
  data: {
    pullRequest: pull.number,
    headRef: pull.headRef,
    baseRef: pull.baseRef,
    agentWritten: isAgentBranch(pull.headRef),
    reviewer: review.author,
    reviewedSha: review.commitSha,
  },
  assignees: pull.assignees,
});

// baseRef: the pull request's base, which a layer of a stack has as the
// layer below's branch. An item saved without it pushes against the repo's
// base branch.
export const AddressItem = Schema.Struct({
  ...ReviewItem.fields,
  baseRef: Schema.optionalKey(Schema.String),
  reviewer: Schema.String,
  reviewedSha: Schema.String,
});

export type AddressItem = typeof AddressItem.Type;

export const addressItemOf = itemData(AddressItem);

// The author's session, from the marker the implement run left; a fresh one
// for `purpose` if there is none. Outside an activity, for a block that reads
// it under a name of its own.
export const findAuthorSession = (pullRequest: number, purpose: string) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const run = yield* Run;
    const repo = yield* Repo;

    const found = latestMarker(
      sessionMarker.read,
      (yield* github.comments(pullRequest)).map((comment) => comment.body),
    );

    return Option.getOrElse(found, (): SessionMarker => ({
      adapter: repo.agent,
      sessionId: sessionIdFor(run.runId, purpose),
      issue: 0,
      branch: "",
    }));
  });

// The author's session, from the marker the implement run left; a fresh one if there is none.
export const authorSession = (pullRequest: number) =>
  activity("find-author", findAuthorSession(pullRequest, "address-review"), SessionMarker);

// The author's worktree on the pull request's branch, brought up to date.
export const prepareAuthorWorktree = (headRef: string) =>
  activity(
    "prepare-worktree",
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
export const changesAsked = (address: AddressItem) =>
  activity(
    "read-review",
    Effect.gen(function* () {
      const github = yield* GitHub;
      const bodies = (yield* github.comments(address.pullRequest)).map((comment) => comment.body);

      const marker = latestMarker(
        (body) =>
          Option.filter(reviewMarker.read(body), (found) => found.sha === address.reviewedSha),
        bodies,
      );

      const notes = (yield* github.reviewComments(address.pullRequest)).filter(
        (note) => note.trusted && sameLogin(note.author, address.reviewer),
      );

      const round = Option.getOrElse(
        Option.map(marker, (found) => found.round),
        () => 1,
      );

      return {
        verdict: "request-changes" as const,
        sha: address.reviewedSha,
        round,
        summary: notes.map(describeReviewLine).join("\n\n"),
      };
    }),
    ReviewResult,
  );

// Fails with NeedsHuman when the author committed nothing since the review,
// or left edits it didn't commit, which the push would leave behind. Ignored
// files don't count, as `git status --porcelain` doesn't list them.
export const checkChanged = (
  pullRequest: number,
  round: number,
  reviewedSha: string,
  worktree: string,
) =>
  activity(
    `check-changed-${round}`,
    Effect.gen(function* () {
      const git = yield* Git;

      if ((yield* git.headSha(worktree)) === reviewedSha) {
        return yield* new NeedsHuman({
          reason: `#${pullRequest}: the author agent committed nothing in answer to review ${round}`,
        });
      }

      const uncommitted = (yield* git.run(["status", "--porcelain"], worktree))
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => `\`${line.slice(3)}\``);

      if (uncommitted.length > 0) {
        return yield* new NeedsHuman({
          reason: `#${pullRequest}: the author agent left changes it didn't commit in answer to review ${round}: ${uncommitted.join(", ")}`,
        });
      }
    }),
  );

// Says why on the pull request, and asks the reviewer to review again,
// outside an activity, for a block that asks under a name of its own.
export const requestAgain = (pullRequest: number, reviewer: string, said: string) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    yield* github.comment(pullRequest, said);
    yield* github.requestReviewers(pullRequest, [reviewer]);
  });

// Asks the reviewer who requested the changes to review again, which starts
// their re-review.
export const askAgain = (pullRequest: number, round: number, reviewer: string, summary: string) =>
  activity(
    `ask-again-${round}`,
    requestAgain(pullRequest, reviewer, `Addressed review ${round}: ${summary}`),
  );
