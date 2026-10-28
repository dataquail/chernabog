// Chernabog's implementations of the SDK services, for one repo.

import {
  type Board,
  type Comment,
  Git,
  GitError,
  GitHub,
  GitHubError,
  type Issue,
  type Json,
  type LinkedIssue,
  type Merged,
  MergeRefused,
  type NewCommit,
  type NewReview,
  NotFound,
  NotInReviewerPool,
  type PullRequest,
  PullRequestClosed,
  PushRejected,
  type RefCommit,
  Repo,
  type RepoSettings,
  ReviewerSeat,
  type ReviewNote,
  type SetupError,
  type SubmittedReview,
  Usage,
  Worktree,
} from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { Persona } from "../../../../kernel/persona.value-object.ts";
import type { HostEnvironment } from "../../../../platform/environment.ts";
import { Exec, execOk } from "../../../../platform/exec.ts";
import {
  decodeBody,
  GitHubApi,
  githubGetAllPages,
  githubGraphql,
  githubJson,
  githubRequest,
  githubSend,
} from "../../../../platform/github-api.ts";
import {
  checkPersona,
  execOptionsFor,
  type GitHubTokens,
} from "../../../../platform/github-auth.ts";
import { Home, homePaths } from "../../../../platform/home.ts";
import { readCiState } from "./ci.ts";
import { checkCodexAccount, codexUsageGate } from "./codex-usage.ts";
import {
  eligibleIssuesFrom,
  interpretCreateRefResponse,
  LabelledIssueNode,
  moveIssueToStatus,
  orderClaimCandidates,
} from "./issues.ts";
import { checkAccount, type GateConfig, runUsageGate, ungated } from "./usage-gate.ts";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const QUEUED_ISSUES_QUERY = `
  query ($search: String!) {
    search(query: $search, type: ISSUE, first: 100) {
      nodes {
        ... on Issue {
          number
          title
          body
          url
          createdAt
          labels(first: 50) { nodes { name } }
          assignees(first: 20) { nodes { login } }
          projectItems(first: 10) {
            nodes {
              project { number }
              status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
            }
          }
        }
      }
    }
  }`;

// What GitHub's REST API sends, as far as Chernabog reads it.
const Named = Schema.Struct({ name: Schema.String });
const User = Schema.OptionFromNullOr(Schema.Struct({ login: Schema.String }));
const Text = Schema.OptionFromNullOr(Schema.String);
const Logins = Schema.optionalKey(Schema.Array(Schema.Struct({ login: Schema.String })));

export const RestIssue = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  body: Text,
  html_url: Schema.String,
  created_at: Schema.String,
  labels: Schema.Array(Named),
  assignees: Logins,
});

const RestLinkedIssue = Schema.Struct({
  ...RestIssue.fields,
  state: Schema.Literals(["open", "closed"]),
});

const LinkedIssues = Schema.Array(RestLinkedIssue);

// The id the sub-issue and dependency endpoints take, which is not the issue's number.
const RestIssueId = Schema.Struct({ id: Schema.Finite });

export const RestPullRequest = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  body: Text,
  html_url: Schema.String,
  state: Schema.String,
  merged_at: Text,
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  base: Schema.Struct({ ref: Schema.String }),
  labels: Schema.Array(Named),
  user: User,
  assignees: Logins,
  requested_reviewers: Logins,
});

const RestComment = Schema.Struct({
  id: Schema.Finite,
  user: User,
  body: Text,
  created_at: Schema.String,
  author_association: Schema.String,
});

const RestReview = Schema.Struct({
  id: Schema.Finite,
  user: User,
  body: Text,
  submitted_at: Text,
  author_association: Schema.String,
  state: Schema.optionalKey(Schema.String),
  commit_id: Schema.optionalKey(Schema.OptionFromNullOr(Schema.String)),
});

const RestLineComment = Schema.Struct({
  ...RestComment.fields,
  path: Schema.String,
  line: Schema.OptionFromNullOr(Schema.Finite),
  original_line: Schema.OptionFromNullOr(Schema.Finite),
});

const RestFile = Schema.Struct({ filename: Schema.String });
const RestRef = Schema.Struct({ object: Schema.Struct({ sha: Schema.String }) });
const RestCommit = Schema.Struct({ sha: Schema.String, message: Schema.String });
const RestUser = Schema.Struct({ login: Schema.String });

const login = (user: typeof User.Type) =>
  Option.match(user, { onNone: () => "", onSome: (found) => found.login });

const text = (value: Option.Option<string>) => Option.getOrElse(value, () => "");

const logins = (users: ReadonlyArray<{ readonly login: string }>) =>
  users.map((user) => user.login);

export const toIssue = (raw: typeof RestIssue.Type): Issue => ({
  number: raw.number,
  title: raw.title,
  body: text(raw.body),
  url: raw.html_url,
  createdAt: raw.created_at,
  labels: raw.labels.map((label) => label.name),
  assignees: logins(raw.assignees ?? []),
});

const toLinkedIssue = (raw: typeof RestLinkedIssue.Type): LinkedIssue => ({
  ...toIssue(raw),
  state: raw.state,
});

const fromNode = (node: LabelledIssueNode): Issue => ({
  number: node.number,
  title: node.title,
  body: text(node.body),
  url: node.url,
  createdAt: node.createdAt,
  labels: node.labels.nodes.map((label) => label.name),
  assignees: logins(node.assignees.nodes),
});

const stateOf = (raw: typeof RestPullRequest.Type): PullRequest["state"] => {
  if (Option.isSome(raw.merged_at)) {
    return "merged";
  }

  if (raw.state === "closed") {
    return "closed";
  }

  return "open";
};

export const toPullRequest = (raw: typeof RestPullRequest.Type): PullRequest => ({
  number: raw.number,
  title: raw.title,
  body: text(raw.body),
  url: raw.html_url,
  state: stateOf(raw),
  headRef: raw.head.ref,
  headSha: raw.head.sha,
  baseRef: raw.base.ref,
  labels: raw.labels.map((label) => label.name),
  author: login(raw.user),
  assignees: logins(raw.assignees ?? []),
  requestedReviewers: logins(raw.requested_reviewers ?? []),
});

const toComment = (raw: typeof RestComment.Type): Comment => ({
  id: raw.id,
  author: login(raw.user),
  body: text(raw.body),
  createdAt: raw.created_at,
  trusted: TRUSTED_ASSOCIATIONS.has(raw.author_association),
});

const SearchResult = Schema.Struct({
  search: Schema.Struct({
    nodes: Schema.Array(Schema.Union([LabelledIssueNode, Schema.Struct({})])),
  }),
});

const isIssueNode = Schema.is(LabelledIssueNode);

const Comments = Schema.Array(RestComment);

const MergedCommit = Schema.Struct({ sha: Schema.String });

const ErrorMessage = Schema.Struct({ message: Schema.String });

// GitHub's reason for refusing a merge, from its message where it gave one.
const refusalOf = (status: number, body: Option.Option<Json>) =>
  Option.match(Option.flatMap(body, Schema.decodeUnknownOption(ErrorMessage)), {
    onNone: () => `GitHub refused the merge (HTTP ${status})`,
    onSome: (error) => `GitHub refused the merge: ${error.message}`,
  });

const PullRequests = Schema.Array(RestPullRequest);
const identity = <A>(page: A) => page;

// A pull request's state, for telling a refusal on a closed one from any other.
const PullState = Schema.Struct({ state: Schema.String, merged_at: Text });

const closedState = (raw: typeof PullState.Type) =>
  Option.match(raw.merged_at, {
    onSome: () => Option.some<PullRequestClosed["state"]>("merged"),
    onNone: () =>
      Option.liftPredicate<PullRequestClosed["state"]>("closed", () => raw.state === "closed"),
  });

export const GitHubLive = (settings: RepoSettings): Layer.Layer<GitHub, never, GitHubApi> =>
  Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const api = yield* GitHubApi;

      const provide = <A, E>(effect: Effect.Effect<A, E, GitHubApi>) =>
        Effect.provideService(effect, GitHubApi, api);

      const repo = settings.slug;
      const [owner = ""] = repo.split("/");
      const path = (rest: string) => `/repos/${repo}${rest}`;

      const labelledOn = (label: string, board: Option.Option<Board>) =>
        provide(
          githubGraphql(
            QUEUED_ISSUES_QUERY,
            { search: `repo:${repo} is:issue is:open label:"${label}"` },
            SearchResult,
          ).pipe(
            Effect.map((data) =>
              orderClaimCandidates(
                eligibleIssuesFrom(data.search.nodes.filter(isIssueNode), board),
              ).map(fromNode),
            ),
          ),
        );

      const queuedIssuesLabelled = (label: string) => labelledOn(label, settings.board);

      const queuedIssues = queuedIssuesLabelled(settings.labels.eligible);

      const comments = (number: number) =>
        provide(
          githubGetAllPages(
            path(`/issues/${number}/comments?per_page=100`),
            Comments,
            identity,
          ).pipe(Effect.map((raw) => raw.map(toComment))),
        );

      // Removing a label the item does not carry is not an error.
      const removeLabel = (number: number, label: string) =>
        provide(
          githubRequest(
            "DELETE",
            path(`/issues/${number}/labels/${encodeURIComponent(label)}`),
          ).pipe(
            Effect.filterOrFail(
              (response) => response.status < 300 || response.status === 404,
              (response) =>
                new GitHubError({
                  message: `removing ${label} from #${number} returned HTTP ${response.status}`,
                }),
            ),
            Effect.asVoid,
          ),
        );

      const issueId = (number: number) =>
        provide(
          githubJson("GET", path(`/issues/${number}`), RestIssueId).pipe(
            Effect.map((found) => found.id),
          ),
        );

      const linked = (rest: string) =>
        provide(
          githubGetAllPages(path(`${rest}?per_page=100`), LinkedIssues, identity).pipe(
            Effect.map((raw) => raw.map(toLinkedIssue)),
          ),
        );

      const subIssues = (parent: number) => linked(`/issues/${parent}/sub_issues`);
      const blockedBy = (issue: number) => linked(`/issues/${issue}/dependencies/blocked_by`);

      const has = (found: ReadonlyArray<LinkedIssue>, number: number) =>
        found.some((one) => one.number === number);

      const self = provide(
        githubJson("GET", "/user", RestUser).pipe(Effect.map((user) => user.login)),
      );

      // One issue or pull request, which GitHub may not have.
      const readOrNotFound = <A>(what: string, rest: string, schema: Schema.Codec<A, Json>) =>
        provide(
          Effect.gen(function* () {
            const response = yield* githubRequest("GET", path(rest));

            if (response.status === 404 || response.status === 410) {
              return yield* new NotFound({ what });
            }

            if (response.status >= 300) {
              return yield* new GitHubError({
                message: `reading ${what} returned HTTP ${response.status}`,
              });
            }

            return yield* decodeBody(schema, `reading ${what}`)(response.body);
          }),
        );

      // A call on a pull request that failed because it was closed or merged
      // fails with PullRequestClosed; any other failure, or a state GitHub
      // won't say, is left as it was.
      const closedOr = <E>(
        pullRequest: number,
        error: E,
      ): Effect.Effect<never, E | PullRequestClosed> =>
        provide(githubJson("GET", path(`/pulls/${pullRequest}`), PullState)).pipe(
          Effect.option,
          Effect.flatMap((state) =>
            Option.match(Option.flatMap(state, closedState), {
              onNone: (): Effect.Effect<never, E | PullRequestClosed> => Effect.fail(error),
              onSome: (closed) =>
                Effect.fail(new PullRequestClosed({ pullRequest, state: closed })),
            }),
          ),
        );

      const unlessClosed =
        (pullRequest: number) =>
        <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | PullRequestClosed> =>
          Effect.catch(effect, (error) => closedOr(pullRequest, error));

      const branchSha = (branch: string) =>
        provide(
          Effect.gen(function* () {
            const response = yield* githubRequest("GET", path(`/git/ref/heads/${branch}`));

            if (response.status === 404) {
              return Option.none<string>();
            }

            if (response.status !== 200) {
              return yield* new GitHubError({
                message: `reading ${branch} returned HTTP ${response.status}`,
              });
            }

            const ref = yield* decodeBody(RestRef, `reading ${branch}`)(response.body);

            return Option.some(ref.object.sha);
          }),
        );

      const createRef = (ref: string, sha: string) =>
        provide(
          githubRequest("POST", path("/git/refs"), Option.some({ ref, sha })).pipe(
            Effect.flatMap((response) =>
              Effect.fromResult(interpretCreateRefResponse(response.status, response.body)).pipe(
                Effect.mapError((message) => new GitHubError({ message })),
              ),
            ),
          ),
        );

      const createBranch = (branch: string, sha: string) => createRef(`refs/heads/${branch}`, sha);

      // GitHub answers 422 for a ref it doesn't have, as well as 404.
      const deleteRef = (ref: string) =>
        provide(
          githubRequest("DELETE", path(`/git/${ref}`)).pipe(
            Effect.filterOrFail(
              (response) =>
                response.status < 300 || response.status === 404 || response.status === 422,
              (response) =>
                new GitHubError({ message: `deleting ${ref} returned HTTP ${response.status}` }),
            ),
            Effect.asVoid,
          ),
        );

      const deleteBranch = (branch: string) => deleteRef(`refs/heads/${branch}`);

      const createCommit = (commit: NewCommit) =>
        provide(
          githubJson(
            "POST",
            path("/git/commits"),
            RestCommit,
            Option.some({
              message: commit.message,
              tree: commit.tree,
              parents: [...commit.parents],
            }),
          ).pipe(Effect.map((created) => created.sha)),
        );

      const ref = (name: string) =>
        provide(
          Effect.gen(function* () {
            const response = yield* githubRequest(
              "GET",
              path(`/git/ref/${name.replace(/^refs\//, "")}`),
            );

            if (response.status === 404) {
              return Option.none<RefCommit>();
            }

            if (response.status !== 200) {
              return yield* new GitHubError({
                message: `reading ${name} returned HTTP ${response.status}`,
              });
            }

            const found = yield* decodeBody(RestRef, `reading ${name}`)(response.body);

            const commit = yield* githubJson(
              "GET",
              path(`/git/commits/${found.object.sha}`),
              RestCommit,
            );

            return Option.some<RefCommit>({ sha: commit.sha, message: commit.message });
          }),
        );

      const reviewComments = (pullRequest: number) =>
        provide(
          Effect.gen(function* () {
            const reviews = yield* githubGetAllPages(
              path(`/pulls/${pullRequest}/reviews?per_page=100`),
              Schema.Array(RestReview),
              identity,
            );

            const lines = yield* githubGetAllPages(
              path(`/pulls/${pullRequest}/comments?per_page=100`),
              Schema.Array(RestLineComment),
              identity,
            );

            const summaries = reviews.flatMap((review): ReadonlyArray<ReviewNote> => {
              if (text(review.body).length === 0) {
                return [];
              }

              return [
                {
                  ...toComment({ ...review, created_at: text(review.submitted_at) }),
                  location: Option.none(),
                },
              ];
            });

            const onLines = lines.map((line): ReviewNote => ({
              ...toComment(line),
              location: Option.some({
                path: line.path,
                line: Option.getOrElse(
                  Option.orElse(line.line, () => line.original_line),
                  () => 0,
                ),
              }),
            }));

            return [...summaries, ...onLines];
          }),
        );

      const review = (pullRequest: number, posted: NewReview) =>
        unlessClosed(pullRequest)(
          provide(
            Effect.gen(function* () {
              const event = posted.event ?? "COMMENT";

              const inline = posted.comments.map((comment) => ({
                path: comment.path,
                line: comment.line,
                side: "RIGHT",
                body: comment.body,
              }));

              const response = yield* githubRequest(
                "POST",
                path(`/pulls/${pullRequest}/reviews`),
                Option.some({
                  event,
                  body: posted.body,
                  commit_id: posted.commitSha,
                  comments: inline,
                }),
              );

              if (response.status < 300) {
                return;
              }

              // A comment on a line outside the diff fails the whole review; fold them into the body instead.
              let folded = posted.body;

              if (posted.comments.length > 0) {
                folded = `${posted.body}\n\n${posted.comments.map((comment) => `- \`${comment.path}:${comment.line}\`: ${comment.body}`).join("\n")}`;
              }

              const again = yield* githubRequest(
                "POST",
                path(`/pulls/${pullRequest}/reviews`),
                Option.some({ event, body: folded, commit_id: posted.commitSha }),
              );

              if (again.status < 300) {
                return;
              }

              // GitHub won't let an account approve or request changes on its own pull request.
              yield* githubSend(
                "POST",
                path(`/pulls/${pullRequest}/reviews`),
                Option.some({ event: "COMMENT", body: folded, commit_id: posted.commitSha }),
              );
            }),
          ),
        );

      const openPullRequests = provide(
        githubGetAllPages(path("/pulls?state=open&per_page=100"), PullRequests, identity).pipe(
          Effect.map((pulls) => pulls.map(toPullRequest)),
        ),
      );

      const reviews = (pullRequest: number) =>
        provide(
          githubGetAllPages(
            path(`/pulls/${pullRequest}/reviews?per_page=100`),
            Schema.Array(RestReview),
            identity,
          ).pipe(
            Effect.map((raw) =>
              raw.map((found): SubmittedReview => ({
                author: login(found.user),
                state: found.state ?? "COMMENTED",
                commitSha: Option.getOrElse(
                  Option.flatten(Option.fromUndefinedOr(found.commit_id)),
                  () => "",
                ),
              })),
            ),
          ),
        );

      return GitHub.of({
        queuedIssues,
        queuedIssuesLabelled,
        oldestQueued: queuedIssues.pipe(
          Effect.map((issues) =>
            Option.map(Option.fromUndefinedOr(issues[0]), (issue) => issue.number),
          ),
        ),
        issuesLabelled: (label) => labelledOn(label, Option.none()),
        issue: (number) =>
          readOrNotFound(`issue #${number}`, `/issues/${number}`, RestIssue).pipe(
            Effect.map(toIssue),
          ),
        createIssue: (issue) =>
          provide(
            githubJson(
              "POST",
              path("/issues"),
              RestIssue,
              Option.some({ title: issue.title, body: issue.body, labels: [...issue.labels] }),
            ).pipe(Effect.map(toIssue)),
          ),
        subIssues,
        addSubIssue: (parent, child) =>
          Effect.gen(function* () {
            if (has(yield* subIssues(parent), child)) {
              return;
            }

            yield* provide(
              githubSend(
                "POST",
                path(`/issues/${parent}/sub_issues`),
                Option.some({ sub_issue_id: yield* issueId(child) }),
              ),
            );
          }),
        blockedBy,
        addBlockedBy: (issue, blocker) =>
          Effect.gen(function* () {
            if (has(yield* blockedBy(issue), blocker)) {
              return;
            }

            yield* provide(
              githubSend(
                "POST",
                path(`/issues/${issue}/dependencies/blocked_by`),
                Option.some({ issue_id: yield* issueId(blocker) }),
              ),
            );
          }),
        removeBlockedBy: (issue, blocker) =>
          Effect.gen(function* () {
            const id = yield* issueId(blocker);

            const response = yield* provide(
              githubRequest("DELETE", path(`/issues/${issue}/dependencies/blocked_by/${id}`)),
            );

            if (response.status >= 300 && response.status !== 404) {
              return yield* new GitHubError({
                message: `unlinking #${blocker} from #${issue} returned HTTP ${response.status}`,
              });
            }
          }),
        comments,
        trustedComments: (number) =>
          comments(number).pipe(Effect.map((all) => all.filter((comment) => comment.trusted))),
        comment: (number, body) =>
          provide(
            githubSend("POST", path(`/issues/${number}/comments`), Option.some({ body })).pipe(
              Effect.asVoid,
            ),
          ),
        addLabel: (number, label) =>
          provide(
            githubSend(
              "POST",
              path(`/issues/${number}/labels`),
              Option.some({ labels: [label] }),
            ).pipe(Effect.asVoid),
          ),
        removeLabel,
        moveToStatus: (number, status) =>
          Option.match(settings.board, {
            onNone: () => Effect.void,
            onSome: (board) => provide(moveIssueToStatus(repo, number, board, status)),
          }),
        assignSelf: (number) =>
          self.pipe(
            Effect.flatMap((user) =>
              provide(
                githubSend(
                  "POST",
                  path(`/issues/${number}/assignees`),
                  Option.some({ assignees: [user] }),
                ),
              ),
            ),
            Effect.asVoid,
          ),
        login: self,
        branchSha,
        createBranch,
        deleteBranch,
        createCommit,
        createRef,
        ref,
        deleteRef,
        pullRequest: (number) =>
          readOrNotFound(`pull request #${number}`, `/pulls/${number}`, RestPullRequest).pipe(
            Effect.map(toPullRequest),
          ),
        pullRequestForBranch: (branch) =>
          provide(
            githubJson(
              "GET",
              path(`/pulls?head=${owner}:${encodeURIComponent(branch)}&state=all&per_page=5`),
              PullRequests,
            ).pipe(
              Effect.map((pulls) => Option.map(Option.fromUndefinedOr(pulls[0]), toPullRequest)),
            ),
          ),
        pullRequestsLabelled: (label) =>
          openPullRequests.pipe(
            Effect.map((pulls) => pulls.filter((pull) => pull.labels.includes(label))),
          ),
        openPullRequests,
        requestReviewers: (pullRequest, reviewers) =>
          unlessClosed(pullRequest)(
            provide(
              githubSend(
                "POST",
                path(`/pulls/${pullRequest}/requested_reviewers`),
                Option.some({ reviewers: [...reviewers] }),
              ).pipe(Effect.asVoid),
            ),
          ),
        reviews,
        openPullRequest: (pullRequest) =>
          provide(
            githubJson(
              "POST",
              path("/pulls"),
              RestPullRequest,
              Option.some({
                head: pullRequest.head,
                base: pullRequest.base,
                title: pullRequest.title,
                body: pullRequest.body,
              }),
            ).pipe(Effect.map(toPullRequest)),
          ),
        ciState: (pullRequest) => provide(readCiState(repo, pullRequest)),
        pullRequestFiles: (pullRequest) =>
          provide(
            githubGetAllPages(
              path(`/pulls/${pullRequest}/files?per_page=100`),
              Schema.Array(RestFile),
              identity,
            ).pipe(Effect.map((files) => files.map((file) => file.filename))),
          ),
        closedPullRequestsLabelled: (label) =>
          provide(
            githubJson(
              "GET",
              path("/pulls?state=closed&sort=updated&direction=desc&per_page=30"),
              PullRequests,
            ).pipe(
              Effect.map((pulls) =>
                pulls.map(toPullRequest).filter((pull) => pull.labels.includes(label)),
              ),
            ),
          ),
        review,
        reviewComments,
        merge: (pullRequest, merge) =>
          provide(
            Effect.gen(function* () {
              const response = yield* githubRequest(
                "PUT",
                path(`/pulls/${pullRequest}/merge`),
                Option.some({ merge_method: merge.method, sha: merge.sha }),
              );

              if (response.status < 300) {
                return {
                  sha: (yield* decodeBody(MergedCommit, "merging")(response.body)).sha,
                } satisfies Merged;
              }

              // 405: not mergeable under the repo's rules; 409: the head moved; 422: the request itself.
              if ([405, 409, 422].includes(response.status)) {
                return yield* unlessClosed(pullRequest)(
                  Effect.fail(
                    new MergeRefused({
                      pullRequest,
                      reason: refusalOf(response.status, response.body),
                    }),
                  ),
                );
              }

              return yield* new GitHubError({
                message: `merging #${pullRequest} returned HTTP ${response.status}`,
              });
            }),
          ),
        request: (method, requestPath, body) =>
          provide(githubJson(method, requestPath, Schema.Json, body)),
      });
    }),
  );

const gitError = (error: { readonly message: string }) => new GitError({ message: error.message });

// GitHub's refusal of a change to a workflow file, by a token without the
// scope or permission it needs: "refusing to allow an OAuth App to create or
// update workflow `.github/workflows/ci.yml` without `workflow` scope".
const MISSING_SCOPE = /refusing to allow .*without `?(\w+)`? (?:scope|permission)/;

// What git said when a push failed, read as the remote refusing it: a token
// missing a scope, or a branch that moved since (a stale lease, a non-fast-forward).
export const pushRejection = (branch: string, said: string) => {
  const lines = said.split("\n").map((line) => line.replace(/^remote:\s*/, "").trim());
  const scope = Arr.findFirst(lines, (line) => MISSING_SCOPE.test(line));

  if (Option.isSome(scope)) {
    return Option.some(
      new PushRejected({
        branch,
        reason: scope.value,
        missingScope: MISSING_SCOPE.exec(scope.value)?.[1] ?? "workflow",
      }),
    );
  }

  return Option.map(
    Arr.findFirst(lines, (line) => /\[(?:remote )?rejected\]/.test(line)),
    (rejected) => new PushRejected({ branch, reason: rejected }),
  );
};

// Git as one persona: a push authenticates with its token.
export const GitLive = (
  persona: Persona,
): Layer.Layer<Git, never, Exec | GitHubTokens | HostEnvironment> =>
  Layer.effect(
    Git,
    Effect.gen(function* () {
      const services = yield* Effect.context<Exec | GitHubTokens | HostEnvironment>();

      const run = (args: ReadonlyArray<string>, cwd: string) =>
        execOptionsFor(persona, { cwd }).pipe(
          Effect.flatMap((options) => execOk("git", args, options)),
          Effect.provideContext(services),
          Effect.mapError(gitError),
        );

      const fetchBase = (cwd: string, base: string) =>
        run(["fetch", "--quiet", "origin", base], cwd);

      return Git.of({
        run,
        headSha: (cwd) => run(["rev-parse", "HEAD"], cwd).pipe(Effect.map((sha) => sha.trim())),
        commitsAhead: (cwd, base) =>
          fetchBase(cwd, base).pipe(
            Effect.andThen(run(["rev-list", "--count", `origin/${base}..HEAD`], cwd)),
            Effect.map((count) => Number(count.trim())),
          ),
        changedFiles: (cwd, base) =>
          fetchBase(cwd, base).pipe(
            Effect.andThen(run(["diff", "--name-only", `origin/${base}...HEAD`], cwd)),
            Effect.map((output) => output.split("\n").filter((line) => line.length > 0)),
          ),
        // Only ever the run's own branch, so a lease is enough to never overwrite someone's push.
        push: (cwd, branch) =>
          run(["push", "--force-with-lease", "origin", `HEAD:refs/heads/${branch}`], cwd).pipe(
            Effect.asVoid,
            Effect.catchTag("GitError", (error): Effect.Effect<never, GitError | PushRejected> =>
              Effect.fail(
                Option.getOrElse(
                  pushRejection(branch, error.message),
                  (): GitError | PushRejected => error,
                ),
              ),
            ),
          ),
        pull: (cwd, branch) =>
          run(["pull", "--ff-only", "--quiet", "origin", branch], cwd).pipe(Effect.asVoid),
      });
    }),
  );

// Worktrees, fetched as `persona`. A branch has one worktree whoever works on
// it, since git allows a branch only one, and a resumed agent session finds
// its transcript by the worktree it ran in. A detached checkout, such as a
// review's, belongs to the repo's persona (Repo.persona), so two personas
// reviewing one pull request never share one.
export const WorktreeLive = (
  settings: RepoSettings,
  persona: Persona,
): Layer.Layer<
  Worktree,
  never,
  Exec | FileSystem.FileSystem | Home | GitHubTokens | HostEnvironment
> =>
  Layer.effect(
    Worktree,
    Effect.gen(function* () {
      const exec = yield* Exec;
      const fs = yield* FileSystem.FileSystem;
      const services = yield* Effect.context<Exec | GitHubTokens | HostEnvironment>();
      const root = homePaths((yield* Home).root).worktrees(settings.name);

      const options = (cwd: string) =>
        execOptionsFor(persona, { cwd }).pipe(
          Effect.provideContext(services),
          Effect.mapError(gitError),
        );

      const git = (args: ReadonlyArray<string>, cwd = settings.path) =>
        options(cwd).pipe(
          Effect.flatMap((found) =>
            execOk("git", args, found).pipe(Effect.provideService(Exec, exec)),
          ),
          Effect.mapError(gitError),
        );

      const pathFor = (branch: string) => `${root}/${branch.replace(/[^\w.-]+/g, "-")}`;

      const checkoutPathFor = (name: string) =>
        pathFor(
          Option.match(Option.fromUndefinedOr(settings.persona), {
            onNone: () => name,
            onSome: (own) => `${name}@${own}`,
          }),
        );

      const exists = (path: string) => fs.exists(path).pipe(Effect.mapError(gitError));
      const makeRoot = fs.makeDirectory(root, { recursive: true }).pipe(Effect.mapError(gitError));

      // The branch's remote-tracking ref, fetched over whatever an earlier run left there.
      const fetchBranch = (branch: string) =>
        Effect.gen(function* () {
          const remote = yield* exec
            .run(
              "git",
              ["fetch", "--quiet", "origin", `+${branch}:refs/remotes/origin/${branch}`],
              yield* options(settings.path),
            )
            .pipe(Effect.mapError(gitError));

          if (remote.exitCode === 0) {
            return `origin/${branch}`;
          }

          yield* git(["fetch", "--quiet", "origin", settings.baseBranch]);

          return `origin/${settings.baseBranch}`;
        });

      // Which run last prepared a worktree, kept in its git directory.
      const ownerFile = (path: string) =>
        git(["rev-parse", "--absolute-git-dir"], path).pipe(
          Effect.map((dir) => `${dir.trim()}/chernabog-run`),
        );

      const owner = (path: string) =>
        ownerFile(path).pipe(
          Effect.flatMap((file) => fs.readFileString(file).pipe(Effect.option)),
          Effect.map(Option.map((found) => found.trim())),
        );

      const own = (path: string, run: Option.Option<string>) =>
        Option.match(run, {
          onNone: () => Effect.void,
          onSome: (id) =>
            ownerFile(path).pipe(
              Effect.flatMap((file) => fs.writeFileString(file, `${id}\n`)),
              Effect.mapError(gitError),
            ),
        });

      const ensure = (branch: string, runId?: string) =>
        Effect.gen(function* () {
          const path = pathFor(branch);
          const run = Option.fromUndefinedOr(runId);

          if (yield* exists(`${path}/.git`)) {
            // Reused as is without a run, or by the run that prepared it, whose
            // uncommitted work is there. Another run's is brought to the claim.
            if (Option.isNone(run)) {
              return path;
            }

            if (Option.contains(yield* owner(path), run.value)) {
              return path;
            }

            const start = yield* fetchBranch(branch);
            yield* git(["checkout", "--quiet", "--force", "-B", branch, start], path);
            yield* git(["clean", "-fdq"], path);

            if (start === `origin/${branch}`) {
              yield* git(["branch", "--set-upstream-to", start, branch], path);
            }

            yield* own(path, run);

            return path;
          }

          yield* makeRoot;
          yield* git(["worktree", "prune"]);
          const start = yield* fetchBranch(branch);
          yield* git(["worktree", "add", "--force", "-B", branch, path, start]);

          if (start === `origin/${branch}`) {
            yield* git(["branch", "--set-upstream-to", start, branch], path);
          }

          yield* own(path, run);

          return path;
        });

      const checkout = (name: string, ref: string) =>
        Effect.gen(function* () {
          const path = checkoutPathFor(name);
          const branch = ref.replace(/^origin\//, "");
          yield* git([
            "fetch",
            "--quiet",
            "origin",
            `${branch}:refs/remotes/origin/${branch}`,
          ]).pipe(Effect.catch(() => git(["fetch", "--quiet", "origin"])));

          if (yield* exists(`${path}/.git`)) {
            yield* git(["checkout", "--quiet", "--detach", ref], path);
            yield* git(["reset", "--quiet", "--hard", ref], path);
            yield* git(["clean", "-fdq"], path);
          } else {
            yield* makeRoot;
            yield* git(["worktree", "prune"]);
            yield* git(["worktree", "add", "--force", "--detach", path, ref]);
          }

          return path;
        });

      // The branch's worktree, and the persona's detached checkout of that name.
      const remove = (branch: string) =>
        Effect.gen(function* () {
          for (const path of Arr.dedupe([pathFor(branch), checkoutPathFor(branch)])) {
            if (yield* exists(path)) {
              yield* git(["worktree", "remove", "--force", path]);
            }
          }

          yield* exec
            .run("git", ["branch", "-D", branch], { cwd: settings.path })
            .pipe(Effect.ignore);
        });

      return Worktree.of({ pathFor, ensure, checkout, remove });
    }),
  );

// The usage gate and account check for whichever agent the repo implements with.
export const UsageLive = (settings: RepoSettings, gate: GateConfig) =>
  Layer.effect(
    Usage,
    Effect.gen(function* () {
      const services = yield* Effect.context<
        | Effect.Services<ReturnType<typeof runUsageGate>>
        | Effect.Services<ReturnType<typeof checkCodexAccount>>
        | Effect.Services<ReturnType<typeof codexUsageGate>>
      >();

      const provide = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          | Effect.Services<ReturnType<typeof runUsageGate>>
          | Effect.Services<ReturnType<typeof checkCodexAccount>>
          | Effect.Services<ReturnType<typeof codexUsageGate>>
        >,
      ) => Effect.provide(effect, services);

      // usageGate none skips the reading; the account still has to be the right one.
      const gated = (reading: Usage["Service"]["gate"]): Usage["Service"]["gate"] => {
        if (settings.account.usageGate === "none") {
          return Effect.succeed(ungated(settings.account));
        }

        return reading;
      };

      if (settings.agent === "claude") {
        const refresh = { launcher: settings.launcher, cwd: settings.path };

        return Usage.of({
          gate: gated(provide(runUsageGate(settings.account, gate, refresh))),
          checkAccount: provide(checkAccount(settings.account)),
        });
      }

      if (settings.agent === "codex") {
        return Usage.of({
          gate: gated(provide(codexUsageGate(settings.account, gate))),
          checkAccount: provide(checkCodexAccount(settings.account)),
        });
      }

      return Usage.of({
        gate: Effect.succeed({
          launch: true,
          reason: `${settings.agent} reports no usage to gate on`,
        }),
        checkAccount: Effect.succeed(`${settings.agent}: not checked`),
      });
    }),
  );

export const RepoLive = (settings: RepoSettings) => Layer.succeed(Repo, settings);

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

// Whether the persona holds a seat in the repo's reviewer pool: a login under
// github:, not the implicit account, that reviewers lists, and that gh has a token for.
export const checkReviewerSeat = (
  settings: RepoSettings,
  persona: Persona,
): Effect.Effect<string, SetupError, GitHubTokens> => {
  const reviewers = settings.reviewers ?? [];

  return Option.match(persona, {
    onNone: () => Effect.fail(new NotInReviewerPool({ reviewers })),
    onSome: (own) => {
      if (!reviewers.some((seated) => sameLogin(seated, own))) {
        return Effect.fail(new NotInReviewerPool({ login: own, reviewers }));
      }

      return checkPersona(persona).pipe(Effect.as(own));
    },
  });
};

// The persona's reviewer seat, checked once as its services are built. Most
// flows never review, so a persona without a seat still runs them: the check's
// failure is raised only when a flow asks for the seat, before its work, as a
// defect carrying the setup error, which the engine reports. No flow handles it.
export const ReviewerSeatLive = (settings: RepoSettings, persona: Persona) =>
  Layer.effect(
    ReviewerSeat,
    Effect.exit(checkReviewerSeat(settings, persona)).pipe(
      Effect.map((checked) =>
        ReviewerSeat.of({
          login: Exit.match(checked, {
            onSuccess: Effect.succeed,
            onFailure: (cause) => Effect.orDie(Effect.failCause(cause)),
          }),
        }),
      ),
    ),
  );
