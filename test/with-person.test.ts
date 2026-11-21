// "With a person" is a ledger phase (ADR 21, decision 1): every hand-off to a
// person records with-person {why, from}, and auto:needs-human is that
// record's projection. A trusted person taking the label off is intent,
// which observer:handed-back records as handed-back; anyone else's removal
// changes nothing. Backfill gives every labelled item its with-person record.

import {
  activity,
  type FlowError,
  type Json,
  type PhaseRecord,
  type WorkflowServices,
} from "@chernabog/core";
import {
  Backfill,
  Blocks,
  Claims,
  DEFAULT_LABELS,
  defineFlow,
  GitHub,
  Implement,
  Ledger,
  Phases,
  Plan,
  PullRequest,
  Stack,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { effect } from "./effect-test.ts";
import { EARLIER_RUN } from "./progress-fake.ts";
import { type Fake, ISSUE, item, makeFake, onFake, PULL, repo, runToEnd } from "./sdk-fakes.ts";

const ISSUE_ITEM = Phases.issueItem(ISSUE);
const PR_ITEM = Phases.pullRequestItem(PULL);
const WITH_PERSON = "with-person";
const HANDED_BACK = "handed-back";
const SLUG = "dataquail/demo";
const PERSON = "a-maintainer";
const STRANGER = "a-stranger";

// A run of a flow whose workflow is `step`, its failures the run's.
const runStep = <A>(fake: Fake, step: Effect.Effect<A, FlowError, WorkflowServices>) =>
  runToEnd(
    flowHandle(
      repo,
      "hand-off",
      defineFlow({
        trigger: Effect.succeed([]),
        workflow: () => step.pipe(Effect.as("done")),
      }),
    ),
    fake,
    item("issue"),
  );

const recordOf = (fake: Fake, name: string) => Option.fromUndefinedOr(fake.records().get(name));

const dataOf = (fake: Fake, name: string) =>
  Option.flatMap(recordOf(fake, name), (found) => found.data);

// What `name`'s with-person record says: why, and the phase it left.
const withPersonOf = (fake: Fake, name: string) =>
  Option.flatMap(dataOf(fake, name), Schema.decodeUnknownOption(Phases.WithPerson));

const said = (why: string, from?: string) =>
  Option.some({ why, from: Option.fromUndefinedOr(from) });

const HandedBackData = Schema.Struct({ from: Schema.OptionFromNullOr(Schema.String) });

// The phase a handed-back record says the item went to a person from.
const handedBackFrom = (fake: Fake, name: string) =>
  Option.map(
    Option.flatMap(dataOf(fake, name), Schema.decodeUnknownOption(HandedBackData)),
    (data) => data.from,
  );

describe("every hand-off to a person records with-person", () => {
  effect("Implement.handToHuman: the issue and its pull request, with why and from", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.recordPhase(PR_ITEM, "review-asked");

      yield* runStep(fake, Implement.handToHuman(ISSUE, "the agent gave up", Option.some(PULL)));

      expect(fake.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
      expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
      expect(withPersonOf(fake, ISSUE_ITEM)).toEqual(said("the agent gave up"));
      expect(withPersonOf(fake, PR_ITEM)).toEqual(said("the agent gave up", "review-asked"));
      expect(fake.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.needsHuman);
      expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
    }),
  );

  effect("PullRequest.handToPerson: the pull request", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");

      const finished = yield* runStep(fake, PullRequest.handToPerson(PULL, "a dispute"));

      expect(finished.status).toBe("needs-human");
      expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
      expect(withPersonOf(fake, PR_ITEM)).toEqual(said("a dispute"));
      expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
    }),
  );

  effect("Plan.handToHuman: the spec, from the plan it hands back", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.recordPhase(ISSUE_ITEM, "proposed");

      yield* runStep(fake, Plan.handToHuman(ISSUE, "nobody answered"));

      expect(fake.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
      expect(withPersonOf(fake, ISSUE_ITEM)).toEqual(said("nobody answered", "plan-handed-back"));
      expect(fake.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.needsHuman);
    }),
  );

  effect("Stack.refreshToPerson, an epic's layer: the layer's pull request", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");

      yield* runStep(fake, Stack.refreshToPerson(PULL, "layer-1", "the refresh conflicts"));

      expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
      expect(fake.labelsOf(PULL)).toContain(DEFAULT_LABELS.needsHuman);
    }),
  );

  effect("a plan's human task is with a person when it's created, besides its label", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");

      const node = (key: string, kind: string) => ({
        key,
        title: `${key}'s task`,
        body: "",
        kind,
        blockedBy: [],
      });

      yield* runStep(
        fake,
        activity("plan", Plan.create(ISSUE, [node("decide", "human"), node("build", "auto")])),
      );

      const made = [...fake.graph.made.values()];

      const issueFor = (key: string) =>
        Option.getOrThrow(
          Option.fromUndefinedOr(made.find((found) => found.title === `${key}'s task`)),
        ).number;

      const human = Phases.issueItem(issueFor("decide"));
      expect(fake.phases()[human]).toBe(WITH_PERSON);
      expect(withPersonOf(fake, human)).toEqual(said(Plan.PERSONS_TASK));
      expect(fake.labelsOf(issueFor("decide"))).toEqual([DEFAULT_LABELS.needsHuman]);
      expect(fake.phases()[Phases.issueItem(issueFor("build"))]).toBeUndefined();
    }),
  );

  effect("a hand-off records no second with-person over one already there", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");

      yield* runStep(fake, Implement.handToHuman(ISSUE, "first", Option.none()));
      yield* runStep(fake, Implement.handToHuman(ISSUE, "second", Option.none()));

      expect(withPersonOf(fake, ISSUE_ITEM)).toEqual(said("first"));
    }),
  );
});

// The fake's GitHub, with the events GitHub lists for each issue or pull
// request and each login's permission on the repo ("read" for any other).
const withEvents = <A, E, R>(
  fake: Fake,
  events: ReadonlyMap<number, ReadonlyArray<Json>>,
  permissions: ReadonlyMap<string, string>,
  effectOf: Effect.Effect<A, E, R>,
) =>
  onFake(
    fake,
    Effect.gen(function* () {
      const github = yield* GitHub;

      const answer = (path: string): Option.Option<Json> =>
        Option.orElse(
          Option.map(
            Option.fromNullOr(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/events/.exec(path)),
            (found): Json => [...(events.get(Number(found[1])) ?? [])],
          ),
          () =>
            Option.map(
              Option.fromNullOr(
                new RegExp(`^/repos/${SLUG}/collaborators/([^/]+)/permission$`).exec(path),
              ),
              (found): Json => ({
                permission: Option.getOrElse(
                  Option.fromUndefinedOr(permissions.get(decodeURIComponent(String(found[1])))),
                  () => "read",
                ),
              }),
            ),
        );

      return yield* effectOf.pipe(
        Effect.provideService(
          GitHub,
          GitHub.of({
            ...github,
            request: (method, path, body) =>
              Option.match(
                Option.filter(answer(path), () => method === "GET"),
                {
                  onNone: () => github.request(method, path, body),
                  onSome: (found) => Effect.succeed(found),
                },
              ),
          }),
        ),
      );
    }),
  );

const unlabeled = (login: string, label: string = DEFAULT_LABELS.needsHuman): Json => ({
  event: "unlabeled",
  label: { name: label },
  actor: { login },
});

const PERMISSIONS = new Map([
  [PERSON, "write"],
  [STRANGER, "read"],
]);

const NOBODY = new Map<string, string>();

const on = (number: number, ...found: ReadonlyArray<Json>) =>
  new Map<number, ReadonlyArray<Json>>([[number, found]]);

// The issue, with a person: as a run handed it over, then its label as `labels`.
const withPerson = (labels: ReadonlyArray<string>) => {
  const fake = makeFake("approve");
  fake.recordPhase(ISSUE_ITEM, WITH_PERSON, { data: { why: "stuck", from: "awaiting-ci" } });
  fake.setLabels(ISSUE, [...labels]);

  return fake;
};

describe("handing an item back is the intent of a trusted person", () => {
  effect("a trusted person removed the label: handed-back, by the observer, with from", () =>
    Effect.gen(function* () {
      const fake = withPerson([]);

      yield* withEvents(
        fake,
        on(ISSUE, unlabeled(PERSON)),
        PERMISSIONS,
        Phases.reconcileHandedBack,
      );

      const found = Option.getOrThrow(recordOf(fake, ISSUE_ITEM));
      expect<string>(found.phase).toBe(HANDED_BACK);
      expect<string>(found.by).toBe("observer:handed-back");
      expect<Option.Option<string>>(found.from).toEqual(Option.some(WITH_PERSON));
      expect(handedBackFrom(fake, ISSUE_ITEM)).toEqual(Option.some(Option.some("awaiting-ci")));
    }),
  );

  effect("a persona's removal counts too", () =>
    Effect.gen(function* () {
      const fake = withPerson([]);

      yield* withEvents(
        fake,
        on(ISSUE, unlabeled("chernabog-bot")),
        NOBODY,
        Phases.reconcileHandedBack,
      );

      expect(fake.phases()[ISSUE_ITEM]).toBe(HANDED_BACK);
    }),
  );

  effect("a label removed by an untrusted user changes nothing", () =>
    Effect.gen(function* () {
      const fake = withPerson([]);

      yield* withEvents(
        fake,
        on(ISSUE, unlabeled(STRANGER)),
        PERMISSIONS,
        Phases.reconcileHandedBack,
      );

      expect(fake.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
    }),
  );

  effect("the last removal decides: a trusted one before a stranger's changes nothing", () =>
    Effect.gen(function* () {
      const fake = withPerson([]);

      yield* withEvents(
        fake,
        on(ISSUE, unlabeled(PERSON), unlabeled(STRANGER)),
        PERMISSIONS,
        Phases.reconcileHandedBack,
      );

      expect(fake.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
    }),
  );

  effect("an item still labelled, or with no removal GitHub lists, stays with a person", () =>
    Effect.gen(function* () {
      const labelled = withPerson([DEFAULT_LABELS.needsHuman]);
      yield* withEvents(
        labelled,
        on(ISSUE, unlabeled(PERSON)),
        PERMISSIONS,
        Phases.reconcileHandedBack,
      );
      expect(labelled.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);

      const unlisted = withPerson([]);
      yield* withEvents(
        unlisted,
        on(ISSUE, unlabeled(PERSON, DEFAULT_LABELS.eligible)),
        PERMISSIONS,
        Phases.reconcileHandedBack,
      );
      expect(unlisted.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
    }),
  );

  effect("a pull request a trusted person took the label off is handed back", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.recordPhase(PR_ITEM, WITH_PERSON, {
        data: Phases.withPersonData("a dispute", Option.none()),
      });

      yield* withEvents(fake, on(PULL, unlabeled(PERSON)), PERMISSIONS, Phases.reconcileHandedBack);

      expect(fake.phases()[PR_ITEM]).toBe(HANDED_BACK);
      expect(handedBackFrom(fake, PR_ITEM)).toEqual(Option.some(Option.none()));
    }),
  );
});

const passes = (name: string, found: PhaseRecord) =>
  Option.isNone(Ledger.check(Blocks.transitions, ["chernabog-bot"])(name, found));

describe("the ledger's check knows with-person and handed-back", () => {
  effect("a run records with-person from any phase; the observer only handed-back from it", () =>
    Effect.sync(() => {
      const fake = makeFake("approve");
      fake.recordPhase(PR_ITEM, "approved");
      fake.recordPhase(PR_ITEM, WITH_PERSON);
      fake.recordPhase(Claims.epic(ISSUE), WITH_PERSON);
      fake.recordPhase(ISSUE_ITEM, WITH_PERSON);
      fake.recordPhase(ISSUE_ITEM, HANDED_BACK, { by: "observer:handed-back" });

      for (const name of [PR_ITEM, Claims.epic(ISSUE), ISSUE_ITEM]) {
        expect(passes(name, Option.getOrThrow(recordOf(fake, name)))).toBe(true);
      }

      fake.recordPhase(ISSUE_ITEM, "awaiting-ci", { by: EARLIER_RUN });
      fake.recordPhase(ISSUE_ITEM, HANDED_BACK, { by: "observer:handed-back" });
      expect(passes(ISSUE_ITEM, Option.getOrThrow(recordOf(fake, ISSUE_ITEM)))).toBe(false);
    }),
  );
});

describe("progress backfill's items with a person", () => {
  effect("an open item labelled auto:needs-human with no with-person record gets one", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.setLabels(ISSUE, [DEFAULT_LABELS.needsHuman]);
      fake.setLabels(PULL, [DEFAULT_LABELS.needsHuman]);
      fake.recordPhase(PR_ITEM, "review-asked");

      const findings = yield* onFake(fake, Backfill.survey);
      const written = yield* onFake(fake, Backfill.apply(findings));

      expect(written.every((each) => each.written)).toBe(true);
      expect(fake.phases()[ISSUE_ITEM]).toBe(WITH_PERSON);
      expect(fake.phases()[PR_ITEM]).toBe(WITH_PERSON);
      expect(withPersonOf(fake, PR_ITEM)).toEqual(
        said("labelled auto:needs-human", "review-asked"),
      );
      expect(Option.map(recordOf(fake, ISSUE_ITEM), (found): string => found.by)).toEqual(
        Option.some("observer:backfill"),
      );

      for (const name of [ISSUE_ITEM, PR_ITEM]) {
        expect(passes(name, Option.getOrThrow(recordOf(fake, name)))).toBe(true);
      }

      expect(yield* onFake(fake, Backfill.survey)).toEqual([]);
    }),
  );

  effect("an item recorded with-person already, or unlabelled, is left alone", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      fake.setLabels(ISSUE, [DEFAULT_LABELS.needsHuman]);
      fake.recordPhase(ISSUE_ITEM, WITH_PERSON);

      const findings = yield* onFake(fake, Backfill.survey);

      expect(findings.filter((found) => found.item === ISSUE_ITEM)).toEqual([]);
      expect(findings.filter((found) => found.item === PR_ITEM)).not.toContainEqual(
        expect.objectContaining({ phase: WITH_PERSON }),
      );
    }),
  );
});
