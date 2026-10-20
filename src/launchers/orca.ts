// A terminal tab in Orca, on the worktree. Orca types the command into a login
// shell, so it is sent as `exec …`: the tab ends when the agent does.

import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

import { type Launcher, LaunchError, runTool, shellCommand } from './launcher.ts';

const NAME = 'orca';

const Failure = Schema.Struct({ code: Schema.String, message: Schema.String });

const Created = Schema.fromJsonString(
  Schema.Union([Schema.Struct({ ok: Schema.Literal(true), result: Schema.Struct({ terminal: Schema.Struct({ handle: Schema.String }) }) }), Schema.Struct({ ok: Schema.Literal(false), error: Failure })]),
);

const Shown = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), result: Schema.Struct({ terminal: Schema.Struct({ connected: Schema.Boolean }) }) }),
    Schema.Struct({ ok: Schema.Literal(false), error: Failure }),
  ]),
);

const Status = Schema.fromJsonString(
  Schema.Struct({ ok: Schema.Boolean, result: Schema.optionalKey(Schema.Struct({ app: Schema.Struct({ running: Schema.Boolean }), runtime: Schema.Struct({ reachable: Schema.Boolean }) })) }),
);

const STALE = 'terminal_handle_stale';

const decode = <A>(schema: Schema.Codec<A, string>, what: string, stdout: string) =>
  Schema.decodeEffect(schema)(stdout.trim()).pipe(Effect.mapError(() => new LaunchError({ launcher: NAME, message: `orca ${what} printed something unexpected: ${stdout.trim().slice(0, 300)}` })));

const orca = (args: ReadonlyArray<string>) => runTool(NAME, 'orca', args);

export const orcaLauncher: Launcher = {
  name: NAME,
  start: (spec) =>
    Effect.gen(function* () {
      const result = yield* orca(['terminal', 'create', '--worktree', `path:${spec.cwd}`, '--title', spec.title, '--command', `exec ${shellCommand(spec.command)}`, '--json']);
      const created = yield* decode(Created, 'terminal create', result.stdout);

      if (!created.ok) return yield* new LaunchError({ launcher: NAME, message: `orca terminal create: ${created.error.message}` });

      return created.result.terminal.handle;
    }),
  // `connected` alone says whether the command still runs: Orca also marks a
  // terminal orphaned a few seconds after Claude Code starts in it, while it runs.
  alive: (handle) =>
    Effect.gen(function* () {
      const result = yield* orca(['terminal', 'show', '--terminal', handle, '--json']);
      const shown = yield* decode(Shown, 'terminal show', result.stdout);

      if (shown.ok) return shown.result.terminal.connected;

      if (shown.error.code === STALE) return false;

      return yield* new LaunchError({ launcher: NAME, message: `orca terminal show: ${shown.error.message}` });
    }),
  // Already gone is closed.
  close: (handle) => Effect.asVoid(orca(['terminal', 'close', '--terminal', handle, '--json'])),
  attach: (handle) => Option.some({ command: 'orca', args: ['terminal', 'switch', '--terminal', handle] }),
  check: Effect.gen(function* () {
    const result = yield* orca(['status', '--json']);
    const status = yield* decode(Status, 'status', result.stdout);
    const ok = status.ok && Option.exists(Option.fromUndefinedOr(status.result), (found) => found.app.running && found.runtime.reachable);

    return { ok, label: 'orca: running and reachable', fix: 'open Orca' };
  }).pipe(Effect.orElseSucceed(() => ({ ok: false, label: 'orca: running and reachable', fix: 'install Orca and open it, or pick another launcher' }))),
};
