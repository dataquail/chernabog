// Creates the labels a repo's flows declare, and corrects their colour or
// description where they drifted. Labels no flow declares are left alone.

import { type Flow, type FlowLabel, labelsOf, Repo, Settings } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { githubGetAllPages, githubSend } from "../../../../platform/github-api.ts";
import { type EffectiveRepo, flowSettingsInput } from "../../../../repo-config.ts";

export const Label = Schema.Struct({
  name: Schema.String,
  color: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
});

export type Label = typeof Label.Type;

export type DesiredLabel = {
  readonly name: string;
  readonly color: string;
  readonly description: string;
};

export type LabelChange = { readonly action: "create" | "update"; readonly label: DesiredLabel };

const FLOW_LABEL_COLOR = "c5def5";

// The labels the flows declare, each once: the first flow to name one gives its look.
export const desiredLabels = (labels: Iterable<FlowLabel>): ReadonlyArray<DesiredLabel> => {
  const all: Array<DesiredLabel> = [];

  for (const label of labels) {
    if (!all.some((known) => known.name.toLowerCase() === label.name.toLowerCase())) {
      all.push({
        name: label.name,
        color: label.color ?? FLOW_LABEL_COLOR,
        description: label.description ?? "Declared by a Chernabog flow",
      });
    }
  }

  return all;
};

// The labels a repo's flows declare, as each persona's settings name them.
export const declaredLabels = (repo: EffectiveRepo, flows: ReadonlyMap<string, Flow>) =>
  Effect.map(
    Effect.forEach(repo.personas, (own) =>
      Effect.forEach([...flows], ([name, flow]) =>
        labelsOf(flow).pipe(
          Effect.provideService(Repo, own.settings),
          Effect.provideService(Settings.FlowSettings, {
            input: flowSettingsInput(own, name),
          }),
        ),
      ),
    ),
    (found) => desiredLabels(found.flat(2)),
  );

const drifted = (current: Label, label: DesiredLabel) =>
  current.color.toLowerCase() !== label.color ||
  Option.getOrElse(current.description, () => "") !== label.description;

export const planLabelSync = (
  existing: ReadonlyArray<Label>,
  desired: ReadonlyArray<DesiredLabel>,
): ReadonlyArray<LabelChange> =>
  desired.flatMap((label): ReadonlyArray<LabelChange> =>
    Option.match(
      Arr.findFirst(
        existing,
        (candidate) => candidate.name.toLowerCase() === label.name.toLowerCase(),
      ),
      {
        onNone: () => [{ action: "create", label }],
        onSome: (current): ReadonlyArray<LabelChange> => {
          if (drifted(current, label)) {
            return [{ action: "update", label }];
          }

          return [];
        },
      },
    ),
  );

const PAST_TENSE = { create: "created", update: "updated" } as const;

const verb = (change: LabelChange) => PAST_TENSE[change.action];

export const syncLabels = (repo: string, desired: ReadonlyArray<DesiredLabel>) =>
  Effect.gen(function* () {
    const existing = yield* githubGetAllPages(
      `/repos/${repo}/labels?per_page=100`,
      Schema.Array(Label),
      (page) => page,
    );

    const changes = planLabelSync(existing, desired);

    for (const { action, label } of changes) {
      if (action === "create") {
        yield* githubSend("POST", `/repos/${repo}/labels`, Option.some(label));
      } else {
        yield* githubSend(
          "PATCH",
          `/repos/${repo}/labels/${encodeURIComponent(label.name)}`,
          Option.some({ color: label.color, description: label.description }),
        );
      }
    }

    if (changes.length === 0) {
      return `${repo}: labels up to date`;
    }

    return `${repo}: ${changes.map((change) => `${verb(change)} ${change.label.name}`).join(", ")}`;
  });
