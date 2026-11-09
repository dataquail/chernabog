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
  type DoctorCheck,
  Git,
  GitHub,
  type Json,
  latestMarker,
  Machine,
  NeedsHuman,
  type PhaseRecord,
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
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RECHECK } from "./default-prompts.ts";
import { ADOPTED_LABEL, sessionIdFor } from "./implement.ts";
import * as Phases from "./phases.ts";
import { renderPrompt, renderPromptOr } from "./prompt.ts";
import * as PullRequestSteps from "./pull-request.ts";
import * as Routing from "./routing.ts";
import * as Settings from "./settings.ts";
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
});

// A work item of the pull request, left for others when the flow's routing
// (Routing's settings) says it isn't this persona's, by the pull request's
// assignees and requested reviewers.
export const routed = (pull: PullRequest, item: WorkItem) =>
  Routing.route(item, { assignees: pull.assignees, reviewers: pull.requestedReviewers });

// Whether a run of another flow owns the pull request, by its claim ref; the standalone flows leave it alone.
export const ownedByARun = (pull: PullRequest) =>
  PullRequestSteps.owner(pull.number).pipe(Effect.map(Option.isSome));

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

// The login this persona reviews as, from its seat in the reviewer pool. A
// flow that uses it, or any block that reviews, requires ReviewerSeat.
export const reviewerLogin = ReviewerSeat.use((seat) => seat.login);

// An open pull request that asks this persona for a review: how many reviews
// it has submitted on it so far, and the pull request's record, none for one
// with no phase recorded yet.
export type ReviewRequest = {
  readonly pull: PullRequest;
  readonly reviewed: number;
  readonly record: Option.Option<PhaseRecord>;
};

// Open pull requests that ask this persona for a review, each with how many
// reviews it has submitted on it so far and its record. One a run of another
// flow owns is left out. It requires the persona's seat in the reviewer pool.
export const reviewRequests = Effect.gen(function* () {
  const github = yield* GitHub;
  const me = yield* reviewerLogin;
  const all = yield* Phases.records;
  const found: Array<ReviewRequest> = [];

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
      record: Phases.recordOf(all, Phases.pullRequestItem(pull.number)),
    });
  }

  return found;
});

// What a review request asks of this persona, by the pull request's phase:
// its first review (review's), a review again (re-review's), one whose
// record moves on to review-asked-again first, or a record GitHub disagrees
// with, which status shows rather than starting either.
type Asked =
  | { readonly kind: "first" }
  | { readonly kind: "again"; readonly record: Option.Option<PhaseRecord> }
  | { readonly kind: "reconcile"; readonly record: PhaseRecord }
  | { readonly kind: "disagrees"; readonly reason: string };

const P = Phases.PHASES.pullRequest;

// Today's inference, for a pull request with no record: see askedOf.
const legacyAsked = (request: ReviewRequest): Asked => {
  if (request.reviewed === 0) {
    return { kind: "first" };
  }

  return { kind: "again", record: Option.none() };
};

// A pull request with a record is read by its phase, not by how many times
// this persona reviewed it. Migration: one with no record, such as one
// handed off before phases were recorded, or one a person opened, falls back
// to the review count (legacyAsked). Drop the count a release after phases
// became the record, keeping "first" for an item with none.
const askedOf = (request: ReviewRequest, me: string): Asked =>
  Option.match(request.record, {
    onNone: () => legacyAsked(request),
    onSome: (found): Asked => {
      if (found.phase === P.reviewAskedAgain) {
        return { kind: "again", record: Option.some(found) };
      }

      // Waiting on a first review, or a person's turn, then a review asked of
      // this persona: its first, or, when it has reviewed already, again. An
      // adopted pull request it reviewed before the hand-off is one.
      if (
        Phases.holds(found, [P.reviewAsked, P.draft, P.readyForPerson]) &&
        request.reviewed === 0
      ) {
        return { kind: "first" };
      }

      if (
        Phases.holds(found, [P.reviewAsked, P.changesAsked, P.approved, P.draft, P.readyForPerson])
      ) {
        return { kind: "reconcile", record: found };
      }

      return {
        kind: "disagrees",
        reason: `its record says ${found.phase}, but GitHub asks ${me} for a review`,
      };
    },
  });

// review.requested's items: open pull requests that ask this persona for its
// first review, routed by their assignees and reviewers, as `pr-7`. One whose
// record GitHub disagrees with is held, with why, for status to show.
export const requestedFirst = Effect.gen(function* () {
  const me = yield* reviewerLogin;
  const items: Array<WorkItem> = [];

  for (const request of yield* reviewRequests) {
    const asked = askedOf(request, me);
    const item = reviewItem(request.pull, `pr-${request.pull.number}`);

    if (asked.kind === "first") {
      items.push(yield* routed(request.pull, item));
    }

    if (asked.kind === "disagrees") {
      items.push({ ...item, held: `#${request.pull.number}: ${asked.reason}` });
    }
  }

  return items;
});

// Who moves a record from what a source reads on GitHub, outside any run.
const observer = (source: string) => `observer:${source}`;

// The key a request to review again runs under: the record it reads, or the
// one reconciling moves it to; the review count for a pull request with no
// record (askedOf). None for a request that isn't to review again, or whose
// record another writer moved elsewhere first.
const againKey = (request: ReviewRequest, asked: Asked) => {
  const item = Phases.pullRequestItem(request.pull.number);

  if (asked.kind === "again") {
    return Effect.succeedSome(
      Option.match(asked.record, {
        onNone: () => `pr-${request.pull.number}-review-${request.reviewed + 1}`,
        onSome: (found) => Phases.keyFor(item, found),
      }),
    );
  }

  if (asked.kind !== "reconcile") {
    return Effect.succeedNone;
  }

  return Phases.reconcile(
    item,
    Option.some(asked.record),
    P.reviewAskedAgain,
    observer("review.requestedAgain"),
  ).pipe(
    Effect.map((found) =>
      Option.map(
        Option.filter(found, (record) => record.phase === P.reviewAskedAgain),
        (record) => Phases.keyFor(item, record),
      ),
    ),
  );
};

// review.requestedAgain's items: open pull requests that ask this persona to
// review again, unless a person has them (auto:needs-human), routed by their
// assignees and reviewers. Each item's key carries the record it reads,
// `pr-7-review-asked-again-1a2b3c4`, so each request is a run of its own. A
// review asked again of a pull request whose record says changes asked or
// approved, such as a person asking after a fix of their own, moves the record
// to review-asked-again first. One with no record keys by the review count,
// `pr-7-review-2`, as before phases.
export const requestedAgain = Effect.gen(function* () {
  const labelNames = yield* Settings.labels;
  const me = yield* reviewerLogin;
  const items: Array<WorkItem> = [];

  for (const request of yield* reviewRequests) {
    if (request.pull.labels.includes(labelNames.needsHuman)) {
      continue;
    }

    const key = yield* againKey(request, askedOf(request, me));

    for (const found of Option.toArray(key)) {
      items.push(yield* routed(request.pull, reviewItem(request.pull, found)));
    }
  }

  return items;
});

// Whether this machine acts as the login, among the logins it acts as.
const actsAs = (here: ReadonlyArray<string>, login: string) =>
  here.some((own) => sameLogin(own, login));

// Open pull requests that wait on a review from a login no persona on this
// machine acts as, as work items that wait on those logins, for `chernabog
// status` to list: this persona's trigger never finds them, and another
// person's machine may serve them. One that asks this persona too is the
// trigger's own work. None from a binary that doesn't say which logins it
// acts as. It requires the persona's seat in the reviewer pool.
export const waitingElsewhere = Effect.gen(function* () {
  const machine = yield* Effect.serviceOption(Machine);

  if (Option.isNone(machine)) {
    return [];
  }

  const me = yield* reviewerLogin;
  const pulls = yield* (yield* GitHub).openPullRequests;

  return pulls.flatMap((pull): ReadonlyArray<WorkItem> => {
    if (pull.requestedReviewers.some((login) => sameLogin(login, me))) {
      return [];
    }

    const others = pull.requestedReviewers.filter(
      (login) => !actsAs(machine.value.personas, login),
    );

    if (others.length === 0) {
      return [];
    }

    return [
      {
        ...reviewItem(pull, `pr-${pull.number}`),
        waitsOn: { who: others.join(", "), why: "not on this machine" },
      },
    ];
  });
});

// Doctor's check for a flow that reviews the pull requests asked of its
// persona, such as review: a persona that runs it holds a seat in the
// reviewer pool, since no pull request asks one that doesn't. Its presence
// also marks the flow as one that reviews, for the pool check of the flows
// that ask for reviews.
export const reviewerCheck: DoctorCheck = (context) =>
  Effect.gen(function* () {
    const { pool } = yield* Settings.reviewers;

    const unseated = Option.filter(
      context.login,
      (login) => context.runs && pool.length > 0 && !actsAs(pool, login),
    );

    return Option.match(unseated, {
      onNone: () => [],
      onSome: (login) => [
        {
          warning: `${login} runs ${context.flow}, but the reviewer pool (${pool.join(", ")}) doesn't list it, so no pull request asks it to review`,
          fix: `add ${login} to reviewers: in .chernabog/config.yaml, or turn ${context.flow} off for ${login}`,
        },
      ],
    });
  });

// Doctor's check for a flow that asks the reviewer pool to review its pull
// requests, such as implement: some reviewer the persona's pull requests may
// ask (the pool, less the persona) is a persona on this machine, and runs a
// flow that reviews here, one with reviewerCheck. A warning, since another
// person's machine may serve that login.
export const poolCheck: DoctorCheck = (context) =>
  Effect.gen(function* () {
    if (!context.runs) {
      return [];
    }

    const { pool } = yield* Settings.reviewers;

    const asked = pool.filter(
      (login) => !Option.exists(context.login, (own) => sameLogin(own, login)),
    );

    if (asked.length === 0) {
      return [];
    }

    const author = Option.getOrElse(context.login, () => "the implicit account");
    const reviewers = asked.join(", ");

    if (!asked.some((login) => actsAs(context.personas, login))) {
      return [
        {
          warning: `pull requests authored as ${author} go to ${reviewers}, which this machine doesn't act as; they wait until another machine reviews them`,
          fix: `run a flow that reviews, such as review, as one of ${reviewers} on this machine (chernabog setup, then chernabog enroll), or make sure another machine does`,
        },
      ];
    }

    const reviewing = context.flows.filter((flow) => flow.doctor.includes(reviewerCheck));

    if (asked.some((login) => reviewing.some((flow) => actsAs(flow.runners, login)))) {
      return [];
    }

    const flows = Option.getOrElse(
      Option.liftPredicate(
        reviewing.map((flow) => flow.name).join(", "),
        (names) => names.length > 0,
      ),
      () => "such as review",
    );

    return [
      {
        warning: `pull requests authored as ${author} go to ${reviewers}, which no persona here reviews as: none of them runs a flow that reviews (${flows}) here`,
        fix: `turn a flow that reviews on for one of ${reviewers} (chernabog enroll --persona <login> --flows ...), or make sure another machine reviews as them`,
      },
    ];
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

// What a re-check found of each earlier finding, and of each new one. A
// blocking finding left open requests changes; a point an approving review
// made never blocks. Absent, from results saved before it existed, it blocks.
export const Finding = Schema.Struct({
  finding: Schema.String,
  remediated: Schema.Boolean,
  blocking: Schema.optionalKey(Schema.Boolean),
});

export type Finding = typeof Finding.Type;

export const RecheckResult = Schema.Struct({
  ...ReviewResult.fields,
  findings: Schema.Array(Finding),
});

export type RecheckResult = typeof RecheckResult.Type;

const RecheckVerdict = Schema.Struct({ ...Verdict.fields, findings: Schema.Array(Finding) });

// A re-check requests changes only for a blocking finding still open,
// whatever verdict the reviewer gave: so a point it let an approval through
// with can't turn into a hand-off when it is asked again. With no findings
// listed there is nothing to settle it by, and the reviewer's verdict stands.
export const settledVerdict = (
  findings: ReadonlyArray<Finding>,
  given: Verdict["verdict"],
): Verdict["verdict"] => {
  if (findings.length === 0) {
    return given;
  }

  if (findings.some((finding) => !finding.remediated && finding.blocking !== false)) {
    return "request-changes";
  }

  return "approve";
};

const earlierVerdict = (verdict: Verdict["verdict"]) => {
  if (verdict === "approve") {
    return "approved it. Its points did not block that approval, so none of them blocks now";
  }

  return "asked for changes";
};

export const recheckJsonSchema = {
  ...verdictJsonSchema,
  properties: {
    ...verdictJsonSchema.properties,
    findings: {
      type: "array",
      description:
        "Each finding of the earlier review, then each new one: whether the new code remediates it, and whether it blocks the merge",
      items: {
        type: "object",
        properties: {
          finding: { type: "string" },
          remediated: { type: "boolean" },
          blocking: { type: "boolean" },
        },
        required: ["finding", "remediated", "blocking"],
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

// The phase a review leaves its pull request in.
const phaseAfter = (verdict: Verdict["verdict"]): Phases.Phase => {
  if (verdict === "approve") {
    return Phases.PHASES.pullRequest.approved;
  }

  return Phases.PHASES.pullRequest.changesAsked;
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
    yield* Phases.record(Phases.pullRequestItem(pull.number), phaseAfter(verdict.verdict));
  });

const reviewAndPost = (pullRequest: number, round: number, role: Option.Option<string>) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const repo = yield* Repo;
    const rules = yield* Settings.rules;
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
      humanOnly: rules.humanOnly,
      notes: rules.notes,
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
        earlier: earlierVerdict(review.verdict),
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

      const answer = yield* Schema.decodeUnknownEffect(RecheckVerdict)(result.output).pipe(
        Effect.mapError(
          (issue) =>
            new StepFailed({
              step: `review-${round}`,
              message: `reviewer answer: ${issue.message}`,
            }),
        ),
      );

      const verdict = { ...answer, verdict: settledVerdict(answer.findings, answer.verdict) };

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

// The latest approval or request for changes, when it asks for changes on
// the pull request's head: nothing was pushed since.
const changesOnHead = (pull: PullRequest, decisive: ReadonlyArray<SubmittedReview>) =>
  Option.filter(
    Arr.last(decisive),
    (review) => review.state === "CHANGES_REQUESTED" && review.commitSha === pull.headSha,
  );

// Today's inference, for a pull request with no record: the latest decisive
// review asks for changes on the head, keyed by the count of decisive
// reviews. Migration: drop it a release after phases became the record.
const legacyChanges = (pull: PullRequest) =>
  Effect.gen(function* () {
    const decisive = yield* decisiveReviews(pull.number);
    const latest = changesOnHead(pull, decisive);

    if (Option.isNone(latest) || (yield* ownedByARun(pull))) {
      return Option.none<WorkItem>();
    }

    return Option.some(addressItem(pull, latest.value, decisive.length));
  });

// The phases a review that asks for changes on the head moves a pull request
// on from: a person's review, which no run was there to record.
const CHANGES_FROM = [P.reviewAsked, P.reviewAskedAgain, P.approved, P.draft, P.readyForPerson];

const shortSha = (sha: string) => sha.slice(0, 7);

// Why a pull request whose record says changes asked isn't one to address,
// by its latest approval or request for changes.
const changesDisagree = (pull: PullRequest, latest: Option.Option<SubmittedReview>) =>
  Option.match(
    Option.filter(latest, (review) => review.state === "CHANGES_REQUESTED"),
    {
      onNone: () =>
        `#${pull.number}: its record says changes asked, but its latest review asks for none`,
      onSome: (review) =>
        `#${pull.number}: changes were asked at ${shortSha(review.commitSha)}, but its head has moved to ${shortSha(pull.headSha)} since; ask ${review.author} to review again`,
    },
  );

// The record a pull request with changes asked on its head holds: its own
// when it says so, or else the one reconciling it moves it to.
const changesAskedRecord = (item: string, found: PhaseRecord) => {
  if (found.phase === P.changesAsked) {
    return Effect.succeedSome(found);
  }

  return Phases.reconcile(
    item,
    Option.some(found),
    P.changesAsked,
    observer("review.changesRequested"),
  );
};

// One pull request with a record, for changesToAddress: an item to address
// when its record says changes asked and the review it names is on the head;
// held, with why, when GitHub disagrees; moved to changes-asked first when a
// review asks for changes on the head of one in a phase before it.
const changesByRecord = (pull: PullRequest, found: PhaseRecord) =>
  Effect.gen(function* () {
    const item = Phases.pullRequestItem(pull.number);
    const asks = found.phase === P.changesAsked;

    if (!asks && !Phases.holds(found, [...CHANGES_FROM, P.mergeHeld])) {
      return Option.none<WorkItem>();
    }

    const decisive = yield* decisiveReviews(pull.number);
    const latest = changesOnHead(pull, decisive);

    if ((!asks && Option.isNone(latest)) || (yield* ownedByARun(pull))) {
      return Option.none<WorkItem>();
    }

    if (Option.isNone(latest)) {
      return Option.some<WorkItem>({
        ...reviewItem(pull, Phases.keyFor(item, found)),
        held: changesDisagree(pull, Arr.last(decisive)),
      });
    }

    if (found.phase === P.mergeHeld) {
      return Option.some<WorkItem>({
        ...reviewItem(pull, Phases.keyFor(item, found)),
        held: `#${pull.number}: its merge is held for a green base, but ${latest.value.author} has asked for changes since`,
      });
    }

    const now = Option.filter(
      yield* changesAskedRecord(item, found),
      (record) => record.phase === P.changesAsked,
    );

    return Option.map(now, (record) => ({
      ...addressItem(pull, latest.value, decisive.length),
      key: Phases.keyFor(item, record),
    }));
  });

// A held item stays here, for status to show why; any other is routed.
const routedUnlessHeld = (pull: PullRequest, item: WorkItem) => {
  if (Option.isSome(Option.fromUndefinedOr(item.held))) {
    return Effect.succeed(item);
  }

  return routed(pull, item);
};

// review.changesRequested's items: pull requests this persona wrote whose
// record says changes asked, by the review that asks them, on the current
// head, so nothing was pushed since. Each item's key carries the record,
// `pr-7-changes-asked-1a2b3c4`. A person's review that asks for changes on
// the head of one whose record is before it moves the record on first. One a
// person has (auto:needs-human), or a run of another flow owns, is left
// alone; one whose record GitHub disagrees with is held, with why, for status
// to show. One with no record is read from its reviews (legacyChanges). Each
// is routed by its assignees and reviewers.
export const changesToAddress = Effect.gen(function* () {
  const labelNames = yield* Settings.labels;
  const all = yield* Phases.records;
  const items: Array<WorkItem> = [];

  for (const pull of yield* authoredByMe) {
    if (pull.labels.includes(labelNames.needsHuman)) {
      continue;
    }

    const found = yield* Option.match(Phases.recordOf(all, Phases.pullRequestItem(pull.number)), {
      onNone: () => legacyChanges(pull),
      onSome: (record) => changesByRecord(pull, record),
    });

    for (const item of Option.toArray(found)) {
      items.push(yield* routedUnlessHeld(pull, item));
    }
  }

  return items;
});

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
export const changesAsked = (
  address: Pick<AddressItem, "pullRequest" | "reviewer" | "reviewedSha">,
) =>
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
    yield* Phases.record(
      Phases.pullRequestItem(pullRequest),
      Phases.PHASES.pullRequest.reviewAskedAgain,
    );
  });

// Asks the reviewer who requested the changes to review again, which starts
// their re-review.
export const askAgain = (pullRequest: number, round: number, reviewer: string, summary: string) =>
  activity(
    `ask-again-${round}`,
    requestAgain(pullRequest, reviewer, `Addressed review ${round}: ${summary}`),
  );

// After resolve-conflicts merged the base in: when the pull request's latest
// approval or request for changes is an approval, asks its reviewer to review
// again, since they approved the code before the merge, and records
// review-asked-again. The approver, or none, with no approval to ask again.
export const askApproverAgain = (pullRequest: number) =>
  activity(
    "ask-approver-again",
    Effect.gen(function* () {
      const approval = Option.filter(
        Arr.last(yield* decisiveReviews(pullRequest)),
        (review) => review.state === "APPROVED",
      );

      if (Option.isNone(approval)) {
        return Option.none<string>();
      }

      yield* (yield* GitHub).requestReviewers(pullRequest, [approval.value.author]);
      yield* Phases.record(Phases.pullRequestItem(pullRequest), P.reviewAskedAgain);

      return Option.some(approval.value.author);
    }),
    Schema.Option(Schema.String),
  );
