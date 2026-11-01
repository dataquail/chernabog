// What the live view's settings keys change: a persona's flow on or off, its
// schedule and its accounts, and a repo paused or resumed. Each goes through
// the daemon first, so its events reach the daemon's bus
// (docs/adr/0017-state-changing-commands-go-through-the-daemon.md), and is
// written here only when no daemon answers.

import * as Effect from "effect/Effect";

import { EnrollmentCommands } from "../../modules/enrollment/enrollment.platform.ts";
import { MachineQueries } from "../../modules/machine/machine.platform.ts";
import { DaemonEnrollmentCommands, daemonReload, throughDaemon } from "../daemon/daemon.client.ts";
import { type Action } from "./update.ts";

export type SettingAction = Extract<
  Action,
  { readonly kind: "pause" | "toggle-flow" | "set-schedule" | "set-account" }
>;

// Written here, with no daemon to dispatch it: one that starts meanwhile
// reloads on it.
const here = <A, E, R>(written: Effect.Effect<A, E, R>) =>
  Effect.tap(written, () => daemonReload.pipe(Effect.ignore));

// A setting a key changed, through the daemon, or here when none is running.
export const applySetting = (action: SettingAction) =>
  Effect.gen(function* () {
    switch (action.kind) {
      case "toggle-flow": {
        const payload = {
          name: action.repo,
          persona: action.persona,
          flow: action.flow,
          enabled: action.enabled,
        };

        yield* throughDaemon(
          DaemonEnrollmentCommands.SetPersonaFlowCommand(payload),
          here(EnrollmentCommands.use((enrollment) => enrollment.SetPersonaFlowCommand(payload))),
        );

        return;
      }

      case "set-schedule": {
        const payload = {
          name: action.repo,
          persona: action.persona,
          flow: action.flow,
          schedule: action.schedule,
        };

        yield* throughDaemon(
          DaemonEnrollmentCommands.SetFlowScheduleCommand(payload),
          here(EnrollmentCommands.use((enrollment) => enrollment.SetFlowScheduleCommand(payload))),
        );

        return;
      }

      case "set-account": {
        const payload = {
          name: action.repo,
          persona: action.persona,
          role: action.role,
          account: action.account,
          offered: yield* MachineQueries.use((machine) => machine.ReadMachineSetupQuery()),
        };

        yield* throughDaemon(
          DaemonEnrollmentCommands.SetPersonaAccountCommand(payload),
          here(
            EnrollmentCommands.use((enrollment) => enrollment.SetPersonaAccountCommand(payload)),
          ),
        );

        return;
      }

      case "pause": {
        const payload = { name: action.repo };

        if (action.paused) {
          yield* throughDaemon(
            DaemonEnrollmentCommands.PauseRepoCommand(payload),
            EnrollmentCommands.use((enrollment) => enrollment.PauseRepoCommand(payload)),
          );

          return;
        }

        yield* throughDaemon(
          DaemonEnrollmentCommands.ResumeRepoCommand(payload),
          EnrollmentCommands.use((enrollment) => enrollment.ResumeRepoCommand(payload)),
        );
      }
    }
  });
