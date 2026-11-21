// The check a source makes of a phase record before it acts on it (ADR 21,
// decision 5): that its writer is one chernabog knows, and that its
// transition is one the catalogue declares. A record that fails either is an
// anomaly: the source doesn't act on it, and the item is held for a person,
// with the record named. This is what every ledger adapter can give; only a
// hosted one could refuse the write instead.
//
// This module holds the check alone, given a catalogue. The catalogue itself
// is the blocks' and sources' declarations, which ledger.ts gathers; this one
// imports none of them, so blocks.ts can use it.

import { Claims, type PhaseRecord, Repo, type WorkItem } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type Anomaly,
  Checking,
  ciRoundOf,
  conflictCiRoundOf,
  type ItemKind,
  NO_RECORD,
  PHASES,
  phasesOf,
  type Reading,
} from "./phases.ts";

export type { Anomaly } from "./phases.ts";

// A transition a writer outside a run records, as the catalogue declares it:
// a source's reconcile (`observer:<source>`), backfill's first records, or a
// person's acknowledgement.
export type Observed = {
  readonly by: string;
  readonly item: ItemKind;
  // The phases it moves on from, NO_RECORD for an item with none; `same`: only
  // from the phase it records, as an acknowledgement records the phase again.
  readonly from: ReadonlyArray<string> | "same";
  // The phase it records; `any`: whichever phase the item holds (with `same`).
  readonly to: string;
};

// What the check goes by. A run, and a persona writing as itself, may record
// any of the SDK's phases of the item's kind, since progress.advance records
// whichever its document names, and any phase of a team's own; `observed` is
// every other writer's, each only its own transitions.
export type Catalogue = {
  readonly observed: ReadonlyArray<Observed>;
};

// The writer a person's acknowledgement of an anomaly names (ledger.ts,
// acknowledge): the record says again what the item holds, by a writer the
// check knows.
export const ACKNOWLEDGED = "observer:acknowledged";

// A run's id, as the daemon and `ci run` mint one: a random UUID. A run's id
// names no persona; the account that wrote the record is the store's to
// prove, which a hosted adapter does and the git adapter can't.
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isRunWriter = (by: string) => RUN_ID.test(by);

const ITEM_KINDS_BY_PREFIX: ReadonlyArray<readonly [string, ItemKind]> = [
  [Claims.issue(0).slice(0, -1), "issue"],
  [Claims.pullRequest(0).slice(0, -1), "pull-request"],
  [Claims.epic(0).slice(0, -1), "epic"],
];

// The kind of item a record is kept for, from its name (`issue-12`, `pr-7`,
// `epic-4`); none for a team's own item.
export const kindOf = (item: string): Option.Option<ItemKind> =>
  Option.map(
    Arr.findFirst(
      ITEM_KINDS_BY_PREFIX,
      ([prefix]) => item.startsWith(prefix) && /^\d+$/.test(item.slice(prefix.length)),
    ),
    ([, kind]) => kind,
  );

// A phase as the catalogue declares it: a later round's wait for CI
// (`awaiting-ci-2`, `awaiting-conflict-ci-3`) is its first round's phase.
export const declaredAs = (phase: string) => {
  if (Option.isSome(ciRoundOf(phase))) {
    return PHASES.issue.awaitingCi;
  }

  if (Option.isSome(conflictCiRoundOf(phase))) {
    return PHASES.pullRequest.awaitingConflictCi;
  }

  return phase;
};

const SDK_PHASES = new Set<string>([
  ...phasesOf("issue"),
  ...phasesOf("pull-request"),
  ...phasesOf("epic"),
]);

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

const listed = (phases: ReadonlyArray<string>) => phases.join(", ");

// What is wrong with a run's, or a persona's, record: a phase of the SDK's
// that isn't one of the item's kind, such as an epic's `waiting` on a pull
// request. A phase that isn't the SDK's is a team's own, which the repo
// names, and passes, as does any phase on an item of a team's own.
const runTransition = (item: string, record: PhaseRecord): Option.Option<string> =>
  Option.flatMap(kindOf(item), (kind) => {
    const phase = declaredAs(record.phase);

    if (!SDK_PHASES.has(phase) || phasesOf(kind).includes(phase)) {
      return Option.none();
    }

    return Option.some(`${record.phase} isn't a phase of a ${kind}`);
  });

// What is wrong with an observer's record: its writer records no such
// transition. None when one of its declared transitions is this one.
const observedTransition = (
  item: string,
  record: PhaseRecord,
  declared: ReadonlyArray<Observed>,
): Option.Option<string> => {
  const kind = kindOf(item);
  const phase = declaredAs(record.phase);
  const from = Option.getOrElse(Option.map(record.from, declaredAs), () => NO_RECORD);

  const fits = (observed: Observed) => {
    const ofKind = Option.match(kind, {
      onNone: () => true,
      onSome: (found) => found === observed.item,
    });

    if (observed.from === "same") {
      return ofKind && Option.contains(record.from, record.phase);
    }

    return ofKind && observed.to === phase && observed.from.includes(from);
  };

  if (declared.some(fits)) {
    return Option.none();
  }

  const transitions = declared.map((observed) => {
    if (observed.from === "same") {
      return `a ${observed.item}'s phase again`;
    }

    return `${observed.item} ${observed.to} from ${listed(observed.from)}`;
  });

  return Option.some(
    `${record.by} records only ${listed(transitions)}, not ${Option.getOrElse(record.from, () => NO_RECORD)} -> ${record.phase}`,
  );
};

// The anomaly a source holds `item` for, its record named, and why.
export const anomalyOf = (item: string, record: PhaseRecord, why: string): Anomaly => ({
  item,
  phase: record.phase,
  ...Option.match(record.from, { onNone: () => ({}), onSome: (from) => ({ from }) }),
  by: record.by,
  version: record.version,
  why,
});

// Why `record`, the record of `item`, is an anomaly, or none when it passes:
// its writer is one of `personas`, a run, or an observer the catalogue
// declares, and its transition is one that writer may record.
export const check =
  (catalogue: Catalogue, personas: ReadonlyArray<string>) =>
  (item: string, record: PhaseRecord): Option.Option<Anomaly> => {
    const declared = catalogue.observed.filter((observed) => observed.by === record.by);
    const asRun = isRunWriter(record.by) || personas.some((login) => sameLogin(login, record.by));

    const why = Option.orElse(
      Option.liftPredicate(
        `its writer, ${record.by}, is none of the repo's personas, a run or an observer chernabog writes as`,
        () => !asRun && declared.length === 0,
      ),
      () => {
        if (asRun) {
          return runTransition(item, record);
        }

        return observedTransition(item, record, declared);
      },
    );

    return Option.map(why, (said) => anomalyOf(item, record, said));
  };

// The record an anomaly names, as a person reads it: its version, its
// transition and its writer.
export const recordNamed = (anomaly: Anomaly) =>
  `record ${anomaly.version.slice(0, 7)} (${anomaly.from ?? NO_RECORD} -> ${anomaly.phase}, by ${anomaly.by})`;

// Why a source holds an item: the record it won't act on, and what a person can do.
export const heldFor = (anomaly: Anomaly) =>
  `${anomaly.item}'s ${recordNamed(anomaly)} is an anomaly: ${anomaly.why}. Record its phase again as a persona, or acknowledge it with chernabog progress anomalies --acknowledge`;

const IssueWork = Schema.Struct({ issue: Schema.Finite });
const PullRequestWork = Schema.Struct({ pullRequest: Schema.Finite });

// The records a work item is about, by its data: its pull request's, and its
// issue's and the epic's of it.
const itemsOf = (work: WorkItem): ReadonlyArray<string> => [
  ...Option.toArray(
    Option.map(Schema.decodeUnknownOption(PullRequestWork)(work.data), (found) =>
      Claims.pullRequest(found.pullRequest),
    ),
  ),
  ...Option.toArray(Schema.decodeUnknownOption(IssueWork)(work.data)).flatMap((found) => [
    Claims.issue(found.issue),
    Claims.epic(found.issue),
  ]),
];

const AnomalyWork = Schema.Struct({ anomaly: Schema.String });

// The item a held anomaly was reported as, when no source reported its item.
export const anomalyKey = (anomaly: Anomaly) =>
  `${anomaly.item}-anomaly-${anomaly.version.slice(0, 7)}`;

// The anomaly a work item reports alone, if it is one (checking).
export const anomalyOfWork = (work: WorkItem): Option.Option<string> =>
  Option.map(Schema.decodeUnknownOption(AnomalyWork)(work.data), (found) => found.anomaly);

// Whether a flow that reads `reads` would act on the item the anomaly is
// about: its record moved the item to, or from, a phase the flow reads.
const readBy = (reads: ReadonlyArray<Reading>, anomaly: Anomaly) =>
  Option.exists(kindOf(anomaly.item), (kind) =>
    reads.some(
      (reading) =>
        reading.item === kind &&
        [anomaly.phase, ...Option.toArray(Option.fromUndefinedOr(anomaly.from))].some((phase) =>
          reading.phases.some((read) => read === declaredAs(phase)),
        ),
    ),
  );

// `trigger`, with every record its sources read through Phases.records and
// Phases.current checked against `catalogue`. A source never sees an
// anomaly's record, so it doesn't act on it: an item it reports that the
// record is about is held, with the record named; an anomaly it didn't
// report, on a phase its flow reads (`reads`, what the flow's sources and
// wakes declare), is reported alone, held. A held item starts no run and
// comments nowhere, so the same anomaly says the same thing on every tick,
// and `chernabog status` shows it. The check holds an item; it never fails
// the tick.
export const checking =
  (catalogue: Catalogue, reads: ReadonlyArray<Reading>) =>
  <E, R>(
    trigger: Effect.Effect<ReadonlyArray<WorkItem>, E, R>,
  ): Effect.Effect<ReadonlyArray<WorkItem>, E, R | Repo> =>
    Effect.gen(function* () {
      // The repo's personas, as its committed config lists them: the same
      // set on every machine and in CI.
      const { personas } = yield* Repo;
      const noted = new Map<string, Anomaly>();
      const judge = check(catalogue, personas);

      const found = yield* trigger.pipe(
        Effect.provideService(Checking, Option.some({ check: judge, noted })),
      );

      const reported = new Set<string>();

      const held = found.map((work) => {
        const anomaly = Arr.findFirst(itemsOf(work), (item) => noted.has(item)).pipe(
          Option.flatMap((item) => Option.fromUndefinedOr(noted.get(item))),
        );

        return Option.match(anomaly, {
          onNone: () => work,
          onSome: (named) => {
            reported.add(named.item);

            return { ...work, held: heldFor(named) };
          },
        });
      });

      const alone = [...noted.values()].flatMap((anomaly): ReadonlyArray<WorkItem> =>
        Arr.filter(
          [
            {
              key: anomalyKey(anomaly),
              title: `${anomaly.item}: an anomaly in its record`,
              data: { anomaly: anomaly.item },
              held: heldFor(anomaly),
            },
          ],
          () => !reported.has(anomaly.item) && readBy(reads, anomaly),
        ),
      );

      return [...held, ...alone];
    });
