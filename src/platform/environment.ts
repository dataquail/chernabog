// The process environment, read once. Effect's Config reads one variable at a
// time; a child process that must run with exactly the right variables (an
// account's config directory set, API keys removed) needs the whole set, which
// only the host can enumerate. This is the one place that reads it.

import * as Context from 'effect/Context';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';

export type Environment = Readonly<Record<string, string>>;

// Also what the host is: its OS, for the service manager, and the user's id, for launchd's domain.
export class HostEnvironment extends Context.Service<
  HostEnvironment,
  { readonly variables: Environment; readonly platform: string; readonly userId: Option.Option<number> }
>()('chernabog/HostEnvironment') {
  public static readonly layer = Layer.sync(HostEnvironment, () => {
    const variables: Record<string, string> = {};

    for (const [name, value] of Object.entries(process.env)) if (typeof value === 'string') variables[name] = value;

    return HostEnvironment.of({ variables, platform: process.platform, userId: Option.fromUndefinedOr(process.getuid?.()) });
  });

  public static readonly fixed = (variables: Environment, platform: string = process.platform) => Layer.succeed(HostEnvironment, HostEnvironment.of({ variables, platform, userId: Option.none() }));
}

// The environment with some variables set and others removed.
export const withVariables = (base: Environment, set: Environment, remove: ReadonlyArray<string>) =>
  Object.fromEntries(Object.entries({ ...base, ...set }).filter(([name]) => !remove.includes(name)));
