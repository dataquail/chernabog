// An Asker with a person's answers given in advance, recording what it was asked.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { Asker, type Choice, PromptFailed } from "../src/interface/cli/asker.prompt.ts";

export type Asked = { readonly message: string; readonly choices: ReadonlyArray<Choice> };

// Answers in order, as a person would give them, and the questions asked, for tests.
export const scripted = (answers: ReadonlyArray<ReadonlyArray<string> | string>) => {
  const asked: Array<Asked> = [];
  const queue = [...answers];

  const next = (message: string, choices: ReadonlyArray<Choice>) =>
    Effect.suspend(() => {
      asked.push({ message, choices });

      return Effect.fromOption(Option.fromUndefinedOr(queue.shift())).pipe(
        Effect.mapError(() => new PromptFailed({ message: `no answer left for: ${message}` })),
      );
    });

  const one = (message: string, choices: ReadonlyArray<Choice>) =>
    Effect.map(next(message, choices), (answer) => [answer].flat()[0] ?? "");

  return {
    asked,
    layer: Layer.succeed(
      Asker,
      Asker.of({
        interactive: true,
        pick: (message, choices) => Effect.map(next(message, choices), (answer) => [answer].flat()),
        choose: one,
        text: (message) => one(message, []),
      }),
    ),
  };
};
