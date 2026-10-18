// A pull request's CI state: red as soon as any check fails, green once every
// required check has passed, pending otherwise.

import type { CiState } from '@chernabog/sdk';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Schema from 'effect/Schema';

import { githubGetAllPages, githubJson } from './GitHubApi.ts';

export const CheckRun = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.OptionFromNullOr(Schema.String),
});

export type CheckRun = typeof CheckRun.Type;

export const BranchRule = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('required_status_checks'),
    parameters: Schema.Struct({ required_status_checks: Schema.Array(Schema.Struct({ context: Schema.String })) }),
  }),
  Schema.Struct({ type: Schema.String }),
]);

export type BranchRule = typeof BranchRule.Type;

const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

export const requiredChecksFrom = (branchRules: ReadonlyArray<BranchRule>) =>
  branchRules.flatMap((rule) => {
    if ('parameters' in rule) return rule.parameters.required_status_checks.map((check) => check.context);

    return [];
  });

const latestRunPerCheck = (runs: ReadonlyArray<CheckRun>) => {
  const latest = new Map<string, CheckRun>();

  for (const run of runs) {
    const current = Option.fromUndefinedOr(latest.get(run.name));

    if (Option.match(current, { onNone: () => true, onSome: (seen) => run.id > seen.id })) latest.set(run.name, run);
  }

  return latest;
};

const isFailed = (run: CheckRun) => run.status === 'completed' && !Option.exists(run.conclusion, (conclusion) => PASSING_CONCLUSIONS.has(conclusion));

// Red as soon as any check fails, required or not, so a fix can start before the
// slow checks finish. Green only once every required check has passed. A repo with
// no required checks needs every check that ran to finish and pass.
export const classifyChecks = (runs: ReadonlyArray<CheckRun>, requiredChecks: ReadonlyArray<string>): CiState => {
  const latest = latestRunPerCheck(runs);

  const failedChecks = Arr.sort(
    [...latest.values()].flatMap((run) => Option.toArray(Option.map(Option.liftPredicate(run, isFailed), (failed) => failed.name))),
    Order.String,
  );

  if (failedChecks.length > 0) return { state: 'red', failedChecks };

  let gating = requiredChecks;

  if (gating.length === 0) gating = [...latest.keys()];

  const waitingOn = Arr.sort(
    gating.filter((name) => !Option.exists(Option.fromUndefinedOr(latest.get(name)), (run) => run.status === 'completed')),
    Order.String,
  );

  if (waitingOn.length > 0 || gating.length === 0) return { state: 'pending', waitingOn };

  return { state: 'green' };
};

const PullRequestRefs = Schema.Struct({ base: Schema.Struct({ ref: Schema.String }), head: Schema.Struct({ sha: Schema.String }) });

const CheckRunsPage = Schema.Struct({ check_runs: Schema.Array(CheckRun) });

const Rules = Schema.Array(BranchRule);

export const readCiState = (repo: string, pullRequestNumber: number) =>
  Effect.gen(function* () {
    const pullRequest = yield* githubJson('GET', `/repos/${repo}/pulls/${pullRequestNumber}`, PullRequestRefs);
    const rules = yield* githubGetAllPages(`/repos/${repo}/rules/branches/${encodeURIComponent(pullRequest.base.ref)}?per_page=100`, Rules, (page) => page);
    const checkRuns = yield* githubGetAllPages(`/repos/${repo}/commits/${pullRequest.head.sha}/check-runs?per_page=100`, CheckRunsPage, (page) => page.check_runs);

    return classifyChecks(checkRuns, requiredChecksFrom(rules));
  });

export const describe = (ciState: CiState) => {
  if (ciState.state === 'red') return `red ${ciState.failedChecks.join(', ')}`;

  if (ciState.state === 'pending' && ciState.waitingOn.length > 0) return `pending ${ciState.waitingOn.join(', ')}`;

  if (ciState.state === 'pending') return 'pending';

  return 'green';
};
