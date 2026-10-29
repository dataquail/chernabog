import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type Persona } from "../../../../kernel/persona.value-object.ts";
import { type RunId } from "../../../../kernel/run-id.id.ts";

// What a flow's trigger reports: one piece of work, such as an issue or a pull
// request, by a key a run of the flow is for. As the SDK defines it; a flow
// carries its own data in `data`.
export const WorkItem = Schema.Struct({
  key: Schema.String,
  title: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  data: Schema.Json,
  // The signals it reports, which wake the runs waiting on them.
  signals: Schema.optionalKey(Schema.Array(Schema.String)),
  // Only wakes a run already waiting on it; never starts one.
  wakeOnly: Schema.optionalKey(Schema.Boolean),
  // Why the trigger won't start it yet; it starts no run, but still wakes one.
  held: Schema.optionalKey(Schema.String),
  // GitHub logins assigned to it, and asked to review it, which routing reads.
  assignees: Schema.optionalKey(Schema.Array(Schema.String)),
  reviewers: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type WorkItem = typeof WorkItem.Type;

// Whether a run may start for the item: not when it only wakes one, nor when
// it's held, whatever else it says. Either way its signals still wake one.
export const mayStart = (item: WorkItem) =>
  item.wakeOnly !== true && Option.isNone(Option.fromUndefinedOr(item.held));

// Whether a run's work item is still there to work on, as its flow's
// stillValid says: Gone, with why, ends the run as superseded.
export type ItemValidity =
  { readonly valid: true } | { readonly valid: false; readonly reason: string };

// The run a flow's stillValid is asked about: its id and execution, the item
// it works on, and the work items it named as its subjects.
export type ValidityQuestion = {
  readonly runId: RunId;
  readonly executionId: string;
  readonly item: WorkItem;
  readonly subjects: ReadonlyArray<string>;
};

// A flow as one persona runs it on this machine: the repo it's in, by the name
// the daemon schedules it under, the flow's name, and the persona.
export type FlowRef = {
  readonly repo: string;
  readonly flow: string;
  readonly persona: Persona;
};

// What a run's item is on GitHub, read from its key by the SDK's conventions:
// `issue-<n>` is an issue, and `pr-<n>` (or `pr-<n>-…`, such as an
// address-review's `pr-<n>-changes-<count>`) a pull request.
export type ItemTarget =
  | { readonly kind: "issue"; readonly number: number }
  | { readonly kind: "pull-request"; readonly number: number };

const ISSUE_KEY = /^issue-(\d+)$/;
const PULL_REQUEST_KEY = /^pr-(\d+)(?:-|$)/;

// The claim a run on the target holds, by the SDK's names for claims:
// `issue-<n>`, or `pr-<n>` for a pull request.
export const claimOf = (target: ItemTarget) => {
  if (target.kind === "issue") {
    return `issue-${target.number}`;
  }

  return `pr-${target.number}`;
};

// The issue or pull request an item key names; none for a key of a flow's own.
export const itemTarget = (key: string): Option.Option<ItemTarget> =>
  Option.orElse(
    Option.map(Option.fromNullOr(ISSUE_KEY.exec(key)), (issue): ItemTarget => ({
      kind: "issue",
      number: Number(issue[1]),
    })),
    () =>
      Option.map(Option.fromNullOr(PULL_REQUEST_KEY.exec(key)), (pull): ItemTarget => ({
        kind: "pull-request",
        number: Number(pull[1]),
      })),
  );

// The first pull request among a run's subjects, which Run's pullRequest
// carries for SDKs from before subjects; none when it named none.
export const firstPullRequest = (subjects: ReadonlyArray<string>) =>
  Arr.findFirst(subjects, (subject) =>
    Option.map(
      Option.filter(itemTarget(subject), (target) => target.kind === "pull-request"),
      (target) => target.number,
    ),
  );
