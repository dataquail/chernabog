// A small stand-in for the GitHub API, enough for the default flows: issues,
// labels, comments, branches and other refs such as claims, and commits made
// through the API (kept in a real bare repo, so git push works), pull
// requests, and CI: check runs, commit statuses and Actions workflow runs.

import { execFileSync, spawnSync } from "node:child_process";

import { type Json, parseJson, printJson } from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";

export type FakeIssue = {
  number: number;
  title: string;
  body: string;
  labels: Array<string>;
  createdAt: string;
  assignees: Array<string>;
  closed?: boolean;
};

export type FakeComment = {
  id: number;
  body: string;
  user: { login: string };
  author_association: string;
  created_at: string;
};

export type FakePull = {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: "open" | "closed";
  merged: boolean;
  labels: Array<string>;
  reviewers: Array<string>;
  author: string;
};

const ReviewComment = Schema.Struct({
  path: Schema.String,
  line: Schema.Finite,
  side: Schema.optionalKey(Schema.String),
  body: Schema.String,
});

export type FakeReview = {
  id: number;
  body: string;
  commit_id: string;
  comments: ReadonlyArray<typeof ReviewComment.Type>;
  author: string;
  state: string;
};

// A review's state once submitted with its event, as GitHub reports it.
const STATES = {
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED",
} satisfies Readonly<Record<string, string>>;

const stateOf = (event: string) =>
  Option.getOrElse(
    Option.map(
      Arr.findFirst(Object.entries(STATES), ([name]) => name === event),
      ([, state]) => state,
    ),
    () => "COMMENTED",
  );

// Who a request comes from: token-<login> is that login, as fakebin/gh hands
// out for a persona; any other token, such as the sandbox's GH_TOKEN, is the bot.
export const BOT = "chernabog-bot";

const loginOf = (request: Request) =>
  Option.getOrElse(
    Option.flatMap(
      Option.fromNullishOr(/^Bearer token-(.+)$/.exec(request.headers.get("authorization") ?? "")),
      (match) => Option.fromUndefinedOr(match[1]),
    ),
    () => BOT,
  );

// The one check run every commit has, or none at all.
export type Checks = "green" | "red" | "pending" | "none";

// An Actions workflow run with one job of the same name. A commit with any of
// these has their jobs as its check runs, in place of the `Checks` one.
export type FakeWorkflowRun = {
  // Also its check suite's.
  id: number;
  name: string;
  workflowId: number;
  event: string;
  headSha: string;
  branch: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: Option.Option<string>;
  // Its job's log.
  log: string;
};

// A commit status, as an outside CI service sets one.
export type FakeStatus = {
  id: number;
  context: string;
  state: "pending" | "success" | "failure" | "error";
  targetUrl: string;
};

// What the fake answers with, where GitHub's own JSON carries nulls.
const PullJson = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  body: Schema.String,
  html_url: Schema.String,
  state: Schema.String,
  merged_at: Schema.OptionFromNullOr(Schema.String),
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  base: Schema.Struct({ ref: Schema.String }),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  user: Schema.Struct({ login: Schema.String }),
  requested_reviewers: Schema.Array(Schema.Struct({ login: Schema.String })),
});

const CheckRunsJson = Schema.Struct({
  check_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.OptionFromNullOr(Schema.String),
      started_at: Schema.OptionFromNullOr(Schema.String),
      completed_at: Schema.OptionFromNullOr(Schema.String),
      html_url: Schema.String,
      check_suite: Schema.Struct({ id: Schema.Finite }),
      app: Schema.Struct({ slug: Schema.String }),
    }),
  ),
});

const WorkflowRunJson = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String,
  workflow_id: Schema.Finite,
  event: Schema.String,
  head_sha: Schema.String,
  head_branch: Schema.String,
  status: Schema.String,
  conclusion: Schema.OptionFromNullOr(Schema.String),
  html_url: Schema.String,
  check_suite_id: Schema.Finite,
});

const WorkflowRunsJson = Schema.Struct({
  total_count: Schema.Finite,
  workflow_runs: Schema.Array(WorkflowRunJson),
});

const JobsJson = Schema.Struct({
  total_count: Schema.Finite,
  jobs: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      run_id: Schema.Finite,
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.OptionFromNullOr(Schema.String),
      html_url: Schema.String,
    }),
  ),
});

// What the app sends.
const GraphqlBody = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  variables: Schema.Struct({
    search: Schema.optionalKey(Schema.String),
    id: Schema.optionalKey(Schema.String),
  }),
});

const NewIssueBody = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  assignees: Schema.optionalKey(Schema.Array(Schema.String)),
});

const StateBody = Schema.Struct({ state: Schema.optionalKey(Schema.Literals(["open", "closed"])) });
const LabelBody = Schema.Struct({ name: Schema.String });

const CreateRefBody = Schema.Struct({ ref: Schema.String, sha: Schema.String });

const UpdateRefBody = Schema.Struct({
  sha: Schema.String,
  force: Schema.optionalKey(Schema.Boolean),
});

const CreateCommitBody = Schema.Struct({
  message: Schema.String,
  tree: Schema.String,
  parents: Schema.Array(Schema.String),
});

const CommentBody = Schema.Struct({ body: Schema.String });
const LabelsBody = Schema.Struct({ labels: Schema.Array(Schema.String) });
const AssigneesBody = Schema.Struct({ assignees: Schema.Array(Schema.String) });

const NewPullBody = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  head: Schema.String,
  base: Schema.String,
});

const ReviewBody = Schema.Struct({
  body: Schema.String,
  commit_id: Schema.String,
  event: Schema.optionalKey(Schema.String),
  comments: Schema.optionalKey(Schema.Array(ReviewComment)),
});

const ReviewersBody = Schema.Struct({ reviewers: Schema.Array(Schema.String) });
const SubIssueBody = Schema.Struct({ sub_issue_id: Schema.Finite });
const BlockerBody = Schema.Struct({ issue_id: Schema.Finite });

// An issue's id, which the sub-issue and dependency endpoints take, is not its
// number on GitHub; the fake keeps them apart so a mix-up fails.
const ID_OFFSET = 1_000_000;
const MergeBody = Schema.Struct({ merge_method: Schema.String, sha: Schema.String });

type Args = {
  readonly params: ReadonlyArray<string>;
  readonly body: Option.Option<Json>;
  readonly url: URL;
  readonly login: string;
};

type Route = {
  readonly method: string;
  readonly pattern: RegExp;
  readonly handle: (args: Args, request: Request) => Response;
};

const json = (body: Json, status = 200) =>
  new Response(printJson(body), { status, headers: { "content-type": "application/json" } });

const encoded = <A, I>(schema: Schema.Codec<A, I>, value: A, status = 200) =>
  new Response(Schema.encodeSync(Schema.fromJsonString(schema))(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const notFound = () => json({ message: "Not Found" }, 404);

// A route whose request body must decode with the schema.
const withBody =
  <A, I>(schema: Schema.Codec<A, I>, handle: (body: A, args: Args) => Response) =>
  (args: Args) =>
    Option.match(Option.flatMap(args.body, Schema.decodeUnknownOption(schema)), {
      onNone: () => json({ message: "Problems parsing JSON" }, 400),
      onSome: (body) => handle(body, args),
    });

const now = () => new Date().toISOString();

const numberParam = (args: Args) => Number(args.params[0] ?? "0");

// One of a login's notifications: why GitHub sent it, the pull request it's
// about, and when its thread last changed, in milliseconds.
export type FakeNotification = {
  readonly login: string;
  readonly reason: string;
  readonly number: number;
  readonly updatedAt: number;
};

// How long the fake asks a poller to wait between polls, in seconds.
const POLL_INTERVAL = 1;

export const startFakeGitHub = (options: { slug: string; bare: string; checks?: Checks }) => {
  const issues = new Map<number, FakeIssue>();
  const comments = new Map<number, Array<FakeComment>>();
  const pulls = new Map<number, FakePull>();
  const reviews = new Map<number, Array<FakeReview>>();
  const notifications: Array<FakeNotification> = [];
  // The Last-Modified each login was last answered with, and how far it reached.
  const lastAnswered = new Map<string, { readonly header: string; readonly at: number }>();

  // As on GitHub, nobody is notified of what they did themselves.
  const notify = (login: string, reason: string, number: number, by: string) => {
    if (login !== by) {
      notifications.push({ login, reason, number, updatedAt: Date.now() });
    }
  };

  // Each issue's sub-issues, and the issues that block it, by number.
  const subIssues = new Map<number, Array<number>>();
  const blockers = new Map<number, Array<number>>();

  const merges: Array<{ readonly number: number; readonly method: string; readonly by: string }> =
    [];

  // Logins that can only read the repo; anyone else can write.
  const readOnly = new Set<string>();
  // Logins that administer the repo, and so may delete its issues.
  const admins = new Set<string>();
  // The repo's labels, as created through the API.
  const repoLabels: Array<string> = [];
  // Who opened each issue through the API.
  const openedBy: Array<string> = [];
  const requests: Array<string> = [];
  // Each request, as "<login> <method> <path>".
  const requestsBy: Array<string> = [];
  let nextNumber = 1;
  let nextComment = 1;
  let checks: Checks = options.checks ?? "green";
  const workflowRuns: Array<FakeWorkflowRun> = [];
  const statuses = new Map<string, Array<FakeStatus>>();
  // The message of the 403 the branch-rules endpoint answers with, if it refuses.
  let branchRulesRefusal = Option.none<string>();
  const inAWhile = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

  const usageOf = (fiveHour: number, sevenDay: number) => ({
    five_hour: { utilization: fiveHour, resets_at: inAWhile(3) },
    seven_day: { utilization: sevenDay, resets_at: inAWhile(24) },
  });

  let usage = usageOf(5, 10);

  const git = (...args: Array<string>) =>
    execFileSync("git", ["--git-dir", options.bare, ...args], { encoding: "utf8" }).trim();

  const takeNumber = () => {
    const number = nextNumber;
    nextNumber += 1;

    return number;
  };

  const takeCommentId = () => {
    const id = nextComment;
    nextComment += 1;

    return id;
  };

  // The sha a ref points at, named in full.
  const shaOf = (ref: string) => {
    const result = spawnSync(
      "git",
      ["--git-dir", options.bare, "rev-parse", "--verify", "--quiet", ref],
      { encoding: "utf8" },
    );

    return Option.liftPredicate(result.stdout.trim(), () => result.status === 0);
  };

  const refSha = (branch: string) => shaOf(`refs/heads/${branch}`);

  const html = (kind: string, number: number) =>
    `https://github.com/${options.slug}/${kind}/${number}`;

  const issueJson = (issue: FakeIssue) => ({
    id: ID_OFFSET + issue.number,
    node_id: `I_${issue.number}`,
    number: issue.number,
    state: Option.getOrElse(
      Option.liftPredicate("closed", () => issue.closed === true),
      () => "open",
    ),
    title: issue.title,
    body: issue.body,
    html_url: html("issues", issue.number),
    created_at: issue.createdAt,
    labels: issue.labels.map((name) => ({ name })),
    assignees: issue.assignees.map((login) => ({ login })),
  });

  const pullJson = (pull: FakePull): typeof PullJson.Type => ({
    number: pull.number,
    title: pull.title,
    body: pull.body,
    html_url: html("pull", pull.number),
    state: pull.state,
    merged_at: Option.liftPredicate(now(), () => pull.merged),
    head: { ref: pull.head, sha: Option.getOrElse(refSha(pull.head), () => "") },
    base: { ref: pull.base },
    labels: pull.labels.map((name) => ({ name })),
    user: { login: pull.author },
    requested_reviewers: pull.reviewers.map((login) => ({ login })),
  });

  const labelsOf = (number: number) =>
    Option.getOrElse(
      Option.orElse(
        Option.map(Option.fromUndefinedOr(issues.get(number)), (issue) => issue.labels),
        () => Option.map(Option.fromUndefinedOr(pulls.get(number)), (pull) => pull.labels),
      ),
      (): Array<string> => [],
    );

  const searchIssues = withBody(GraphqlBody, (body) => {
    const label = Option.flatMap(Option.fromUndefinedOr(body.variables.search), (search) =>
      Option.flatMap(Option.fromNullishOr(/label:"([^"]+)"/.exec(search)), (match) =>
        Option.fromUndefinedOr(match[1]),
      ),
    );

    const nodes = [...issues.values()].flatMap((issue) => {
      if (issue.closed === true || (Option.isSome(label) && !issue.labels.includes(label.value))) {
        return [];
      }

      return [
        {
          ...issueJson(issue),
          url: html("issues", issue.number),
          createdAt: issue.createdAt,
          labels: { nodes: issue.labels.map((name) => ({ name })) },
          assignees: { nodes: issue.assignees.map((login) => ({ login })) },
          projectItems: { nodes: [] },
        },
      ];
    });

    return json({ data: { search: { nodes } } });
  });

  // GraphQL's search, and deleteIssue, which only an admin of the repo may run.
  const graphql = withBody(GraphqlBody, (body, args) => {
    if (body.query?.includes("deleteIssue") === true) {
      if (!admins.has(args.login)) {
        return json({ errors: [{ message: `${args.login} must be an admin to delete an issue` }] });
      }

      const number = Number((body.variables.id ?? "").replace("I_", ""));
      issues.delete(number);

      return json({ data: { deleteIssue: {} } });
    }

    return searchIssues(args);
  });

  const createIssue = withBody(NewIssueBody, (body, args) => {
    const issue: FakeIssue = {
      number: takeNumber(),
      title: body.title,
      body: body.body,
      labels: [...(body.labels ?? [])],
      createdAt: now(),
      assignees: [...(body.assignees ?? [])],
    };

    issues.set(issue.number, issue);
    openedBy.push(`${args.login} opened #${issue.number}`);

    return json(issueJson(issue), 201);
  });

  const editIssue = withBody(StateBody, (body, args) =>
    Option.match(Option.fromUndefinedOr(issues.get(numberParam(args))), {
      onNone: notFound,
      onSome: (issue) => {
        issue.closed = body.state === "closed";

        return json(issueJson(issue));
      },
    }),
  );

  const editPull = withBody(StateBody, (body, args) =>
    Option.match(Option.fromUndefinedOr(pulls.get(numberParam(args))), {
      onNone: notFound,
      onSome: (pull) => {
        pull.state = body.state ?? pull.state;

        return encoded(PullJson, pullJson(pull));
      },
    }),
  );

  const createLabel = withBody(LabelBody, (body) => {
    repoLabels.push(body.name);

    return json({ name: body.name }, 201);
  });

  // As on GitHub, a second create of one ref answers 422, whoever asks.
  // Every ref created through the API, oldest first, as it pointed when made.
  const createdRefs: Array<{ readonly ref: string; readonly sha: string }> = [];

  const createRef = withBody(CreateRefBody, (body) => {
    if (Option.isSome(shaOf(body.ref))) {
      return json({ message: "Reference already exists" }, 422);
    }

    git("update-ref", body.ref, body.sha);
    createdRefs.push({ ref: body.ref, sha: body.sha });

    return json({ ref: body.ref, object: { sha: body.sha } }, 201);
  });

  // A commit of `tree` on `parents`, as GitHub makes one through the API: its sha.
  const commitTree = (body: {
    readonly message: string;
    readonly tree: string;
    readonly parents: ReadonlyArray<string>;
  }) => {
    // The empty tree, which GitHub has in every repo.
    execFileSync("git", ["--git-dir", options.bare, "hash-object", "-t", "tree", "-w", "--stdin"], {
      input: "",
    });

    const sha = execFileSync(
      "git",
      [
        "--git-dir",
        options.bare,
        "commit-tree",
        body.tree,
        ...body.parents.flatMap((parent) => ["-p", parent]),
        "-m",
        body.message,
      ],
      {
        encoding: "utf8",
        input: "",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "GitHub",
          GIT_AUTHOR_EMAIL: "noreply@github.com",
          GIT_COMMITTER_NAME: "GitHub",
          GIT_COMMITTER_EMAIL: "noreply@github.com",
        },
      },
    ).trim();

    return sha;
  };

  const createCommit = withBody(CreateCommitBody, (body) =>
    json({ sha: commitTree(body), message: body.message }, 201),
  );

  const readCommit = (args: Args) => {
    const sha = args.params[0] ?? "";

    if (Option.isNone(shaOf(`${sha}^{commit}`))) {
      return notFound();
    }

    return json({ sha, message: git("log", "-1", "--format=%B", sha) });
  };

  const deleteRef = (args: Args) => {
    const ref = `refs/${args.params[0] ?? ""}`;

    if (Option.isNone(shaOf(ref))) {
      return json({ message: "Reference does not exist" }, 422);
    }

    git("update-ref", "-d", ref);

    return new Response("", { status: 204 });
  };

  // As on GitHub outside refs/heads/: forced or not, the ref moves.
  const updateRef = withBody(UpdateRefBody, (body, args) => {
    const ref = `refs/${args.params[0] ?? ""}`;

    if (Option.isNone(shaOf(ref))) {
      return json({ message: "Reference does not exist" }, 422);
    }

    git("update-ref", ref, body.sha);

    return json({ ref, object: { sha: body.sha } });
  });

  const addComment = withBody(CommentBody, (body, args) => {
    const number = numberParam(args);

    const comment = {
      id: takeCommentId(),
      body: body.body,
      user: { login: args.login },
      author_association: "OWNER",
      created_at: now(),
    };

    comments.set(number, [...(comments.get(number) ?? []), comment]);

    return json(comment, 201);
  });

  const linkedJson = (links: Map<number, Array<number>>, args: Args) =>
    json(
      (links.get(numberParam(args)) ?? []).flatMap((number) =>
        Option.toArray(Option.map(Option.fromUndefinedOr(issues.get(number)), issueJson)),
      ),
    );

  const answerWith = (number: number, status: number) =>
    Option.match(Option.fromUndefinedOr(issues.get(number)), {
      onNone: notFound,
      onSome: (issue) => json(issueJson(issue), status),
    });

  // Links one issue to another by id, as GitHub does; one already there is refused.
  const link = (links: Map<number, Array<number>>, args: Args, id: number) => {
    const from = numberParam(args);
    const to = id - ID_OFFSET;

    if (!issues.has(from) || !issues.has(to)) {
      return notFound();
    }

    const existing = links.get(from) ?? [];

    if (existing.includes(to)) {
      return json({ message: "Validation Failed" }, 422);
    }

    links.set(from, [...existing, to]);

    return answerWith(from, 201);
  };

  const unlink = (args: Args) => {
    const from = numberParam(args);
    const to = Number(args.params[1] ?? "0") - ID_OFFSET;
    const existing = blockers.get(from) ?? [];

    if (!existing.includes(to)) {
      return notFound();
    }

    blockers.set(
      from,
      existing.filter((number) => number !== to),
    );

    return answerWith(from, 200);
  };

  // Issues newest first, as the REST list gives them; creator and state are ignored.
  const listIssues = () =>
    json([...issues.values()].toSorted((left, right) => right.number - left.number).map(issueJson));

  const addLabels = withBody(LabelsBody, (body, args) => {
    const labels = labelsOf(numberParam(args));

    for (const label of body.labels) {
      if (!labels.includes(label)) {
        labels.push(label);
      }
    }

    return json(labels.map((name) => ({ name })));
  });

  const removeLabel = (args: Args) => {
    const labels = labelsOf(numberParam(args));
    const index = labels.indexOf(decodeURIComponent(args.params[1] ?? ""));

    if (index < 0) {
      return json({ message: "Label does not exist" }, 404);
    }

    labels.splice(index, 1);

    return json([]);
  };

  const addAssignees = withBody(AssigneesBody, (body, args) => {
    const issue = Option.fromUndefinedOr(issues.get(numberParam(args)));

    if (Option.isSome(issue)) {
      issue.value.assignees = [...issue.value.assignees, ...body.assignees];
    }

    return json({}, 201);
  });

  const removeAssignees = withBody(AssigneesBody, (body, args) => {
    const issue = Option.fromUndefinedOr(issues.get(numberParam(args)));

    if (Option.isSome(issue)) {
      issue.value.assignees = issue.value.assignees.filter(
        (login) => !body.assignees.includes(login),
      );
    }

    return json({});
  });

  // How far one branch is ahead of another, as git counts it in the bare repo.
  const compare = (args: Args) => {
    const [base = "", head = ""] = (args.params[0] ?? "").split("...").map(decodeURIComponent);

    const ahead = Number(
      execFileSync("git", ["--git-dir", options.bare, "rev-list", "--count", `${base}..${head}`], {
        encoding: "utf8",
      }).trim(),
    );

    return json({ ahead_by: ahead, behind_by: 0 });
  };

  const createPull = withBody(NewPullBody, (body, args) => {
    if (Option.isNone(refSha(body.head))) {
      return json({ message: `no branch ${body.head}` }, 422);
    }

    const pull: FakePull = {
      number: takeNumber(),
      title: body.title,
      body: body.body,
      head: body.head,
      base: body.base,
      state: "open",
      merged: false,
      labels: [],
      reviewers: [],
      author: args.login,
    };

    pulls.set(pull.number, pull);

    return encoded(PullJson, pullJson(pull), 201);
  });

  const listPulls = ({ url }: Args) => {
    const head = Option.flatMap(Option.fromNullishOr(url.searchParams.get("head")), (spec) =>
      Option.fromUndefinedOr(spec.split(":")[1]),
    );

    const state = url.searchParams.get("state") ?? "open";

    const found = [...pulls.values()]
      .filter(
        (pull) =>
          Option.match(head, { onNone: () => true, onSome: (wanted) => pull.head === wanted }) &&
          (state === "all" || pull.state === state),
      )
      .reverse();

    if (url.searchParams.get("sort") === "updated") {
      found.sort((a, b) => b.number - a.number);
    }

    return encoded(Schema.Array(PullJson), found.map(pullJson));
  };

  // As on GitHub: nobody approves or requests changes on their own pull
  // request, and a review drops its author from the requested reviewers.
  const addReview = withBody(ReviewBody, (body, args) => {
    const number = numberParam(args);
    const pull = Option.fromUndefinedOr(pulls.get(number));
    const event = body.event ?? "COMMENT";

    if (event !== "COMMENT" && Option.exists(pull, (found) => found.author === args.login)) {
      return json({ message: "Can not approve your own pull request" }, 422);
    }

    const review: FakeReview = {
      id: takeCommentId(),
      body: body.body,
      commit_id: body.commit_id,
      comments: body.comments ?? [],
      author: args.login,
      state: stateOf(event),
    };

    reviews.set(number, [...(reviews.get(number) ?? []), review]);

    for (const found of Option.toArray(pull)) {
      notify(found.author, "author", number, args.login);
      found.reviewers = found.reviewers.filter((login) => login !== args.login);
    }

    return json(review);
  });

  const requestReviewers = withBody(ReviewersBody, (body, args) =>
    Option.match(Option.fromUndefinedOr(pulls.get(numberParam(args))), {
      onNone: notFound,
      onSome: (pull) => {
        pull.reviewers = [
          ...pull.reviewers.filter((login) => !body.reviewers.includes(login)),
          ...body.reviewers,
        ];

        for (const login of body.reviewers) {
          notify(login, "review_requested", pull.number, args.login);
        }

        return encoded(PullJson, pullJson(pull), 201);
      },
    }),
  );

  // Merges exactly the head asked for, as a squash onto the base.
  const mergePull = withBody(MergeBody, (body, args) =>
    Option.match(Option.fromUndefinedOr(pulls.get(numberParam(args))), {
      onNone: notFound,
      onSome: (pull) => {
        if (Option.getOrElse(refSha(pull.head), () => "") !== body.sha) {
          return json({ message: "Head branch was modified" }, 409);
        }

        git("update-ref", `refs/heads/${pull.base}`, body.sha);
        pull.state = "closed";
        pull.merged = true;
        merges.push({ number: pull.number, method: body.merge_method, by: args.login });

        return json({ sha: body.sha, merged: true });
      },
    }),
  );

  const listReviews = (args: Args) =>
    json(
      (reviews.get(numberParam(args)) ?? []).map(({ author, ...review }) => ({
        ...review,
        user: { login: author },
        author_association: "OWNER",
        submitted_at: now(),
      })),
    );

  const listReviewComments = (args: Args) =>
    json(
      (reviews.get(numberParam(args)) ?? []).flatMap((review) =>
        review.comments.map((comment, index) => ({
          id: review.id * 100 + index,
          ...comment,
          original_line: comment.line,
          user: { login: review.author },
          author_association: "OWNER",
          created_at: now(),
        })),
      ),
    );

  const pullFiles = (args: Args) =>
    Option.match(Option.fromUndefinedOr(pulls.get(numberParam(args))), {
      onNone: notFound,
      onSome: (pull) =>
        json(
          git("diff", "--name-only", `${pull.base}...${pull.head}`)
            .split("\n")
            .flatMap((filename) =>
              Option.toArray(
                Option.map(
                  Option.liftPredicate(filename, (name) => name.length > 0),
                  (name) => ({ filename: name }),
                ),
              ),
            ),
        ),
    });

  // A workflow run's one job, which is also its check run.
  const jobIdOf = (run: FakeWorkflowRun) => run.id * 10;

  const runUrl = (run: FakeWorkflowRun) =>
    `https://github.com/${options.slug}/actions/runs/${run.id}`;

  const checkRuns = (args: Args) => {
    const run = {
      id: 1,
      name: "test",
      started_at: Option.none<string>(),
      completed_at: Option.none<string>(),
      html_url: `https://github.com/${options.slug}/runs/1`,
      check_suite: { id: 1 },
      app: { slug: "github-actions" },
    };

    const onSha = workflowRuns.filter((workflowRun) => workflowRun.headSha === args.params[0]);

    if (onSha.length > 0) {
      return encoded(CheckRunsJson, {
        check_runs: onSha.map((workflowRun) => ({
          ...run,
          id: jobIdOf(workflowRun),
          name: workflowRun.name,
          status: workflowRun.status,
          conclusion: workflowRun.conclusion,
          html_url: `${runUrl(workflowRun)}/job/${jobIdOf(workflowRun)}`,
          check_suite: { id: workflowRun.id },
        })),
      });
    }

    if (checks === "none") {
      return encoded(CheckRunsJson, { check_runs: [] });
    }

    if (checks === "pending") {
      return encoded(CheckRunsJson, {
        check_runs: [{ ...run, status: "in_progress", conclusion: Option.none() }],
      });
    }

    const conclusion = Option.some(
      Option.getOrElse(
        Option.liftPredicate("success", () => checks === "green"),
        () => "failure",
      ),
    );

    return encoded(CheckRunsJson, { check_runs: [{ ...run, status: "completed", conclusion }] });
  };

  const workflowRunJson = (run: FakeWorkflowRun): typeof WorkflowRunJson.Type => ({
    id: run.id,
    name: run.name,
    workflow_id: run.workflowId,
    event: run.event,
    head_sha: run.headSha,
    head_branch: run.branch,
    status: run.status,
    conclusion: run.conclusion,
    html_url: runUrl(run),
    check_suite_id: run.id,
  });

  // Newest first, filtered by the query's head_sha, branch, event and status, as GitHub does.
  const listWorkflowRuns = (args: Args) => {
    const query = args.url.searchParams;

    const matches = (run: FakeWorkflowRun) =>
      [
        ["head_sha", run.headSha],
        ["branch", run.branch],
        ["event", run.event],
        ["status", run.status],
      ].every(([key = "", value]) =>
        Option.match(Option.fromNullishOr(query.get(key)), {
          onNone: () => true,
          onSome: (wanted) => wanted === value,
        }),
      );

    const found = Arr.sort(
      workflowRuns.filter(matches),
      Order.mapInput(Order.flip(Order.Number), (run: FakeWorkflowRun) => run.id),
    );

    return encoded(WorkflowRunsJson, {
      total_count: found.length,
      workflow_runs: found.map(workflowRunJson),
    });
  };

  const runJobs = (args: Args) =>
    Option.match(
      Arr.findFirst(workflowRuns, (run) => run.id === numberParam(args)),
      {
        onNone: notFound,
        onSome: (run) =>
          encoded(JobsJson, {
            total_count: 1,
            jobs: [
              {
                id: jobIdOf(run),
                run_id: run.id,
                name: run.name,
                status: run.status,
                conclusion: run.conclusion,
                html_url: `${runUrl(run)}/job/${jobIdOf(run)}`,
              },
            ],
          }),
      },
    );

  // GitHub redirects to the log; the fake answers with it.
  const jobLog = (args: Args) =>
    Option.match(
      Arr.findFirst(workflowRuns, (run) => jobIdOf(run) === numberParam(args)),
      {
        onNone: notFound,
        onSome: (run) => new Response(run.log, { headers: { "content-type": "text/plain" } }),
      },
    );

  const combinedStatus = (args: Args) => {
    const set = statuses.get(args.params[0] ?? "") ?? [];

    return json({
      state: "pending",
      statuses: set.map((status) => ({
        id: status.id,
        context: status.context,
        state: status.state,
        target_url: status.targetUrl,
      })),
    });
  };

  const branchRules = () =>
    Option.match(branchRulesRefusal, {
      onNone: () => json([]),
      onSome: (message) => json({ message, status: "403" }, 403),
    });

  const permissionOf = (login: string) =>
    Option.getOrElse(
      Option.liftPredicate("read", () => readOnly.has(login)),
      () => "write",
    );

  const repo = `/repos/${options.slug}`;

  // A login's notifications, read or not, changed after `since`. It answers
  // If-Modified-Since with a 304 when none changed since that answer, and
  // never marks one read.
  const listNotifications = (args: Args, request: Request) => {
    const mine = notifications.filter((found) => found.login === args.login);
    const latest = Math.max(0, ...mine.map((found) => found.updatedAt));
    const last = Option.fromUndefinedOr(lastAnswered.get(args.login));
    const asked = Option.fromNullishOr(request.headers.get("if-modified-since"));

    const headers = {
      "content-type": "application/json",
      "x-poll-interval": String(POLL_INTERVAL),
    };

    if (Option.exists(last, (seen) => Option.contains(asked, seen.header) && latest <= seen.at)) {
      return new Response("", { status: 304, headers });
    }

    // HTTP dates have only seconds, so the fake keeps how far each answer reached itself.
    const header = new Date(Math.max(latest, Date.now())).toUTCString();
    lastAnswered.set(args.login, { header, at: Math.max(latest, Date.now()) });

    const since = Option.match(Option.fromNullishOr(args.url.searchParams.get("since")), {
      onNone: () => 0,
      onSome: Date.parse,
    });

    return new Response(
      printJson(
        mine.flatMap((found) =>
          Option.toArray(
            Option.map(
              Option.liftPredicate(found, () => found.updatedAt > since),
              (fresh) => ({
                reason: fresh.reason,
                updated_at: new Date(fresh.updatedAt).toISOString(),
                repository: { full_name: options.slug },
                subject: { url: `https://api.github.com${repo}/pulls/${fresh.number}` },
              }),
            ),
          ),
        ),
      ),
      { status: 200, headers: { ...headers, "last-modified": header } },
    );
  };

  const routes: ReadonlyArray<Route> = [
    { method: "GET", pattern: /^\/user$/, handle: (args) => json({ login: args.login }) },
    { method: "GET", pattern: /^\/api\/oauth\/usage$/, handle: () => json(usage) },
    { method: "GET", pattern: /^\/notifications$/, handle: listNotifications },
    { method: "POST", pattern: /^\/graphql$/, handle: graphql },
    { method: "POST", pattern: new RegExp(`^${repo}/issues$`), handle: createIssue },
    { method: "GET", pattern: new RegExp(`^${repo}/issues$`), handle: listIssues },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/issues/(\\d+)/sub_issues$`),
      handle: (args) => linkedJson(subIssues, args),
    },
    {
      method: "POST",
      pattern: new RegExp(`^${repo}/issues/(\\d+)/sub_issues$`),
      handle: withBody(SubIssueBody, (body, args) => link(subIssues, args, body.sub_issue_id)),
    },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/issues/(\\d+)/dependencies/blocked_by$`),
      handle: (args) => linkedJson(blockers, args),
    },
    {
      method: "POST",
      pattern: new RegExp(`^${repo}/issues/(\\d+)/dependencies/blocked_by$`),
      handle: withBody(BlockerBody, (body, args) => link(blockers, args, body.issue_id)),
    },
    {
      method: "DELETE",
      pattern: new RegExp(`^${repo}/issues/(\\d+)/dependencies/blocked_by/(\\d+)$`),
      handle: unlink,
    },
    { method: "PATCH", pattern: new RegExp(`^${repo}/issues/(\\d+)$`), handle: editIssue },
    { method: "PATCH", pattern: new RegExp(`^${repo}/pulls/(\\d+)$`), handle: editPull },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/labels$`),
      handle: () => json(repoLabels.map((name) => ({ name, color: "ededed", description: "" }))),
    },
    { method: "POST", pattern: new RegExp(`^${repo}/labels$`), handle: createLabel },
    { method: "PATCH", pattern: new RegExp(`^${repo}/labels/(.+)$`), handle: () => json({}) },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/git/ref/(.+)$`),
      handle: (args) =>
        Option.match(shaOf(`refs/${args.params[0] ?? ""}`), {
          onNone: notFound,
          onSome: (sha) => json({ ref: `refs/${args.params[0] ?? ""}`, object: { sha } }),
        }),
    },
    { method: "POST", pattern: new RegExp(`^${repo}/git/refs$`), handle: createRef },
    { method: "DELETE", pattern: new RegExp(`^${repo}/git/refs/(.+)$`), handle: deleteRef },
    { method: "PATCH", pattern: new RegExp(`^${repo}/git/refs/(.+)$`), handle: updateRef },
    { method: "POST", pattern: new RegExp(`^${repo}/git/commits$`), handle: createCommit },
    { method: "GET", pattern: new RegExp(`^${repo}/git/commits/(\\w+)$`), handle: readCommit },
    { method: "POST", pattern: new RegExp(`^${repo}/issues/(\\d+)/comments$`), handle: addComment },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/issues/(\\d+)/comments$`),
      handle: (args) => json(comments.get(numberParam(args)) ?? []),
    },
    { method: "POST", pattern: new RegExp(`^${repo}/issues/(\\d+)/labels$`), handle: addLabels },
    {
      method: "DELETE",
      pattern: new RegExp(`^${repo}/issues/(\\d+)/labels/(.+)$`),
      handle: removeLabel,
    },
    {
      method: "POST",
      pattern: new RegExp(`^${repo}/issues/(\\d+)/assignees$`),
      handle: addAssignees,
    },
    {
      method: "DELETE",
      pattern: new RegExp(`^${repo}/issues/(\\d+)/assignees$`),
      handle: removeAssignees,
    },
    { method: "GET", pattern: new RegExp(`^${repo}/compare/(.+)$`), handle: compare },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/issues/(\\d+)$`),
      // As on GitHub, a pull request is an issue too.
      handle: (args) =>
        Option.match(Option.fromUndefinedOr(issues.get(numberParam(args))), {
          onNone: () =>
            Option.match(Option.fromUndefinedOr(pulls.get(numberParam(args))), {
              onNone: notFound,
              onSome: (pull) =>
                json({
                  node_id: `PR_${pull.number}`,
                  number: pull.number,
                  labels: pull.labels.map((name) => ({ name })),
                  pull_request: { html_url: html("pull", pull.number) },
                }),
            }),
          onSome: (issue) => json(issueJson(issue)),
        }),
    },
    { method: "POST", pattern: new RegExp(`^${repo}/pulls$`), handle: createPull },
    { method: "GET", pattern: new RegExp(`^${repo}/pulls$`), handle: listPulls },
    { method: "POST", pattern: new RegExp(`^${repo}/pulls/(\\d+)/reviews$`), handle: addReview },
    { method: "GET", pattern: new RegExp(`^${repo}/pulls/(\\d+)/reviews$`), handle: listReviews },
    {
      method: "POST",
      pattern: new RegExp(`^${repo}/pulls/(\\d+)/requested_reviewers$`),
      handle: requestReviewers,
    },
    { method: "PUT", pattern: new RegExp(`^${repo}/pulls/(\\d+)/merge$`), handle: mergePull },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/collaborators/([^/]+)/permission$`),
      handle: (args) =>
        json({
          permission: permissionOf(args.params[0] ?? ""),
          role_name: permissionOf(args.params[0] ?? ""),
        }),
    },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/pulls/(\\d+)/comments$`),
      handle: listReviewComments,
    },
    { method: "GET", pattern: new RegExp(`^${repo}/pulls/(\\d+)/files$`), handle: pullFiles },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/pulls/(\\d+)$`),
      handle: (args) =>
        Option.match(Option.fromUndefinedOr(pulls.get(numberParam(args))), {
          onNone: notFound,
          onSome: (pull) => encoded(PullJson, pullJson(pull)),
        }),
    },
    { method: "GET", pattern: new RegExp(`^${repo}/rules/branches/`), handle: branchRules },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/commits/([^/]+)/check-runs$`),
      handle: checkRuns,
    },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/commits/([^/]+)/status$`),
      handle: combinedStatus,
    },
    { method: "GET", pattern: new RegExp(`^${repo}/actions/runs$`), handle: listWorkflowRuns },
    { method: "GET", pattern: new RegExp(`^${repo}/actions/runs/(\\d+)/jobs$`), handle: runJobs },
    { method: "GET", pattern: new RegExp(`^${repo}/actions/jobs/(\\d+)/logs$`), handle: jobLog },
  ];

  const handle = async (request: Request) => {
    const url = new URL(request.url);
    const login = loginOf(request);
    requests.push(`${request.method} ${url.pathname}`);
    requestsBy.push(`${login} ${request.method} ${url.pathname}`);
    const body = parseJson(await request.text());

    const answered = Arr.findFirst(routes, (route) =>
      Option.map(
        Option.filter(
          Option.fromNullishOr(route.pattern.exec(url.pathname)),
          () => route.method === request.method,
        ),
        (match) => route.handle({ params: match.slice(1), body, url, login }, request),
      ),
    );

    return Option.getOrElse(answered, () =>
      json({ message: `fake GitHub has no ${request.method} ${url.pathname}` }, 404),
    );
  };

  const server = Bun.serve({ port: 0, fetch: handle });

  // Test helpers fail loudly when a test asks for what isn't there.
  const required = <A>(value: Option.Option<A>, what: string): A => {
    if (Option.isNone(value)) {
      throw new Error(`fake GitHub has no ${what}`);
    }

    return value.value;
  };

  return {
    url: `http://localhost:${server.port}`,
    issues,
    comments,
    pulls,
    reviews,
    subIssues,
    blockers,
    issue: (number: number) =>
      required(Option.fromUndefinedOr(issues.get(number)), `issue #${number}`),
    pull: (number: number) =>
      required(Option.fromUndefinedOr(pulls.get(number)), `pull request #${number}`),
    firstPull: () => Arr.head([...pulls.values()]),
    commentsOn: (number: number) => comments.get(number) ?? [],
    reviewsOf: (number: number) => reviews.get(number) ?? [],
    notifications,
    // A review someone off this machine submits on the pull request's head.
    submitReview: (
      number: number,
      login: string,
      state: "CHANGES_REQUESTED" | "APPROVED",
      body: string,
    ) => {
      const pull = required(Option.fromUndefinedOr(pulls.get(number)), `pull request #${number}`);

      reviews.set(number, [
        ...(reviews.get(number) ?? []),
        {
          id: takeCommentId(),
          body,
          commit_id: Option.getOrElse(refSha(pull.head), () => ""),
          comments: [],
          author: login,
          state,
        },
      ]);
      pull.reviewers = pull.reviewers.filter((reviewer) => reviewer !== login);
      notify(pull.author, "author", number, login);
    },
    merges,
    readOnly,
    admins,
    repoLabels,
    openedBy,
    closePull: (number: number, merged = true) => {
      const pull = required(Option.fromUndefinedOr(pulls.get(number)), `pull request #${number}`);
      pull.state = "closed";
      pull.merged = merged;
    },
    requests,
    requestsBy,
    // The sha a ref points at, such as a claim, named in full.
    refSha: shaOf,
    createdRefs,
    // Points a ref, named in full, at a commit, as a run that left it would have.
    setRef: (ref: string, sha: string) => {
      git("update-ref", ref, sha);
    },
    // Creates a ref, named in full, as another machine would through the API:
    // whether it did, as a second create of one ref fails.
    createRef: (ref: string, sha: string) => {
      if (Option.isSome(shaOf(ref))) {
        return false;
      }

      git("update-ref", ref, sha);

      return true;
    },
    deleteRef: (ref: string) => {
      git("update-ref", "-d", ref);
    },
    // A commit's message, as GitHub keeps it.
    messageOf: (sha: string) => git("log", "-1", "--format=%B", sha),
    // A commit with an empty tree, such as a claim another machine made: its sha.
    commit: (message: string, parents: ReadonlyArray<string> = []) =>
      commitTree({ message, tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", parents }),
    setChecks: (state: Checks) => {
      checks = state;
    },
    workflowRuns,
    // Sets a commit status on `sha`, replacing any with its context.
    setStatus: (sha: string, status: FakeStatus) => {
      statuses.set(sha, [
        status,
        ...(statuses.get(sha) ?? []).filter((set) => set.context !== status.context),
      ]);
    },
    // Refuses the branch-rules endpoint with a 403. By default it's GitHub's
    // answer on a private repo in a free-plan org.
    refuseBranchRules: (
      message = "Upgrade to GitHub Pro or make this repository public to enable this feature.",
    ) => {
      branchRulesRefusal = Option.some(message);
    },
    setUsage: (fiveHour: number, sevenDay: number) => {
      usage = usageOf(fiveHour, sevenDay);
    },
    addIssue: (
      title: string,
      labels: ReadonlyArray<string>,
      body = "Do the thing.",
      assignees: ReadonlyArray<string> = [],
    ) => {
      const number = takeNumber();
      issues.set(number, {
        number,
        title,
        body,
        labels: [...labels],
        createdAt: new Date(Date.now() - 1000 * (100 - number)).toISOString(),
        assignees: [...assignees],
      });

      return number;
    },
    // A pull request someone off this machine opened, asking `reviewers` to review it.
    addPull: (title: string, head: string, author: string, reviewers: ReadonlyArray<string>) => {
      const number = takeNumber();
      pulls.set(number, {
        number,
        title,
        body: "A change.",
        head,
        base: "main",
        state: "open",
        merged: false,
        labels: [],
        reviewers: [...reviewers],
        author,
      });

      return number;
    },
    // A notification GitHub sends `login` about a pull request, from someone else.
    notify: (login: string, reason: string, number: number) => {
      notify(login, reason, number, "");
    },
    stop: () => server.stop(true),
  };
};
