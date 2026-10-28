// Prompts are agent-neutral Markdown in .chernabog/prompts/, filled in with
// {{name}} placeholders. A list renders as one `- ` line per item. An imported
// flow's prompts are looked up in layers: the repo's prompts/<name>.md first,
// then its package's, then the default the SDK carries, if any.

import { FlowPackage, Repo, StepFailed } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

export type PromptValue = string | number | ReadonlyArray<string> | Option.Option<string>;

const render = (value: PromptValue): string => {
  if (Option.isOption(value)) {
    return Option.getOrElse(value, () => "");
  }

  if (Predicate.isString(value) || Predicate.isNumber(value)) {
    return String(value);
  }

  if (value.length === 0) {
    return "- none";
  }

  return value.map((item) => `- ${item}`).join("\n");
};

export const fillTemplate = (template: string, values: Readonly<Record<string, PromptValue>>) =>
  template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (placeholder, key: string) =>
    Option.match(Option.fromUndefinedOr(values[key]), {
      onNone: () => placeholder,
      onSome: render,
    }),
  );

// Where a prompt is looked for, in order: the repo, then the package an
// imported flow comes from.
const promptPaths = (name: string) =>
  Effect.gen(function* () {
    const repo = yield* Repo;
    const flowPackage = yield* Effect.serviceOption(FlowPackage);

    return [
      `${repo.configDir}/prompts/${name}.md`,
      ...Option.toArray(Option.map(flowPackage, (found) => `${found.dir}/prompts/${name}.md`)),
    ];
  });

// The first of the prompt's layers that has it; none when no layer does.
const findPrompt = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    for (const path of yield* promptPaths(name)) {
      if (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))) {
        return Option.some(path);
      }
    }

    return Option.none<string>();
  });

const readPrompt = (name: string, path: string) =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(path)).pipe(
    Effect.mapError(
      () => new StepFailed({ step: `prompt ${name}`, message: `no prompt at ${path}` }),
    ),
  );

export const renderPrompt = (name: string, values: Readonly<Record<string, PromptValue>>) =>
  Effect.gen(function* () {
    const found = yield* findPrompt(name);

    if (Option.isNone(found)) {
      const looked = (yield* promptPaths(name)).join(" or ");

      return yield* new StepFailed({ step: `prompt ${name}`, message: `no prompt at ${looked}` });
    }

    return fillTemplate(yield* readPrompt(name, found.value), values);
  });

// Like renderPrompt, from the default the SDK carries when neither the repo
// nor the flow's package has prompts/<name>.md.
export const renderPromptOr = (
  name: string,
  fallback: string,
  values: Readonly<Record<string, PromptValue>>,
) =>
  Effect.gen(function* () {
    const found = yield* findPrompt(name);

    if (Option.isNone(found)) {
      return fillTemplate(fallback, values);
    }

    return fillTemplate(yield* readPrompt(name, found.value), values);
  });
