// What the GitHub service needs to know about queued issues, claim branches
// and project boards, kept apart from the API calls so it can be tested.

import { type Board, type Json, printJson } from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { GitHubError, githubGraphql } from "./platform/github-api.ts";

const ProjectItem = Schema.Struct({
  project: Schema.Struct({ number: Schema.Finite }),
  status: Schema.OptionFromNullOr(Schema.Struct({ name: Schema.String })),
});

export const LabelledIssueNode = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  body: Schema.OptionFromNullOr(Schema.String),
  url: Schema.String,
  createdAt: Schema.String,
  labels: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ name: Schema.String })) }),
  assignees: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ login: Schema.String })) }),
  projectItems: Schema.Struct({ nodes: Schema.Array(ProjectItem) }),
});

export type LabelledIssueNode = typeof LabelledIssueNode.Type;

// Without a board the label alone queues an issue; with one, its Status must be ready too.
export const eligibleIssuesFrom = (
  labelledIssues: ReadonlyArray<LabelledIssueNode>,
  board: Option.Option<Board>,
) =>
  labelledIssues.filter((issue) =>
    Option.match(board, {
      onNone: () => true,
      onSome: (ready) =>
        issue.projectItems.nodes.some(
          (item) =>
            item.project.number === ready.projectNumber &&
            Option.exists(item.status, (status) => status.name === ready.readyStatus),
        ),
    }),
  );

// Oldest first; the issue number breaks a tie.
type Aged = { readonly createdAt: string; readonly number: number };

export const byAge = Order.combine(
  Order.mapInput(Order.String, (issue: Aged) => issue.createdAt),
  Order.mapInput(Order.Number, (issue: Aged) => issue.number),
);

export const orderClaimCandidates = <
  T extends { readonly createdAt: string; readonly number: number },
>(
  candidates: ReadonlyArray<T>,
) => Arr.sort(candidates, byAge);

export const StatusField = Schema.Struct({
  id: Schema.String,
  field: Schema.Struct({
    id: Schema.String,
    options: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  }),
});

export type StatusField = typeof StatusField.Type;

export const IssueProjectItems = Schema.Struct({
  id: Schema.String,
  projectItems: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({ id: Schema.String, project: Schema.Struct({ number: Schema.Finite }) }),
    ),
  }),
});

export type IssueProjectItems = typeof IssueProjectItems.Type;

export type StatusChange = {
  readonly projectId: string;
  readonly itemId: string;
  readonly fieldId: string;
  readonly optionId: string;
};

export const statusChangeFor = (
  statusField: StatusField,
  issue: IssueProjectItems,
  board: Board,
  statusName: string,
): Result.Result<StatusChange, string> => {
  const item = Arr.findFirst(
    issue.projectItems.nodes,
    (projectItem) => projectItem.project.number === board.projectNumber,
  );

  if (Option.isNone(item)) {
    return Result.fail(`The issue is not on project #${board.projectNumber}`);
  }

  const option = Arr.findFirst(
    statusField.field.options,
    (statusOption) => statusOption.name === statusName,
  );

  if (Option.isNone(option)) {
    return Result.fail(`Project #${board.projectNumber} has no "${statusName}" option for Status`);
  }

  return Result.succeed({
    projectId: statusField.id,
    itemId: item.value.id,
    fieldId: statusField.field.id,
    optionId: option.value.id,
  });
};

export type CreateRefOutcome = "created" | "already-exists";

const RefError = Schema.Struct({ message: Schema.String });

// GitHub's answer to creating the claim branch. A 422 for an existing ref means another run won the claim.
export const interpretCreateRefResponse = (
  status: number,
  body: Option.Option<Json>,
): Result.Result<CreateRefOutcome, string> => {
  if (status === 201) {
    return Result.succeed("created");
  }

  const message = Option.flatMap(body, Schema.decodeUnknownOption(RefError)).pipe(
    Option.map((error) => error.message),
  );

  if (status === 422 && Option.contains(message, "Reference already exists")) {
    return Result.succeed("already-exists");
  }

  const said = Option.getOrElse(message, () =>
    Option.match(body, { onNone: () => "no body", onSome: printJson }),
  );

  return Result.fail(`Creating the claim branch failed with HTTP ${status}: ${said}`);
};

const STATUS_FIELD_QUERY = `
  query ($owner: String!, $projectNumber: Int!) {
    repositoryOwner(login: $owner) {
      ... on ProjectV2Owner {
        projectV2(number: $projectNumber) {
          id
          field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
        }
      }
    }
  }`;

const ISSUE_PROJECT_ITEMS_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) { id projectItems(first: 10) { nodes { id project { number } } } }
    }
  }`;

const SET_STATUS_MUTATION = `
  mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }
    ) { projectV2Item { id } }
  }`;

const StatusFieldData = Schema.Struct({
  repositoryOwner: Schema.Struct({ projectV2: StatusField }),
});

const IssueProjectItemsData = Schema.Struct({
  repository: Schema.Struct({ issue: IssueProjectItems }),
});

export const moveIssueToStatus = (
  repo: string,
  issueNumber: number,
  board: Board,
  statusName: string,
) =>
  Effect.gen(function* () {
    const [owner = "", name = ""] = repo.split("/");

    const statusField = (yield* githubGraphql(
      STATUS_FIELD_QUERY,
      { owner, projectNumber: board.projectNumber },
      StatusFieldData,
    )).repositoryOwner.projectV2;

    const issue = (yield* githubGraphql(
      ISSUE_PROJECT_ITEMS_QUERY,
      { owner, name, number: issueNumber },
      IssueProjectItemsData,
    )).repository.issue;

    const change = yield* Effect.fromResult(
      statusChangeFor(statusField, issue, board, statusName),
    ).pipe(Effect.mapError((message) => new GitHubError({ message })));

    yield* githubGraphql(SET_STATUS_MUTATION, change, Schema.Json);
  });
