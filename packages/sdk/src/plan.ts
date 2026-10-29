// The building blocks of the `plan` recipe: the agent reads a spec issue and
// the code, and proposes the tasks the spec splits into and which blocks
// which; the code checks the plan and adds a verify task, a person approves it
// on the spec, and the spec becomes an epic of sub-issues, each linked to what
// blocks it. The agent answers with data only: each task's labels decide which
// of the repo's flows picks it up.

import {
  activity,
  Agent,
  awaitSignal,
  type Comment,
  type FlowLabel,
  GitHub,
  hasMarker,
  type Issue,
  type Json,
  NeedsHuman,
  planMarker,
  planNodeMarker,
  Repo,
  Run,
  StepFailed,
  type WorkItem,
  Worktree,
} from "@chernabog/core";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  askForClarification as askImplementClarification,
  branchFor,
  issueItem,
  issueOf,
  sessionIdFor,
} from "./implement.ts";
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

// The plan's comment on its spec: the summary, the graph, each task folded,
// and how to answer it.
export const planComment = (round: number, summary: string, nodes: Plan) =>
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
    planMarker.write({ round }),
  ].join("\n");

// The comments of the repo's owners, members and collaborators since the
// latest plan was posted, other than Chernabog's own: a person's answer to it.
const sinceLatestPlan = (comments: ReadonlyArray<Comment>) => {
  const posted = comments.findLastIndex((comment) => Option.isSome(planMarker.read(comment.body)));

  return comments
    .slice(posted + 1)
    .filter((comment) => posted >= 0 && comment.trusted && !hasMarker(comment.body));
};

const feedbackOf = (comments: ReadonlyArray<Comment>) =>
  Option.liftPredicate(
    sinceLatestPlan(comments)
      .map((comment) => `${comment.author}: ${comment.body}`)
      .join("\n\n"),
    (text) => text !== "",
  );

// Specs whose posted plan a person has answered, as signals to the run
// waiting on each: `approved` when it carries the approval label, or
// `changes-requested` when someone commented since. Never starts a run.
export const answers = Effect.gen(function* () {
  const github = yield* GitHub;
  const items: Array<WorkItem> = [];

  for (const spec of yield* github.issuesLabelled(LABELS.proposed)) {
    let signal = Option.some("approved");

    if (!spec.labels.includes(LABELS.approved)) {
      signal = Option.as(
        feedbackOf(yield* github.trustedComments(spec.number)),
        "changes-requested",
      );
    }

    for (const found of Option.toArray(signal)) {
      items.push({ ...issueItem(spec), signals: [found], wakeOnly: true });
    }
  }

  return items;
});

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

// Posts the plan on the spec, with the verify task added, and labels it as
// waiting on a person. Returns the plan as posted, which is the one created.
export const propose = (spec: number, round: number, answer: PlanDraft) =>
  activity(
    `propose-plan-${round}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const plan = withVerify(yield* github.issue(spec), answer.nodes);
      yield* github.comment(spec, planComment(round, answer.summary, plan));
      yield* github.addLabel(spec, LABELS.proposed);

      return plan;
    }),
    Plan,
  );

// Parks the run until a person answers the plan: `approved`,
// `changes-requested`, or `timeout` once `timeout` passes.
export const awaitAnswer = (round: number, timeout: Duration.Input) =>
  awaitSignal(["approved", "changes-requested"], { id: `plan-${round}`, timeout });

// What a person asked to change, from their comments since the plan.
export const changesAsked = (spec: number, round: number) =>
  activity(
    `changes-asked-${round}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      yield* github.removeLabel(spec, LABELS.proposed);

      return Option.getOrElse(
        feedbackOf(yield* github.trustedComments(spec)),
        () => "Nothing in the comments says what; make the plan clearer.",
      );
    }),
    Schema.String,
  );

const labelsFor = (kind: string, labels: Settings.LabelNames): ReadonlyArray<string> => {
  if (kind === "auto") {
    return [labels.eligible];
  }

  if (kind === "human") {
    return [labels.needsHuman];
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
        for (const label of labelsFor(node.kind, labelNames)) {
          yield* github.addLabel(yield* numberOf(node.key), label);
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
      const labelNames = yield* Settings.labels;
      yield* github.addLabel(spec, LABELS.epic);

      for (const label of [LABELS.approved, LABELS.proposed, labelNames.inProgress]) {
        yield* github.removeLabel(spec, label);
      }

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
      const labelNames = yield* Settings.labels;
      yield* github.addLabel(spec, labelNames.needsHuman);

      for (const label of [LABELS.proposed, labelNames.inProgress]) {
        yield* github.removeLabel(spec, label);
      }

      yield* github.deleteBranch(branchFor(spec));
      yield* github.comment(
        spec,
        `Chernabog stopped planning and needs a person: ${reason}\n\nTo plan it again, apply \`${LABELS.plan}\`.`,
      );

      return `#${spec} needs a person: ${reason}`;
    }),
    Schema.String,
  );
