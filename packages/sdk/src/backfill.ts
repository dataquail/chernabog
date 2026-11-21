// `chernabog progress backfill` (ADR 21, consequences): a record for every
// open item that a source needs one for and that holds none, inferred from
// GitHub. This is the one place that inference is allowed, once, so that the
// sources' no-record paths can go (audit S6, S7). Where GitHub's facts don't
// settle a phase, it writes nothing and lists the item for a person.
//
// The table it goes by is in docs/run-progress/audit.md, "Backfill".

import {
  claimMarker,
  Claims,
  GitHub,
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
  type SubmittedReview,
} from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { statusMarker } from "./epic.ts";
import { ADOPTED_LABEL, AWAITING_READY_LABEL } from "./implement.ts";
import { kindOf, type Observed } from "./ledger-check.ts";
import * as Phases from "./phases.ts";
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

// The first records backfill writes, each from no record, for the ledger's
// check (ADR 21, decision 5): the phases of the table in
// docs/run-progress/audit.md, "Backfill".
export const OBSERVED: ReadonlyArray<Observed> = [
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
  { by: WRITER, item: "epic", from: [Phases.NO_RECORD], to: Phases.PHASES.epic.waiting },
  // A park from before each site had a phase of its own, moved onto its own
  // (movedPark).
  {
    by: WRITER,
    item: "pull-request",
    from: [SHARED_CI],
    to: Phases.PHASES.pullRequest.awaitingFixCi,
  },
  { by: WRITER, item: "issue", from: [SHARED_CI], to: Phases.PHASES.issue.awaitingAdoptedCi },
];

// How long an adopted draft's wait lasts in a backfilled awaiting-ready
// record: the implement recipe's, and every shipped document's. The run that
// takes the wait up waits by its own setting; this is only when the source
// offers it again with the draft still a draft.
export const READY_WITHIN = Duration.days(14);

// What backfill found for one open item: a phase to write, with its data,
// if any, and the facts it read; or a person to decide, with why. A write is
// from no record, or, with `from`, from the record the survey read: a park
// moved off a phase it shared onto its site's own. Plain JSON, as the binary
// reads it from the repo's SDK (loadRepoBackfill) and hands it back to
// `apply`.
export type Finding =
  | {
      readonly kind: "write";
      readonly item: string;
      readonly phase: string;
      readonly data?: { readonly [key: string]: Json };
      readonly from?: { readonly phase: string; readonly version: string };
      readonly why: string;
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

    const bodies = (yield* github.comments(number)).map((found) => found.body);

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

    const plan = latestMarker(planMarker.read, bodies);

    return Option.some(
      Option.match(plan, {
        onNone: () =>
          person(item, `labelled ${PLAN_LABELS.proposed}, but no plan was posted on it`),
        onSome: (posted) =>
          write(
            item,
            Phases.PHASES.issue.proposed,
            `round ${posted.round}'s plan waits on a person (${PLAN_LABELS.proposed})`,
            { round: posted.round },
          ),
      }),
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
      from: { phase: found.phase, version: found.version },
      why: `parked on ${found.phase}, a phase ${site}'s wait shared`,
    }));
  });

// Every park on SHARED_CI among `all`, each moved onto its site's phase.
const movedParks = (all: ReadonlyMap<string, PhaseRecord>) =>
  [...all].flatMap(([item, found]) => Option.toArray(movedPark(item, found)));

// Every open item that holds no record and needs one, each with the phase
// to write or why a person must decide, read as the repo's personas, by its
// committed config (Repo.personas). An item with a record is left out: it is
// backfilled already, or a run recorded it.
export const survey = Effect.gen(function* () {
  const github = yield* GitHub;
  const logins = (yield* Repo).personas;
  const all = yield* Phases.records;
  const findings: Array<Finding> = movedParks(all);
  const unrecorded = (item: string) => Option.isNone(Phases.recordOf(all, item));

  for (const pull of yield* github.openPullRequests) {
    if (!unrecorded(Phases.pullRequestItem(pull.number))) {
      continue;
    }

    const reviews = yield* github.reviews(pull.number);

    if (automated(pull, reviews, logins)) {
      findings.push(yield* pullRequestFinding(pull, reviews));
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

// Writes each finding's phase, advancing from no record, or from the record
// the survey read, so an item a run recorded since the survey keeps the
// run's record (PhaseMoved), as Phases.reconcile leaves it.
export const apply = (findings: ReadonlyArray<Finding>) =>
  Effect.gen(function* () {
    const progress = yield* Progress;
    const results: Array<Written> = [];

    for (const finding of findings) {
      if (finding.kind !== "write") {
        continue;
      }

      // From the version the survey read, none or a record: an item a run
      // recorded since is a lost race, and keeps the run's record.
      const from = Option.map(Option.fromUndefinedOr(finding.from), (read) => ({
        phase: asPhase(read.phase),
        version: read.version,
      }));

      const base = { from, to: asPhase(finding.phase), by: asWriter(WRITER) };

      const transition = Option.match(Option.fromUndefinedOr(finding.data), {
        onNone: () => base,
        onSome: (data) => ({ ...base, data: asData(data) }),
      });

      const written = yield* progress.advance(finding.item, transition).pipe(
        Effect.as(true),
        Effect.catchTag("PhaseMoved", () => Effect.succeed(false)),
      );

      results.push({ finding, written });
    }

    return results;
  });
