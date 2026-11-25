// The live driver (ADR 22, decision 7): the domain layer over the real CLI
// and daemon against a real scratch repo on GitHub, with the fake agents of
// test/fakebin/ (claude under the fake tmux, so interactive, and codex), so
// no real agent runs and nothing uses -p. It runs only when a person
// configures it (live-github.ts' HOW_TO_RUN): the cast's alice and bob act as
// the two logins it names, which gh must hold tokens for, with write access.
// The machine it runs on is test/acceptance/live-machine.ts.
//
// What the scratch repo must have first: its default branch holds the
// review loop's four recipes in .chernabog/ (`chernabog init`, merged), and
// its config.yaml's settings.reviewers names both logins, since the engine
// reads the reviewer pool from there alone. It must have no open issues or
// pull requests, since the implement flow takes any it may.
//
// Each scenario works on a scratch base branch of its own, made from the
// default branch's head: every flow's `base`, in machine config, is it, so
// the pull request opens against it and its merge goes there, and the
// default branch is never written. The driver files the scenario's issue,
// and plays the repo's CI: it posts a passing commit status on each head of
// the scenario's pull requests, as a workflow would. When the scenario ends
// it stops the daemon, then closes what it opened and deletes the branches
// and refs the scenario made (live-github.ts' cleanupPlan), once it has
// checked the plan leaves the default branch alone, and fails if anything
// is left.
//
// The world is GitHub's records for the scenario's issues and the pull
// requests on its base, and the fake agents' calls, read in live-github.ts.

import type { Json } from "@chernabog/sdk";
import { BunServices } from "@effect/platform-bun";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import YAML from "yaml";

import { HostEnvironment } from "../../../src/platform/environment.ts";
import { Exec } from "../../../src/platform/exec.ts";
import {
  GitHubApi,
  githubGetAllPages,
  githubJson,
  githubRequest,
  githubSend,
} from "../../../src/platform/github-api.ts";
import { GitHubTokens } from "../../../src/platform/github-auth.ts";
import { type LiveMachine, openLiveMachine, scratchId } from "../../acceptance/live-machine.ts";
import { type Domain, DomainFailed, type Login, type World } from "../domain.ts";
import type { Driver } from "../runner.ts";
import { flowsOf, RECIPES } from "./cast.ts";
import { pollFor, type Polling, settleDaemon } from "./daemon-settle.ts";
import {
  CAST,
  type CastLogins,
  castLogins,
  cleanupPlan,
  guarded,
  type LiveConfig,
  type LiveRecords,
  mayCreate,
  poolProblems,
  scratchBaseFor,
  worldFrom,
} from "./live-github.ts";

// Each persona's cast flows tick this often, well inside GitHub's rate limits.
const EVERY = { schedule: "*/20 * * * * *" };

// How often a wait looks again, and how long it waits for one thing.
const POLL_MS = 15_000;
const WAIT_MS = 10 * 60_000;

// How long the daemon may take to load the repo, and how often to ask.
const READY_MS = 5 * 60_000;
const READY_POLL_MS = 2000;

// The commit status the driver posts as the repo's CI.
const CI_CONTEXT = "chernabog-features-live";

// The local gate the sandbox has too: the fake agents' change files are there.
const LOCAL_GATE = ['test -n "$(ls change-*.txt)"'];

// `install: null`: there is nothing to install in a scratch repo.
const NO_INSTALL = Schema.encodeSync(Schema.OptionFromNullOr(Schema.String))(Option.none());

const REVIEWING = ["review", "re-review"];

const failed = (message: string) => new DomainFailed({ message });

const User = Schema.Struct({ login: Schema.String });

const Repository = Schema.Struct({ default_branch: Schema.String });

const GitRef = Schema.Struct({ object: Schema.Struct({ sha: Schema.String }) });

const MatchingRef = Schema.Struct({ ref: Schema.String });

const Contents = Schema.Struct({ content: Schema.String });

const OpenItem = Schema.Struct({ html_url: Schema.String });

const Created = Schema.Struct({ number: Schema.Finite });

const Issue = Schema.Struct({
  number: Schema.Finite,
  state: Schema.String,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
});

const PullListed = Schema.Struct({
  number: Schema.Finite,
  state: Schema.String,
  user: User,
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  requested_reviewers: Schema.Array(User),
  merged_at: Schema.OptionFromNullOr(Schema.String),
});

type PullListed = typeof PullListed.Type;

const PullMerged = Schema.Struct({ merged_by: Schema.OptionFromNullOr(User) });

const Review = Schema.Struct({
  id: Schema.Finite,
  user: Schema.OptionFromNullOr(User),
  state: Schema.String,
  commit_id: Schema.OptionFromNullOr(Schema.String),
  submitted_at: Schema.OptionFromOptionalNullOr(Schema.String),
});

const ReviewComment = Schema.Struct({
  pull_request_review_id: Schema.OptionFromNullOr(Schema.Finite),
});

const Comment = Schema.Struct({
  user: Schema.OptionFromNullOr(User),
  body: Schema.String,
  created_at: Schema.String,
});

const TimelineEvent = Schema.Struct({
  event: Schema.OptionFromOptionalKey(Schema.String),
  created_at: Schema.OptionFromOptionalKey(Schema.String),
  actor: Schema.OptionFromOptionalNullOr(User),
  requested_reviewer: Schema.OptionFromOptionalNullOr(User),
  label: Schema.OptionFromOptionalKey(Schema.Struct({ name: Schema.String })),
});

const Activity = Schema.Struct({
  after: Schema.String,
  ref: Schema.String,
  timestamp: Schema.String,
  activity_type: Schema.String,
  actor: Schema.OptionFromNullOr(User),
});

const CombinedStatus = Schema.Struct({
  statuses: Schema.Array(Schema.Struct({ context: Schema.String })),
});

// A fake agent's call, as its session log has it after "session ".
const SessionLine = Schema.fromJsonString(
  Schema.Struct({
    call: Schema.Literals(["start", "resume"]),
    session: Schema.String,
    persona: Schema.OptionFromNullOr(Schema.String),
    branch: Schema.String,
    head: Schema.String,
    at: Schema.OptionFromOptionalKey(Schema.String),
  }),
);

const NO_COMMIT = /^0+$/;

// The activity types that move a branch to a commit someone pushed.
const PUSHED = new Set(["push", "force_push", "branch_creation"]);

const tokensLayer = GitHubTokens.layer.pipe(
  Layer.provide(Layer.mergeAll(Exec.layer, HostEnvironment.layer, FetchHttpClient.layer)),
  Layer.provide(BunServices.layer),
);

const apiAs = (login: Login) =>
  GitHubApi.layerFor(Option.some(login)).pipe(
    Layer.provide(Layer.mergeAll(tokensLayer, FetchHttpClient.layer)),
  );

type Api = Context.Context<GitHubApi>;

type Apis = { readonly writer: Api; readonly reviewer: Api };

// What a scenario set up, and what it made on GitHub, for its cleanup.
type Machine = {
  personas: ReadonlyArray<Login>;
  pool: ReadonlyArray<Login>;
  disputing: Set<Login>;
  running: Option.Option<LiveMachine>;
  defaultBranch: Option.Option<string>;
  scratchBase: Option.Option<string>;
  readonly issues: Array<number>;
  // The heads the driver has passed CI on.
  readonly passed: Set<string>;
};

const added = (known: ReadonlyArray<Login>, logins: ReadonlyArray<Login>) => [
  ...known,
  ...logins.filter((login) => !known.includes(login)),
];

const onGitHub =
  (api: Api, what: string) =>
  <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E, GitHubApi>) =>
    effect.pipe(
      Effect.provideContext(api),
      Effect.mapError((error) => failed(`${what}: ${error.message}`)),
    );

const host = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => failed(`${what}: ${String(error)}`) });

// The logins the cast's names act as, refusing a name the configuration has none for.
const loginsOf = (cast: CastLogins, names: ReadonlyArray<Login>) =>
  Effect.forEach(names, (name) =>
    Effect.fromOption(cast.loginOf(name)).pipe(
      Effect.mapError(() =>
        failed(`the live driver has logins for ${CAST.join(" and ")} only, not ${name}`),
      ),
    ),
  );

// Each recipe's settings for the persona `name` acts as: its cast flows on,
// at the scratch base, and the rest off.
const flowsFor = (name: Login, pool: ReadonlyArray<Login>, base: string) =>
  Object.fromEntries(
    RECIPES.map((flow): readonly [string, Json] => [
      flow,
      Option.match(
        Option.liftPredicate(flow, (found) => flowsOf(name, pool).includes(found)),
        {
          onNone: (): Json => ({ enabled: false }),
          onSome: (): Json => ({
            ...EVERY,
            ...Option.match(
              Option.liftPredicate(flow, (found) => REVIEWING.includes(found)),
              { onNone: () => ({}), onSome: () => ({ agent: "codex" }) },
            ),
            settings: { base, localGate: LOCAL_GATE, install: NO_INSTALL },
          }),
        },
      ),
    ]),
  );

// The cast's persona entries, by login: `entry` of each name.
const byLogin = <A>(cast: CastLogins, names: ReadonlyArray<Login>, entry: (name: Login) => A) =>
  Object.fromEntries(
    names.flatMap((name) =>
      Option.toArray(Option.map(cast.loginOf(name), (login) => [login, entry(name)] as const)),
    ),
  );

// Machine config for the cast: claude interactive under tmux, codex
// reviewing, no usage gate (the fake agents spend nothing), and each
// persona's cast flows at the scratch base.
const machineConfigText = (
  config: LiveConfig,
  live: LiveMachine,
  cast: CastLogins,
  machine: Machine,
  base: string,
) =>
  new YAML.Document({
    accounts: {
      work: {
        configDir: `${live.root}/claude`,
        expectedEmail: "dev@example.com",
        usageGate: "none",
      },
      codex: { agent: "codex", configDir: `${live.root}/codex`, usageGate: "none" },
    },
    launcher: "tmux",
    github: byLogin(cast, machine.personas, () => ({})),
    repos: [
      {
        path: live.checkout,
        repo: config.slug,
        name: "demo",
        account: "work",
        personas: byLogin(cast, machine.personas, (name) => ({
          flows: flowsFor(name, machine.pool, base),
        })),
      },
    ],
  }).toString();

const pollingOf = (live: LiveMachine): Polling => ({
  pollMs: POLL_MS,
  waitMs: WAIT_MS,
  tail: live.daemonLog,
});

const statusOf = (live: LiveMachine) => host("the daemon's status", live.daemonStatus);

// Fails, naming them, when the repo has open issues or pull requests: the
// implement flow would take any it may, and the world would be another's too.
const nothingOpen = (slug: string, api: Api) =>
  Effect.gen(function* () {
    const open = yield* githubGetAllPages(
      `/repos/${slug}/issues?state=open&per_page=100`,
      Schema.Array(OpenItem),
      (page) => page,
    ).pipe(onGitHub(api, "the repo's open issues"));

    if (open.length > 0) {
      return yield* failed(
        `${slug} has open issues or pull requests, which a scenario's flows would take up; close them first: ${open.map((item) => item.html_url).join(", ")}`,
      );
    }
  });

// The team's config on the default branch must name the scenario's reviewers.
const poolIsSetUp = (
  slug: string,
  defaultBranch: string,
  api: Api,
  reviewing: ReadonlyArray<Login>,
) =>
  Effect.gen(function* () {
    const contents = yield* githubJson(
      "GET",
      `/repos/${slug}/contents/.chernabog/config.yaml?ref=${encodeURIComponent(defaultBranch)}`,
      Contents,
    ).pipe(
      onGitHub(
        api,
        `${slug}'s ${defaultBranch} has no .chernabog/config.yaml; run chernabog init there with the review loop's recipes and merge it`,
      ),
    );

    const problems = poolProblems(
      Buffer.from(contents.content, "base64").toString("utf8"),
      reviewing,
    );

    if (problems.length > 0) {
      return yield* failed(`${slug}'s ${defaultBranch} can't run the cast: ${problems.join("; ")}`);
    }
  });

// The scenario's scratch base, from the default branch's head.
const scratchBaseMade = (slug: string, defaultBranch: string, api: Api, machine: Machine) =>
  Effect.gen(function* () {
    const base = scratchBaseFor(scratchId());

    if (!mayCreate(base, defaultBranch)) {
      return yield* failed(`${base} isn't a scratch branch the driver may make`);
    }

    const head = yield* githubJson(
      "GET",
      `/repos/${slug}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
      GitRef,
    ).pipe(onGitHub(api, `${defaultBranch}'s head`));

    yield* githubSend(
      "POST",
      `/repos/${slug}/git/refs`,
      Option.some({ ref: `refs/heads/${base}`, sha: head.object.sha }),
    ).pipe(onGitHub(api, `the scratch base ${base}`));

    machine.scratchBase = Option.some(base);

    return base;
  });

const tokenOf = (login: Login) =>
  GitHubTokens.use((tokens) => tokens.token(Option.some(login))).pipe(
    Effect.provide(tokensLayer),
    Effect.map((token) => ({ login, token })),
    Effect.mapError((error) => failed(`${login}'s token: ${error.message}`)),
  );

// Waits until the daemon has loaded the repo with each persona's cast flows
// on, failing with what it last said if it never does.
const ready = (live: LiveMachine, machine: Machine) => {
  const flows = machine.personas.reduce(
    (count, name) => count + flowsOf(name, machine.pool).length,
    0,
  );

  let last = "the daemon wasn't listening";

  return pollFor(
    { pollMs: READY_POLL_MS, waitMs: READY_MS, tail: live.daemonLog },
    () =>
      statusOf(live).pipe(
        Effect.map((status) => {
          const repo = Arr.findFirst(status.repos, (found) => found.name === "demo");

          const on = Option.getOrElse(
            Option.map(repo, (found) => found.flows.filter((flow) => flow.enabled).length),
            () => 0,
          );

          last = Option.match(repo, {
            onNone: () => "the daemon listed no repo demo",
            onSome: (found) =>
              `demo was ${found.status} (${Option.getOrElse(found.message, () => "")}), with ${on} of ${flows} flows on`,
          });

          return Option.liftPredicate(status, () =>
            Option.exists(repo, (found) => found.status === "ready" && on >= flows),
          );
        }),
        Effect.orElseSucceed(() => Option.none()),
      ),
    () => `the daemon never ran the cast's flows: last, ${last}`,
  ).pipe(Effect.asVoid);
};

// The machine, up: the repo checked, the scratch base made, a clone, machine
// config for the cast, and the daemon running the cast's flows.
const setUp = (config: LiveConfig, cast: CastLogins, api: Api, machine: Machine) =>
  Effect.gen(function* () {
    const logins = yield* loginsOf(cast, machine.personas);
    const reviewing = yield* loginsOf(cast, machine.pool);

    const repo = yield* githubJson("GET", `/repos/${config.slug}`, Repository).pipe(
      onGitHub(api, config.slug),
    );

    const defaultBranch = repo.default_branch;
    machine.defaultBranch = Option.some(defaultBranch);

    yield* nothingOpen(config.slug, api);
    yield* poolIsSetUp(config.slug, defaultBranch, api, reviewing);
    const base = yield* scratchBaseMade(config.slug, defaultBranch, api, machine);
    const tokens = yield* Effect.forEach(logins, tokenOf);

    const live = yield* Effect.try({
      try: () => openLiveMachine(config.slug, tokens),
      catch: (error) => failed(`the machine couldn't be set up: ${String(error)}`),
    });

    machine.running = Option.some(live);

    for (const name of machine.disputing) {
      for (const login of Option.toArray(cast.loginOf(name))) {
        live.disagreeAs(login);
      }
    }

    live.writeMachineConfig(machineConfigText(config, live, cast, machine, base));

    const trusted = yield* host("trust", () => live.runCli(["trust", "demo"]));

    if (trusted.code !== 0) {
      return yield* failed(`trust failed: ${trusted.output}`);
    }

    yield* host("the daemon didn't start", live.startDaemon);
    yield* ready(live, machine);

    return live;
  });

// A fake agent's calls, from its session log; a line from before calls
// said when is left out.
const sessionsOf = (live: LiveMachine): LiveRecords["sessions"] =>
  live.sessionLines().flatMap((line) =>
    Result.match(Schema.decodeResult(SessionLine)(line), {
      onFailure: () => [],
      onSuccess: (call) =>
        Option.toArray(
          Option.map(call.at, (at) => ({
            persona: call.persona,
            session: call.session,
            resumed: call.call === "resume",
            branch: call.branch,
            head: call.head,
            at,
          })),
        ),
    }),
  );

const listed = <A>(path: string, item: Schema.Codec<A, Json>) =>
  githubGetAllPages(path, Schema.Array(item), (page) => page);

const loginOf = (user: Option.Option<{ readonly login: string }>) =>
  Option.map(user, (found) => found.login);

const mergedByOf = (slug: string, pull: PullListed) =>
  Option.match(pull.merged_at, {
    onNone: () => Effect.succeed(Option.none<Login>()),
    onSome: () =>
      Effect.map(githubJson("GET", `/repos/${slug}/pulls/${pull.number}`, PullMerged), (found) =>
        loginOf(found.merged_by),
      ),
  });

const reviewsOf = (slug: string, number: number) =>
  Effect.gen(function* () {
    const reviews = yield* listed(`/repos/${slug}/pulls/${number}/reviews?per_page=100`, Review);

    const lineComments = yield* listed(
      `/repos/${slug}/pulls/${number}/comments?per_page=100`,
      ReviewComment,
    );

    return reviews.flatMap((review) =>
      Option.toArray(
        Option.all({
          author: loginOf(review.user),
          commitId: review.commit_id,
          submittedAt: review.submitted_at,
        }).pipe(
          Option.map((found) => ({
            pullRequest: number,
            ...found,
            state: review.state,
            lineComments: lineComments.filter((comment) =>
              Option.contains(comment.pull_request_review_id, review.id),
            ).length,
          })),
        ),
      ),
    );
  });

const timelineOf = (slug: string, number: number) =>
  Effect.map(
    listed(`/repos/${slug}/issues/${number}/timeline?per_page=100`, TimelineEvent),
    (timeline) => ({
      reviewRequests: timeline.flatMap((event) =>
        Option.toArray(
          Option.all({
            reviewer: loginOf(event.requested_reviewer),
            createdAt: event.created_at,
          }).pipe(
            Option.filter(() => Option.contains(event.event, "review_requested")),
            Option.map((found) => ({
              pullRequest: number,
              ...found,
              actor: loginOf(event.actor),
            })),
          ),
        ),
      ),
      labelled: timeline.flatMap((event) =>
        Option.toArray(
          Option.all({
            label: Option.map(event.label, (label) => label.name),
            createdAt: event.created_at,
          }).pipe(
            Option.filter(() => Option.contains(event.event, "labeled")),
            Option.map((found) => ({ pullRequest: number, ...found })),
          ),
        ),
      ),
    }),
  );

// The pushes that moved a branch, from the repo's activity, which says who pushed.
const pushesTo = (slug: string, branch: string) =>
  Effect.map(
    listed(
      `/repos/${slug}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&per_page=100`,
      Activity,
    ),
    (activity) =>
      activity.flatMap((found) =>
        Option.toArray(
          Option.liftPredicate(
            {
              branch: found.ref.replace(/^refs\/heads\//, ""),
              after: found.after,
              actor: loginOf(found.actor),
              timestamp: found.timestamp,
            },
            () => PUSHED.has(found.activity_type) && !NO_COMMIT.test(found.after),
          ),
        ),
      ),
  );

// One pull request's records: its merge, reviews, comments, timeline, and
// the pushes to its branch.
const pullRecords = (slug: string, pull: PullListed) =>
  Effect.gen(function* () {
    const { number } = pull;

    const comments = yield* listed(
      `/repos/${slug}/issues/${number}/comments?per_page=100`,
      Comment,
    );

    return {
      pull: {
        number,
        author: pull.user.login,
        headRef: pull.head.ref,
        headSha: pull.head.sha,
        requested: pull.requested_reviewers.map((user) => user.login),
        mergedBy: yield* mergedByOf(slug, pull),
        mergedAt: pull.merged_at,
      },
      reviews: yield* reviewsOf(slug, number),
      comments: comments.flatMap((comment) =>
        Option.toArray(
          Option.map(loginOf(comment.user), (author) => ({
            pullRequest: number,
            author,
            body: comment.body,
            createdAt: comment.created_at,
          })),
        ),
      ),
      pushes: yield* pushesTo(slug, pull.head.ref),
      ...(yield* timelineOf(slug, number)),
    };
  });

// Posts a passing status on each open pull request's head the driver hasn't
// passed yet, as the repo's CI.
const ciPasses = (slug: string, machine: Machine, pulls: ReadonlyArray<PullListed>) =>
  Effect.forEach(
    pulls.filter((pull) => pull.state === "open" && !machine.passed.has(pull.head.sha)),
    (pull) =>
      Effect.gen(function* () {
        const status = yield* githubJson(
          "GET",
          `/repos/${slug}/commits/${pull.head.sha}/status`,
          CombinedStatus,
        );

        if (!status.statuses.some((found) => found.context === CI_CONTEXT)) {
          yield* githubSend(
            "POST",
            `/repos/${slug}/statuses/${pull.head.sha}`,
            Option.some({
              state: "success",
              context: CI_CONTEXT,
              description: "The live feature driver passes every head.",
            }),
          );
        }

        machine.passed.add(pull.head.sha);
      }),
    { discard: true },
  );

const pullsOn = (slug: string, base: string) =>
  listed(
    `/repos/${slug}/pulls?state=all&base=${encodeURIComponent(base)}&per_page=100`,
    PullListed,
  );

const issuesOf = (slug: string, machine: Machine) =>
  Effect.forEach(machine.issues, (number) =>
    githubJson("GET", `/repos/${slug}/issues/${number}`, Issue),
  );

const scratchBaseOf = (machine: Machine) =>
  Effect.fromOption(machine.scratchBase).pipe(
    Effect.mapError(() => failed("the scenario has no scratch base")),
  );

// What can be seen now, once the driver's CI has passed what's new. The
// reviewer's token reads and the writer's posts CI, to spread GitHub's rate
// limits over both.
const look = (
  config: LiveConfig,
  cast: CastLogins,
  apis: Apis,
  machine: Machine,
  live: LiveMachine,
): Effect.Effect<World, DomainFailed> =>
  Effect.gen(function* () {
    const base = yield* scratchBaseOf(machine);

    const pulls = yield* pullsOn(config.slug, base).pipe(
      onGitHub(apis.reviewer, "the pull requests"),
    );

    yield* ciPasses(config.slug, machine, pulls).pipe(onGitHub(apis.writer, "the CI status"));

    const perPull = yield* Effect.forEach(pulls, (pull) => pullRecords(config.slug, pull)).pipe(
      onGitHub(apis.reviewer, "a pull request's records"),
    );

    const issues = yield* issuesOf(config.slug, machine).pipe(
      onGitHub(apis.reviewer, "the scenario's issues"),
    );

    return worldFrom(
      {
        issues: issues.map((issue) => ({
          number: issue.number,
          labels: issue.labels.map((label) => label.name),
        })),
        pulls: perPull.map((found) => found.pull),
        reviews: perPull.flatMap((found) => found.reviews),
        comments: perPull.flatMap((found) => found.comments),
        pushes: perPull.flatMap((found) => found.pushes),
        reviewRequests: perPull.flatMap((found) => found.reviewRequests),
        labelled: perPull.flatMap((found) => found.labelled),
        sessions: sessionsOf(live),
      },
      cast,
    );
  });

// A ref GitHub can still find.
const refLeft = (slug: string, ref: string) =>
  Effect.map(githubRequest("GET", `/repos/${slug}/git/ref/${ref}`), (response) =>
    Option.liftPredicate(ref, () => response.status === 200),
  );

const stillOpen = (slug: string, number: number) =>
  Effect.map(githubJson("GET", `/repos/${slug}/issues/${number}`, Issue), (found) =>
    Option.liftPredicate(`#${found.number}`, () => found.state === "open"),
  );

const closePath = (slug: string, item: { readonly kind: string; readonly number: number }) =>
  Option.match(
    Option.liftPredicate(item.kind, (kind) => kind === "pull"),
    {
      onNone: () => `/repos/${slug}/issues/${item.number}`,
      onSome: () => `/repos/${slug}/pulls/${item.number}`,
    },
  );

// Closes what the scenario opened and deletes what it made, once the plan is
// checked to leave the default branch alone; dies naming anything left.
const cleanUp = (config: LiveConfig, api: Api, machine: Machine) =>
  Effect.gen(function* () {
    const { slug } = config;
    const both = Option.all({ base: machine.scratchBase, defaultBranch: machine.defaultBranch });

    if (Option.isNone(both)) {
      return;
    }

    const { base, defaultBranch } = both.value;
    const pulls = yield* pullsOn(slug, base);
    const issues = yield* issuesOf(slug, machine);

    const plan = yield* Result.match(
      guarded(
        cleanupPlan({
          scratchBase: base,
          issues: issues.map((issue) => ({ number: issue.number, open: issue.state === "open" })),
          pulls: pulls.map((pull) => ({
            number: pull.number,
            headRef: pull.head.ref,
            open: pull.state === "open",
          })),
        }),
        defaultBranch,
      ),
      { onFailure: (why) => Effect.die(why), onSuccess: Effect.succeed },
    );

    yield* Effect.forEach(
      plan.close,
      (item) => githubRequest("PATCH", closePath(slug, item), Option.some({ state: "closed" })),
      { discard: true },
    );

    const leases = yield* Effect.forEach(plan.deletePrefixes, (prefix) =>
      listed(`/repos/${slug}/git/matching-refs/${prefix}`, MatchingRef),
    );

    const refs = [
      ...leases.flat().map((found) => found.ref.replace(/^refs\//, "")),
      ...plan.deleteRefs,
    ];

    yield* Effect.forEach(
      refs,
      (ref) => githubRequest("DELETE", `/repos/${slug}/git/refs/${ref}`),
      {
        discard: true,
      },
    );

    const left = [
      ...(yield* Effect.forEach(refs, (ref) => refLeft(slug, ref))),
      ...(yield* Effect.forEach(plan.close, (item) => stillOpen(slug, item.number))),
    ].flatMap(Option.toArray);

    if (left.length > 0) {
      return yield* Effect.die(
        `the scenario left ${left.join(", ")} on ${slug}; a ruleset on chernabog/threads/* may refuse to delete a thread`,
      );
    }
  }).pipe(
    Effect.provideContext(api),
    Effect.catch((error) =>
      Effect.die(`the scenario's cleanup on ${config.slug} failed: ${error.message}`),
    ),
  );

// Setting up the machine comes before anything happens on it.
const beforeActing = (machine: Machine, what: string, change: () => void) =>
  Option.match(machine.running, {
    onNone: () => Effect.sync(change),
    onSome: () => Effect.fail(failed(`${what} must be set up before anything happens`)),
  });

const noPerson = (what: string) =>
  Effect.fail(
    failed(
      `the live driver can't ${what}: it has only its personas' logins, and a person is none of them`,
    ),
  );

export const openLive = (
  config: LiveConfig,
): Effect.Effect<Domain, never, Scope.Scope | BunServices.BunServices> =>
  Effect.gen(function* () {
    const cast = castLogins(config);

    const apis: Apis = {
      writer: yield* Layer.build(apiAs(config.writer)),
      reviewer: yield* Layer.build(apiAs(config.reviewer)),
    };

    const machine: Machine = {
      personas: [],
      pool: [],
      disputing: new Set(),
      running: Option.none(),
      defaultBranch: Option.none(),
      scratchBase: Option.none(),
      issues: [],
      passed: new Set(),
    };

    // The daemon stops first, so nothing writes while the cleanup deletes.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        Option.toArray(machine.running),
        (live) => Effect.promise(() => live.stopDaemon()),
        { discard: true },
      ).pipe(Effect.andThen(cleanUp(config, apis.writer, machine))),
    );

    const running = Effect.suspend(() =>
      Option.match(machine.running, {
        onSome: Effect.succeed,
        onNone: () => setUp(config, cast, apis.writer, machine),
      }),
    );

    const lookNow = (live: LiveMachine) => look(config, cast, apis, machine, live);

    return {
      personas: (names) =>
        Effect.andThen(
          loginsOf(cast, names),
          beforeActing(machine, "personas", () => {
            machine.personas = added(machine.personas, names);
          }),
        ),
      reviewForTheTeam: (names) =>
        Effect.andThen(
          loginsOf(cast, names),
          beforeActing(machine, "the reviewer pool", () => {
            machine.pool = added(machine.pool, names);
          }),
        ),
      willDispute: (author) =>
        Effect.flatMap(loginsOf(cast, [author]), (logins) =>
          Effect.sync(() => {
            machine.disputing.add(author);

            for (const live of Option.toArray(machine.running)) {
              for (const login of logins) {
                live.disagreeAs(login);
              }
            }
          }),
        ),
      fileIssue: (labels) =>
        Effect.gen(function* () {
          const base = yield* Effect.andThen(running, scratchBaseOf(machine));

          const issue = yield* githubJson(
            "POST",
            `/repos/${config.slug}/issues`,
            Created,
            Option.some({
              title: "Filed work",
              body: `Filed by chernabog's live feature driver for the scenario on ${base}, which closes it when the scenario ends.`,
              labels: [...labels],
            }),
          ).pipe(onGitHub(apis.writer, "the issue couldn't be filed"));

          machine.issues.push(issue.number);

          return issue.number;
        }),
      openPullRequest: () => noPerson("open a pull request as a person"),
      askToReview: () => noPerson("ask for a review as a person"),
      world: Effect.flatMap(running, lookNow),
      waitUntil: (description, find) =>
        Effect.flatMap(running, (live) =>
          pollFor(
            pollingOf(live),
            () => Effect.map(lookNow(live), find),
            () => `waited ${WAIT_MS / 60_000} minutes for ${description}`,
          ),
        ),
      // Each look passes CI on what's new too, so a run that waits on it goes on.
      settle: Effect.flatMap(running, (live) =>
        settleDaemon(pollingOf(live), Effect.andThen(lookNow(live), statusOf(live))),
      ),
    } satisfies Domain;
  });

export const live = (config: LiveConfig): Driver => ({
  name: "live",
  open: openLive(config),
  timeout: 45 * 60_000,
});
