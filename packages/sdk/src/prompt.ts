// Prompts are agent-neutral Markdown in .chernabog/prompts/, filled in with
// {{name}} placeholders. A list renders as one `- ` line per item.

import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';

import { StepFailed } from './errors.ts';
import { Repo } from './services.ts';

export type PromptValue = string | number | ReadonlyArray<string> | Option.Option<string>;

const render = (value: PromptValue): string => {
  if (Option.isOption(value)) return Option.getOrElse(value, () => '');

  if (Predicate.isString(value) || Predicate.isNumber(value)) return String(value);

  if (value.length === 0) return '- none';

  return value.map((item) => `- ${item}`).join('\n');
};

export const fillTemplate = (template: string, values: Readonly<Record<string, PromptValue>>) =>
  template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (placeholder, key: string) =>
    Option.match(Option.fromUndefinedOr(values[key]), { onNone: () => placeholder, onSome: render }),
  );

export const renderPrompt = (name: string, values: Readonly<Record<string, PromptValue>>) =>
  Effect.gen(function* () {
    const repo = yield* Repo;
    const fs = yield* FileSystem.FileSystem;
    const path = `${repo.configDir}/prompts/${name}.md`;
    const template = yield* fs.readFileString(path).pipe(Effect.mapError(() => new StepFailed({ step: `prompt ${name}`, message: `no prompt at ${path}` })));

    return fillTemplate(template, values);
  });
