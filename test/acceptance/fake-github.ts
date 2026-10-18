// A small stand-in for the GitHub API, enough for the default flows: issues,
// labels, comments, branches (kept in a real bare repo, so git push works),
// pull requests and check runs.

import { execFileSync, spawnSync } from 'node:child_process';

import { type Json, parseJson, printJson } from '@chernabog/sdk';
import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

export type FakeIssue = { number: number; title: string; body: string; labels: Array<string>; createdAt: string; assignees: Array<string> };

export type FakeComment = { id: number; body: string; user: { login: string }; author_association: string; created_at: string };

export type FakePull = { number: number; title: string; body: string; head: string; base: string; state: 'open' | 'closed'; merged: boolean; labels: Array<string> };

const ReviewComment = Schema.Struct({ path: Schema.String, line: Schema.Finite, side: Schema.optionalKey(Schema.String), body: Schema.String });

export type FakeReview = { id: number; body: string; commit_id: string; comments: ReadonlyArray<typeof ReviewComment.Type> };

export type Checks = 'green' | 'red' | 'pending';

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
    }),
  ),
});

// What the app sends.
const GraphqlBody = Schema.Struct({ variables: Schema.Struct({ search: Schema.optionalKey(Schema.String) }) });
const CreateRefBody = Schema.Struct({ ref: Schema.String, sha: Schema.String });
const CommentBody = Schema.Struct({ body: Schema.String });
const LabelsBody = Schema.Struct({ labels: Schema.Array(Schema.String) });
const AssigneesBody = Schema.Struct({ assignees: Schema.Array(Schema.String) });
const NewPullBody = Schema.Struct({ title: Schema.String, body: Schema.String, head: Schema.String, base: Schema.String });
const ReviewBody = Schema.Struct({ body: Schema.String, commit_id: Schema.String, comments: Schema.optionalKey(Schema.Array(ReviewComment)) });

type Args = { readonly params: ReadonlyArray<string>; readonly body: Option.Option<Json>; readonly url: URL };

type Route = { readonly method: string; readonly pattern: RegExp; readonly handle: (args: Args) => Response };

const json = (body: Json, status = 200) => new Response(printJson(body), { status, headers: { 'content-type': 'application/json' } });

const encoded = <A, I>(schema: Schema.Codec<A, I>, value: A, status = 200) =>
  new Response(Schema.encodeSync(Schema.fromJsonString(schema))(value), { status, headers: { 'content-type': 'application/json' } });

const notFound = () => json({ message: 'Not Found' }, 404);

// A route whose request body must decode with the schema.
const withBody =
  <A, I>(schema: Schema.Codec<A, I>, handle: (body: A, args: Args) => Response) =>
  (args: Args) =>
    Option.match(Option.flatMap(args.body, Schema.decodeUnknownOption(schema)), {
      onNone: () => json({ message: 'Problems parsing JSON' }, 400),
      onSome: (body) => handle(body, args),
    });

const now = () => new Date().toISOString();

const numberParam = (args: Args) => Number(args.params[0] ?? '0');

export const startFakeGitHub = (options: { slug: string; bare: string; checks?: Checks }) => {
  const issues = new Map<number, FakeIssue>();
  const comments = new Map<number, Array<FakeComment>>();
  const pulls = new Map<number, FakePull>();
  const reviews = new Map<number, Array<FakeReview>>();
  const requests: Array<string> = [];
  let nextNumber = 1;
  let nextComment = 1;
  let checks: Checks = options.checks ?? 'green';
  const inAWhile = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  const usageOf = (fiveHour: number, sevenDay: number) => ({ five_hour: { utilization: fiveHour, resets_at: inAWhile(3) }, seven_day: { utilization: sevenDay, resets_at: inAWhile(24) } });
  let usage = usageOf(5, 10);
  const git = (...args: Array<string>) => execFileSync('git', ['--git-dir', options.bare, ...args], { encoding: 'utf8' }).trim();

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

  const refSha = (branch: string) => {
    const result = spawnSync('git', ['--git-dir', options.bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { encoding: 'utf8' });

    return Option.liftPredicate(result.stdout.trim(), () => result.status === 0);
  };

  const html = (kind: string, number: number) => `https://github.com/${options.slug}/${kind}/${number}`;

  const issueJson = (issue: FakeIssue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    html_url: html('issues', issue.number),
    created_at: issue.createdAt,
    labels: issue.labels.map((name) => ({ name })),
  });

  const pullJson = (pull: FakePull): typeof PullJson.Type => ({
    number: pull.number,
    title: pull.title,
    body: pull.body,
    html_url: html('pull', pull.number),
    state: pull.state,
    merged_at: Option.liftPredicate(now(), () => pull.merged),
    head: { ref: pull.head, sha: Option.getOrElse(refSha(pull.head), () => '') },
    base: { ref: pull.base },
    labels: pull.labels.map((name) => ({ name })),
    user: { login: 'chernabog-bot' },
  });

  const labelsOf = (number: number) =>
    Option.getOrElse(Option.orElse(Option.map(Option.fromUndefinedOr(issues.get(number)), (issue) => issue.labels), () => Option.map(Option.fromUndefinedOr(pulls.get(number)), (pull) => pull.labels)), (): Array<string> => []);

  const searchIssues = withBody(GraphqlBody, (body) => {
    const label = Option.flatMap(Option.fromUndefinedOr(body.variables.search), (search) => Option.flatMap(Option.fromNullishOr(/label:"([^"]+)"/.exec(search)), (match) => Option.fromUndefinedOr(match[1])));

    const nodes = [...issues.values()].flatMap((issue) => {
      if (Option.isSome(label) && !issue.labels.includes(label.value)) return [];

      return [{ ...issueJson(issue), url: html('issues', issue.number), createdAt: issue.createdAt, labels: { nodes: issue.labels.map((name) => ({ name })) }, projectItems: { nodes: [] } }];
    });

    return json({ data: { search: { nodes } } });
  });

  const createRef = withBody(CreateRefBody, (body) => {
    if (Option.isSome(refSha(body.ref.replace('refs/heads/', '')))) return json({ message: 'Reference already exists' }, 422);

    git('update-ref', body.ref, body.sha);

    return json({ ref: body.ref }, 201);
  });

  const deleteRef = (args: Args) => {
    const branch = args.params[0] ?? '';

    if (Option.isNone(refSha(branch))) return json({ message: 'Reference does not exist' }, 422);

    git('update-ref', '-d', `refs/heads/${branch}`);

    return new Response('', { status: 204 });
  };

  const addComment = withBody(CommentBody, (body, args) => {
    const number = numberParam(args);
    const comment = { id: takeCommentId(), body: body.body, user: { login: 'chernabog-bot' }, author_association: 'OWNER', created_at: now() };
    comments.set(number, [...(comments.get(number) ?? []), comment]);

    return json(comment, 201);
  });

  const addLabels = withBody(LabelsBody, (body, args) => {
    const labels = labelsOf(numberParam(args));

    for (const label of body.labels) if (!labels.includes(label)) labels.push(label);

    return json(labels.map((name) => ({ name })));
  });

  const removeLabel = (args: Args) => {
    const labels = labelsOf(numberParam(args));
    const index = labels.indexOf(decodeURIComponent(args.params[1] ?? ''));

    if (index < 0) return json({ message: 'Label does not exist' }, 404);

    labels.splice(index, 1);

    return json([]);
  };

  const addAssignees = withBody(AssigneesBody, (body, args) => {
    const issue = Option.fromUndefinedOr(issues.get(numberParam(args)));

    if (Option.isSome(issue)) issue.value.assignees = [...issue.value.assignees, ...body.assignees];

    return json({}, 201);
  });

  const createPull = withBody(NewPullBody, (body) => {
    if (Option.isNone(refSha(body.head))) return json({ message: `no branch ${body.head}` }, 422);

    const pull: FakePull = { number: takeNumber(), title: body.title, body: body.body, head: body.head, base: body.base, state: 'open', merged: false, labels: [] };
    pulls.set(pull.number, pull);

    return encoded(PullJson, pullJson(pull), 201);
  });

  const listPulls = ({ url }: Args) => {
    const head = Option.flatMap(Option.fromNullishOr(url.searchParams.get('head')), (spec) => Option.fromUndefinedOr(spec.split(':')[1]));
    const state = url.searchParams.get('state') ?? 'open';
    const found = [...pulls.values()].filter((pull) => Option.match(head, { onNone: () => true, onSome: (wanted) => pull.head === wanted }) && (state === 'all' || pull.state === state)).reverse();

    if (url.searchParams.get('sort') === 'updated') found.sort((a, b) => b.number - a.number);

    return encoded(Schema.Array(PullJson), found.map(pullJson));
  };

  const addReview = withBody(ReviewBody, (body, args) => {
    const number = numberParam(args);
    const review: FakeReview = { id: takeCommentId(), body: body.body, commit_id: body.commit_id, comments: body.comments ?? [] };
    reviews.set(number, [...(reviews.get(number) ?? []), review]);

    return json(review);
  });

  const listReviews = (args: Args) =>
    json((reviews.get(numberParam(args)) ?? []).map((review) => ({ ...review, user: { login: 'chernabog-bot' }, author_association: 'OWNER', submitted_at: now() })));

  const listReviewComments = (args: Args) =>
    json(
      (reviews.get(numberParam(args)) ?? []).flatMap((review) =>
        review.comments.map((comment, index) => ({ id: review.id * 100 + index, ...comment, original_line: comment.line, user: { login: 'chernabog-bot' }, author_association: 'OWNER', created_at: now() })),
      ),
    );

  const pullFiles = (args: Args) =>
    Option.match(Option.fromUndefinedOr(pulls.get(numberParam(args))), {
      onNone: notFound,
      onSome: (pull) =>
        json(
          git('diff', '--name-only', `${pull.base}...${pull.head}`)
            .split('\n')
            .flatMap((filename) => Option.toArray(Option.map(Option.liftPredicate(filename, (name) => name.length > 0), (name) => ({ filename: name })))),
        ),
    });

  const checkRuns = () => {
    const run = { id: 1, name: 'test', started_at: Option.none<string>(), completed_at: Option.none<string>() };

    if (checks === 'pending') return encoded(CheckRunsJson, { check_runs: [{ ...run, status: 'in_progress', conclusion: Option.none() }] });

    const conclusion = Option.some(Option.getOrElse(Option.liftPredicate('success', () => checks === 'green'), () => 'failure'));

    return encoded(CheckRunsJson, { check_runs: [{ ...run, status: 'completed', conclusion }] });
  };

  const repo = `/repos/${options.slug}`;

  const routes: ReadonlyArray<Route> = [
    { method: 'GET', pattern: /^\/user$/, handle: () => json({ login: 'chernabog-bot' }) },
    { method: 'GET', pattern: /^\/api\/oauth\/usage$/, handle: () => json(usage) },
    { method: 'POST', pattern: /^\/graphql$/, handle: searchIssues },
    { method: 'GET', pattern: new RegExp(`^${repo}/git/ref/heads/(.+)$`), handle: (args) => Option.match(refSha(args.params[0] ?? ''), { onNone: notFound, onSome: (sha) => json({ object: { sha } }) }) },
    { method: 'POST', pattern: new RegExp(`^${repo}/git/refs$`), handle: createRef },
    { method: 'DELETE', pattern: new RegExp(`^${repo}/git/refs/heads/(.+)$`), handle: deleteRef },
    { method: 'POST', pattern: new RegExp(`^${repo}/issues/(\\d+)/comments$`), handle: addComment },
    { method: 'GET', pattern: new RegExp(`^${repo}/issues/(\\d+)/comments$`), handle: (args) => json(comments.get(numberParam(args)) ?? []) },
    { method: 'POST', pattern: new RegExp(`^${repo}/issues/(\\d+)/labels$`), handle: addLabels },
    { method: 'DELETE', pattern: new RegExp(`^${repo}/issues/(\\d+)/labels/(.+)$`), handle: removeLabel },
    { method: 'POST', pattern: new RegExp(`^${repo}/issues/(\\d+)/assignees$`), handle: addAssignees },
    { method: 'GET', pattern: new RegExp(`^${repo}/issues/(\\d+)$`), handle: (args) => Option.match(Option.fromUndefinedOr(issues.get(numberParam(args))), { onNone: notFound, onSome: (issue) => json(issueJson(issue)) }) },
    { method: 'POST', pattern: new RegExp(`^${repo}/pulls$`), handle: createPull },
    { method: 'GET', pattern: new RegExp(`^${repo}/pulls$`), handle: listPulls },
    { method: 'POST', pattern: new RegExp(`^${repo}/pulls/(\\d+)/reviews$`), handle: addReview },
    { method: 'GET', pattern: new RegExp(`^${repo}/pulls/(\\d+)/reviews$`), handle: listReviews },
    { method: 'GET', pattern: new RegExp(`^${repo}/pulls/(\\d+)/comments$`), handle: listReviewComments },
    { method: 'GET', pattern: new RegExp(`^${repo}/pulls/(\\d+)/files$`), handle: pullFiles },
    {
      method: 'GET',
      pattern: new RegExp(`^${repo}/pulls/(\\d+)$`),
      handle: (args) => Option.match(Option.fromUndefinedOr(pulls.get(numberParam(args))), { onNone: notFound, onSome: (pull) => encoded(PullJson, pullJson(pull)) }),
    },
    { method: 'GET', pattern: new RegExp(`^${repo}/rules/branches/`), handle: () => json([]) },
    { method: 'GET', pattern: new RegExp(`^${repo}/commits/([^/]+)/check-runs$`), handle: checkRuns },
  ];

  const handle = async (request: Request) => {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}`);
    const body = parseJson(await request.text());

    const answered = Arr.findFirst(routes, (route) =>
      Option.map(
        Option.filter(Option.fromNullishOr(route.pattern.exec(url.pathname)), () => route.method === request.method),
        (match) => route.handle({ params: match.slice(1), body, url }),
      ),
    );

    return Option.getOrElse(answered, () => json({ message: `fake GitHub has no ${request.method} ${url.pathname}` }, 404));
  };

  const server = Bun.serve({ port: 0, fetch: handle });

  // Test helpers fail loudly when a test asks for what isn't there.
  const required = <A>(value: Option.Option<A>, what: string): A => {
    if (Option.isNone(value)) throw new Error(`fake GitHub has no ${what}`);

    return value.value;
  };

  return {
    url: `http://localhost:${server.port}`,
    issues,
    comments,
    pulls,
    reviews,
    issue: (number: number) => required(Option.fromUndefinedOr(issues.get(number)), `issue #${number}`),
    pull: (number: number) => required(Option.fromUndefinedOr(pulls.get(number)), `pull request #${number}`),
    firstPull: () => Arr.head([...pulls.values()]),
    commentsOn: (number: number) => comments.get(number) ?? [],
    reviewsOf: (number: number) => reviews.get(number) ?? [],
    closePull: (number: number, merged = true) => {
      const pull = required(Option.fromUndefinedOr(pulls.get(number)), `pull request #${number}`);
      pull.state = 'closed';
      pull.merged = merged;
    },
    requests,
    setChecks: (state: Checks) => {
      checks = state;
    },
    setUsage: (fiveHour: number, sevenDay: number) => {
      usage = usageOf(fiveHour, sevenDay);
    },
    addIssue: (title: string, labels: ReadonlyArray<string>, body = 'Do the thing.') => {
      const number = takeNumber();
      issues.set(number, { number, title, body, labels: [...labels], createdAt: new Date(Date.now() - 1000 * (100 - number)).toISOString(), assignees: [] });

      return number;
    },
    stop: () => server.stop(true),
  };
};
