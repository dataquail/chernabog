// The workflow a repo runs its CI flows in (#461), from its checkout: the
// flows its .chernabog/config.yaml names under ci.flows, what each declares
// through the SDK the repo pins (#457), and the repo's own CI workflows,
// which a workflow_run of wakes the flows waiting on CI.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { ConfigError } from "../../../../platform/config-error.ts";
import { loadFlows, loadRepoEvents } from "../../../../platform/flow-loader.ts";
import {
  APP_ID_VARIABLE,
  APP_KEY_SECRET,
  CiWorkflow,
  type RepoWorkflow,
  WORKFLOW_FILE,
  WORKFLOW_NAME,
  type WorkflowApps,
  type WorkflowDocument,
} from "../../domain/domain-services/ci-workflow.domain-service.ts";

// What the workflow reads of a repo's ci: section: its flows, the sweep's
// schedule, and the App each flow acts as, when config names apps: (#477).
export type CiWorkflowSettings = {
  readonly flows: ReadonlyArray<string>;
  readonly schedule: string;
  readonly apps: Readonly<
    Record<
      string,
      { readonly role: string; readonly permissions: Readonly<Record<string, string>> }
    >
  >;
};

export type CiWorkflowOptions = {
  // The checkout, whose .github/workflows/ names its CI workflows.
  readonly root: string;
  // The .chernabog/ the flows and the SDK are read from.
  readonly configDir: string;
  readonly ciOf: (
    configDir: string,
  ) => Effect.Effect<CiWorkflowSettings, ConfigError, FileSystem.FileSystem>;
  // The chernabog the workflow pins.
  readonly version: string;
  // How the repo's workflow files are read, other than `except`, and how a
  // workflow is written as YAML.
  readonly workflowFiles: WorkflowFiles;
};

export type WorkflowFiles = {
  readonly read: (
    root: string,
    except: string,
  ) => Effect.Effect<ReadonlyArray<RepoWorkflow>, ConfigError, FileSystem.FileSystem>;
  readonly text: (document: WorkflowDocument) => string;
};

export type CiWorkflowText = {
  readonly path: string;
  readonly text: string;
  readonly notes: ReadonlyArray<string>;
  // What the repo needs on GitHub before the workflow runs: its secrets, and
  // with Apps, each App's Environment.
  readonly needs: string;
};

const WRITTEN_BY = `# Written by chernabog (chernabog init, or chernabog ci workflow --write) from
# .chernabog/config.yaml: its ci: section and what its flows declare. Change
# those and write it again rather than editing it; chernabog doctor checks it
# still matches.
#`;

const NEVER_API_KEY = `# ANTHROPIC_API_KEY: claude would bill it per token.`;

const HEADER = `${WRITTEN_BY}
# Repository secrets: CHERNABOG_TOKEN, a GitHub token of the persona the flows
# act as, and CLAUDE_CODE_OAUTH_TOKEN, from claude setup-token. Never set
${NEVER_API_KEY}
`;

const APPS_HEADER = `${WRITTEN_BY}
# The flows act as the repo's GitHub Apps. Each App's Environment, which
# chernabog ci apps sets up, holds its id as the variable ${APP_ID_VARIABLE} and
# its private key as the secret ${APP_KEY_SECRET}; the plan job holds neither,
# and acts as the workflow's own token. Repository secret:
# CLAUDE_CODE_OAUTH_TOKEN, from claude setup-token. Never set
${NEVER_API_KEY}
`;

const NEEDS = "give the repo the secrets CHERNABOG_TOKEN and CLAUDE_CODE_OAUTH_TOKEN";

const APPS_NEEDS = `give the repo the secret CLAUDE_CODE_OAUTH_TOKEN, and each App's Environment its ${APP_ID_VARIABLE} and ${APP_KEY_SECRET} (chernabog ci apps sets them up)`;

// Each role the CI flows act as once, with what its App may do: none when
// config names no apps:.
const workflowApps = (ci: CiWorkflowSettings) =>
  Option.map(
    Arr.match(
      Arr.dedupeWith(
        ci.flows.flatMap((flow) => Option.toArray(Record.get(ci.apps, flow))),
        (one, other) => one.role === other.role,
      ),
      { onEmpty: Option.none, onNonEmpty: Option.some },
    ),
    (roles): WorkflowApps => ({ roles }),
  );

const WorkflowOn = Schema.Record(
  Schema.String,
  Schema.Struct({
    types: Schema.Array(Schema.String),
    workflows: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);

const Wiring = Schema.Struct({ on: WorkflowOn, notes: Schema.Array(Schema.String) });

const NOTHING_DECLARED = { events: [], readsPhases: false };

const failed = (error: { readonly message: string }) => new ConfigError({ message: error.message });

// The workflow for the repo's CI flows, as text: none when ci.flows names none.
export const ciWorkflowFor = (options: CiWorkflowOptions) =>
  Effect.gen(function* () {
    const ci = yield* options.ciOf(options.configDir);

    if (ci.flows.length === 0) {
      return Option.none<CiWorkflowText>();
    }

    const flows = yield* loadFlows(options.configDir).pipe(Effect.mapError(failed));
    const routing = yield* loadRepoEvents(options.configDir).pipe(Effect.mapError(failed));

    if (Option.isNone(routing)) {
      return yield* new ConfigError({
        message:
          "the repo's @chernabog/sdk is from before flows declared the events that wake them, so it can't say what the workflow wakes on; chernabog recipes upgrade moves it on",
      });
    }

    const missing = ci.flows
      .filter((name) => !flows.has(name))
      .map((name) => `ci.flows names ${name}, which isn't one of the repo's flows`);

    const declared = ci.flows.flatMap((name) =>
      Option.toArray(
        Option.map(Option.fromUndefinedOr(flows.get(name)), (flow) => ({
          flow: name,
          personas: [],
          declared: Option.getOrElse(routing.value.of(flow), () => NOTHING_DECLARED),
        })),
      ),
    );

    const workflows = yield* options.workflowFiles.read(
      options.root,
      WORKFLOW_FILE.split("/").at(-1) ?? WORKFLOW_FILE,
    );

    const wiring = yield* Schema.decodeUnknownEffect(Wiring)(
      routing.value.workflowOn(declared, {
        ciWorkflows: CiWorkflow.ciWorkflows(workflows),
        own: WORKFLOW_NAME,
      }),
    ).pipe(
      Effect.mapError(
        (issue) =>
          new ConfigError({
            message: `the repo's @chernabog/sdk built an on: block in a shape this chernabog can't read: ${issue.message}`,
          }),
      ),
    );

    const apps = workflowApps(ci);

    const built = CiWorkflow.build({
      on: wiring.on,
      schedule: ci.schedule,
      version: options.version,
      apps,
    });

    if (Result.isFailure(built)) {
      return yield* new ConfigError({ message: `no workflow written: ${built.failure}` });
    }

    const said = Option.match(apps, {
      onNone: () => ({ header: HEADER, needs: NEEDS }),
      onSome: () => ({ header: APPS_HEADER, needs: APPS_NEEDS }),
    });

    const text = `${said.header}\n${CiWorkflow.withVersionComments(options.workflowFiles.text(built.success.document))}`;

    return Option.some<CiWorkflowText>({
      path: WORKFLOW_FILE,
      text,
      notes: [...missing, ...wiring.notes, ...built.success.notes],
      needs: said.needs,
    });
  });
