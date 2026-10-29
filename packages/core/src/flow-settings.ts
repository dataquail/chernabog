// A flow's own settings. A flow declares them with a schema
// (`defineFlow({ settings })`), and a repo sets them in .chernabog/config.yaml:
// the `settings:` every flow shares, then `flows.<name>.settings`, then a
// persona's `flows.<name>.settings` in machine config, key by key. The engine
// decodes them with the flow's schema when the flow loads, so a bad setting
// is a config error then, and knows nothing of what any of them means.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { Json } from "./json.ts";

// What a flow's settings schema decodes: the settings as config.yaml writes them.
export type SettingsSchema = Schema.Codec<unknown, unknown>;

// Settings as config.yaml writes them, by key.
export type Input = { readonly [key: string]: Json };

// The settings one flow runs with, as one persona, before its schema
// decodes them: the layers merged. Provided by Chernabog.
export class FlowSettings extends Context.Service<
  FlowSettings,
  {
    readonly input: Input;
  }
>()("@chernabog/sdk/FlowSettings") {}

// The settings, merged; none outside a flow the engine runs.
export const input = Effect.serviceOption(FlowSettings).pipe(
  Effect.map(
    Option.match({
      onNone: (): Input => ({}),
      onSome: (settings) => settings.input,
    }),
  ),
);

// Decodes the flow's settings with `schema`, which may be the flow's whole
// schema or only the part a block reads: keys it doesn't name are left for
// others. The engine decoded the flow's own schema when the flow loaded, so
// a failure here is a defect, of a schema the flow didn't declare.
export const read = <S extends SettingsSchema>(schema: S): Effect.Effect<S["Type"]> =>
  input.pipe(
    Effect.flatMap((settings) => Schema.decodeEffect(schema)(settings)),
    Effect.orDie,
  );
