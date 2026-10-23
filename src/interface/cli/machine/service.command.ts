import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { installServiceUseCase } from "../../../modules/machine/use-cases/install-service.use-case.ts";
import { stopServiceUseCase } from "../../../modules/machine/use-cases/stop-service.use-case.ts";
import { uninstallServiceUseCase } from "../../../modules/machine/use-cases/uninstall-service.use-case.ts";
import { printLines } from "../cli.output.ts";
import { setupFlags, setUpMachine } from "./setup.command.ts";

export const installCommand = Command.make("install", setupFlags, (flags) =>
  Effect.gen(function* () {
    yield* printLines(yield* setUpMachine(flags));
    yield* Console.log(`installed and started ${(yield* installServiceUseCase()).path}`);
  }),
).pipe(
  Command.withDescription(
    "Set up personas and accounts, then register the daemon with launchd (macOS) or systemd (Linux) and start it",
  ),
);

export const uninstallCommand = Command.make("uninstall", {}, () =>
  uninstallServiceUseCase().pipe(Effect.flatMap((unit) => Console.log(`removed ${unit.path}`))),
).pipe(Command.withDescription("Stop the daemon and remove its service"));

export const stopCommand = Command.make("stop", {}, () =>
  stopServiceUseCase().pipe(
    Effect.andThen(Console.log("stopped; runs in flight resume when it starts again")),
  ),
).pipe(Command.withDescription("Stop the daemon; runs in flight resume when it starts again"));
