// `chernabog progress backfill` (ADR 21, consequences): a record for every
// open item that a source needs one for and that holds none, inferred from
// GitHub. This is the one place that inference is allowed, once, so that the
// sources' no-record paths can go (audit S6, S7). Where GitHub's facts don't
// settle a phase, it writes nothing and lists the item for a person. It also
// copies the review a pull request's review marker names into its record,
// which the merge gate and the review flows read since #564, and the plan a
// spec's plan marker kept into its proposed record, as the blob Plan.posted
// reads since #563.
//
// The table it goes by is in docs/run-progress/audit.md, "Backfill".

import {
  claimMarker,
  Claims,
  type Comment,
  GitHub,
  isPhaseData,
  type Json,
  latestMarker,
  Phase as CorePhase,
  PhaseData,
  type PhaseRecord,
  PhaseWriter,
  planMarker,
  Progress,
  type PullRequest,
  Repo,
  reviewMarker,
  sessionMarker,
  type SubmittedReview,
} from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { statusMarker } from "./epic.ts";
import { ADOPTED_LABEL, AWAITING_READY_LABEL } from "./implement.ts";
import { kindOf, type Observed } from "./ledger-check.ts";
import * as Phases from "./phases.ts";
import { planBlob } from "./plan.ts";
import { LABELS as PLAN_LABELS } from "./plan-labels.ts";
import { holdKeysOf, ships } from "./pull-request.ts";
import { isAgentBranch } from "./review.ts";
import * as Settings from "./settings.ts";

// Who backfill's records name as their writer.
export const WRITER = "observer:backfill";

// The phase two park sites shared before each had one of its own (#566):
// implement's waits for CI on the pull request it opened and on one it
// adopted, both on the issue, and address-review's wait on its fix's CI, on
// the pull request.
const SHARED_CI = Phases.PHASES.issue.awaitingCi;

// The records backfill writes, for the ledger's check (ADR 21, decision 5):
// the first, each from no record, the phases of the table in
// docs/run-progress/audit.md, "Backfill"; a pull request's phase again,
// with the review its comment's marker names copied into its record (#564);
// and a park moved off the phase two sites shared (#566).
export const OBSERVED: ReadonlyArray<Observed> = [
  { by: WRITER, item: "pull-request", from: "same", to: "any" },
  ...[
    Phases.PHASES.pullRequest.reviewAsked,
    Phases.PHASES.pullRequest.reviewAskedAgain,
    Phases.PHASES.pullRequest.changesAsked,
    Phases.PHASES.pullRequest.approved,
    Phases.PHASES.pullRequest.draft,
    Phases.PHASES.pullRequest.mergeHeld,
  ].map((to): Observed => ({ by: WRITER, item: "pull-request", from: [Phases.NO_RECORD], to })),
  ...[Phases.PHASES.issue.awaitingReady, Phases.PHASES.issue.proposed].map((to): Observed => ({
    by: WRITER,
    item: "issue",
    from: [Phases.NO_RECORD],
    to,
  })),
  // A spec's proposed record again, with the plan its marker kept (#563).
  {
    by: WRITER,
    item: "issue",
    from: [Phases.PHASES.issue.proposed],
    to: Phases.PHASES.issue.proposed,
  },
  { by: WRITER, item: "epic", from: [Phases.NO_RECORD], to: Phases.PHASES.epic.waiting },
  // S1 and S2: the author's session, from an in-flight pull request's marker,
  // onto its issue's handed-off record, which it rewrites to keep it.
  {
    by: WRITER,
    item: "issue",
    from: [Phases.NO_RECORD, Phases.PHASES.issue.handedOff],
    to: Phases.PHASES.issue.handedOff,
  },
  // A park from before each site had a phase of its own, moved onto its own
  // (movedPark).
  {
    by: WRITER,
    item: "pull-request",
    from: [SHARED_CI],
    to: Phases.PHASES.pullRequest.awaitingFixCi,
  },
  { by: WRITER, item: "issue", from: [SHARED_CI], to: Phases.PHASES.issue.awaitingAdoptedCi },
  // An item labelled auto:needs-human is with a person, whatever it held.
  ...Phases.ITEM_KINDS.map((item): Observed => ({
    by: WRITER,
    item,
    from: [Phases.NO_RECORD, ...Phases.phasesOf(item)],
    to: Phases.PHASES.issue.withPerson,
  })),
];

// How long an adopted draft's wait lasts in a backfilled awaiting-ready
// record: the implement recipe's, and every shipped document's. The run that
// takes the wait up waits by its own setting; this is only when the source
// offers it again with the draft still a draft.
export const READY_WITHIN = Duration.days(14);

// What backfill found for one open item: a phase to write, with its data,
// if any, and the facts it read; or a person to decide, with why. A write is
// from no record, or, with `over`, from the record the survey read: a park
// moved off a phase it shared onto its site's own, or a handed-off record
// rewritten to keep the author's session a marker held beside it (S1). Plain
// JSON, as the binary reads it from the repo's SDK (loadRepoBackfill) and
// hands it back to `apply`.
export type Finding =
  | {
      readonly kind: "write";
      readonly item: string;
      readonly phase: string;
      readonly data?: { readonly [key: string]: Json };
      // Content written with the record, which its data names by hash.
      readonly blobs?: ReadonlyArray<string>;
      readonly why: string;
      // The record it moves on from, by version; left out: from no record.
      readonly over?: { readonly phase: string; readonly version: string };
    }
  | { readonly kind: "person"; readonly item: string; readonly why: string };

const write = (
  item: string,
  phase: Phases.Phase,
  why: string,
  data?: { readonly [key: string]: Json },
): Finding =>
  Option.match(Option.fromUndefinedOr(data), {
    onNone: () => ({ kind: "write", item, phase, why }),
    onSome: (found) => ({ kind: "write", item, phase, data: found, why }),
  });

const person = (item: string, why: string): Finding => ({ kind: "person", item, why });

const P = Phases.PHASES.pullRequest;

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

const isOneOf = (logins: ReadonlyArray<string>, login: string) =>
  logins.some((own) => sameLogin(own, login));

const decisive = (reviews: ReadonlyArray<SubmittedReview>) =>
  reviews.filter((review) => review.state === "APPROVED" || review.state === "CHANGES_REQUESTED");

const reviewedBy = (reviews: ReadonlyArray<SubmittedReview>, login: string) =>
  reviews.some((review) => sameLogin(review.author, login));

// Who reviewed the pull request so far, as a review-asked or draft record
// keeps it (Phases.reviewedBefore); none when nobody has.
const reviewedData = (reviews: ReadonlyArray<SubmittedReview>) =>
  Option.getOrUndefined(
    Option.map(
      Option.liftPredicate(
        Arr.dedupe(reviews.map((review) => review.author)),
        (authors) => authors.length > 0,
      ),
      (reviewed) => ({ reviewed }),
    ),
  );

const DraftState = Schema.Struct({ draft: Schema.Boolean });

// Whether GitHub says the pull request is a draft, which PullRequest leaves out.
const isDraft = (pull: PullRequest) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const repo = yield* Repo;

    const found = yield* github.request(
      "GET",
      `/repos/${repo.slug}/pulls/${pull.number}`,
      Option.none(),
    );

    return Option.exists(Schema.decodeUnknownOption(DraftState)(found), (state) => state.draft);
  });

// Whether chernabog works on the pull request: an agent wrote it, a run
// adopted it, or one of the personas is asked to review it or has.
const automated = (
  pull: PullRequest,
  reviews: ReadonlyArray<SubmittedReview>,
  logins: ReadonlyArray<string>,
) =>
  isAgentBranch(pull.headRef) ||
  pull.labels.includes(ADOPTED_LABEL) ||
  pull.requestedReviewers.some((login) => isOneOf(logins, login)) ||
  reviews.some((review) => isOneOf(logins, review.author));

// P1 to P3: a review is asked. Whether it is each asked reviewer's first is
// what review.requested and review.requestedAgain told apart by the count.
const requestedFinding = (
  item: string,
  requested: ReadonlyArray<string>,
  reviews: ReadonlyArray<SubmittedReview>,
) => {
  const again = requested.filter((login) => reviewedBy(reviews, login));
  const asked = requested.join(", ");

  if (again.length === requested.length) {
    return write(item, P.reviewAskedAgain, `${asked} asked to review again, having reviewed it`);
  }

  if (again.length > 0) {
    return person(
      item,
      `of the reviewers asked, ${again.join(", ")} reviewed it before and the rest didn't`,
    );
  }

  return Option.match(Arr.last(decisive(reviews)), {
    onNone: () =>
      write(item, P.reviewAsked, `${asked} asked for a first review`, reviewedData(reviews)),
    onSome: (review) =>
      person(
        item,
        `${asked} asked for a first review, but ${review.author} has reviewed it already`,
      ),
  });
};

// P4 and P5: a merge held for a red base, by the hold markers of the runs
// holding it; none for a pull request no run holds the merge of.
const heldFinding = (item: string, pull: PullRequest, latest: Option.Option<SubmittedReview>) =>
  Effect.gen(function* () {
    const labelNames = yield* Settings.labels;

    if (!ships(pull, labelNames) || pull.labels.includes(labelNames.needsHuman)) {
      return Option.none<Finding>();
    }

    const comments = yield* (yield* GitHub).trustedComments(pull.number);
    const keys = Arr.dedupe(holdKeysOf(comments.map((found) => found.body)));

    const approvedOnHead = Option.exists(
      latest,
      (review) => review.state === "APPROVED" && review.commitSha === pull.headSha,
    );

    if (keys.length > 1) {
      return Option.some(
        person(item, `runs of several work items hold its merge: ${keys.join(", ")}`),
      );
    }

    return Option.map(Arr.head(keys), (key) => {
      if (approvedOnHead) {
        return write(item, P.mergeHeld, `a run holds its merge (${key})`, { key });
      }

      return person(
        item,
        "a hold marker says a run holds its merge, but its latest review isn't an approval of its head",
      );
    });
  });

// P6 and P7: the latest approval or request for changes, as review.round
// recorded it.
const reviewedFinding = (item: string, pull: PullRequest, review: SubmittedReview) => {
  if (review.state === "APPROVED") {
    return write(item, P.approved, `${review.author} approved it`);
  }

  const where = Option.match(
    Option.liftPredicate(review, (found) => found.commitSha === pull.headSha),
    { onNone: () => ", and it was pushed to since", onSome: () => " on its head" },
  );

  return write(item, P.changesAsked, `${review.author} asked for changes${where}`);
};

// The latest review a persona's comment's marker names, as the pull request's
// record keeps one (Phases.reviewOf): what review.round wrote before records
// kept it (#564). This is the one place the SDK reads a review marker, once,
// to copy it into the record. The reviewer is the marker's, or, on a marker
// from before markers named one, the comment's author.
const markedReview = (pull: PullRequest, logins: ReadonlyArray<string>) =>
  Effect.map(
    GitHub.use((github) => github.trustedComments(pull.number)),
    (comments) =>
      Arr.last(
        comments
          .filter((found) => isOneOf(logins, found.author))
          .flatMap((found) =>
            Option.toArray(
              Option.map(reviewMarker.read(found.body), (marker): Phases.Reviewed => ({
                ...marker,
                reviewer: marker.reviewer ?? found.author,
              })),
            ),
          ),
      ),
  );

// `finding` with the review its pull request's marker names in its data.
const withReview = (finding: Finding, review: Option.Option<Phases.Reviewed>): Finding => {
  if (finding.kind !== "write" || Option.isNone(review)) {
    return finding;
  }

  return { ...finding, data: { ...finding.data, ...Phases.reviewData(review.value) } };
};

// One open pull request's record that keeps no review, when a persona's
// marker names one: the record's phase again, its data with the review
// copied in. None for a record of a team's own phase, or one that keeps a
// review already.
const reviewFinding = (
  item: string,
  found: PhaseRecord,
  review: Option.Option<Phases.Reviewed>,
): Option.Option<Finding> =>
  Option.flatMap(
    Option.filter(review, () => Option.isNone(Phases.reviewOf(found))),
    (marked) =>
      Option.map(
        Arr.findFirst(Object.values(P), (phase) => phase === found.phase),
        (phase) =>
          write(
            item,
            phase,
            `copies review ${marked.round}'s sha and reviewer from its review comment into its record`,
            { ...Option.getOrUndefined(found.data), ...Phases.reviewData(marked) },
          ),
      ),
  );

// The phase of one open pull request with no record, by the table's rows
// P1 to P9, in order.
const pullRequestFinding = (pull: PullRequest, reviews: ReadonlyArray<SubmittedReview>) =>
  Effect.gen(function* () {
    const item = Phases.pullRequestItem(pull.number);
    const latest = Arr.last(decisive(reviews));

    if (pull.requestedReviewers.length > 0) {
      return requestedFinding(item, pull.requestedReviewers, reviews);
    }

    const held = yield* heldFinding(item, pull, latest);

    if (Option.isSome(held)) {
      return held.value;
    }

    if (Option.isSome(latest)) {
      return reviewedFinding(item, pull, latest.value);
    }

    // P8: an agent's draft, which nobody was asked to review.
    if (isAgentBranch(pull.headRef) && (yield* isDraft(pull))) {
      return write(item, P.draft, "an agent's draft, no review asked", reviewedData(reviews));
    }

    // P9.
    return person(
      item,
      "no review is asked or given: handed to a person, or a review request was taken off",
    );
  });

// A plan a comment's marker names: its round, its comment's id, and its
// tasks, when the marker kept them, as plan.propose wrote it before records
// kept plans (#563). This is the one place the SDK reads a plan marker, once,
// to carry the plan into the spec's record.
type MarkedPlan = {
  readonly round: number;
  readonly comment: number;
  readonly plan: Option.Option<ReadonlyArray<Json>>;
};

const markedPlans = (comments: ReadonlyArray<Comment>): ReadonlyArray<MarkedPlan> =>
  comments.flatMap((found) =>
    Option.toArray(
      Option.map(planMarker.read(found.body), (marker) => ({
        round: marker.round,
        comment: found.id,
        plan: Option.fromUndefinedOr(marker.plan),
      })),
    ),
  );

// `finding` with what a spec's proposed record keeps of the marked plan:
// where a person's answer starts, after its comment, and the plan as a blob
// its data names, when the marker kept it.
type Write = Extract<Finding, { readonly kind: "write" }>;

const withPlan = (finding: Write, marked: MarkedPlan): Write => {
  const data = { ...finding.data, after: marked.comment };

  return Option.match(marked.plan, {
    onNone: () => ({ ...finding, data }),
    onSome: (tasks) => {
      const blob = planBlob(tasks);

      return { ...finding, data: { ...data, plan: blob.hash }, blobs: [blob.text] };
    },
  });
};

// The phase of one open issue with no record (I1, I2); none for one whose
// lack of a record is its phase, such as a queued one.
const issueFinding = (number: number, labels: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const item = Phases.issueItem(number);
    const awaiting = labels.includes(AWAITING_READY_LABEL);
    const proposed = labels.includes(PLAN_LABELS.proposed);

    if (!awaiting && !proposed) {
      return Option.none<Finding>();
    }

    if (awaiting && proposed) {
      return Option.some(
        person(item, `labelled both ${AWAITING_READY_LABEL} and ${PLAN_LABELS.proposed}`),
      );
    }

    const comments = yield* github.comments(number);
    const bodies = comments.map((found) => found.body);

    if (awaiting) {
      const draft = Option.flatMap(latestMarker(claimMarker.read, bodies), (marker) =>
        Option.filter(Option.fromUndefinedOr(marker.adopted), (adopted) => adopted.draft),
      );

      return Option.some(
        Option.match(draft, {
          onNone: () =>
            person(
              item,
              `labelled ${AWAITING_READY_LABEL}, but its latest claim marker adopted no draft`,
            ),
          onSome: (adopted) =>
            write(
              item,
              Phases.PHASES.issue.awaitingReady,
              `waits on adopted draft #${adopted.number} (${AWAITING_READY_LABEL})`,
              { pullRequest: adopted.number, withinMillis: Duration.toMillis(READY_WITHIN) },
            ),
        }),
      );
    }

    const plan = Arr.last(markedPlans(comments));

    return Option.some(
      Option.match(plan, {
        onNone: () =>
          person(item, `labelled ${PLAN_LABELS.proposed}, but no plan was posted on it`),
        onSome: (posted) =>
          withPlan(
            {
              kind: "write",
              item,
              phase: Phases.PHASES.issue.proposed,
              why: `round ${posted.round}'s plan waits on a person (${PLAN_LABELS.proposed})`,
              data: { round: posted.round },
            },
            posted,
          ),
      }),
    );
  });

const NamesPlan = Schema.Struct({ round: Schema.Finite, plan: Schema.String });

const Round = Schema.Struct({ round: Schema.Finite });

// I3: a spec whose proposed record names no plan, from before records
// kept plans: its record again, from its version, with the plan its round's
// marker kept carried in as a blob. None for a record that names one, or a
// spec closed, or whose marker kept none.
const planFinding = (item: string, found: PhaseRecord) =>
  Effect.gen(function* () {
    const number = Option.map(Option.fromNullOr(/^issue-(\d+)$/.exec(item)), (match) =>
      Number(match[1]),
    );

    const round = Option.map(
      Option.flatMap(found.data, Schema.decodeUnknownOption(Round)),
      (data) => data.round,
    );

    if (
      found.phase !== Phases.PHASES.issue.proposed ||
      Option.isSome(Option.flatMap(found.data, Schema.decodeUnknownOption(NamesPlan))) ||
      Option.isNone(number) ||
      Option.isNone(round)
    ) {
      return Option.none<Finding>();
    }

    const github = yield* GitHub;

    const open = yield* github.issue(number.value).pipe(
      Effect.map((issue) => issue.state !== "closed"),
      Effect.catchTag("NotFound", () => Effect.succeed(false)),
    );

    if (!open) {
      return Option.none<Finding>();
    }

    const marked = Arr.findLast(
      markedPlans(yield* github.comments(number.value)),
      (posted) => posted.round === round.value && Option.isSome(posted.plan),
    );

    return Option.map(marked, (posted): Finding =>
      withPlan(
        {
          kind: "write",
          item,
          phase: Phases.PHASES.issue.proposed,
          why: `carries round ${posted.round}'s plan from its comment into its record`,
          data: { ...Option.getOrUndefined(found.data) },
          over: { phase: found.phase, version: found.version },
        },
        posted,
      ),
    );
  });

// The phase of one open epic with no record (E1): waiting, when a run
// posted its status and a task is still open; none for an epic no run has
// worked on, or one with nothing left open, whose lack of a record is its
// phase.
const epicFinding = (number: number, logins: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const github = yield* GitHub;

    if (!(yield* github.subIssues(number)).some((task) => task.state === "open")) {
      return Option.none<Finding>();
    }

    const status = latestMarker(
      statusMarker.read,
      (yield* github.comments(number))
        .filter((found) => isOneOf(logins, found.author))
        .map((found) => found.body),
    );

    return Option.map(status, (found) =>
      write(
        Claims.epic(number),
        Phases.PHASES.epic.waiting,
        "a run posted its status, and a task is open",
        {
          fingerprint: found.fingerprint,
          tasks: { attempts: [], handedBack: [], withPerson: [] },
        },
      ),
    );
  });

// The park site of a record on SHARED_CI, by its item and data; none for
// one whose phase is its site's already.
const siteOf = (item: string, data: { readonly [key: string]: Json }) => {
  const kind = kindOf(item);

  if (Option.contains(kind, "pull-request")) {
    return Option.some(Phases.PHASES.pullRequest.awaitingFixCi);
  }

  return Option.liftPredicate(
    Phases.PHASES.issue.awaitingAdoptedCi,
    () => Option.contains(kind, "issue") && "pullRequest" in data && !("resume" in data),
  );
};

// A record parked on the phase two sites shared (SHARED_CI), as the write
// that moves it onto its own site's phase, in the same round and with the
// same data: a pull request's is address-review's wait on its fix
// (awaiting-fix-ci), and an issue's that keeps the pull request it waits on
// is implement's on an adopted one (awaiting-adopted-ci). An issue's that
// keeps none is the wait on the pull request its run opened, whose phase it
// is already. A document's park (its data's `resume`) resumes at the node it
// names whatever its phase, so it stays, but for a pull request's, whose
// site is one either way.
const movedPark = (item: string, found: PhaseRecord): Option.Option<Finding> =>
  Option.flatMap(Phases.roundOf(SHARED_CI, found.phase), (round) => {
    const data = Option.getOrElse(found.data, () => ({}));

    return Option.map(siteOf(item, data), (site): Finding => ({
      kind: "write",
      item,
      phase: Phases.inRound(site, round),
      data,
      over: { phase: found.phase, version: found.version },
      why: `parked on ${found.phase}, a phase ${site}'s wait shared`,
    }));
  });

// Every park on SHARED_CI among `all`, each moved onto its site's phase.
const movedParks = (all: ReadonlyMap<string, PhaseRecord>) =>
  [...all].flatMap(([item, found]) => Option.toArray(movedPark(item, found)));

// The item an issue labelled auto:needs-human is with a person as: its
// epic's, for an epic, else its issue's.
const issueOrEpic = (issue: { readonly number: number; readonly labels: ReadonlyArray<string> }) =>
  Option.match(
    Option.liftPredicate(issue.number, () => issue.labels.includes(PLAN_LABELS.epic)),
    { onNone: () => Phases.issueItem(issue.number), onSome: Claims.epic },
  );

// H1: an open item labelled auto:needs-human whose record isn't with-person
// is with one, from whatever it holds (ADR 21, decision 1).
const withPersonFindings = (all: ReadonlyMap<string, PhaseRecord>) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const labelNames = yield* Settings.labels;
    const why = `labelled ${labelNames.needsHuman}`;

    const items = [
      ...(yield* github.pullRequestsLabelled(labelNames.needsHuman))
        .filter((pull) => pull.state === "open")
        .map((pull) => Phases.pullRequestItem(pull.number)),
      ...(yield* github.issuesLabelled(labelNames.needsHuman))
        .filter((issue) => issue.state !== "closed")
        .map(issueOrEpic),
    ];

    return Arr.dedupe(items).flatMap((item): ReadonlyArray<Finding> => {
      const found = Phases.recordOf(all, item);

      if (Option.exists(found, (held) => held.phase === Phases.PHASES.issue.withPerson)) {
        return [];
      }

      const data = Phases.withPersonData(why, found);

      return [
        Option.match(found, {
          onNone: () => write(item, Phases.PHASES.issue.withPerson, why, data),
          onSome: (held) => ({
            kind: "write" as const,
            item,
            phase: Phases.PHASES.issue.withPerson,
            data,
            why,
            over: { phase: held.phase, version: held.version },
          }),
        }),
      ];
    });
  });

// What backfill finds for one open pull request: the review its marker names
// copied into the record it holds, or, with none, the phase to write, with
// that review; none for one that needs nothing.
const surveyPullRequest = (
  pull: PullRequest,
  all: ReadonlyMap<string, PhaseRecord>,
  logins: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const item = Phases.pullRequestItem(pull.number);
    const recorded = Phases.recordOf(all, item);

    if (Option.isSome(recorded)) {
      return reviewFinding(item, recorded.value, yield* markedReview(pull, logins));
    }

    const reviews = yield* GitHub.use((github) => github.reviews(pull.number));

    if (!automated(pull, reviews, logins)) {
      return Option.none<Finding>();
    }

    const review = yield* markedReview(pull, logins);

    return Option.some(withReview(yield* pullRequestFinding(pull, reviews), review));
  });

// I3 for every spec's record, but those with a person.
const planFindings = (all: ReadonlyMap<string, PhaseRecord>, withPerson: ReadonlySet<string>) =>
  Effect.map(
    Effect.forEach(
      [...all].filter(([item]) => !withPerson.has(item)),
      ([item, found]) => planFinding(item, found),
    ),
    (found) => found.flatMap((finding) => Option.toArray(finding)),
  );

// S1 and S2: the author's session an implement run from before the ledger
// kept it left on an open pull request, as a persona's session marker, onto
// the issue it names: its handed-off record, rewritten from the version read
// to keep the session beside the data it has (S1), or a handed-off record for
// an issue with none (S2). None for a pull request with no such marker, an
// issue whose record keeps a session for it already, or one at another phase,
// which a run has moved on since.
const sessionFinding = (
  pull: PullRequest,
  all: ReadonlyMap<string, PhaseRecord>,
  logins: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const marker = Option.filter(
      latestMarker(
        sessionMarker.read,
        (yield* (yield* GitHub).comments(pull.number))
          .filter((found) => isOneOf(logins, found.author))
          .map((found) => found.body),
      ),
      (found) => found.issue > 0,
    );

    if (Option.isNone(marker)) {
      return Option.none<Finding>();
    }

    const session = marker.value;
    const item = Phases.issueItem(session.issue);
    const why = `#${pull.number}'s session marker names #${session.issue}`;
    const found = Phases.recordOf(all, item);
    const handedOff = Phases.handedOffData(pull.number, Option.some(session));

    if (Option.isNone(found)) {
      return Option.some(write(item, Phases.PHASES.issue.handedOff, why, handedOff));
    }

    if (
      found.value.phase !== Phases.PHASES.issue.handedOff ||
      Option.isSome(Phases.authorOf(new Map([[item, found.value]]), pull.number))
    ) {
      return Option.none<Finding>();
    }

    const data = { ...Option.getOrElse(found.value.data, () => ({})), ...handedOff };

    if (!isPhaseData(data)) {
      return Option.some(
        person(item, `${why}, but the session doesn't fit beside its record's data`),
      );
    }

    return Option.some<Finding>({
      kind: "write",
      item,
      phase: Phases.PHASES.issue.handedOff,
      data,
      why,
      over: { phase: found.value.phase, version: found.value.version },
    });
  });

// What backfill finds from one open pull request: the author's session its
// marker names, onto its issue (sessionFinding), and its own record
// (surveyPullRequest); none for an item with a person, whose hand-off
// withPersonFindings writes.
const pullRequestFindings = (
  pull: PullRequest,
  all: ReadonlyMap<string, PhaseRecord>,
  logins: ReadonlyArray<string>,
  withPerson: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const session = Option.filter(
      yield* sessionFinding(pull, all, logins),
      (found) => !withPerson.has(found.item),
    );

    if (withPerson.has(Phases.pullRequestItem(pull.number))) {
      return Option.toArray(session);
    }

    return [
      ...Option.toArray(session),
      ...Option.toArray(yield* surveyPullRequest(pull, all, logins)),
    ];
  });

// Every open item that holds no record and needs one, each with the phase
// to write or why a person must decide, read as the repo's personas, by its
// committed config (Repo.personas), and every one labelled auto:needs-human
// whose record isn't with-person. Any other item with a record is left out:
// it is backfilled already, or a run recorded it; but for a pull request's
// record that keeps no review its marker names (surveyPullRequest), and a
// spec's proposed record that names no plan its marker kept (planFinding).
export const survey = Effect.gen(function* () {
  const github = yield* GitHub;
  const logins = (yield* Repo).personas;
  const all = yield* Phases.records;
  const handedOff = yield* withPersonFindings(all);
  const withPerson = new Set(handedOff.map((found) => found.item));

  const findings: Array<Finding> = [
    ...handedOff,
    ...movedParks(all).filter((moved) => !withPerson.has(moved.item)),
  ];

  const unrecorded = (item: string) =>
    Option.isNone(Phases.recordOf(all, item)) && !withPerson.has(item);

  for (const pull of yield* github.openPullRequests) {
    for (const found of yield* pullRequestFindings(pull, all, logins, withPerson)) {
      findings.push(found);
    }
  }

  const issues = Arr.dedupeWith(
    [
      ...(yield* github.issuesLabelled(AWAITING_READY_LABEL)),
      ...(yield* github.issuesLabelled(PLAN_LABELS.proposed)),
    ],
    (left, right) => left.number === right.number,
  );

  for (const issue of issues) {
    if (issue.state !== "closed" && unrecorded(Phases.issueItem(issue.number))) {
      for (const found of Option.toArray(yield* issueFinding(issue.number, issue.labels))) {
        findings.push(found);
      }
    }
  }

  for (const carried of yield* planFindings(all, withPerson)) {
    findings.push(carried);
  }

  for (const epic of yield* github.issuesLabelled(PLAN_LABELS.epic)) {
    if (epic.state !== "closed" && unrecorded(Claims.epic(epic.number))) {
      for (const found of Option.toArray(yield* epicFinding(epic.number, logins))) {
        findings.push(found);
      }
    }
  }

  return findings;
});

const asPhase = Schema.decodeSync(CorePhase);
const asWriter = Schema.decodeSync(PhaseWriter);
const asData = Schema.decodeSync(PhaseData);

// What writing found for one finding: written, or left alone because a
// record arrived after the survey read none, a run's or an earlier
// backfill's.
export type Written = {
  readonly finding: Extract<Finding, { readonly kind: "write" }>;
  readonly written: boolean;
};

// The record a finding writes over: one at the finding's phase that keeps no
// review, when the finding copies one in (reviewFinding); none otherwise, for
// a finding written from no record.
const overwritten = (finding: Finding, current: Option.Option<PhaseRecord>) =>
  Option.filter(
    current,
    (found) =>
      finding.kind === "write" &&
      found.phase === finding.phase &&
      Option.isNone(Phases.reviewOf(found)) &&
      Predicate.isNotUndefined(finding.data) &&
      Predicate.hasProperty(finding.data, "review"),
  );

// Writes each finding's phase, advancing from no record, or from the record
// the survey read, so an item a run recorded since the survey keeps the
// run's record (PhaseMoved), as Phases.reconcile leaves it. A finding that
// copies a review into a record writes over that record, while it is still
// at its phase and keeps none.
export const apply = (findings: ReadonlyArray<Finding>) =>
  Effect.gen(function* () {
    const progress = yield* Progress;
    const results: Array<Written> = [];

    for (const finding of findings) {
      if (finding.kind !== "write") {
        continue;
      }

      // From the record the survey read, by its version: for a hand-off to a
      // person, a park moved onto its site's phase, or a handed-off record
      // that keeps the author's session (S1). Else from no record:
      // an item a run recorded since is a lost race, and keeps the run's
      // record. Or from the record a review is copied into, by its version.
      const from = yield* Option.match(Option.fromUndefinedOr(finding.over), {
        onNone: () =>
          Effect.map(progress.read(finding.item), (current) =>
            Option.map(overwritten(finding, current), (found) => ({
              phase: found.phase,
              version: found.version,
            })),
          ),
        onSome: (over) => Effect.succeedSome({ phase: asPhase(over.phase), version: over.version }),
      });

      const base = {
        from,
        to: asPhase(finding.phase),
        by: asWriter(WRITER),
        blobs: finding.blobs ?? [],
      };

      const transition = Option.match(Option.fromUndefinedOr(finding.data), {
        onNone: () => base,
        onSome: (data) => ({ ...base, data: asData(data) }),
      });

      const written = yield* Phases.advance(finding.item, transition).pipe(
        Effect.as(true),
        Effect.catchTag("PhaseMoved", () => Effect.succeed(false)),
      );

      results.push({ finding, written });
    }

    return results;
  });
