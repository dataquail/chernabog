// `chernabog ci`: what a repo's GitHub Actions workflow runs (#455). `ci plan`
// is its plan job: the matrix of run jobs to start, written to the step's
// outputs, with why nothing else starts in the job's summary.

import * as Arr from "effect/Array";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import { type CiEvent, type CiPlanResult, planCi } from "../../modules/runs/runs.platform.ts";
import { ConfigError } from "../../platform/config-error.ts";
import { HostEnvironment } from "../../platform/environment.ts";

const EventPayload = Schema.fromJsonString(Schema.Json);

// The event the plan is for: the flags, or the workflow's own variables; none for the sweep.
const eventOf = (name: Option.Option<string>, path: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isNone(name)) {
      return Option.none<CiEvent>();
    }

    if (Option.isNone(path)) {
      return yield* new ConfigError({
        message: `the ${name.value} event needs its payload: --event-path, or GITHUB_EVENT_PATH`,
      });
    }

    const text = yield* (yield* FileSystem.FileSystem)
      .readFileString(path.value)
      .pipe(
        Effect.mapError((error) => new ConfigError({ message: `${path.value}: ${error.message}` })),
      );

    const payload = yield* Schema.decodeEffect(EventPayload)(text).pipe(
      Effect.mapError(
        (issue) => new ConfigError({ message: `${path.value}: not JSON: ${issue.message}` }),
      ),
    );

    return Option.some<CiEvent>({ name: name.value, payload });
  });

const starts = (plan: CiPlanResult) => {
  if (plan.start.length === 0) {
    return "Starts no run job.";
  }

  if (plan.start.length === 1) {
    return "Starts 1 run job:";
  }

  return `Starts ${plan.start.length} run jobs, at most ${plan.maxParallel} at once:`;
};

// Why nothing else starts, when there's anything to say.
const why = (notes: ReadonlyArray<string>) =>
  Option.match(Option.liftPredicate(notes, Arr.isReadonlyArrayNonEmpty), {
    onNone: () => [],
    onSome: (said) => ["", "Why nothing else starts:", "", ...said.map((note) => `- ${note}`)],
  });

// The plan as a job summary, in Markdown.
const summaryOf = (plan: CiPlanResult) =>
  [
    `### chernabog ci plan: ${plan.scope}`,
    "",
    starts(plan),
    "",
    ...plan.start.map((entry) => `- \`${entry.flow}\` as \`${entry.persona}\`: ${entry.item}`),
    ...why(plan.notes),
    "",
    `\`items\`: \`${plan.matrix}\``,
    "",
  ].join("\n");

type PlanOptions = Parameters<typeof planCi>[0];

// How the command reads machine config and a repo's ci: section, which the
// CLI's root hands it.
export type CiConfigAccess<R> = {
  readonly enrolled: (
    repo: string,
  ) => Effect.Effect<Pick<PlanOptions, "machine" | "enrolled">, ConfigError, R>;
  readonly ciOf: PlanOptions["ciOf"];
};

const planCommand = <R>(config: CiConfigAccess<R>) =>
  Command.make(
    "plan",
    {
      repo: Flag.String("repo").pipe(
        Flag.withDescription(
          "The enrolled repo, by name, owner/name or path; GITHUB_REPOSITORY when left out",
        ),
        Flag.optional,
      ),
      event: Flag.String("event").pipe(
        Flag.withDescription(
          "The GitHub event to plan for, such as issues; GITHUB_EVENT_NAME when left out. None, schedule or workflow_dispatch is the sweep",
        ),
        Flag.optional,
      ),
      eventPath: Flag.String("event-path").pipe(
        Flag.withDescription("The event's payload, as JSON; GITHUB_EVENT_PATH when left out"),
        Flag.optional,
      ),
      fromCheckout: Flag.Boolean("from-checkout").pipe(
        Flag.withDescription(
          "Read the working copy's .chernabog/, rather than the default branch's",
        ),
        Flag.withDefault(false),
      ),
    },
    (options) =>
      Effect.gen(function* () {
        const variables = (yield* HostEnvironment).variables;
        const fs = yield* FileSystem.FileSystem;
        const fromEnv = (name: string) => Record.get(variables, name);

        const repo = yield* Effect.fromOption(
          Option.orElse(options.repo, () => fromEnv("GITHUB_REPOSITORY")),
        ).pipe(
          Effect.mapError(
            () => new ConfigError({ message: "name the repo: --repo, or GITHUB_REPOSITORY" }),
          ),
        );

        const event = yield* eventOf(
          Option.orElse(options.event, () => fromEnv("GITHUB_EVENT_NAME")),
          Option.orElse(options.eventPath, () => fromEnv("GITHUB_EVENT_PATH")),
        );

        const { enrolled, machine } = yield* config.enrolled(repo);

        const planned = yield* planCi({
          machine,
          enrolled,
          ciOf: config.ciOf,
          fromCheckout: options.fromCheckout,
          event,
          workflow: fromEnv("GITHUB_WORKFLOW"),
        });

        for (const note of planned.notes) {
          yield* Console.error(note);
        }

        yield* Console.log(planned.matrix);

        const append = (variable: string, text: string) =>
          Effect.forEach(
            Option.toArray(fromEnv(variable)),
            (file) => fs.writeFileString(file, text, { flag: "a" }),
            { discard: true },
          );

        yield* append(
          "GITHUB_OUTPUT",
          `items=${planned.matrix}\nmax-parallel=${planned.maxParallel}\n`,
        );
        yield* append("GITHUB_STEP_SUMMARY", summaryOf(planned));
      }),
  ).pipe(
    Command.withDescription(
      "The plan job: run the triggers of the repo's CI flows and print the run jobs to start as a JSON matrix, [{flow, persona, item}], also written to GITHUB_OUTPUT as items; with an event, only for what it concerns",
    ),
  );

export const ciCommand = <R>(config: CiConfigAccess<R>) =>
  Command.make("ci").pipe(
    Command.withDescription("What a repo's GitHub Actions workflow runs"),
    Command.withSubcommands([planCommand(config)]),
  );
