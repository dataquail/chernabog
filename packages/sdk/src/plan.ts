// The building blocks of the `plan` recipe: the agent reads a spec issue and
// the code, and proposes the tasks the spec splits into and which blocks
// which; the code checks the plan and adds a verify task, a person approves it
// on the spec, and the spec becomes an epic of sub-issues, each linked to what
// blocks it. The agent answers with data only: each task's labels decide which
// of the repo's flows picks it up.

import { createHash } from "node:crypto";

import {
  activity,
  Agent,
  BlobHash,
  type Comment,
  type FlowLabel,
  GitHub,
  hasMarker,
  type Issue,
  type Json,
  NeedsHuman,
  type PhaseRecord,
  planMarker,
  planNodeMarker,
  Progress,
  Repo,
  Run,
  StepFailed,
  type WorkItem,
  Worktree,
} from "@chernabog/core";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  askForClarification as askImplementClarification,
  branchFor,
  issueItem,
  issueOf,
  routed,
  sessionIdFor,
} from "./implement.ts";
import * as Phases from "./phases.ts";
import { LABELS } from "./plan-labels.ts";
import { renderPrompt } from "./prompt.ts";
import * as Settings from "./settings.ts";
import { issueValidity } from "./still-valid.ts";

// Whether the spec is still this run's to plan, for a flow's stillValid: it
// is open, and no other run holds its claim.
export const stillValid = (item: WorkItem) =>
  issueOf(item).pipe(Effect.flatMap((spec) => issueValidity(spec, { pullRequest: false })));

// The labels of a plan's life on its spec: queued, proposed and waiting on a
// person, approved, and made into an epic.
export { LABELS };

// For a flow's `labels`, so `chernabog labels` creates them.
export const flowLabels: ReadonlyArray<FlowLabel> = [
  {
    name: LABELS.plan,
    color: "5319e7",
    description: "Chernabog drafts a plan of sub-issues for this spec",
  },
  {
    name: LABELS.proposed,
    color: "fbca04",
    description: "A plan is posted on this spec and waits for a person",
  },
  {
    name: LABELS.approved,
    color: "0e8a16",
    description: "A person approved the plan: Chernabog makes its sub-issues",
  },
  { name: LABELS.epic, color: "3e4b9e", description: "An epic of sub-issues a plan made" },
];

// Who takes a task: an agent unattended (auto:eligible), a person with an
// agent (`chernabog start`), or a person alone, for a decision (auto:needs-human).
export const Kind = Schema.Literals(["auto", "hybrid", "human"]);

export type Kind = typeof Kind.Type;

const isKind = Schema.is(Kind);

// One task. `kind` is checked in code rather than by the schema, so a plan
// with an unknown kind goes back to the agent instead of failing the step.
export const PlanNode = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  body: Schema.String,
  kind: Schema.String,
  blockedBy: Schema.Array(Schema.String),
});

export type PlanNode = typeof PlanNode.Type;

export const Plan = Schema.Array(PlanNode);

export type Plan = typeof Plan.Type;

export const PlanDraft = Schema.Struct({
  status: Schema.Literals(["plan", "needs-clarification"]),
  summary: Schema.String,
  nodes: Plan,
  questions: Schema.optionalKey(Schema.String),
});

export type PlanDraft = typeof PlanDraft.Type;

export const planDraftJsonSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["plan", "needs-clarification"] },
    summary: {
      type: "string",
      description: "The plan in two or three sentences: how the work splits and why in this order",
    },
    nodes: {
      type: "array",
      description: "The tasks, each one reviewable pull request; empty for needs-clarification",
      items: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Stable within the plan: lowercase letters, digits and dashes",
          },
          title: { type: "string", description: "The issue title" },
          body: {
            type: "string",
            description: "The issue body in Markdown: what to do, and its acceptance criteria",
          },
          kind: { type: "string", enum: ["auto", "hybrid", "human"] },
          blockedBy: {
            type: "array",
            items: { type: "string" },
            description: "Keys of the tasks that must land before this one starts",
          },
        },
        required: ["key", "title", "body", "kind", "blockedBy"],
        additionalProperties: false,
      },
    },
    questions: {
      type: "string",
      description: "For needs-clarification: numbered questions, each led by a recommendation",
    },
  },
  required: ["status", "summary", "nodes"],
  additionalProperties: false,
} satisfies Json;

// The task the code adds last, blocked by every other.
export const VERIFY = "verify";

const KEY = /^[a-z0-9][a-z0-9-]*$/;

const sizeProblems = (size: number, limit: number) => {
  if (size === 0) {
    return ["the plan has no tasks"];
  }

  if (size > limit) {
    return [`the plan has ${size} tasks, and may have at most ${limit}`];
  }

  return [];
};

const keyProblems = (keys: ReadonlyArray<string>) => {
  const repeated = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];

  return [
    ...repeated.map((key) => `key \`${key}\` names more than one task`),
    ...keys.flatMap((key) => {
      if (key === VERIFY) {
        return [`key \`${VERIFY}\` is kept for the verify task Chernabog adds`];
      }

      if (!KEY.test(key)) {
        return [`key \`${key}\` must be lowercase letters, digits and dashes`];
      }

      return [];
    }),
  ];
};

const nodeProblems = (node: PlanNode, known: ReadonlySet<string>) => [
  ...Option.toArray(
    Option.liftPredicate(
      `task \`${node.key}\` has kind \`${node.kind}\`; it must be auto, hybrid or human`,
      () => !isKind(node.kind),
    ),
  ),
  ...Option.toArray(
    Option.liftPredicate(`task \`${node.key}\` has no title`, () => node.title.trim() === ""),
  ),
  ...node.blockedBy
    .filter((blocker) => !known.has(blocker))
    .map((blocker) => `task \`${node.key}\` is blocked by \`${blocker}\`, which no task is`),
];

// The tasks that never become free to start, by taking away, round by round,
// those whose blockers have all been taken away.
const cycleProblems = (nodes: Plan, known: ReadonlySet<string>) => {
  const waiting = new Map(
    nodes.map((node) => [node.key, node.blockedBy.filter((blocker) => known.has(blocker))]),
  );

  for (let freed = true; freed;) {
    freed = false;

    for (const [key, blockers] of waiting) {
      if (blockers.every((blocker) => !waiting.has(blocker))) {
        waiting.delete(key);
        freed = true;
      }
    }
  }

  if (waiting.size === 0) {
    return [];
  }

  return [
    `blockedBy forms a cycle among ${[...waiting.keys()].map((key) => `\`${key}\``).join(", ")}`,
  ];
};

// What is wrong with a plan, if anything: its size, keys that repeat or
// can't be used, unknown kinds, blockers no task is, and cycles.
export const checkPlan = (nodes: Plan, limit: number): ReadonlyArray<string> => {
  const known = new Set(nodes.map((node) => node.key));

  return [
    ...sizeProblems(nodes.length, limit),
    ...keyProblems(nodes.map((node) => node.key)),
    ...nodes.flatMap((node) => nodeProblems(node, known)),
    ...cycleProblems(nodes, known),
  ];
};

const HEADING = /^(#{1,6})\s/;

const headingLevel = (line: string) =>
  Option.map(Option.fromNullishOr(HEADING.exec(line)), (match) => match[1].length);

// The spec's section headed "Acceptance criteria", up to the next heading at
// its level or above. None when the spec has no such heading.
export const acceptanceCriteria = (body: string): Option.Option<string> => {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^#{1,6}\s+acceptance criteria/i.test(line.trim()));

  return Option.flatMap(
    Option.liftPredicate(start, (found) => found >= 0),
    (found) =>
      Option.map(headingLevel(lines[found].trim()), (level) => {
        const rest = lines.slice(found + 1);

        const end = rest.findIndex((line) =>
          Option.exists(headingLevel(line), (other) => other <= level),
        );

        if (end >= 0) {
          return rest.slice(0, end).join("\n").trim();
        }

        return rest.join("\n").trim();
      }),
  );
};

// The plan with the verify task added: a person checks what merged against
// the spec's acceptance criteria once every other task is closed.
export const withVerify = (spec: Issue, nodes: Plan): Plan => [
  ...nodes,
  {
    key: VERIFY,
    title: `Verify: ${spec.title}`,
    body: [
      `Check that the work planned for #${spec.number} meets its acceptance criteria, now that every other task has landed.`,
      "",
      "## Acceptance criteria",
      "",
      Option.getOrElse(
        acceptanceCriteria(spec.body),
        () =>
          `#${spec.number} names none under that heading: check the work against the whole spec.`,
      ),
    ].join("\n"),
    kind: "human",
    blockedBy: nodes.map((node) => node.key),
  },
];

const quoted = (text: string) => text.replace(/"/g, "#quot;");

// The plan as a Mermaid graph, each arrow from a task to one it blocks.
export const mermaid = (nodes: Plan) => {
  const ids = new Map(nodes.map((node, index) => [node.key, `t${index + 1}`]));
  const idOf = (key: string) => ids.get(key) ?? key;

  return [
    "```mermaid",
    "graph TD",
    ...nodes.map(
      (node) => `  ${idOf(node.key)}["${quoted(`${node.key}: ${node.title} (${node.kind})`)}"]`,
    ),
    ...nodes.flatMap((node) =>
      node.blockedBy.map((blocker) => `  ${idOf(blocker)} --> ${idOf(node.key)}`),
    ),
    "```",
  ].join("\n");
};

const roundOf = (round: number) =>
  Option.match(
    Option.liftPredicate(round, (later) => later > 1),
    { onNone: () => "", onSome: (later) => ` (round ${later})` },
  );

const blockersOf = (node: PlanNode) =>
  Option.match(
    Option.liftPredicate(node.blockedBy, (blockers) => blockers.length > 0),
    {
      onNone: () => "Blocked by nothing.",
      onSome: (blockers) => `Blocked by ${blockers.map((key) => `\`${key}\``).join(", ")}.`,
    },
  );

const encodePlan = Schema.encodeSync(Plan);

// The plan's comment, ending with `marker`.
const shownPlan = (round: number, summary: string, nodes: Plan, marker: string) =>
  [
    `## Proposed plan${roundOf(round)}`,
    "",
    summary,
    "",
    mermaid(nodes),
    "",
    ...nodes.flatMap((node) => [
      `<details><summary><code>${node.key}</code>: ${node.title} (${node.kind})</summary>`,
      "",
      blockersOf(node),
      "",
      node.body,
      "",
      "</details>",
      "",
    ]),
    `To approve it, add the label \`${LABELS.approved}\`. To change it, comment with what to change, and Chernabog drafts it again.`,
    "",
    marker,
  ].join("\n");

// The plan's comment on its spec, for people: the summary, the graph, each
// task folded, and how to answer it. Its marker keeps only the round, which
// marks the comment as Chernabog's; the plan itself is in the spec's record
// (planBlob), so editing or deleting the comment changes nothing.
export const planComment = (round: number, summary: string, nodes: Plan) =>
  shownPlan(round, summary, nodes, planMarker.write({ round }));

// The blob a spec's proposed record keeps the posted plan in: its tasks as
// JSON, encoded as Plan, and the hash that names it in the record's data.
const encodeTasks = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Json)));

export const planBlob = (encoded: ReadonlyArray<Json>) => {
  const text = encodeTasks(encoded);

  return { text, hash: createHash("sha256").update(text).digest("hex") };
};

// What a spec's proposed record keeps of the plan posted in its round: the
// hash of the blob that holds its tasks, and `after`, the id of the newest
// comment on the spec before the plan's, so a person's comment after it is
// an answer, whatever became of the plan's own comment.
const PostedPlan = Schema.Struct({
  round: Schema.Finite,
  plan: BlobHash,
  after: Schema.optionalKey(Schema.Finite),
});

const postedIn = (data: Option.Option<{ readonly [key: string]: Json }>, round: number) =>
  Option.filter(
    Option.flatMap(data, Schema.decodeUnknownOption(PostedPlan)),
    (posted) => posted.round === round,
  );

const After = Schema.Struct({ after: Schema.Finite });

// Where a person's answer to the posted plan starts: after the comment the
// spec's record names (`after`), by id; or, for a record from before records
// named one, after the wait began, by when each comment was made.
type Anchor = { readonly after: Option.Option<number>; readonly since: DateTime.Utc };

const anchorOf = (data: Option.Option<{ readonly [key: string]: Json }>, at: DateTime.Utc) => ({
  after: Option.map(
    Option.flatMap(data, Schema.decodeUnknownOption(After)),
    (found) => found.after,
  ),
  since: Option.getOrElse(Phases.sinceOf(data), () => at),
});

const madeAfter = (comment: Comment, anchor: Anchor) =>
  Option.match(anchor.after, {
    onSome: (after) => comment.id > after,
    onNone: () =>
      Option.exists(DateTime.make(comment.createdAt), (made) =>
        DateTime.isGreaterThan(made, anchor.since),
      ),
  });

// The comments of the repo's owners, members and collaborators since the
// plan was posted, other than Chernabog's own: a person's answer to it.
const sincePlan = (comments: ReadonlyArray<Comment>, anchor: Anchor) =>
  comments.filter(
    (comment) => comment.trusted && !hasMarker(comment.body) && madeAfter(comment, anchor),
  );

const feedbackOf = (comments: ReadonlyArray<Comment>, anchor: Anchor) =>
  Option.liftPredicate(
    sincePlan(comments, anchor)
      .map((comment) => `${comment.author}: ${comment.body}`)
      .join("\n\n"),
    (text) => text !== "",
  );

// The open spec `number`, or none once it is closed or gone.
const openSpec = (number: number) =>
  Effect.gen(function* () {
    const github = yield* GitHub;

    const spec = yield* github.issue(number).pipe(
      Effect.asSome,
      Effect.catchTag("NotFound", () => Effect.succeedNone),
    );

    return Option.filter(spec, (found) => found.state !== "closed");
  });

const SPEC_RECORD = /^issue-(\d+)$/;

// What a spec's proposed record carries: the round whose plan waits.
const Proposed = Schema.Struct({ round: Schema.Finite });

// The round a proposed record's plan waits on.
const proposedRound = (found: PhaseRecord) =>
  Option.map(
    Option.flatMap(found.data, Schema.decodeUnknownOption(Proposed)),
    (data) => data.round,
  );

// A person's answer to a posted plan, or that nobody gave one in time.
export type Answer = "approved" | "changes-requested" | "timeout";

// A spec whose posted plan waits on a person: its number, the round, when
// the plan was posted, and where a person's answer to it starts.
type Waiting = {
  readonly spec: Issue;
  readonly round: number;
  readonly since: DateTime.Utc;
  readonly anchor: Anchor;
};

// Specs whose record says their plan waits on a person (proposed), open. The
// record, not auto:plan-proposed, says which wait (ADR 0021, decision 3), and
// one handed to a person is with-person instead: the labels are for people.
const waitingSpecs = Effect.gen(function* () {
  const found: Array<Waiting> = [];

  for (const [name, record] of yield* Phases.records) {
    const number = Option.map(Option.fromNullOr(SPEC_RECORD.exec(name)), (match) =>
      Number(match[1]),
    );

    const round = Option.map(
      Option.flatMap(
        Option.filter(record.data, () => record.phase === Phases.PHASES.issue.proposed),
        Schema.decodeUnknownOption(Proposed),
      ),
      (proposed) => proposed.round,
    );

    if (Option.isNone(number) || Option.isNone(round)) {
      continue;
    }

    for (const open of Option.toArray(yield* openSpec(number.value))) {
      found.push({
        spec: open,
        round: round.value,
        since: record.at,
        anchor: anchorOf(record.data, record.at),
      });
    }
  }

  return found;
});

// What a person said to the plan waiting on `waiting`: `approved` when the
// spec carries the approval label, `changes-requested` when someone commented
// since it was posted; none yet.
const answerTo = (waiting: Waiting) =>
  Effect.gen(function* () {
    const github = yield* GitHub;

    if (waiting.spec.labels.includes(LABELS.approved)) {
      return Option.some<Answer>("approved");
    }

    return Option.as(
      feedbackOf(yield* github.trustedComments(waiting.spec.number), waiting.anchor),
      "changes-requested" as const,
    );
  });

// Specs whose posted plan a person has answered, as signals to the run
// waiting on each: `approved` when it carries the approval label, or
// `changes-requested` when someone commented since. Never starts a run, and
// wakes none either: a park ends its run (ADR 23, decision 2).
/**
 * @deprecated Wakes nothing: a park ends its run (ADR 23, decision 2), so no
 * run is left parked for its signals to wake, and its items are `wakeOnly`, so
 * they start none. Use a source that offers the spec from its parked phase
 * record, so a new run takes it up: `Plan.answered(within)` in a recipe's
 * trigger, or `Plan.documentAnswers`, which a document's `plan.awaitAnswer`
 * already offers (#694).
 */
export const answers = Effect.gen(function* () {
  const items: Array<WorkItem> = [];

  for (const waiting of yield* waitingSpecs) {
    for (const answer of Option.toArray(yield* answerTo(waiting))) {
      items.push({ ...issueItem(waiting.spec), signals: [answer], wakeOnly: true });
    }
  }

  return items;
});

// Where a run that takes up a plan someone answered starts: the round whose
// plan was answered, and the answer.
export const Resumed = Schema.Struct({
  round: Schema.Finite,
  answer: Schema.Literals(["approved", "changes-requested", "timeout"]),
});

export type Resumed = typeof Resumed.Type;

const ResumedItem = Schema.Struct({ resumePlan: Resumed });

// The answer a work item from answered takes up; none for any other.
export const resuming = (item: WorkItem): Option.Option<Resumed> =>
  Option.map(Schema.decodeUnknownOption(ResumedItem)(item.data), (data) => data.resumePlan);

// The answer a run takes up for the plan waiting on `waiting`: a person's,
// or a timeout once `within` has passed since the plan was posted; none yet.
const takenAnswer = (waiting: Waiting, within: Duration.Input) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const answer = yield* answerTo(waiting);

    const due = DateTime.isLessThanOrEqualTo(
      DateTime.addDuration(waiting.since, Duration.fromInputUnsafe(within)),
      now,
    );

    return Option.orElse(answer, () => Option.liftPredicate<Answer>("timeout", () => due));
  });

// Specs whose posted plan a person answered, or that nobody answered within
// `within` of its posting, as work a run may start (ADR 0021, decision 4): the
// run that waited on the answer ended at its park (ADR 23, decision 2), and a
// new run takes the plan up from its record. A person's answer is also named
// in the item's signals. Routed by assignees.
export const answered = (within: Duration.Input) =>
  Effect.gen(function* () {
    const items: Array<WorkItem> = [];

    for (const waiting of yield* waitingSpecs) {
      for (const found of Option.toArray(yield* takenAnswer(waiting, within))) {
        const item: WorkItem = {
          ...issueItem(waiting.spec),
          data: {
            issue: waiting.spec.number,
            resumePlan: { round: waiting.round, answer: found },
          },
        };

        // A person's answer is named in the item's signals; a timeout is not
        // a signal.
        if (found === "timeout") {
          items.push(yield* routed(waiting.spec, item));
          continue;
        }

        items.push(yield* routed(waiting.spec, { ...item, signals: [found] }));
      }
    }

    return items;
  });

// What a flow document's proposed record carries beside its round: how long
// a person has to answer, which its plan.awaitAnswer was given.
const DocumentWait = Schema.Struct({
  round: Schema.Finite,
  within: Schema.TemplateLiteral([Schema.Finite, " days"]),
});

// The spec `number`, while its plan may still be taken up: open, and not a
// person's, by its record (Phases.withPerson).
const specWaiting = (number: number) =>
  Effect.gen(function* () {
    if (yield* Phases.withPerson(Phases.issueItem(number))) {
      return Option.none<Issue>();
    }

    return yield* openSpec(number);
  });

// Specs a flow document's run parked on a person's answer to their plan (a
// proposed record that says how long a person has, which its
// plan.awaitAnswer was given), as work a run may start (ADR 0021, decision
// 4): once a person answers, or nobody does within that time since the plan
// was posted, routed by assignees, as the recipe's are (answered); held, with
// why, while neither. Each says the round it parked in (answerRound). A spec
// closed or handed to a person has nothing left to take up.
export const documentAnswers = Effect.gen(function* () {
  const items: Array<WorkItem> = [];

  for (const [name, record] of yield* Phases.records) {
    const number = Option.map(Option.fromNullOr(SPEC_RECORD.exec(name)), (match) =>
      Number(match[1]),
    );

    const parked = Option.flatMap(
      Option.filter(record.data, () => record.phase === Phases.PHASES.issue.proposed),
      Schema.decodeUnknownOption(DocumentWait),
    );

    if (Option.isNone(number) || Option.isNone(parked)) {
      continue;
    }

    const spec = yield* specWaiting(number.value);

    for (const open of Option.toArray(spec)) {
      const item: WorkItem = {
        ...issueItem(open),
        data: { issue: open.number, answerRound: parked.value.round },
      };

      const waiting = {
        spec: open,
        round: parked.value.round,
        since: record.at,
        anchor: anchorOf(record.data, record.at),
      };

      if (Option.isNone(yield* takenAnswer(waiting, parked.value.within))) {
        items.push({
          ...item,
          held: `waits on a person's answer to the plan of round ${parked.value.round}`,
        });

        continue;
      }

      items.push(yield* routed(open, item));
    }
  }

  return items;
});

const AnswerItem = Schema.Struct({ answerRound: Schema.Finite });

// The round of the plan a work item from documentAnswers takes the answer to
// up; none for any other.
export const answerRoundOf = (item: WorkItem): Option.Option<number> =>
  Option.map(Schema.decodeUnknownOption(AnswerItem)(item.data), (data) => data.answerRound);

// The answer to the plan of `round` a flow document's run acts on, read in
// the step `step`: a person's, or a timeout once `within` has passed since
// the spec's record says the plan was posted; none yet.
const answerIn = (step: string, spec: number, round: number, within: Duration.Input) =>
  activity(
    step,
    Effect.gen(function* () {
      const found = yield* specWaiting(spec);

      const record = yield* Progress.use((progress) => progress.read(Phases.issueItem(spec)));

      const waiting = Option.map(Option.all({ spec: found, record }), (both) => ({
        spec: both.spec,
        round,
        since: both.record.at,
        anchor: anchorOf(both.record.data, both.record.at),
      }));

      if (Option.isNone(waiting)) {
        return Option.none<Answer>();
      }

      return yield* takenAnswer(waiting.value, within);
    }),
    Schema.Option(Schema.Literals(["approved", "changes-requested", "timeout"])),
  );

// The answer a flow document's run that took up the plan of `round` acts on,
// as answerIn reads it; none yet, as for a run started before a person
// answered, which waits again.
export const answerNow = (spec: number, round: number, within: Duration.Input) =>
  answerIn(`plan-answer-${round}`, spec, round, within);

const decodePlanText = Schema.decodeUnknownOption(Schema.fromJsonString(Plan));

// The plan posted in `round`, from the blob the spec's record names; none
// when the record names no plan of that round.
const recordedPlan = (spec: number, round: number) =>
  Effect.gen(function* () {
    const progress = yield* Progress;
    const item = Phases.issueItem(spec);

    const named = postedIn(
      Option.flatMap(yield* progress.read(item), (found) => found.data),
      round,
    );

    if (Option.isNone(named)) {
      return Option.none<Plan>();
    }

    const bytes = yield* progress.blob(item, named.value.plan);

    return Option.flatMap(bytes, (found) => decodePlanText(new TextDecoder().decode(found)));
  });

// The plan posted in `round`, as the spec's record keeps it, for a run that
// takes it up once approved: never its comment, which a person may edit or
// delete. A person's when the record keeps none, as one from before records
// kept plans that backfill didn't carry over.
export const posted = (spec: number, round: number) =>
  activity(
    `posted-plan-${round}`,
    Effect.gen(function* () {
      const kept = yield* recordedPlan(spec, round);

      if (Option.isNone(kept)) {
        return yield* new NeedsHuman({
          reason: `the spec's record keeps no plan of round ${round}, so Chernabog can't make the approved plan's tasks`,
        });
      }

      return kept.value;
    }),
    Plan,
  );

const RESUME_PROMPT =
  "You were interrupted. Continue from where you left off, then give your final answer in the required format.";

// The prompt that starts a plan, from .chernabog/prompts/plan.md.
const specPrompt = (spec: number) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const repo = yield* Repo;
    const planLimits = yield* Settings.plans;
    const rules = yield* Settings.rules;
    const details = yield* github.issue(spec);
    const comments = yield* github.trustedComments(spec);

    return yield* renderPrompt("plan", {
      repo: repo.slug,
      issue: spec,
      title: details.title,
      body: details.body,
      comments: comments
        .filter((comment) => !hasMarker(comment.body))
        .map((comment) => `${comment.author}: ${comment.body}`),
      base: yield* Settings.base,
      planNodes: planLimits.nodes,
      humanOnly: rules.humanOnly,
      notes: rules.notes,
    });
  });

type Asking = { readonly prompt: string; readonly resume: string };

// The read-only checkout the agent drafts a spec's plan in.
export const planCheckout = (spec: number) => `plan-issue-${spec}`;

// Removes the plan's checkout once the run is done with it, however it ends:
// an epic, questions on the spec, or a person's.
export const doneDrafting = (spec: number) =>
  activity(
    `clean-up-${planCheckout(spec)}`,
    Worktree.use((worktree) => worktree.remove(planCheckout(spec))),
  );

// Asks the agent for a plan in a read-only checkout of the base branch, in
// the run's one planning session: `resume` when the session exists, and
// otherwise `prompt`, which must stand on its own.
const askForPlan = <E, R>(name: string, spec: number, asking: Effect.Effect<Asking, E, R>) =>
  activity(
    name,
    Effect.gen(function* () {
      const run = yield* Run;
      const { prompt, resume } = yield* asking;

      const worktree = yield* (yield* Worktree).checkout(
        planCheckout(spec),
        `origin/${yield* Settings.base}`,
      );

      const result = yield* (yield* Agent).run({
        cwd: worktree,
        prompt,
        sessionId: sessionIdFor(run.runId, "plan"),
        resumePrompt: Option.some(resume),
        outputSchema: Option.some(planDraftJsonSchema),
        adapter: Option.none(),
      });

      return yield* Schema.decodeUnknownEffect(PlanDraft)(result.output).pipe(
        Effect.mapError(
          (issue) => new StepFailed({ step: name, message: `agent answer: ${issue.message}` }),
        ),
      );
    }),
    PlanDraft,
  );

const followUp = (spec: number, text: string) =>
  Effect.map(specPrompt(spec), (prompt) => ({ prompt: `${prompt}\n\n${text}`, resume: text }));

// The agent drafts the plan, or redrafts it with what a person asked to change.
export const draft = (spec: number, round: number, changes: Option.Option<string>) =>
  askForPlan(
    `draft-plan-${round}`,
    spec,
    Option.match(changes, {
      onNone: () => Effect.map(specPrompt(spec), (prompt) => ({ prompt, resume: RESUME_PROMPT })),
      onSome: (asked) =>
        followUp(
          spec,
          `A person read the plan you proposed and asked for changes:\n\n${asked}\n\nDraft the plan again with them, and give your final answer.`,
        ),
    }),
  );

const fix = (spec: number, round: number, attempt: number, problems: ReadonlyArray<string>) =>
  askForPlan(
    `fix-plan-${round}-${attempt}`,
    spec,
    followUp(
      spec,
      `The plan fails Chernabog's checks:\n\n${problems.map((problem) => `- ${problem}`).join("\n")}\n\nFix it, and give your final answer again.`,
    ),
  );

// Drafts the plan and checks it, sending the agent back with what is wrong up
// to limits.planRounds times. A plan that still fails needs a person.
export const checkedDraft = (spec: number, round: number, changes: Option.Option<string>) =>
  Effect.gen(function* () {
    const planLimits = yield* Settings.plans;
    let answer = yield* draft(spec, round, changes);

    for (let attempt = 1; answer.status === "plan"; attempt++) {
      const problems = checkPlan(answer.nodes, planLimits.nodes);

      if (problems.length === 0) {
        return answer;
      }

      if (attempt > planLimits.rounds) {
        return yield* new NeedsHuman({
          reason: `the plan still fails its checks after ${planLimits.rounds} attempts to fix it:\n\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
        });
      }

      answer = yield* fix(spec, round, attempt, problems);
    }

    return answer;
  });

// Posts the agent's questions on the spec, releases the claim and stops, as
// implement does. The requeue hint names auto:plan.
export const askForClarification = (spec: number, answer: PlanDraft) =>
  askImplementClarification(
    spec,
    {
      status: "needs-clarification",
      summary: answer.summary,
      title: "",
      body: "",
      questions: answer.questions ?? answer.summary,
    },
    { label: LABELS.plan },
  );

// Posts the plan on the spec, with the verify task added, labels it as
// waiting on a person, and records the spec proposed, the plan a blob its
// record names (planBlob) beside the round: the record, not the comment, is
// the plan a run makes once approved. Returns the plan as posted, which is
// the one created. The wait on the person's answer, which awaitAnswer
// records, carries the plan on.
export const propose = (spec: number, round: number, answer: PlanDraft) =>
  activity(
    `propose-plan-${round}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const plan = withVerify(yield* github.issue(spec), answer.nodes);
      const after = Math.max(0, ...(yield* github.comments(spec)).map((comment) => comment.id));
      yield* github.comment(spec, planComment(round, answer.summary, plan));

      const blob = planBlob(encodePlan(plan));

      // Written again even over a record of this run's: the wait of the
      // round before is proposed too.
      yield* Phases.record(
        Phases.issueItem(spec),
        Phases.PHASES.issue.proposed,
        { round, plan: blob.hash, after },
        { always: true, blobs: [blob.text] },
      );

      return plan;
    }),
    Plan,
  );

// What the wait's record carries on of the plan of `round` the spec's
// record names: the hash and its blob, and where answers start. A blob is
// read only at the record that names it, so the wait writes it again.
const carriedPlan = (spec: number, round: number) =>
  Effect.gen(function* () {
    const progress = yield* Progress;
    const item = Phases.issueItem(spec);

    const named = postedIn(
      Option.flatMap(yield* progress.read(item), (found) => found.data),
      round,
    );

    if (Option.isNone(named)) {
      return { data: {}, blobs: [] };
    }

    const bytes = yield* progress.blob(item, named.value.plan);

    return {
      data: Option.match(Option.fromUndefinedOr(named.value.after), {
        onNone: () => ({ plan: named.value.plan }),
        onSome: (after) => ({ plan: named.value.plan, after }),
      }),
      blobs: Option.toArray(bytes),
    };
  });

// The wait on a person's answer to the plan of `round`, as the spec's
// proposed record (plan-<round>-waits): the round, and what else the record
// keeps, such as how long a document's wait gives a person. A wait of the round already there
// is kept, so a run that took the plan up waits on from it, and `timeout`
// counts from when the plan was posted; the record plan.propose wrote, which
// says when no wait began, is not a wait yet. The wait's record carries on
// the plan that record names (carriedPlan).
export const answerParking = (
  spec: number,
  round: number,
  timeout: Duration.Input,
  data: { readonly [key: string]: Json } = {},
): Phases.Parking => ({
  step: `plan-${round}-waits`,
  item: Phases.issueItem(spec),
  phase: Phases.PHASES.issue.proposed,
  data: { ...data, round },
  keeps: (found) =>
    Option.contains(proposedRound(found), round) && Option.isSome(Phases.sinceOf(found.data)),
  timeout: Duration.fromInputUnsafe(timeout),
  carries: carriedPlan(spec, round),
});

// Records the wait on a person's answer to the plan (answerParking) and
// parks, which ends the run; answered offers the spec to a new run from the
// record once a person answers. Gives `approved`, `changes-requested`, or
// `timeout` once `timeout` passes.
export const awaitAnswer = (
  spec: number,
  round: number,
  timeout: Duration.Input,
  data: { readonly [key: string]: Json } = {},
) =>
  Phases.park(
    answerParking(spec, round, timeout, data),
    ["approved", "changes-requested"],
    `plan-${round}`,
  ).pipe(
    Effect.map((answer) => {
      if (answer === "timed-out") {
        return "timeout";
      }

      return answer;
    }),
  );

// What a person asked to change, from their comments since the plan.
export const changesAsked = (spec: number, round: number) =>
  activity(
    `changes-asked-${round}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const found = yield* Progress.use((progress) => progress.read(Phases.issueItem(spec)));

      const anchor = Option.match(found, {
        onNone: () => ({ after: Option.none<number>(), since: DateTime.makeUnsafe(0) }),
        onSome: (record) => anchorOf(record.data, record.at),
      });

      return Option.getOrElse(
        feedbackOf(yield* github.trustedComments(spec), anchor),
        () => "Nothing in the comments says what; make the plan clearer.",
      );
    }),
    Schema.String,
  );

// Why a plan's human task is with a person.
export const PERSONS_TASK = "a person's task";

// The intent a task's kind carries: an auto task is queued. A human task's
// auto:needs-human is its with-person record's projection.
const labelsFor = (kind: string, labels: Settings.LabelNames): ReadonlyArray<string> => {
  if (kind === "auto") {
    return [labels.eligible];
  }

  return [];
};

const NOTES: Readonly<Record<Kind, string>> = {
  auto: "An agent takes it once nothing blocks it.",
  hybrid: "For a person and an agent together: `chernabog start` with this issue's number.",
  human: "For a person to decide.",
};

const noteFor = (kind: string) =>
  Option.match(Option.liftPredicate(kind, isKind), {
    onNone: () => "",
    onSome: (known) => NOTES[known],
  });

const nodeBody = (spec: number, node: PlanNode) =>
  [
    node.body,
    "",
    "---",
    `Task \`${node.key}\` of the plan for #${spec}. ${noteFor(node.kind)}`,
    "",
    planNodeMarker.write({ spec, key: node.key }),
  ].join("\n");

const Made = Schema.Array(
  Schema.Struct({ number: Schema.Finite, body: Schema.OptionFromNullOr(Schema.String) }),
);

// The issues this spec's plan already made, by key: its sub-issues, and the
// issues this login opened lately, for one made just before a crash and not
// yet a sub-issue.
const madeFor = (spec: number) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const repo = yield* Repo;
    const login = yield* github.login;

    const recent = yield* github.request(
      "GET",
      `/repos/${repo.slug}/issues?state=all&creator=${encodeURIComponent(login)}&sort=created&direction=desc&per_page=100`,
      Option.none(),
    );

    const found = [
      ...(yield* github.subIssues(spec)).map((issue) => ({
        number: issue.number,
        body: Option.some(issue.body),
      })),
      ...Option.getOrElse(Schema.decodeUnknownOption(Made)(recent), () => []),
    ];

    const made = new Map<string, number>();

    for (const issue of found) {
      for (const marker of Option.toArray(Option.flatMap(issue.body, planNodeMarker.read))) {
        if (marker.spec === spec) {
          made.set(marker.key, issue.number);
        }
      }
    }

    return made;
  });

export const Created = Schema.Array(Schema.Struct({ key: Schema.String, issue: Schema.Finite }));

export type Created = typeof Created.Type;

// Makes each task an issue and a sub-issue of the spec, links each to the
// tasks that block it, and only then labels them, so no flow picks one up
// before its blockers are linked. Safe to repeat: a task's issue is found by
// its marker, and links and labels already there stay.
export const create = (spec: number, plan: Plan) =>
  activity(
    "create-issues",
    Effect.gen(function* () {
      const github = yield* GitHub;
      const labelNames = yield* Settings.labels;
      const made = yield* madeFor(spec);

      for (const node of plan) {
        if (!made.has(node.key)) {
          const issue = yield* github.createIssue({
            title: node.title,
            body: nodeBody(spec, node),
            labels: [],
          });

          made.set(node.key, issue.number);
        }
      }

      const numberOf = (key: string) =>
        Effect.fromOption(Option.fromUndefinedOr(made.get(key))).pipe(
          Effect.mapError(
            () => new StepFailed({ step: "create-issues", message: `no issue for \`${key}\`` }),
          ),
        );

      const created: Array<Created[number]> = [];

      for (const node of plan) {
        const issue = yield* numberOf(node.key);
        yield* github.addSubIssue(spec, issue);

        for (const blocker of node.blockedBy) {
          yield* github.addBlockedBy(issue, yield* numberOf(blocker));
        }

        created.push({ key: node.key, issue });
      }

      for (const node of plan) {
        const issue = yield* numberOf(node.key);

        // A person's task is with a person from the start (ADR 21, decision 1).
        if (node.kind === "human") {
          yield* Phases.recordWithPerson(Phases.issueItem(issue), PERSONS_TASK);
        }

        for (const label of labelsFor(node.kind, labelNames)) {
          yield* github.addLabel(issue, label);
        }
      }

      return created;
    }),
    Created,
  );

// Labels the spec an epic, which the epic flow picks up, releases the claim,
// and says on it which issue each task became.
export const becomeEpic = (spec: number, plan: Plan, created: Created) =>
  activity(
    "epic",
    Effect.gen(function* () {
      const github = yield* GitHub;
      yield* github.addLabel(spec, LABELS.epic);
      yield* Phases.record(Phases.issueItem(spec), Phases.PHASES.issue.becameEpic);
      // The person's approval, acknowledged; the became-epic record
      // projects the rest of the spec's status labels.
      yield* github.removeLabel(spec, LABELS.approved);

      yield* github.deleteBranch(branchFor(spec));

      const lines = created.map(({ issue, key }) => {
        const title = Option.match(Option.fromUndefinedOr(plan.find((node) => node.key === key)), {
          onNone: () => key,
          onSome: (node) => node.title,
        });

        return `- #${issue} \`${key}\`: ${title}`;
      });

      yield* github.comment(
        spec,
        [
          `The plan is approved: this issue is now an epic of ${created.length} sub-issues.`,
          "",
          ...lines,
        ].join("\n"),
      );

      return `#${spec}: an epic of ${created.length} sub-issues`;
    }),
    Schema.String,
  );

// Labels the spec for a person, says why, and releases the claim, so
// labelling it auto:plan again starts over.
export const handToHuman = (spec: number, reason: string) =>
  activity(
    "needs-human",
    Effect.gen(function* () {
      const github = yield* GitHub;
      // Nothing waits on the plan any more; auto:plan again proposes afresh.
      // The with-person record projects the spec's status labels.
      yield* Phases.record(Phases.issueItem(spec), Phases.PHASES.issue.planHandedBack);
      yield* Phases.handToPerson(Phases.issueItem(spec), reason);

      yield* github.deleteBranch(branchFor(spec));
      yield* github.comment(
        spec,
        `Chernabog stopped planning and needs a person: ${reason}\n\nTo plan it again, apply \`${LABELS.plan}\`.`,
      );

      return `#${spec} needs a person: ${reason}`;
    }),
    Schema.String,
  );
