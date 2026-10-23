// The questions setup and enrollment ask. In a terminal they're prompts; piped,
// in a script or a test without answers, nothing is asked and each wizard
// takes its defaults, or a flag, instead.

import * as Prompt from "effect/cli/Prompt";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stdio from "effect/Stdio";

import { ConfigError } from "./config.ts";

export type Choice = {
  readonly title: string;
  readonly value: string;
  readonly description?: string;
  // Shown, but can't be picked; its description says why.
  readonly disabled?: boolean;
  readonly selected?: boolean;
};

export class Asker extends Context.Service<
  Asker,
  {
    // Whether anyone is there to answer.
    readonly interactive: boolean;
    // Several of the choices.
    pick(
      message: string,
      choices: ReadonlyArray<Choice>,
    ): Effect.Effect<ReadonlyArray<string>, ConfigError>;
    // One of the choices.
    choose(message: string, choices: ReadonlyArray<Choice>): Effect.Effect<string, ConfigError>;
    // A line of text; empty for none.
    text(message: string): Effect.Effect<string, ConfigError>;
  }
>()("chernabog/Asker") {
  // Prompts in a terminal; elsewhere, no one to ask.
  public static readonly layer: Layer.Layer<Asker, never, Stdio.Stdio | Prompt.Environment> =
    Layer.effect(
      Asker,
      Effect.gen(function* () {
        const stdio = yield* Stdio.Stdio;
        const interactive = (yield* stdio.stdinIsTerminal) && (yield* stdio.stdoutIsTerminal);
        const context = yield* Effect.context<Prompt.Environment>();
        const cancelled = () => new ConfigError({ message: "cancelled" });

        const asked = <A>(prompt: Prompt.Prompt<A>) =>
          Effect.provideContext(prompt, context).pipe(Effect.mapError(cancelled));

        return Asker.of({
          interactive,
          pick: (message, choices) => asked(Prompt.MultiSelect({ message, choices: [...choices] })),
          choose: (message, choices) => asked(Prompt.Select({ message, choices: [...choices] })),
          text: (message) => asked(Prompt.String({ message, default: "" })),
        });
      }),
    );

  // No one to ask, as in a script.
  public static readonly none: Layer.Layer<Asker> = Layer.succeed(
    Asker,
    Asker.of({
      interactive: false,
      pick: () => Effect.fail(new ConfigError({ message: "nothing to answer with" })),
      choose: () => Effect.fail(new ConfigError({ message: "nothing to answer with" })),
      text: () => Effect.fail(new ConfigError({ message: "nothing to answer with" })),
    }),
  );
}
