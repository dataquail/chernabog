// The GitHub Actions workflow a repo runs its CI flows in (#455, #461), as
// `chernabog init` and `chernabog ci workflow` write it: a plan job
// (`chernabog ci plan`), then a matrix of run jobs (`chernabog ci run`), one
// per entry of the plan, each through the action published from this repo at
// the version that wrote it.
//
// Its `on:` block is the one the repo's SDK builds from what its CI flows
// declare (#457), with the sweep's schedule and `workflow_dispatch` added.
// The workflow's own token reads the checkout and nothing more: chernabog
// acts as a persona, whose token starts the repo's other workflows where the
// workflow's own wouldn't. That token and Claude's are passed to the steps
// that run chernabog, and to no other.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

// What the workflow says of one event in its `on:` block.
export type EventFilter = {
  readonly types: ReadonlyArray<string>;
  readonly workflows?: ReadonlyArray<string>;
};

export type WorkflowOn = { readonly [event: string]: EventFilter };

// What starts the workflow besides the flows' events: the sweep's schedule,
// and a person, by hand.
type Schedule = ReadonlyArray<{ readonly cron: string }>;

type ByHand = { readonly [input: string]: never };

type Trigger = EventFilter | Schedule | ByHand;

// Where the workflow lives in the repo, and the name it runs under, which a
// workflow_run filter never names.
export const WORKFLOW_FILE = ".github/workflows/chernabog.yml";

export const WORKFLOW_NAME = "chernabog";

// The repository secrets the workflow reads: a persona's GitHub token, and
// the subscription token claude runs on (claude setup-token).
export const SECRETS = ["CHERNABOG_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

// The action, published from this repo at each binary's tag.
const ACTION = "dataquail/chernabog/action";

// Events an agent never runs on, whatever a flow declares: a fork's pull
// request runs with the base repo's secrets there.
const REFUSED = ["pull_request_target"];

// Where `chernabog ci run` keeps the run log and the transcripts on a runner.
const LOGS = "${{ runner.temp }}/chernabog-logs";

// How long a run job's logs are kept: long enough to find out what went
// wrong, short since a public repo's artifacts are anyone's to read.
const LOG_RETENTION_DAYS = 5;

export type Step = {
  readonly name?: string;
  readonly id?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly with?: { readonly [key: string]: string | number | boolean };
  readonly env?: { readonly [key: string]: string };
};

export type Job = {
  readonly name?: string;
  readonly needs?: string;
  readonly if?: string;
  readonly "runs-on": string;
  readonly "timeout-minutes": number;
  readonly outputs?: { readonly [key: string]: string };
  readonly strategy?: {
    readonly "fail-fast": boolean;
    readonly "max-parallel": string;
    readonly matrix: { readonly include: string };
  };
  readonly concurrency?: { readonly group: string; readonly "cancel-in-progress": boolean };
  readonly steps: ReadonlyArray<Step>;
};

export type WorkflowDocument = {
  readonly name: string;
  readonly on: { readonly [event: string]: Trigger };
  readonly permissions: { readonly [scope: string]: string };
  readonly jobs: { readonly plan: Job; readonly run: Job };
};

export type Built = {
  readonly document: WorkflowDocument;
  // What a person setting it up should know, such as a schedule on the hour.
  readonly notes: ReadonlyArray<string>;
};

// The actions from elsewhere the workflow runs, pinned by commit with their
// version beside it, as this repo's own workflows pin them: the jobs hold a
// persona's token and Claude's in every enrolled repo, so a tag that moved
// must not run there. They move with each binary release, as the action's
// own tag does.
const PINNED = {
  checkout: {
    uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    version: "v7.0.1",
  },
  upload: {
    uses: "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    version: "v7.0.2",
  },
} as const;

// Both steps that run chernabog take both tokens: ci run's agent runs on
// Claude's, and ci plan's usage gate (#459) reads the subscription's room
// this week with it, through the oauthTokenEnv its runner's machine config
// names. No other step takes either.
const secretsEnv = {
  GH_TOKEN: "${{ secrets.CHERNABOG_TOKEN }}",
  CLAUDE_CODE_OAUTH_TOKEN: "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
};

// The default branch, never a pull request's merge commit: chernabog reads
// its config from there, and a job never checks a contributor's code out.
// The workflow's token stays out of git's config, so chernabog's pushes go as
// the persona. A schedule event's payload names no repository, so its ref is
// empty and checkout takes the event's own, which for a schedule is the
// default branch too.
const checkout = (more: { readonly [key: string]: string | number | boolean } = {}): Step => ({
  uses: PINNED.checkout.uses,
  with: {
    ref: "${{ github.event.repository.default_branch }}",
    "persist-credentials": false,
    ...more,
  },
});

const onTheHour = (schedule: string) => {
  const minute = schedule.trim().split(/\s+/)[0] ?? "";

  return minute.split(",").some((part) => /^0+$/.test(part) || part.startsWith("*"));
};

const build = (options: {
  readonly on: WorkflowOn;
  readonly schedule: string;
  readonly version: string;
}): Result.Result<Built, string> => {
  const refused = Object.keys(options.on).filter((event) => REFUSED.includes(event));

  if (refused.length > 0) {
    return Result.fail(
      `the flows wake on ${refused.join(", ")}, on which an agent never runs: a fork's pull request would run with the repo's secrets`,
    );
  }

  const action = `${ACTION}@v${options.version}`;

  const document: WorkflowDocument = {
    name: WORKFLOW_NAME,
    on: {
      ...options.on,
      schedule: [{ cron: options.schedule }],
      workflow_dispatch: {},
    },
    permissions: { contents: "read" },
    jobs: {
      plan: {
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 15,
        outputs: {
          items: "${{ steps.plan.outputs.items }}",
          "max-parallel": "${{ steps.plan.outputs.max-parallel }}",
        },
        steps: [
          checkout(),
          {
            id: "plan",
            uses: action,
            with: { step: "plan", version: options.version },
            env: secretsEnv,
          },
        ],
      },
      run: {
        name: "${{ matrix.flow }} ${{ matrix.item }}",
        needs: "plan",
        if: "needs.plan.outputs.items != '[]'",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 360,
        strategy: {
          "fail-fast": false,
          "max-parallel": "${{ fromJSON(needs.plan.outputs.max-parallel) }}",
          matrix: { include: "${{ fromJSON(needs.plan.outputs.items) }}" },
        },
        concurrency: {
          group: "chernabog-${{ matrix.flow }}-${{ matrix.item }}",
          "cancel-in-progress": false,
        },
        steps: [
          checkout({ "fetch-depth": 0 }),
          {
            uses: action,
            with: {
              step: "run",
              version: options.version,
              flow: "${{ matrix.flow }}",
              persona: "${{ matrix.persona }}",
              item: "${{ matrix.item }}",
            },
            env: secretsEnv,
          },
          {
            if: "always()",
            uses: PINNED.upload.uses,
            with: {
              name: "chernabog-${{ matrix.flow }}-${{ matrix.item }}-${{ github.run_id }}-${{ github.run_attempt }}",
              path: LOGS,
              "retention-days": LOG_RETENTION_DAYS,
              "if-no-files-found": "ignore",
              "include-hidden-files": true,
            },
          },
        ],
      },
    },
  };

  const notes = Arr.filter(
    [
      `ci.schedule "${options.schedule}" runs on the hour, when GitHub drops the most scheduled runs; an odd minute, such as 17, is safer`,
    ],
    () => onTheHour(options.schedule),
  );

  return Result.succeed({ document, notes });
};

// One of the repo's workflow files, and the events that start it.
export type RepoWorkflow = {
  readonly file: string;
  readonly name: Option.Option<string>;
  readonly events: ReadonlyArray<string>;
};

// The repo's CI workflows, by the name a workflow_run filter matches: those a
// push or a pull request starts, never chernabog's own. A workflow without a
// name runs under its path.
const ciWorkflows = (workflows: ReadonlyArray<RepoWorkflow>) =>
  workflows.flatMap((workflow) => {
    const started = workflow.events.some((event) => event === "push" || event === "pull_request");
    const name = Option.getOrElse(workflow.name, () => `.github/workflows/${workflow.file}`);

    return Arr.filter([name], () => started && name !== WORKFLOW_NAME);
  });

// The chernabog version a workflow file runs, by its action's tag.
const pinnedVersion = (text: string) =>
  Option.flatMap(
    Option.fromNullishOr(new RegExp(`${ACTION}@v([0-9A-Za-z.+-]+)`).exec(text)),
    (match) => Option.fromUndefinedOr(match[1]),
  );

// The workflow's text with each pinned action's version said beside its
// commit, as a comment YAML can't carry in a value.
const withVersionComments = (text: string) =>
  Object.values(PINNED).reduce(
    (annotated, pinned) =>
      annotated.replace(
        new RegExp(`(uses: ${pinned.uses.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})$`, "gm"),
        `$1 # ${pinned.version}`,
      ),
    text,
  );

export const CiWorkflow = { build, ciWorkflows, pinnedVersion, withVersionComments } as const;
