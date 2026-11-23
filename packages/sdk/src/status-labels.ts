// Status labels are a projection of the ledger (ADR 21, decision 8): one
// projector derives an item's from its record's phase and its claim, and
// writes exactly that set onto its issue or pull request after every advance
// (Phases' recording, reconcile and every other write of a record) and every
// claim change (acquire, release, and a run's end, by core's claimLabel
// marker). No flow or block writes a status label. A label a person added or
// removed by hand is put right by the next projection. Until #570 moves them
// onto the record, two readers remain: Review.authoredByMe and
// Implement.withHistory take a pull request labelled auto:adopted as
// chernabog's, and reconcileHandedBack reads auto:needs-human's removal.
//
// Intent labels (auto:eligible, auto:plan, auto:plan-approved, auto:ship,
// auto:epic, hybrid) and every label chernabog doesn't own are never touched
// here: a person applies them, and a block removes one only to acknowledge it.

import {
  activity,
  Claims,
  GitHub,
  Markers,
  type PhaseRecord,
  Progress,
  type ProgressError,
  Repo,
  RunLog,
} from "@chernabog/core";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PHASES } from "./phase-names.ts";
import { LABELS as PLAN_LABELS } from "./plan-labels.ts";
import * as Settings from "./settings.ts";

// An issue waits on an adopted draft its author marks ready (its record's
// awaiting-ready). Not renamable: the projector's alone.
export const AWAITING_READY = "auto:awaiting-ready";

// A pull request a person opened that chernabog took on for the issue it
// closes, and answers reviews on: its record's data says so (ADOPTED_KEY).
export const ADOPTED = "auto:adopted";

// The key of a pull request's record data that says chernabog adopted it,
// carried through every phase after the hand-off (Phases.record).
export const ADOPTED_KEY = "adopted";

// The key of a review-asked record's data that says no reviewer in the pool
// could be asked, so a person is to review it (auto:needs-review).
export const UNASKED_KEY = "unasked";

// The status label names, as the flow's settings give them.
export const Names = Schema.Struct({
  ...Settings.LabelNames.fields,
  readyForPerson: Schema.String,
});

export type Names = typeof Names.Type;

export const DEFAULT_NAMES: Names = {
  ...Settings.DEFAULT_LABEL_NAMES,
  readyForPerson: Settings.READY_FOR_PERSON,
};

// The names the flow's settings give, over the repo's.
export const names = Effect.gen(function* () {
  return {
    ...(yield* Settings.labels),
    readyForPerson: yield* Settings.readyForPerson,
  } satisfies Names;
});

// Every status label: the projector's to add and remove, and nobody else's.
export const statusOf = (named: Names): ReadonlyArray<string> => [
  named.inProgress,
  named.needsReview,
  named.changesRequested,
  named.approved,
  named.needsHuman,
  named.needsClarification,
  named.stale,
  named.readyForPerson,
  AWAITING_READY,
  ADOPTED,
  PLAN_LABELS.proposed,
];

// Every intent label, which the projector never touches.
export const intentOf = (named: Names): ReadonlyArray<string> => [
  named.eligible,
  named.ship,
  named.hybrid,
  PLAN_LABELS.plan,
  PLAN_LABELS.approved,
  PLAN_LABELS.epic,
];

const ITEM = /^(issue|pr|epic)-(\d+)$/;

const Kind = Schema.Literals(["issue", "pr", "epic"]);

type Kind = typeof Kind.Type;

const parsed = (item: string): Option.Option<{ readonly kind: Kind; readonly number: number }> =>
  Option.flatMap(Option.fromNullOr(ITEM.exec(item)), (found) =>
    Option.map(Schema.decodeUnknownOption(Kind)(found[1]), (kind) => ({
      kind,
      number: Number(found[2]),
    })),
  );

// The phases at which an issue's run has let it go, though it still holds
// the claim until it ends: handed off as a pull request, waiting on answers,
// with a person, or made an epic. No in-progress label there.
const LET_GO: ReadonlyArray<string> = [
  PHASES.issue.handedOff,
  PHASES.issue.askedQuestions,
  PHASES.issue.withPerson,
  PHASES.issue.becameEpic,
];

// The label an issue's phase projects, beside in-progress.
const issueLabel = (phase: string, named: Names): ReadonlyArray<string> => {
  switch (phase) {
    case PHASES.issue.withPerson:
      return [named.needsHuman];
    case PHASES.issue.askedQuestions:
      return [named.needsClarification];
    case PHASES.issue.awaitingReady:
      return [AWAITING_READY];
    case PHASES.issue.proposed:
      return [PLAN_LABELS.proposed];
    default:
      return [];
  }
};

// The label a pull request's phase projects, beside what its data says.
const pullLabel = (phase: string, named: Names): ReadonlyArray<string> => {
  switch (phase) {
    case PHASES.pullRequest.withPerson:
      return [named.needsHuman];
    case PHASES.pullRequest.changesAsked:
      return [named.changesRequested];
    case PHASES.pullRequest.approved:
      return [named.approved];
    case PHASES.pullRequest.readyForPerson:
      return [named.readyForPerson];
    default:
      return [];
  }
};

// Whether `record`'s data says `key`.
const said = (record: PhaseRecord, key: string) =>
  Option.exists(record.data, (data) => data[key] === true);

// `label` when `shows`, none otherwise.
const when = (shows: boolean, label: string): ReadonlyArray<string> =>
  Option.toArray(Option.liftPredicate(label, () => shows));

const issueLabels = (
  record: Option.Option<PhaseRecord>,
  claim: Option.Option<Claims.Holder>,
  named: Names,
) => {
  const working =
    Option.isSome(claim) && !Option.exists(record, (found) => LET_GO.includes(found.phase));

  return [
    ...when(working, named.inProgress),
    ...Option.toArray(record).flatMap((found) => issueLabel(found.phase, named)),
  ];
};

const pullLabels = (record: Option.Option<PhaseRecord>, named: Names) =>
  Option.toArray(record).flatMap((found) => [
    ...pullLabel(found.phase, named),
    ...when(
      found.phase === PHASES.pullRequest.reviewAsked && said(found, UNASKED_KEY),
      named.needsReview,
    ),
    ...when(said(found, ADOPTED_KEY), ADOPTED),
  ]);

const epicLabels = (record: Option.Option<PhaseRecord>, named: Names) =>
  Option.toArray(record).flatMap((found) =>
    when(found.phase === PHASES.epic.withPerson, named.needsHuman),
  );

// The status labels `item` shows, by its record and the claim on it: the
// projection, pure. `claim` is a live claim's holder, none when no run holds
// the item. An item that names no issue, pull request or epic shows none.
//
// | Item         | Record or claim                                       | Label              |
// | ------------ | ----------------------------------------------------- | ------------------ |
// | issue        | claimed, but not handed-off, asked-questions,         | inProgress         |
// |              | with-person or became-epic                            |                    |
// | issue        | with-person                                           | needsHuman         |
// | issue        | asked-questions                                       | needsClarification |
// | issue        | awaiting-ready                                        | auto:awaiting-ready|
// | issue        | proposed (a plan waits on a person)                   | auto:plan-proposed |
// | pull request | with-person                                           | needsHuman         |
// | pull request | review-asked, with no reviewer to ask (UNASKED_KEY)   | needsReview        |
// | pull request | changes-asked                                         | changesRequested   |
// | pull request | approved                                              | approved           |
// | pull request | ready-for-person                                      | readyForPerson     |
// | pull request | any phase, adopted (ADOPTED_KEY)                      | auto:adopted       |
// | epic         | with-person                                           | needsHuman         |
//
// stale is a status label no phase projects, so the projector only ever
// takes it off.
export const project = (
  item: string,
  record: Option.Option<PhaseRecord>,
  claim: Option.Option<Claims.Holder>,
  named: Names = DEFAULT_NAMES,
): ReadonlyArray<string> =>
  Option.match(parsed(item), {
    onNone: () => [],
    onSome: ({ kind }) => {
      switch (kind) {
        case "issue":
          return issueLabels(record, claim, named);
        case "pr":
          return pullLabels(record, named);
        case "epic":
          return epicLabels(record, named);
      }
    },
  });

// The items whose projections share `item`'s issue or pull request: an
// issue's and the epic it became, which are one GitHub issue; a pull
// request's alone.
const sharing = (kind: Kind, number: number) => {
  if (kind === "pr") {
    return [Claims.pullRequest(number)];
  }

  return [Claims.issue(number), Claims.epic(number)];
};

// How the projector reads a record: Progress.read, or a readAll it made.
type ReadRecord = (
  item: string,
) => Effect.Effect<Option.Option<PhaseRecord>, ProgressError, Progress>;

const readOne: ReadRecord = (item) => Progress.use((progress) => progress.read(item));

// The live claim on `item` that counts, but `without`'s: only an issue's
// labels depend on its claim.
const claimOn = (item: string, without: Option.Option<string>) => {
  if (!item.startsWith("issue-")) {
    return Effect.succeedNone;
  }

  return Effect.map(Claims.liveHolder(item), (held) =>
    Option.filter(held, (found) => !Option.contains(without, found.runId)),
  );
};

// The status labels the issue or pull request numbered `number` shows: the
// projection of every item it is, by their records and the live claims on
// them, but `without`'s claim, a run letting its claim go.
const wanted = (
  kind: Kind,
  number: number,
  named: Names,
  without: Option.Option<string>,
  read: ReadRecord = readOne,
) =>
  Effect.gen(function* () {
    const shown = new Set<string>();

    for (const one of sharing(kind, number)) {
      const record = yield* read(one);
      const claim: Option.Option<Claims.Holder> = yield* claimOn(one, without);

      for (const label of project(one, record, claim, named)) {
        shown.add(label);
      }
    }

    return shown;
  });

// The labels the issue or pull request of `item` has on GitHub.
const labelsOn = (kind: Kind, number: number) =>
  GitHub.use((github) => {
    if (kind === "pr") {
      return Effect.map(github.pullRequest(number), (pull) => pull.labels);
    }

    return Effect.map(github.issue(number), (issue) => issue.labels);
  });

// How the labels of one issue or pull request differ from its projection.
export type Drift = {
  readonly item: string;
  readonly number: number;
  readonly missing: ReadonlyArray<string>;
  readonly extra: ReadonlyArray<string>;
};

// How `has`, the labels of `item`'s issue or pull request numbered
// `number`, differ from `shown`, its projection, among the status labels.
const differ = (
  item: string,
  number: number,
  named: Names,
  shown: ReadonlySet<string>,
  has: ReadonlyArray<string>,
): Drift => {
  const status = statusOf(named);

  return {
    item,
    number,
    missing: status.filter((label) => shown.has(label) && !has.includes(label)),
    extra: status.filter((label) => !shown.has(label) && has.includes(label)),
  };
};

const driftOf = (item: string, named: Names, without: Option.Option<string>) =>
  Effect.gen(function* () {
    const found = parsed(item);

    if (Option.isNone(found)) {
      return Option.none<Drift>();
    }

    const { kind, number } = found.value;
    const shown = yield* wanted(kind, number, named, without);

    return Option.some(differ(item, number, named, shown, yield* labelsOn(kind, number)));
  });

const note = (line: string) =>
  Effect.serviceOption(RunLog).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (log) => log.log(line) })),
  );

// Sets the status labels of `item`'s issue or pull request to exactly its
// projection, under `named`, leaving every other label as it is. `without`
// is a run letting its claim go, whose claim no longer counts. A projection
// that fails fails nothing: the ledger holds the item's progress, and the
// next projection writes the labels again; the run log says why.
export const sync = (item: string, named: Names, without: Option.Option<string> = Option.none()) =>
  Effect.gen(function* () {
    const github = yield* GitHub;

    for (const drift of Option.toArray(yield* driftOf(item, named, without))) {
      for (const label of drift.missing) {
        yield* github.addLabel(drift.number, label);
      }

      for (const label of drift.extra) {
        yield* github.removeLabel(drift.number, label);
      }
    }
  }).pipe(
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catch((error: { readonly message: string }) =>
      note(
        `projecting ${item}'s status labels failed; the next projection writes them: ${error.message}`,
      ),
    ),
  );

// Projects `item`'s status labels under the flow's names: after an advance.
// Where there is no GitHub, as in a tool that reads or writes only the
// ledger, there are no labels to project.
export const projectItem = (item: string) =>
  Effect.gen(function* () {
    const github = yield* Effect.serviceOption(GitHub);
    const repo = yield* Effect.serviceOption(Repo);

    if (Option.isNone(github) || Option.isNone(repo)) {
      return;
    }

    yield* Effect.flatMap(names, (named) => sync(item, named)).pipe(
      Effect.provideService(GitHub, github.value),
      Effect.provideService(Repo, repo.value),
    );
  });

// Whether the pull request numbered `number` carries auto:adopted on GitHub:
// how the first advance of a record from before records said ADOPTED_KEY
// learns that chernabog adopted it (Phases.advance). False where there is no
// GitHub, or the read fails.
export const labelledAdopted = (number: number) =>
  Effect.gen(function* () {
    const github = yield* Effect.serviceOption(GitHub);

    if (Option.isNone(github)) {
      return false;
    }

    return yield* github.value.pullRequest(number).pipe(
      Effect.map((pull) => pull.labels.includes(ADOPTED)),
      Effect.orElseSucceed(() => false),
    );
  });

// Claims `item` for this run, as Claims.acquire does, and projects its
// labels: an issue's in-progress, held as core's claimLabel, so it comes
// off however the run ends. The one way the SDK claims an item.
export const acquire = (item: string, options: Claims.AcquireOptions = {}) =>
  Effect.gen(function* () {
    const claimed = yield* Claims.acquire(item, options);

    if (!claimed.acquired) {
      return claimed;
    }

    const named = yield* names;

    for (const found of Option.toArray(
      Option.filter(parsed(item), (one) => one.kind === "issue"),
    )) {
      yield* Markers.hold(Markers.claimLabel, {
        item,
        number: found.number,
        label: named.inProgress,
      });
    }

    yield* sync(item, named);

    return claimed;
  });

// Lets go of the label claimLabel holds for this run's claim on `item`, now.
const dropClaimLabel = (item: string) =>
  Effect.gen(function* () {
    const named = yield* names;

    for (const found of Option.toArray(
      Option.filter(parsed(item), (one) => one.kind === "issue"),
    )) {
      yield* Markers.drop(Markers.claimLabel, {
        item,
        number: found.number,
        label: named.inProgress,
      });
    }
  });

// Lets go of this run's claim on `item`, as Claims.release does, and of the
// label that showed it.
export const release = (item: string) =>
  Effect.tap(Claims.release(item), () => dropClaimLabel(item));

// Lets the claim on `item` go as soon as `effect` ends, as Claims.releasing
// does (its step, `release-claim-<item>`), then the label that showed an
// issue's, in a step of its own (`release-claim-label-<item>`), so a replay
// doesn't take it off again. A wait suspends the run by interrupting it; that
// is not an ending.
export const releasing =
  (item: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Claims.releasing(item),
      Effect.onExit((exit) => {
        if (
          (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) ||
          !Option.exists(parsed(item), (one) => one.kind === "issue")
        ) {
          return Effect.void;
        }

        return activity(`release-claim-label-${item}`, dropClaimLabel(item)).pipe(Effect.ignore);
      }),
    );

const OpenPage = Schema.Array(
  Schema.Struct({
    number: Schema.Finite,
    labels: Schema.Array(Schema.Struct({ name: Schema.String })),
    pull_request: Schema.optionalKey(Schema.Unknown),
  }),
);

// GitHub lists open issues and pull requests a page at a time.
const OPEN_PAGE = 100;

// The most pages of open items read: past them, the rest aren't checked.
const OPEN_PAGES = 20;

// Every open issue and pull request, by number: whether it is a pull
// request, and its labels. One list, as GitHub's issues give both.
const openItems = Effect.gen(function* () {
  const { slug } = yield* Repo;
  const github = yield* GitHub;

  const found = new Map<
    number,
    { readonly pull: boolean; readonly labels: ReadonlyArray<string> }
  >();

  for (let page = 1; page <= OPEN_PAGES; page++) {
    const listed = Option.getOrElse(
      Schema.decodeUnknownOption(OpenPage)(
        yield* github.request(
          "GET",
          `/repos/${slug}/issues?state=open&per_page=${OPEN_PAGE}&page=${page}`,
          Option.none(),
        ),
      ),
      () => [],
    );

    for (const one of listed) {
      found.set(one.number, {
        pull: "pull_request" in one,
        labels: one.labels.map((label) => label.name),
      });
    }

    if (listed.length < OPEN_PAGE) {
      break;
    }
  }

  return found;
});

// Every open issue's and pull request's status labels that differ from its
// projection, by the repo's label names, for `chernabog doctor`: a label a
// person edited by hand, or a projection that failed. A live claim counts as
// it is. Only items with a record: the projector writes none on the others.
export const drifted = Effect.gen(function* () {
  const named = yield* names;
  const all = yield* Progress.use((progress) => progress.readAll);
  const read: ReadRecord = (item) => Effect.succeed(Option.fromUndefinedOr(all.get(item)));
  const open = yield* openItems;
  const found: Array<Drift> = [];
  const seen = new Set<number>();

  for (const item of all.keys()) {
    const one = parsed(item);

    if (Option.isNone(one) || seen.has(one.value.number)) {
      continue;
    }

    const { kind, number } = one.value;
    seen.add(number);

    const listed = Option.filter(
      Option.fromUndefinedOr(open.get(number)),
      (it) => it.pull === (kind === "pr"),
    );

    for (const it of Option.toArray(listed)) {
      const differs = differ(
        item,
        number,
        named,
        yield* wanted(kind, number, named, Option.none(), read),
        it.labels,
      );

      if (differs.missing.length > 0 || differs.extra.length > 0) {
        found.push(differs);
      }
    }
  }

  return found;
});
