// CI's reading of a pull request, a commit or a branch: red as soon as any
// check fails, green once every check that gates it has passed, pending
// otherwise. And what a failed run's log says.

import {
  type CiFailedRun,
  type CiFailureDetails,
  type CiReport,
  type CiState,
  type Json,
  printJson,
} from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";

import {
  decodeBody,
  GitHubError,
  githubGetAllPages,
  githubJson,
  githubRequest,
} from "../../../../platform/github-api.ts";

export const CheckRun = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.OptionFromNullOr(Schema.String),
});

export type CheckRun = typeof CheckRun.Type;

export const BranchRule = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("required_status_checks"),
    parameters: Schema.Struct({
      required_status_checks: Schema.Array(Schema.Struct({ context: Schema.String })),
    }),
  }),
  Schema.Struct({ type: Schema.String }),
]);

export type BranchRule = typeof BranchRule.Type;

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export const requiredChecksFrom = (branchRules: ReadonlyArray<BranchRule>) =>
  branchRules.flatMap((rule) => {
    if ("parameters" in rule) {
      return rule.parameters.required_status_checks.map((check) => check.context);
    }

    return [];
  });

const latestRunPerCheck = (runs: ReadonlyArray<CheckRun>) => {
  const latest = new Map<string, CheckRun>();

  for (const run of runs) {
    const current = Option.fromUndefinedOr(latest.get(run.name));

    if (Option.match(current, { onNone: () => true, onSome: (seen) => run.id > seen.id })) {
      latest.set(run.name, run);
    }
  }

  return latest;
};

const isFailed = (run: CheckRun) =>
  run.status === "completed" &&
  !Option.exists(run.conclusion, (conclusion) => PASSING_CONCLUSIONS.has(conclusion));

// Red as soon as any check fails, required or not, so a fix can start before the
// slow checks finish. Green only once every required check has passed. A repo with
// no required checks needs every check that ran to finish and pass.
export const classifyChecks = (
  runs: ReadonlyArray<CheckRun>,
  requiredChecks: ReadonlyArray<string>,
): CiState => {
  const latest = latestRunPerCheck(runs);

  const failedChecks = Arr.sort(
    [...latest.values()].flatMap((run) =>
      Option.toArray(Option.map(Option.liftPredicate(run, isFailed), (failed) => failed.name)),
    ),
    Order.String,
  );

  if (failedChecks.length > 0) {
    return { state: "red", failedChecks };
  }

  let gating = requiredChecks;

  if (gating.length === 0) {
    gating = [...latest.keys()];
  }

  const waitingOn = Arr.sort(
    gating.filter(
      (name) =>
        !Option.exists(
          Option.fromUndefinedOr(latest.get(name)),
          (run) => run.status === "completed",
        ),
    ),
    Order.String,
  );

  if (waitingOn.length > 0 || gating.length === 0) {
    return { state: "pending", waitingOn };
  }

  return { state: "green" };
};

const PullRequestRefs = Schema.Struct({
  base: Schema.Struct({ ref: Schema.String }),
  head: Schema.Struct({ sha: Schema.String }),
});

const CheckRunsPage = Schema.Struct({ check_runs: Schema.Array(CheckRun) });

const Rules = Schema.Array(BranchRule);

const ErrorMessage = Schema.Struct({ message: Schema.String });

// GitHub's 403 for a feature the repo's plan doesn't have, such as branch
// rules on a private repo in a free-plan org: "Upgrade to GitHub Pro or make
// this repository public to enable this feature." A rate limit or a token
// without access is a 403 too, and isn't this.
const isPlanRefusal = (body: Option.Option<Json>) =>
  Option.exists(Option.flatMap(body, Schema.decodeUnknownOption(ErrorMessage)), (error) =>
    error.message.startsWith("Upgrade to GitHub Pro"),
  );

// The checks a branch requires, or why every check counts instead: GitHub
// refuses the branch-rules endpoint on a private repo in a free-plan org. Any
// other refusal fails, so required checks are never dropped silently.
const requiredChecksOf = (repo: string, branch: string) =>
  Effect.gen(function* () {
    const path = `/repos/${repo}/rules/branches/${encodeURIComponent(branch)}?per_page=100`;
    const first = yield* githubRequest("GET", path);

    if (first.status === 403 && isPlanRefusal(first.body)) {
      return {
        required: [],
        caveat: Option.some(
          `GitHub's plan for this repo doesn't offer branch rules, so every check counts, not only the ones ${branch} requires`,
        ),
      };
    }

    if (first.status >= 300) {
      return yield* new GitHubError({
        message: `GET ${path} returned HTTP ${first.status}: ${Option.match(first.body, {
          onNone: () => "no body",
          onSome: printJson,
        })}`,
      });
    }

    const firstPage = yield* decodeBody(Rules, `GET ${path}`)(first.body);

    const rest = yield* Option.match(first.nextUrl, {
      onNone: () => Effect.succeed<ReadonlyArray<BranchRule>>([]),
      onSome: (next) => githubGetAllPages(next, Rules, (page) => page),
    });

    const rules = [...firstPage, ...rest];

    return { required: requiredChecksFrom(rules), caveat: Option.none<string>() };
  });

export const readCiState = (repo: string, pullRequestNumber: number) =>
  Effect.gen(function* () {
    const pullRequest = yield* githubJson(
      "GET",
      `/repos/${repo}/pulls/${pullRequestNumber}`,
      PullRequestRefs,
    );

    const { caveat, required } = yield* requiredChecksOf(repo, pullRequest.base.ref);

    const checkRuns = yield* githubGetAllPages(
      `/repos/${repo}/commits/${pullRequest.head.sha}/check-runs?per_page=100`,
      CheckRunsPage,
      (page) => page.check_runs,
    );

    const reading: CiState = classifyChecks(checkRuns, required);

    return Option.match(caveat, {
      onNone: () => reading,
      onSome: (said): CiState => ({ ...reading, caveat: said }),
    });
  });

// A check with where to read why it failed.
export type LinkedCheck = { readonly check: CheckRun; readonly link: CiFailedRun };

// A commit's checks, every one gating it, and links to those that failed.
export const classifyCommit = (checks: ReadonlyArray<LinkedCheck>): CiReport => {
  const latest = new Set(latestRunPerCheck(checks.map((linked) => linked.check)).values());

  const failedRuns = Arr.sort(
    checks.filter((linked) => latest.has(linked.check) && isFailed(linked.check)),
    Order.mapInput(Order.String, (linked: LinkedCheck) => linked.check.name),
  ).map((linked) => linked.link);

  return {
    ...classifyChecks(
      checks.map((linked) => linked.check),
      [],
    ),
    failedRuns,
  };
};

export const WorkflowRun = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String,
  workflow_id: Schema.Finite,
  event: Schema.String,
  status: Schema.String,
  conclusion: Schema.OptionFromNullOr(Schema.String),
  html_url: Schema.String,
  check_suite_id: Schema.Finite,
});

export type WorkflowRun = typeof WorkflowRun.Type;

const runLink = (run: WorkflowRun): CiFailedRun => ({
  name: run.name,
  url: run.html_url,
  job: Option.none(),
  workflowRun: Option.some(run.id),
});

// A branch's push runs, by workflow: red if any workflow's newest completed
// run failed, pending while a workflow has no completed run, green otherwise.
// A cancelled run, such as one a newer push superseded, decides nothing.
export const classifyBranch = (runs: ReadonlyArray<WorkflowRun>): CiReport => {
  const byWorkflow = new Map<number, Array<WorkflowRun>>();

  for (const run of runs) {
    byWorkflow.set(run.workflow_id, [...(byWorkflow.get(run.workflow_id) ?? []), run]);
  }

  const failedRuns: Array<CiFailedRun> = [];
  const waitingOn: Array<string> = [];

  for (const workflowRuns of byWorkflow.values()) {
    const newestFirst = Arr.sort(
      workflowRuns,
      Order.mapInput(Order.flip(Order.Number), (run: WorkflowRun) => run.id),
    );

    const decided = Arr.findFirst(
      newestFirst,
      (run) =>
        run.status === "completed" &&
        !Option.exists(run.conclusion, (said) => said === "cancelled"),
    );

    Option.match(decided, {
      onNone: () => {
        for (const run of Arr.take(newestFirst, 1)) {
          waitingOn.push(run.name);
        }
      },
      onSome: (run) => {
        if (isFailed(run)) {
          failedRuns.push(runLink(run));
        }
      },
    });
  }

  const byName = Order.mapInput(Order.String, (run: CiFailedRun) => run.name);

  if (failedRuns.length > 0) {
    const sorted = Arr.sort(failedRuns, byName);

    return { state: "red", failedChecks: sorted.map((run) => run.name), failedRuns: sorted };
  }

  if (waitingOn.length > 0 || byWorkflow.size === 0) {
    return { state: "pending", waitingOn: Arr.sort(waitingOn, Order.String), failedRuns: [] };
  }

  return { state: "green", failedRuns: [] };
};

const LinkedCheckRun = Schema.Struct({
  ...CheckRun.fields,
  html_url: Schema.OptionFromNullOr(Schema.String),
  details_url: Schema.optionalKey(Schema.OptionFromNullOr(Schema.String)),
  check_suite: Schema.OptionFromNullOr(Schema.Struct({ id: Schema.Finite })),
  app: Schema.OptionFromNullOr(Schema.Struct({ slug: Schema.String })),
});

const LinkedCheckRunsPage = Schema.Struct({ check_runs: Schema.Array(LinkedCheckRun) });

const CommitStatus = Schema.Struct({
  id: Schema.Finite,
  context: Schema.String,
  state: Schema.String,
  target_url: Schema.OptionFromNullOr(Schema.String),
});

const CombinedStatus = Schema.Struct({ statuses: Schema.Array(CommitStatus) });

const WorkflowRunsPage = Schema.Struct({ workflow_runs: Schema.Array(WorkflowRun) });

const checkRunLink = (run: typeof LinkedCheckRun.Type): CiFailedRun => ({
  name: run.name,
  url: Option.getOrElse(
    Option.orElse(run.html_url, () => Option.flatten(Option.fromUndefinedOr(run.details_url))),
    () => "",
  ),
  // An Actions check run is its job: they share an id.
  job: Option.as(
    Option.filter(run.app, (app) => app.slug === "github-actions"),
    run.id,
  ),
  workflowRun: Option.none(),
});

// A commit status read as a check run: pending until it says otherwise.
const statusCheck = (status: typeof CommitStatus.Type): LinkedCheck => ({
  check: {
    id: status.id,
    name: status.context,
    status: Option.match(
      Option.liftPredicate(status.state, (state) => state === "pending"),
      {
        onNone: () => "completed",
        onSome: () => "in_progress",
      },
    ),
    conclusion: Option.liftPredicate(status.state, (state) => state !== "pending"),
  },
  link: {
    name: status.context,
    url: Option.getOrElse(status.target_url, () => ""),
    job: Option.none(),
    workflowRun: Option.none(),
  },
});

export const readCommitCiState = (repo: string, sha: string, event: Option.Option<string>) =>
  Effect.gen(function* () {
    const checkRuns = yield* githubGetAllPages(
      `/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
      LinkedCheckRunsPage,
      (page) => page.check_runs,
    );

    const statuses = yield* githubGetAllPages(
      `/repos/${repo}/commits/${sha}/status?per_page=100`,
      CombinedStatus,
      (page) => page.statuses,
    );

    // The check suites of the workflow runs another event triggered.
    const otherEvents = new Set(
      yield* Option.match(event, {
        onNone: () => Effect.succeed<ReadonlyArray<number>>([]),
        onSome: (wanted) =>
          githubGetAllPages(
            `/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`,
            WorkflowRunsPage,
            (page) => page.workflow_runs,
          ).pipe(
            Effect.map((runs) =>
              runs.filter((run) => run.event !== wanted).map((run) => run.check_suite_id),
            ),
          ),
      }),
    );

    const counted = checkRuns.filter(
      (run) => !Option.exists(run.check_suite, (suite) => otherEvents.has(suite.id)),
    );

    return classifyCommit([
      ...counted.map((run) => ({
        check: { id: run.id, name: run.name, status: run.status, conclusion: run.conclusion },
        link: checkRunLink(run),
      })),
      ...statuses.map(statusCheck),
    ]);
  });

// The newest 100 push runs on the branch: enough for each workflow's newest
// completed one, short of a branch where one workflow ran a hundred times since.
export const readBranchCiState = (repo: string, branch: string) =>
  githubJson(
    "GET",
    `/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&event=push&per_page=100`,
    WorkflowRunsPage,
  ).pipe(Effect.map((page) => classifyBranch(page.workflow_runs)));

const LOG_TAIL_LINES = 100;

const Jobs = Schema.Struct({
  jobs: Schema.Array(Schema.Struct({ ...CheckRun.fields })),
});

// The last lines of a job's log; none when GitHub has no log to give.
const logTail = (repo: string, job: number) =>
  githubRequest("GET", `/repos/${repo}/actions/jobs/${job}/logs`).pipe(
    Effect.map((response) =>
      Option.map(
        Option.flatMap(
          Option.filter(response.body, () => response.status < 300),
          Schema.decodeUnknownOption(Schema.String),
        ),
        (log) => log.trimEnd().split("\n").slice(-LOG_TAIL_LINES).join("\n"),
      ),
    ),
  );

export const readCiFailureDetails = (repo: string, run: CiFailedRun) =>
  Effect.gen(function* () {
    const jobs = yield* Option.match(run.job, {
      onSome: (job) => Effect.succeed([{ id: job, name: run.name }]),
      onNone: () =>
        Option.match(run.workflowRun, {
          onNone: () => Effect.succeed<ReadonlyArray<{ id: number; name: string }>>([]),
          onSome: (workflowRun) =>
            githubJson(
              "GET",
              `/repos/${repo}/actions/runs/${workflowRun}/jobs?filter=latest&per_page=100`,
              Jobs,
            ).pipe(Effect.map((page) => page.jobs.filter(isFailed))),
        }),
    });

    const tails = yield* Effect.forEach(jobs, (job) =>
      logTail(repo, job.id).pipe(Effect.map(Option.map((tail) => ({ name: job.name, tail })))),
    );

    const found = tails.flatMap(Option.toArray);
    let text = found.map((job) => `== ${job.name} ==\n${job.tail}`).join("\n\n");

    if (found.length === 1) {
      text = found.map((job) => job.tail).join("");
    }

    const details: CiFailureDetails = {
      url: run.url,
      logTail: Option.liftPredicate(text, () => found.length > 0),
    };

    return details;
  });

export const describe = (ciState: CiState) => {
  if (ciState.state === "red") {
    return `red ${ciState.failedChecks.join(", ")}`;
  }

  if (ciState.state === "pending" && ciState.waitingOn.length > 0) {
    return `pending ${ciState.waitingOn.join(", ")}`;
  }

  if (ciState.state === "pending") {
    return "pending";
  }

  return "green";
};
