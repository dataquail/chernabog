// `chernabog ci plan`, the plan job of a repo's workflow (#455, #459): runs
// the triggers of the flows its config runs in CI and says which items to
// start a run job for, as a daemon's tick would, without state.db. Whether an
// item already has a run comes from the claim refs (#133), whose live claims
// also count against each flow's concurrency; what a tick would record as a
// skip or a hold comes back as notes, for the job's summary.
//
// Given an event, it plans only for what the event concerns, by the routes
// the repo's SDK builds from what its flows declare (#457). An event a guard
// refuses (an untrusted author, the flow's own persona) wakes nothing, and the
// plan ends before any persona's services are built or any trigger runs. With
// no event, it is the sweep: every item of every CI flow, its triggers reading
// every thread's phase from one query.

import {
  Claims,
  describeError,
  type Flow,
  GitHub,
  isManual,
  isSetupError,
  type Json,
  Progress,
  Runs,
  Settings,
  triggerOf,
  type WorkItem,
} from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { IMPLICIT, type Persona, samePersona } from "../../../../kernel/persona.value-object.ts";
import { ConfigError } from "../../../../platform/config-error.ts";
import {
  type CiFlowEvents,
  type EventRouting,
  loadRepoEvents,
} from "../../../../platform/flow-loader.ts";
import { GitHubApi, githubGraphql, viewerLoginAs } from "../../../../platform/github-api.ts";
import {
  type CiFlow,
  CiPlan,
  type Entry,
  type EventItem,
  type Findings,
  type LiveClaim,
  type Scope,
} from "../../domain/domain-services/ci-plan.domain-service.ts";
import { flowHandle, flowSettingsFor, surfaceSetup } from "./engine.ts";
import {
  buildPersonaContexts,
  type OpenRepo,
  openRepo,
  type RepoContext,
  servicesFrom,
} from "./repo-runtime.ts";

// A GitHub event, by its name and payload, as a workflow's GITHUB_EVENT_NAME
// and GITHUB_EVENT_PATH give them.
export type CiEvent = { readonly name: string; readonly payload: Json };

// What the plan reads of a repo's ci: section.
export type CiSettings = {
  readonly flows: ReadonlyArray<string>;
  readonly maxParallel: number;
};

type MachineConfig = Parameters<typeof openRepo>[0];

type EnrolledRepo = Parameters<typeof openRepo>[1];

type EffectiveRepo = OpenRepo["repo"];

export type CiPlanOptions = {
  readonly machine: MachineConfig;
  // The enrolled repo, and how to read the ci: section of its .chernabog/.
  readonly enrolled: EnrolledRepo;
  readonly ciOf: (
    configDir: string,
  ) => Effect.Effect<CiSettings, ConfigError, FileSystem.FileSystem>;
  // The working copy's .chernabog/, rather than the default branch's.
  readonly fromCheckout: boolean;
  // None for the sweep.
  readonly event: Option.Option<CiEvent>;
  // The workflow the plan job runs in, which a workflow_run of never wakes a flow.
  readonly workflow: Option.Option<string>;
};

export type CiPlanResult = {
  // What the plan looked at: "sweep", or the event and its activity type.
  readonly scope: string;
  readonly start: ReadonlyArray<Entry>;
  // The run jobs to start, as the workflow reads them: exactly `[]` for none.
  readonly matrix: string;
  readonly notes: ReadonlyArray<string>;
  readonly maxParallel: number;
};

// The events that plan across every item, as no event does: the schedule's,
// and a person running the workflow by hand.
const SWEEPS = ["schedule", "workflow_dispatch"];

const PayloadObject = Schema.Record(Schema.String, Schema.Json);

// The string at a dotted path into a payload.
const textAt = (payload: Json, path: string) =>
  path
    .split(".")
    .reduce<Option.Option<Json>>(
      (found, key) =>
        Option.flatMap(found, (value) =>
          Option.flatMap(Schema.decodeUnknownOption(PayloadObject)(value), (object) =>
            Record.get(object, key),
          ),
        ),
      Option.some(payload),
    )
    .pipe(Option.filter(Predicate.isString));

const describeScope = (event: Option.Option<CiEvent>) =>
  Option.match(event, {
    onNone: () => "sweep",
    onSome: (found) =>
      Option.match(textAt(found.payload, "action"), {
        onNone: () => found.name,
        onSome: (action) => `${found.name} ${action}`,
      }),
  });

const EventItemSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["issue", "pull-request"]),
    number: Schema.Int,
  }),
  Schema.Struct({ kind: Schema.Literals(["branch", "item"]), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("repo") }),
]);

const WokenList = Schema.Array(
  Schema.Struct({ flow: Schema.String, persona: Schema.String, item: EventItemSchema }),
);

const NOTHING_DECLARED = { events: [], readsPhases: false };

// What an event wakes, by the routes the repo's SDK builds for its CI flows.
// A workflow_run reached the plan job only because the workflow's on: block
// names the run's workflow, so that one is the repo's CI workflow here.
const wokenBy = (
  routing: EventRouting,
  flows: ReadonlyArray<{ readonly ci: CiFlow; readonly flow: Flow }>,
  event: CiEvent,
  own: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const declared: ReadonlyArray<CiFlowEvents> = flows.map(({ ci, flow }) => ({
      ...ci,
      declared: Option.getOrElse(routing.of(flow), () => NOTHING_DECLARED),
    }));

    const ciWorkflows = Option.toArray(
      Option.flatMap(
        Option.liftPredicate(event, (found) => found.name === "workflow_run"),
        (found) => textAt(found.payload, "workflow_run.name"),
      ),
    );

    const wiring = routing.workflowOn(declared, {
      ciWorkflows,
      ...Option.match(own, { onNone: () => ({}), onSome: (name) => ({ own: name }) }),
    });

    return yield* Schema.decodeUnknownEffect(WokenList)(
      routing.wokenBy(wiring.routes, event.name, event.payload),
    ).pipe(
      Effect.mapError(
        (issue) =>
          new ConfigError({
            message: `the repo's @chernabog/sdk named the flows an event wakes in a shape this chernabog can't read: ${issue.message}`,
          }),
      ),
    );
  });

const CLAIMS = `
  query ($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      refs(refPrefix: "refs/chernabog/claims/", first: 100, after: $after) {
        nodes { name target { ... on Commit { message } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

const ClaimsData = Schema.Struct({
  repository: Schema.Struct({
    refs: Schema.Struct({
      nodes: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          target: Schema.Struct({ message: Schema.optionalKey(Schema.String) }),
        }),
      ),
      pageInfo: Schema.Struct({
        hasNextPage: Schema.Boolean,
        endCursor: Schema.OptionFromNullOr(Schema.String),
      }),
    }),
  }),
});

// Every claim on the repo's items whose lease hasn't run out, from one query a
// page of a hundred, as the persona. A claim ref a writer is part way through
// replacing still names the run it replaces, which holds it until it lets go.
const liveClaims = (slug: string, persona: Persona) =>
  Effect.gen(function* () {
    const [owner = "", name = ""] = slug.split("/");
    const now = yield* DateTime.now;
    const claims: Array<LiveClaim> = [];
    let after = Option.none<string>();

    for (;;) {
      const data = yield* githubGraphql(
        CLAIMS,
        { owner, name, after: Option.getOrNull(after) },
        ClaimsData,
      );

      for (const node of data.repository.refs.nodes) {
        const holder = Option.filter(
          Claims.holderOf(node.target.message ?? ""),
          (found) => !Claims.expired(found, now),
        );

        for (const found of Option.toArray(holder)) {
          claims.push({
            item: node.name,
            runId: found.runId,
            flow: found.flow,
            persona: found.persona,
          });
        }
      }

      const page = data.repository.refs.pageInfo;

      if (!page.hasNextPage || Option.isNone(page.endCursor)) {
        return claims;
      }

      after = page.endCursor;
    }
  }).pipe(Effect.provide(GitHubApi.layerFor(persona)));

// A setup error says itself, fix included; anything else is the flow failing.
const failure = <E>(error: E) => {
  if (isSetupError(error)) {
    return error.message;
  }

  return describeError(error);
};

// The gate's Skip is its own reason, as is a setup error; anything else is the gate failing.
const gateReason = <E>(error: E) => {
  if (Predicate.isTagged(error, "Skip") && Predicate.hasProperty(error, "reason")) {
    return String(error.reason);
  }

  if (isSetupError(error)) {
    return error.message;
  }

  return `gate failed: ${describeError(error)}`;
};

// The sweep's triggers read every thread's phase from the one query readAll
// makes, rather than one query an item. When that query fails, each reads its
// own, as on a daemon.
const withPhasesRead = (context: RepoContext) =>
  Effect.gen(function* () {
    const progress = Context.get(context, Progress);
    const all = yield* Effect.result(progress.readAll);

    if (Result.isFailure(all)) {
      return {
        context,
        note: Option.some(
          `couldn't read every thread's phase at once (${all.failure.message}); each item's was read on its own`,
        ),
      };
    }

    const phases = all.success;

    return {
      context: Context.add(
        context,
        Progress,
        Progress.of({
          ...progress,
          read: (item) => Effect.succeed(Option.fromUndefinedOr(phases.get(item))),
        }),
      ),
      note: Option.none<string>(),
    };
  });

// A trigger on a runner, which never had a run of its own: what Runs says of
// any run is that it doesn't know it, as of a run on another machine.
const NO_RUNS = Runs.of({ isActive: () => Effect.succeedNone });

const planned = (scope: string, maxParallel: number, notes: ReadonlyArray<string>) =>
  ({ scope, start: [], matrix: CiPlan.matrix([]), notes, maxParallel }) satisfies CiPlanResult;

// The persona a login names in the repo: the implicit one when it is that login.
const personaFor = (repo: EffectiveRepo, logins: ReadonlyMap<string, Persona>, login: string) =>
  Option.getOrElse(
    Option.fromUndefinedOr(logins.get(login.toLowerCase())),
    () => Arr.headNonEmpty(repo.personas).persona,
  );

export const planCi = (options: CiPlanOptions) =>
  Effect.gen(function* () {
    const scope = describeScope(options.event);
    const { enrolled, machine } = options;
    const { flows, repo } = yield* openRepo(machine, enrolled, options.fromCheckout);
    const ci = yield* options.ciOf(repo.settings.configDir);

    if (ci.flows.length === 0) {
      return planned(scope, ci.maxParallel, [
        `${repo.settings.name}'s .chernabog/config.yaml names no flow under ci.flows`,
      ]);
    }

    // Each persona by the login it acts as: the implicit one's is its token's.
    const logins = new Map<string, Persona>();
    const runners = new Map<string, Array<string>>();

    for (const own of repo.personas) {
      const login = yield* Option.match(own.persona, {
        onNone: () => viewerLoginAs(IMPLICIT),
        onSome: Effect.succeed,
      });

      logins.set(login.toLowerCase(), own.persona);

      // A persona runs the flows its machine config chooses for it, as on a daemon.
      for (const name of own.chosen) {
        runners.set(name, [...(runners.get(name) ?? []), login]);
      }
    }

    const ciFlows = ci.flows.flatMap((name) =>
      Option.toArray(
        Option.map(Option.fromUndefinedOr(flows.get(name)), (flow) => ({
          ci: { flow: name, personas: runners.get(name) ?? [] } satisfies CiFlow,
          flow,
        })),
      ),
    );

    const unrun = ciFlows
      .filter(({ ci: one }) => one.personas.length === 0)
      .map(({ ci: one }) => `${one.flow} runs as none of this machine's personas`);

    const configNotes: Array<string> = ci.flows.flatMap((name) =>
      Option.match(Option.fromUndefinedOr(flows.get(name)), {
        onNone: () => [`ci.flows names ${name}, which isn't one of the repo's flows`],
        onSome: (flow) =>
          Arr.filter(
            [`${name} is a manual flow, which a person starts: the plan job finds no work for it`],
            () => isManual(flow),
          ),
      }),
    );

    const triggered = ciFlows.filter(({ flow }) => !isManual(flow));

    for (const note of unrun) {
      configNotes.push(note);
    }

    const chosen = yield* Option.match(
      Option.filter(options.event, (event) => !SWEEPS.includes(event.name)),
      {
        onNone: () => Effect.succeed(Result.succeed<Scope>({ kind: "sweep" })),
        onSome: (event) =>
          Effect.gen(function* () {
            const routing = yield* loadRepoEvents(repo.settings.configDir);

            if (Option.isNone(routing)) {
              return Result.fail(
                "the repo's @chernabog/sdk is from before flows declared the events that wake them, so only the sweep plans; chernabog recipes upgrade moves it on",
              );
            }

            const woken = yield* wokenBy(routing.value, triggered, event, options.workflow);

            return Result.succeed<Scope>({ kind: "event", woken });
          }),
      },
    );

    if (Result.isFailure(chosen)) {
      return planned(scope, ci.maxParallel, [...configNotes, chosen.failure]);
    }

    const targets = CiPlan.targets(
      triggered.map(({ ci: one }) => one),
      chosen.success,
    );

    // A guard refused the event, or it concerns no CI flow: nothing more to ask GitHub.
    if (targets.length === 0) {
      return planned(scope, ci.maxParallel, [
        ...configNotes,
        Option.match(options.event, {
          onNone: () => "no CI flow has a trigger to run",
          onSome: () =>
            "the event wakes none of the CI flows: a guard refused who caused it, or it concerns none of them",
        }),
      ]);
    }

    const servicesFor = servicesFrom(yield* buildPersonaContexts(repo, machine));
    const sweep = chosen.success.kind === "sweep";
    const notes: Array<string> = [...configNotes];

    // Each persona's services, built once, with what a runner's trigger reads.
    const contexts = new Map<string, Result.Result<RepoContext, string>>();

    for (const login of Arr.dedupe(targets.map((target) => target.persona))) {
      const built = yield* Effect.result(
        Option.match(servicesFor(personaFor(repo, logins, login)), {
          onNone: () => Effect.fail(`${repo.settings.name} has no persona ${login}`),
          onSome: (services) => Effect.mapError(services, (error) => error.message),
        }),
      );

      if (Result.isFailure(built) || !sweep) {
        contexts.set(login, built);
        continue;
      }

      const phased = yield* withPhasesRead(built.success);

      for (const note of Option.toArray(phased.note)) {
        notes.push(note);
      }

      contexts.set(login, Result.succeed(phased.context));
    }

    const claims = yield* liveClaims(
      repo.settings.slug,
      Option.match(Arr.head(targets), {
        onNone: () => IMPLICIT,
        onSome: (first) => personaFor(repo, logins, first.persona),
      }),
    );

    const findings: Array<Findings> = [];

    for (const target of targets) {
      const flow = Option.getOrThrow(
        Option.fromUndefinedOr(triggered.find((one) => one.ci.flow === target.flow)),
      ).flow;

      const persona = personaFor(repo, logins, target.persona);
      const handle = flowHandle(repo, target.flow, flow);

      const concurrency = Option.getOrElse(
        Option.flatMap(
          Option.flatMap(
            Arr.findFirst(repo.personas, (own) => samePersona(own.persona, persona)),
            (own) => Record.get(own.flows, target.flow),
          ),
          (settings) => Option.fromUndefinedOr(settings.concurrency),
        ),
        () => flow.concurrency ?? 1,
      );

      const built = Option.getOrThrow(Option.fromUndefinedOr(contexts.get(target.persona)));

      if (Result.isFailure(built)) {
        findings.push({
          target,
          concurrency,
          found: { kind: "failed", reason: built.failure },
          held: Option.none(),
        });
        continue;
      }

      const context = Context.add(
        Context.add(built.success, Runs, NO_RUNS),
        Settings.FlowSettings,
        flowSettingsFor(handle, persona),
      );

      // A branch names the pull request open from it, and the issue whose work branch it is.
      const only = yield* Effect.transposeOption(
        Option.map(target.only, (items) =>
          Effect.map(
            Effect.forEach(items, (concerned) => {
              if (concerned.kind !== "branch") {
                return Effect.succeed<ReadonlyArray<EventItem>>([concerned]);
              }

              return GitHub.use((github) => github.pullRequestForBranch(concerned.name)).pipe(
                Effect.map((pull) =>
                  CiPlan.resolveBranch(
                    concerned.name,
                    Option.map(pull, (found) => found.number),
                  ),
                ),
                Effect.orElseSucceed((): ReadonlyArray<EventItem> => []),
                Effect.provideContext(context),
              );
            }),
            (resolved) => resolved.flat(),
          ),
        ),
      );

      const items = yield* Effect.result(
        Effect.provideContext(surfaceSetup(triggerOf(flow)), context),
      );

      const one: Findings = {
        target: { ...target, only },
        concurrency,
        found: Result.match(items, {
          onSuccess: (found: ReadonlyArray<WorkItem>) => ({ kind: "items" as const, items: found }),
          onFailure: (error) => ({ kind: "failed" as const, reason: failure(error) }),
        }),
        held: Option.none(),
      };

      // Only a flow with something to start has its gate asked, the usage gate among them.
      const gate = Option.filter(
        Option.fromUndefinedOr(flow.gate),
        () => CiPlan.startable(one, claims).length > 0,
      );

      const held = yield* Option.match(gate, {
        onNone: () => Effect.succeedNone,
        onSome: (asked) =>
          Effect.map(
            Effect.result(Effect.provideContext(surfaceSetup(asked), context)),
            Result.match({
              onSuccess: () => Option.none<string>(),
              onFailure: (error) => Option.some(gateReason(error)),
            }),
          ),
      });

      findings.push({ ...one, held });
    }

    const plan = CiPlan.plan(findings, claims);

    return {
      scope,
      start: plan.start,
      matrix: CiPlan.matrix(plan.start),
      notes: [...notes, ...plan.notes],
      maxParallel: ci.maxParallel,
    } satisfies CiPlanResult;
  }).pipe(Effect.scoped);
