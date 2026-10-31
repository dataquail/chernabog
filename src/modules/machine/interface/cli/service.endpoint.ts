import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { printLines } from "../../../../interface/cli/cli.output.ts";
import { MachineCommands } from "../../machine.command-handlers.ts";
import { setupFlags, setUpMachine } from "./setup.endpoint.ts";

export const installEndpoint = Command.make("install", setupFlags, (flags) =>
  Effect.gen(function* () {
    yield* printLines(yield* setUpMachine(flags));
    const unit = yield* (yield* MachineCommands).InstallServiceCommand();
    yield* Console.log(`installed and started ${unit.path}`);
  }),
).pipe(
  Command.withDescription(
    "Set up personas and accounts, then register the daemon with launchd (macOS) or systemd (Linux) and start it",
  ),
);

export const uninstallEndpoint = Command.make("uninstall", {}, () =>
  Effect.flatMap(MachineCommands, (commands) => commands.UninstallServiceCommand()).pipe(
    Effect.flatMap((unit) => Console.log(`removed ${unit.path}`)),
  ),
).pipe(Command.withDescription("Stop the daemon and remove its service"));

export const stopEndpoint = Command.make("stop", {}, () =>
  Effect.flatMap(MachineCommands, (commands) => commands.StopServiceCommand()).pipe(
    Effect.andThen(Console.log("stopped; runs in flight resume when it starts again")),
  ),
).pipe(Command.withDescription("Stop the daemon; runs in flight resume when it starts again"));
